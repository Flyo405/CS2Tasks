import { Bingo } from './tasks/bingo.js';
import { PointsGame } from './tasks/points.js';
// Ядро: связывает трекер матча, задания, предложения, чат и рассылку состояния.
import fs from 'node:fs';
import path from 'node:path';
import { normalize, yawOf, activeWeapon } from './gsi/normalize.js';
import { getType, comboRequirement, RETIRED_TYPES } from './tasks/taskTypes.js';
import { MatchTracker } from './game/matchTracker.js';
import { TaskManager } from './tasks/taskManager.js';
import { TaskError } from './tasks/taskTypes.js';
import { validateTemplates, saveTemplates } from './tasks/templates.js';
import { Suggestions } from './chat/suggestions.js';
import { createCommandHandler, isAllowed } from './chat/commands.js';
import { TaskVote } from './chat/taskVote.js';
import { generate } from './tasks/generator.js';
import { titleFor } from './tasks/taskTypes.js';
import { TwitchProvider } from './chat/twitch.js';
import { applyConfigPatch } from './config.js';
import { readJson, writeJsonAtomic, createSaver } from './store.js';
import { log as defaultLog, setLogLevel } from './log.js';
import { KillBonuses } from './bonuses/killBonuses.js';
import { MatchReports } from './game/matchReports.js';
import { ObsConnection } from './obs/connection.js';
import { situationalTemplates, isPistolRound } from './tasks/situational.js';
import { lowHealthVitals } from './game/lowHealth.js';
import { LowHealthFilter } from './obs/lowHealthFilter.js';
import { localizeTask } from './i18n.js';

const HISTORY_FILE_LIMIT = 2000;
const RAW_BUFFER_SIZE = 1500; // ~2–3 минуты игры
export class Core {
  /**
   * @param {object} o
   * @param {object} o.config
   * @param {string|null} o.configFile — null = не сохранять
   * @param {string|null} o.dataDir — null = без файлов (тесты)
   * @param {{raw: Array, templates: Array, errors: string[]}} o.templates
   */
  constructor({ config, configFile = null, dataDir = null, templates, now = () => Date.now(), rng = Math.random, log = defaultLog, chatProviderFactory = null, input = null }) {
    this.input = input; // InputService (мышь/клавиатура) или null
    this.config = config;
    this.configFile = configFile;
    this.dataDir = dataDir;
    this.templatesRaw = templates.raw;
    this.templates = templates.templates;
    this.templateErrors = templates.errors;
    this.now = now;
    this.log = log;
    this.listeners = new Set();
    this.gsiInstall = null;
    this.chat = null;
    this.chatStatus = { enabled: false, connected: false, channel: '', canSay: false, error: null };
    this.chatProviderFactory = chatProviderFactory || ((opts) => new TwitchProvider(opts));
    this.broadcastTimer = null;
    // Счётчик за время работы программы: не сохраняется, при перезапуске начинается с нуля.
    this.session = { completed: 0, skipped: 0, failed: 0, startedAt: now() };
    this.bonuses = new KillBonuses({ getConfig: () => this.config, now,
      emit: (popup) => { this.reports?.addBonus(popup); this.emitEvent({ kind: 'kill_bonus', popup }); } });

    const persisted = dataDir ? readStateSafe(path.join(dataDir, 'state.json'), log) : {};
    let reportHistory = [];
    if (dataDir) {
      try { reportHistory = readJson(path.join(dataDir, 'match-reports.json'), []); }
      catch (e) { log.warn('Не удалось прочитать итоги матчей:', e.message); }
    }
    this.reports = new MatchReports({ current: persisted.reportCurrent || null,
      history: Array.isArray(reportHistory) ? reportHistory : [],
      save: (history) => { if (dataDir) writeJsonAtomic(path.join(dataDir, 'match-reports.json'), history); } });
    this.obs = new ObsConnection({ getConfig: () => this.config, onChange: () => this.changed(), now });
    this.lowHealthFilter = new LowHealthFilter({ obs: this.obs, getConfig: () => this.config.lowHealth });
    this.tracker = new MatchTracker({ getConfig: () => this.config, initial: persisted.tracker });
    this.warnings = []; // для панели
    this.rawBuffer = []; // последние сырые пакеты GSI — для диагностики
    this.tracker.onWarning = (msg, code) => this.addWarning(msg, code);
    this.tasks = new TaskManager({
      getConfig: () => this.config,
      getTemplates: (opts) => this.availableTemplates(opts),
      // Вручную стример может добавить урон, пока не известно, что игра его не присылает.
      checkType: (type, params) => this.inputBlock(type, params),
      getMatch: () => this.tracker.match,
      getCtx: () => this.ctx(),
      emit: (ev) => this.emitEvent(ev),
      onChange: () => this.changed(),
      onFinished: (t) => this.recordTask(t),
      initial: persisted.tasks,
      rng,
      now,
      log,
    });
    this.bingo = new Bingo({
      initial: persisted.bingo, getConfig: () => this.config, getMatch: () => this.tracker.match,
      getCtx: () => this.ctx(), getTemplates: () => this.availableTemplates(),
      checkType: (type, params) => this.inputBlock(type, params),
      onFinished: (task) => this.recordTask(task),
      onLine: (count, matchId) => this.bonuses.awardBingo(count, matchId),
      now, rng, log,
    });
    this.points = new PointsGame({ initial: persisted.points, getConfig: () => this.config, now });
    this.suggestions = new Suggestions({ getConfig: () => this.config, initial: persisted.suggestions, now });
    this.taskVote = new TaskVote({
      canVote: ({ roles }) => isAllowed(roles, this.config.twitch.voteAllowedRoles),
      now, rng,
      getOptions: () => {
        const templates = this.availableTemplates().filter((template) => {
          const type = getType(template.type);
          return type && !type.manual && !type.roundScoped;
        });
        const excludeTypes = this.tasks.active().map((task) => task.type);
        const preferred = generate({ templates, count: 4, excludeTypes, rng });
        const extras = generate({ templates, count: 4 - preferred.length, excludeTypes: preferred.map((option) => option.type), rng });
        return [...preferred, ...extras].map((spec) => ({ ...spec, title: titleFor(spec.type, spec.params) }));
      },
      addWinner: (option) => {
        try {
          const task = this.tasks.add({ ...option, source: 'vote' }, { allowReserve: false });
          const title = localizeTask(task, this.config.language).title;
          this.chat?.say(this.config.language === 'en' ? `Winning challenge: ${title}` : `Победило задание «${title}»`);
          return true;
        } catch (error) {
          this.log.warn('Не удалось добавить задание голосования:', error.message);
          return false;
        }
      },
      announce: (options) => {
        const title = this.config.language === 'en' ? 'Vote in the next 30 seconds by typing 1, 2, 3, or 4' : 'Голосование на 30 секунд. Напишите в чат 1, 2, 3 или 4';
        this.chat?.say(`${title} · ${options.map((option, index) => `${index + 1}) ${localizeTask(option, this.config.language).title}`).join(' · ')}`);
      },
      onChange: () => this.changed(),
    });

    if (dataDir) {
      this.stateSaver = createSaver(path.join(dataDir, 'state.json'), () => this.serialize(), 500);
      this.historyFile = path.join(dataDir, 'history.json');
      this.historyBuffer = null;
      this.historySaver = createSaver(this.historyFile, () => this.historyBuffer || [], 1000);
    }
    this.handleChat = createCommandHandler({
      // Зрители не могут предложить урон, пока игра не доказала, что присылает его.
      checkType: (type, params) => this.inputBlock(type, params),
      getConfig: () => this.config,
      getTemplates: () => this.templates,
      suggestions: this.suggestions,
      getActiveTasks: () => (this.bingoActive ? this.bingo.manager.active() : this.tasks.active()).map((t) => localizeTask(t, this.config.language)),
      say: (text) => this.chat?.say(text),
      onChange: () => this.changed(),
      log,
    });
    this.tasks.replaceTypes(RETIRED_TYPES, 'retired', 'Задание удалено из набора');
  }

  serialize() {
    return {
      version: 1,
      savedAt: this.now(),
      tracker: this.tracker.serialize(),
      tasks: this.tasks.serialize(),
      bingo: this.bingo.serialize(),
      points: this.points.serialize(),
      suggestions: this.suggestions.serialize(),
      reportCurrent: this.reports.current,
    };
  }

  ctx() {
    const pub = this.tracker.publicState();
    return { match: pub.match, round: pub.round, player: this.tracker.lastSelf?.player || null };
  }

  // ---------- GSI ----------

  ingest(raw, receivedAt = this.now()) {
    if (raw && typeof raw === 'object') {
      const { auth, ...p } = raw;
      this.rawBuffer.push({ t: receivedAt, p });
      if (this.rawBuffer.length > RAW_BUFFER_SIZE) this.rawBuffer.splice(0, this.rawBuffer.length - RAW_BUFFER_SIZE);
    }
    const snap = normalize(raw, receivedAt);
    if (!snap) return [];
    this.trackMotion(snap);
    const wasConnected = this.tracker.connected;
    if (this.input && snap.isSelf && snap.player) {
      if (snap.providerSteamId && snap.providerSteamId !== this.lastSteamId) {
        this.lastSteamId = snap.providerSteamId;
        this.input.onSteamId?.();
      }
      this.input.onWeapon(activeWeapon(snap.player.weapons)?.name, receivedAt);
    }
    const events = this.tracker.handle(snap);
    const detector = this.input?.available().running ? this.input.detector : null;
    for (const ev of events) {
      if (ev.type === 'primary_removed' && detector?.consumeDrop?.(receivedAt)) ev.type = 'team_drop';
    }
    this.reports.observe(events, this.tracker.match);
    // Признаки убийства по мыши и клавиатуре: после 360°, в прыжке, без прицела.
    for (const ev of events) {
      if (ev.type !== 'kill') continue;
      ev.pistolRound = isPistolRound(ev.round ?? this.tracker.round.round ?? snap.mapRound);
      if (this.input && this.input.available().running) {
        const k = this.input.classifyKill(receivedAt, ev.weapon, ev);
        ev.spin = k.spin;
        ev.jump = k.jump;
        ev.noscope = k.noscope;
        ev.flick = k.flick;
        ev.crouched = k.crouched;
        ev.stationary = k.stationary;
        ev.oneTap = k.oneTap;
        ev.heldAngle = k.heldAngle;
        if (k.flick) this.log.info(`Флик-убийство (${ev.weapon.name})`);
        if (k.spin || k.jump || k.noscope) {
          this.log.info(`Убийство${k.spin ? ' после 360°' : ''}${k.jump ? ' в прыжке' : ''}${k.noscope ? ' без прицела' : ''} (${ev.weapon.name})`);
        }
      } else {
        ev.spin = false;
        ev.jump = false;
        ev.noscope = false;
      }
    }
    // Ограничения раунда по вводу: были ли прыжки и нажатия перезарядки между концом фризтайма и концом раунда.
    for (const ev of events) {
      if (ev.type !== 'round_end') continue;
      const d = this.input?.available().running ? this.input.detector : null;
      const inRound = (t) => ev.liveAt != null && t >= ev.liveAt && t <= ev.endedAt;
      ev.jumped = d && ev.liveAt != null ? d.jumps.some(inRound) : null;
      ev.reloadKey = d && ev.liveAt != null ? (d.reloads || []).some(inRound) : false;
      if (d?.roundMovement) Object.assign(ev, d.roundMovement(ev.liveAt, ev.endedAt));
    }
    if (!wasConnected) this.log.info('GSI: данные от CS2 получены');
    for (const ev of events) {
      if (ev.type === 'match_start') this.log.info(`Новый матч: ${ev.mapName ?? '?'} (режим: ${ev.mode ?? 'неизвестен'}, причина: ${ev.reason})`);
      else if (ev.type === 'match_end') this.log.info(`Матч окончен: ${ev.result} ${ev.myScore}:${ev.enemyScore}`);
      else if (ev.type === 'kill') this.log.debug(`kill x${ev.count} hs=${ev.headshots} ${ev.weapon.name} hp=${ev.hpAtKill}`);
      else this.log.debug('event', ev.type);
    }
    this.bonuses.handle(events, receivedAt);
    this.handleChallenges(events);
    for (const ev of events) {
      if (ev.type === 'match_end') {
        if (this.pointsActive && this.reports.current?.matchId === ev.matchId) {
          this.reports.current.points = { score: this.points.score, goal: this.points.cfg.goal, reached: !!this.points.reachedAt };
        }
        const report = this.reports.finish(ev, this.tracker.match);
        if (report) this.emitEvent({ kind: 'match_report', report });
      }
    }
    this.syncLowHealth();
    this.updateTaskVote();
    this.changed();
    return events;
  }

  get bingoActive() {
    return !!this.bingo.matchId && this.bingo.matchId === this.tracker.match?.matchId;
  }

  handleStyleInput(kind, at) {
    if (!this.tracker.connected || !this.tracker.lastSnapshot?.hasMap || !this.tracker.lastSnapshot.isSelf) return;
    this.bonuses.awardStyle(kind, at);
  }

  /** Режим «Очки» включён для текущего матча. */
  get pointsActive() {
    return !!this.points.matchId && this.points.matchId === this.tracker.match?.matchId;
  }

  requireClassic() {
    if (this.bingoActive) throw new TaskError('Обычные задания недоступны в режиме бинго');
  }

  recordTask(task) {
    this.reports.taskFinished(task);
    if (task.status in this.session) this.session[task.status]++;
    this.appendHistory(task);
    if (this.pointsActive && (task.status === 'completed' || task.status === 'skipped')) {
      const r = task.status === 'completed' ? this.points.award(task) : this.points.penalize(task);
      if (r) {
        this.log.info(`Очки: ${r.points > 0 ? '+' : ''}${r.points} за «${task.title}» — ${r.score} / ${r.goal}`);
        if (r.reached) this.log.info(`Цель режима «Очки» достигнута: ${r.score} / ${r.goal}`);
        this.emitEvent({ kind: 'task_points', taskId: task.id, ...r });
      }
    }
  }

  handleChallenges(events) {
    const start = events.find((event) => event.type === 'match_start');
    const mode = this.config.tasks.mode;
    if (start) {
      this.bingo.start(mode === 'bingo' || mode === 'bingo5' ? start.matchId : null, mode === 'bingo5' ? 5 : 3);
      this.points.start(mode === 'points' ? start.matchId : null);
    }
    const side = this.tracker.match?.team;
    this.tasks.adaptToSide(side);
    this.bingo.manager.adaptToSide(side);
    if (this.bingoActive) {
      this.bingo.handleEvents(events.filter((event) => event.type !== 'match_start'), this.ctx());
    } else {
      this.tasks.handleEvents(events, this.ctx());
      if (events.some((event) => event.type === 'round_live' || event.type === 'match_start')) this.tasks.adaptToSituation();
    }
  }

  syncLowHealth() {
    const v = lowHealthVitals(this.tracker, this.config.lowHealth, this.now());
    if (v.active) {
      if (!this.healthEpisode || this.healthEpisode.key !== v.key) this.healthEpisode = { key: v.key, startedAt: this.now() };
    } else this.healthEpisode = null;
    this.lowHealthFilter.sync(v.active);
    return v;
  }

  updateTaskVote() {
    const match = this.tracker.match;
    const eligible = this.config.twitch.taskVoting && this.chatStatus.connected && !this.bingoActive
      && this.tracker.connected && this.tracker.lastSnapshot?.hasMap && !this.tracker.ignoredMode
      && match?.status === 'live' && match.phase === 'live';
    const hasWinner = this.tasks.active().some((task) => task.source === 'vote' && task.matchId === match?.matchId);
    this.taskVote.update(eligible ? match.matchId : null, hasWinner, match?.team);
  }

  tick() {
    this.syncLowHealth();
    if (this.tracker.checkConnection(this.now())) {
      this.log.warn('GSI: нет данных от CS2 больше 30 секунд (игра закрыта или cfg не установлен)');
      this.changed();
    }
    this.updateTaskVote();
  }

  // ---------- Состояние и рассылка ----------

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(msg) {
    if (msg.type === 'event' && msg.task) msg = { ...msg, task: localizeTask(msg.task, this.config.language) };
    for (const fn of this.listeners) {
      try { fn(msg); } catch (e) { this.log.debug('listener error', e.message); }
    }
  }

  emitEvent(ev) {
    // Событие уходит сразу, вместе с актуальным состоянием — чтобы оверлей анимировал без задержки.
    this.send({ type: 'event', ...ev });
    this.flushBroadcast();
  }

  changed({ persist = true } = {}) {
    if (persist) this.stateSaver?.schedule();
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => this.flushBroadcast(), 50);
  }

  flushBroadcast() {
    if (this.broadcastTimer) { clearTimeout(this.broadcastTimer); this.broadcastTimer = null; }
    if (this.listeners.size) this.send({ type: 'state', state: this.getState() });
  }

  getState() {
    const pub = this.tracker.publicState();
    const vote = this.taskVote.publicState();
    return {
      serverTime: this.now(),
      update: this.update ?? null,
      gsi: { ...pub.gsi, install: this.gsiInstall },
      match: pub.match,
      round: pub.round,
      bingo: this.bingoActive ? { ...this.bingo.serialize(), focus: this.bingo.focus(), cells: this.bingo.cells.map((t) => localizeTask(t, this.config.language)) } : null,
      tasks: (this.bingoActive ? [] : this.tasks.tasks).map((t) => {
        const local = localizeTask(t, this.config.language);
        return this.pointsActive ? { ...local, points: this.points.valueOf(t), penalty: this.points.penaltyOf(t) } : local;
      }),
      points: this.pointsActive ? this.points.publicState() : null,
      history: this.tasks.history.slice(0, 100).map((t) => localizeTask(t, this.config.language)),
      suggestions: this.suggestions.queue.map((t) => localizeTask(t, this.config.language)),
      taskVote: vote && { ...vote, options: vote.options.map((option) => localizeTask(option, this.config.language)) },
      chat: this.chatStatus,
      session: this.session,
      healthEffect: { startedAt: this.healthEpisode?.startedAt ?? null, ...lowHealthVitals(this.tracker, this.config.lowHealth, this.now()), error: this.lowHealthFilter.error },
      bonuses: this.bonuses.state(),
      matchReports: this.reports.history.slice(0, 20).map(({ tasks, ...report }) => report),
      obs: this.obs.publicState(),
      templateErrors: this.templateErrors,
      warnings: this.warnings,
      motion: this.motionState(),
      input: this.input ? this.input.publicState() : null,
      blockedTypes: this.blockedTypes(),
      settings: {
        language: this.config.language,
        sounds: this.config.sounds,
        overlay: this.config.overlay,
        bonuses: this.config.bonuses,
        summary: this.config.summary,
        lowHealth: this.config.lowHealth,
        tasks: { mode: this.config.tasks.mode, count: this.config.tasks.count, maxActive: this.config.tasks.maxActive, points: this.config.tasks.points },
      },
    };
  }

  /**
   * Диагностика данных о движении (player_position): приходят ли позиция и взгляд
   * для самого стримера и как часто. Нужна для заданий «360» и «в прыжке».
   */
  trackMotion(snap) {
    const m = this.motion || (this.motion = { selfTimes: [], position: null, forward: null, yaw: null, at: null, seenForOthers: false });
    if (!snap.position && !snap.forward) return;
    if (!snap.isSelf) { m.seenForOthers = true; return; }
    m.position = snap.position;
    m.forward = snap.forward;
    m.yaw = yawOf(snap.forward);
    m.at = snap.ts;
    m.selfTimes.push(snap.ts);
    const cutoff = snap.ts - 5000;
    while (m.selfTimes.length && m.selfTimes[0] < cutoff) m.selfTimes.shift();
  }

  motionState() {
    const m = this.motion;
    if (!m) return { self: false, seenForOthers: false };
    const recent = m.selfTimes.filter((t) => t >= this.now() - 5000);
    return {
      self: !!m.at,
      seenForOthers: m.seenForOthers,
      lastAt: m.at,
      yaw: m.yaw == null ? null : Math.round(m.yaw),
      z: m.position ? Math.round(m.position.z) : null,
      ratePerSec: Math.round((recent.length / 5) * 10) / 10,
    };
  }

  /** { тип: причина } для типов, которые сейчас нельзя добавить вручную. */
  blockedTypes() {
    const out = {};
    for (const t of ['spin_kills', 'jump_kills', 'noscope_kills', 'pistol_round_kills', 'flick_kills',
      'crouch_kills', 'stationary_kills', 'one_tap_kills', 'forward_only_round', 'walk_only_round', 'team_drops',
      'held_angle_kills', 'defuse_survive', 'plant_survive', 'post_plant_kills', 'retake_kills']) {
      const r = this.inputBlock(t);
      if (r) out[t] = r;
    }
    return out;
  }

  /** Почему тип задания сейчас недоступен из-за мыши/клавиатуры (или null). */
  inputBlock(type, params) {
    const taskType = getType(type);
    const side = this.tracker.match?.team;
    if (taskType?.side && (side === 'CT' || side === 'T') && taskType.side !== side) {
      return 'Это задание доступно только за другую сторону';
    }
    if (type === 'pistol_round_kills') {
      const m = this.tracker.match;
      if (!m || m.phase !== 'live' || m.status !== 'live' || m.roundPhase === 'over' || !isPistolRound(this.tracker.round.round ?? m.round)) {
        return 'Это задание доступно только в пистолетном раунде (1-й или 13-й раунд MR12)';
      }
    }
    const req = type === 'combo_kills' ? comboRequirement(params) : taskType?.requires;
    if (!req) return null;
    const av = this.input?.available() || { running: false, spin: false };
    if (!av.running) return 'Нужен ввод мыши и клавиатуры (вкладка «GSI и OBS»): сейчас он не работает';
    if (req === 'spin' && !av.spin) return 'Неизвестна чувствительность мыши: укажите её в настройках';
    return null;
  }

  /** Шаблоны с учётом того, что умеет присылать игра и работает ли ввод мыши. */
  availableTemplates({ situational = false } = {}) {
    const side = this.tracker.match?.team;
    const ok = this.templates.map((t) => {
      const type = getType(t.type);
      return type?.opposite && (side === 'CT' || side === 'T') && side !== type.side ? { ...t, type: type.opposite } : t;
    }).filter((t) => !RETIRED_TYPES.includes(t.type) && !this.inputBlock(t.type, t.params));
    const pool = situationalTemplates(ok, this.ctx(), !!this.config.tasks.situational);
    return situational ? pool : pool.filter((t) => t.type !== 'pistol_round_kills');
  }

  addWarning(msg, code = null) {
    this.log.warn(msg);
    const file = this.dumpRawBuffer(code || 'warning');
    if (file) this.log.warn(`Последние пакеты GSI сохранены для диагностики: ${file}`);
    this.warnings = this.warnings.filter((w) => !code || w.code !== code);
    this.warnings.push({ code, message: msg, file, at: this.now() });
    this.changed();
  }

  /** Сохраняет последние сырые пакеты GSI в data/gsi-sample-*.jsonl. Возвращает путь или null. */
  dumpRawBuffer(tag = 'manual') {
    if (!this.dataDir || !this.rawBuffer.length) return null;
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(this.dataDir, `gsi-sample-${stamp}-${tag}.jsonl`);
    try {
      fs.writeFileSync(file, this.rawBuffer.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
      return file;
    } catch (e) {
      this.log.warn('Не удалось сохранить пакеты GSI:', e.message);
      return null;
    }
  }

  appendHistory(task) {
    if (!this.historySaver) return;
    if (!this.historyBuffer) {
      try { this.historyBuffer = readJson(this.historyFile, []); } catch { this.historyBuffer = []; }
      if (!Array.isArray(this.historyBuffer)) this.historyBuffer = [];
    }
    this.historyBuffer.unshift(task);
    if (this.historyBuffer.length > HISTORY_FILE_LIMIT) this.historyBuffer.length = HISTORY_FILE_LIMIT;
    this.historySaver.schedule();
  }

  saveNow() {
    this.stateSaver?.now();
    if (this.historyBuffer) this.historySaver?.now();
  }

  /** При запуске программы сразу показываем полный набор заданий. */
  ensureInitialTasks() {
    const mode = this.config.tasks.mode;
    if (this.bingoActive || mode === 'bingo' || mode === 'bingo5' || !this.tasks.cfg.count) return;
    const created = this.tasks.topUp();
    if (created.length) this.log.info(`Сгенерировано заданий при запуске: ${created.length}`);
  }

  // ---------- Действия панели ----------

  startNewMatch() {
    const events = this.tracker.startManual(this.now());
    this.reports.observe(events, this.tracker.match);
    this.bonuses.reset();
    this.syncLowHealth();
    this.log.info('Новый матч начат вручную');
    this.handleChallenges(events);
    this.changed();
  }

  approveSuggestion(id) {
    this.requireClassic();
    const item = this.suggestions.take(id);
    if (!item) throw new TaskError('Предложение не найдено');
    let task;
    try {
      task = this.tasks.add({ type: item.type, params: item.params, source: 'viewer', author: item.displayName });
    } catch (e) {
      this.suggestions.putBack(item);
      throw e;
    }
    this.chat?.say(this.config.language === 'en' ? `@${item.displayName}, your challenge "${localizeTask(task, 'en').title}" ${task.status === 'reserve' ? 'was approved and is in reserve' : 'was approved!'}` : `@${item.displayName}, твоё задание «${task.title}» ${task.status === 'reserve' ? 'одобрено и ждёт в резерве' : 'одобрено!'}`);
    this.changed();
    return task;
  }

  rejectSuggestion(id) {
    const item = this.suggestions.take(id);
    if (!item) throw new TaskError('Предложение не найдено');
    this.changed();
    return item;
  }

  playTestSound(sound) {
    this.send({ type: 'event', event: 'test_sound', sound: sound === 'complete' ? 'complete' : 'skip' });
  }

  /** Фейковые задания, чтобы прогнать анимации и звуки в оверлее. */
  runOverlayTest() {
    const a = this.tasks.add({ type: 'manual', params: { text: 'Тест: выполнить задание', count: 3 }, source: 'streamer', test: true }, { allowReserve: false });
    const b = this.tasks.add({ type: 'manual', params: { text: 'Тест: пропустить задание', count: 5 }, source: 'viewer', author: 'зритель', test: true }, { allowReserve: false });
    const step = (ms, fn) => setTimeout(() => { try { fn(); } catch { /* задание удалили вручную */ } }, ms);
    step(1200, () => this.tasks.adjustProgress(a.id, 1));
    step(2400, () => this.tasks.adjustProgress(b.id, 2));
    step(3600, () => this.tasks.adjustProgress(a.id, 1));
    step(4800, () => this.tasks.adjustProgress(a.id, 1));
    step(7000, () => this.tasks.skip(b.id));
    step(7000 + (this.config.overlay.showCompletedFor + 2) * 1000, () => {
      this.tasks.tasks = this.tasks.tasks.filter((t) => !t.test);
      this.changed();
    });
  }

  // ---------- Настройки и шаблоны ----------

  async updateConfig(patch) {
    const prev = this.config;
    const next = applyConfigPatch(prev, patch);
    this.bonuses.flush();
    this.bonuses.configChanged(prev.bonuses, next.bonuses);
    if (JSON.stringify(prev.obs) !== JSON.stringify(next.obs)) await this.lowHealthFilter.close();
    this.config = next;
    if (JSON.stringify(prev.obs) !== JSON.stringify(next.obs)) this.obs.restart();
    if (this.input) {
      if (prev.input?.enabled !== next.input?.enabled) {
        await this.input.stop();
        await this.input.start();
      } else {
        this.input.applySettings?.();
      }
    }
    if (this.configFile) writeJsonAtomic(this.configFile, next);
    this.syncLowHealth();
    setLogLevel(next.debug.logLevel);
    const chatKeys = ['channel', 'oauthToken', 'botUsername'];
    const wasChatEnabled = prev.twitch.enabled || prev.twitch.taskVoting;
    const isChatEnabled = next.twitch.enabled || next.twitch.taskVoting;
    if (wasChatEnabled !== isChatEnabled || chatKeys.some((k) => prev.twitch[k] !== next.twitch[k])) {
      await this.restartChat();
    }
    this.tasks.promoteReserve();
    this.changed();
    return { config: next, restartRequired: prev.port !== next.port, overlayLanRestartRequired: prev.overlayLanAddress !== next.overlayLanAddress };
  }

  setTemplates(raw) {
    const res = validateTemplates(raw);
    if (res.errors.length) {
      const e = new TaskError('Шаблоны не сохранены');
      e.details = res.errors;
      throw e;
    }
    if (!res.templates.length) throw new TaskError('Нужен хотя бы один включённый шаблон');
    this.templatesRaw = raw;
    this.templates = res.templates;
    this.templateErrors = [];
    if (this.dataDir) saveTemplates(this.dataDir, raw);
    this.changed();
    return res.templates;
  }

  // ---------- Чат ----------

  async restartChat() {
    if (this.chat) {
      await this.chat.disconnect();
      this.chat = null;
    }
    const t = this.config.twitch;
    const enabled = t.enabled || t.taskVoting;
    this.chatStatus = { enabled, connected: false, channel: t.channel, canSay: false, error: null };
    if (!enabled || !t.channel.trim()) { this.changed(); return; }
    const provider = this.chatProviderFactory({
      channel: t.channel,
      oauthToken: t.oauthToken,
      botUsername: t.botUsername,
      log: this.log,
      onStatus: (s) => { this.chatStatus = { enabled: true, ...s }; this.changed(); },
    });
    provider.onMessage((msg) => {
      if (this.config.twitch.taskVoting && this.taskVote.vote(msg)) return;
      if (this.config.twitch.enabled) this.handleChat(msg);
    });
    this.chat = provider;
    this.changed();
    try {
      await provider.connect();
    } catch (e) {
      this.log.warn(`Не удалось подключиться к чату Twitch: ${e.message}`);
    }
  }

  async shutdown() {
    await this.lowHealthFilter.close();
    this.obs.stop();
    this.bonuses.stop();
    if (this.chat) await this.chat.disconnect().catch(() => {});
    if (this.input) await this.input.stop().catch(() => {});
    this.saveNow();
  }
}

function readStateSafe(file, log) {
  try {
    const s = readJson(file, {});
    return s && typeof s === 'object' ? s : {};
  } catch (e) {
    log.warn(`${e.message}. Начинаю с чистого состояния (старый файл переименован в state.broken.json).`);
    try { fs.renameSync(file, file.replace(/state\.json$/, 'state.broken.json')); } catch { /* ignore */ }
    return {};
  }
}
