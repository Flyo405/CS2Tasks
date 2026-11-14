// Жизненный цикл заданий: active / reserve / completed / skipped / failed.
import { getType, normalizeParams, buildTask, TaskError, RETIRED_TYPES } from './taskTypes.js';
import { generate } from './generator.js';
import { situationCandidates } from './situational.js';
import { log as defaultLog } from '../log.js';

const HISTORY_LIMIT = 200;

export class TaskManager {
  /**
   * @param {object} o
   * @param {() => object} o.getConfig
   * @param {() => Array} o.getTemplates — валидные шаблоны
   * @param {() => object|null} o.getMatch — текущий матч трекера
   * @param {() => object} o.getCtx — контекст для типов заданий ({ match, round })
   * @param {(ev: object) => void} o.emit — события для оверлея (task_completed и т.д.)
   * @param {() => void} o.onChange
   * @param {(task: object) => void} o.onFinished — для history.json
   */
  constructor({ getConfig, getTemplates, checkType = () => null, getMatch, getCtx, emit = () => {}, onChange = () => {}, onFinished = () => {}, initial = {}, rng = Math.random, now = () => Date.now(), log = defaultLog }) {
    Object.assign(this, { getConfig, getTemplates, checkType, getMatch, getCtx, emit, onChange, onFinished, rng, now, log });
    this.tasks = Array.isArray(initial.tasks)
      ? initial.tasks.filter((task) => task.status !== 'reserve' || !RETIRED_TYPES.includes(task.type))
      : [];
    this.history = Array.isArray(initial.history) ? initial.history : [];
    for (const task of this.tasks) {
      if (task.status !== 'active' && task.status !== 'reserve') continue;
      if (task.type === 'headshots' && task.source !== 'streamer') {
        if (task.difficulty === 'easy' && task.target >= 4 && task.target <= 6) task.difficulty = 'medium';
        if (task.difficulty === 'medium' && task.target >= 8 && task.target <= 12) task.difficulty = 'hard';
      }
      if (task.difficulty === 'easy' && task.source === 'random'
        && ((task.type === 'kills' && task.target >= 10 && task.target <= 16)
          || (task.type === 'round_wins' && task.target >= 6 && task.target <= 9))) task.difficulty = 'medium';
      if (task.type === 'flick_kills') task.title = getType(task.type).title(task.params);
      if (task.type === 'last_seconds_wins' && task.params.seconds < 20) {
        task.params = { ...task.params, seconds: 20 };
        task.title = getType(task.type).title(task.params);
      }
      if (task.type !== 'positive_kd' || task.params.rounds != null) continue;
      const type = getType(task.type);
      const params = normalizeParams(task.type, task.params);
      Object.assign(task, { params, mode: type.mode, title: type.title(params), target: type.target(params),
        progress: 0, display: null, activeSince: this.now() });
    }
  }

  serialize() {
    return { tasks: this.tasks, history: this.history.slice(0, HISTORY_LIMIT) };
  }

  adaptToSide(side) {
    if (side !== 'CT' && side !== 'T') return;
    let changed = false;
    for (const task of this.tasks) {
      if (task.status !== 'active' && task.status !== 'reserve') continue;
      const type = getType(task.type);
      if (!type?.opposite || type.side === side) continue;
      const next = getType(type.opposite);
      Object.assign(task, { type: type.opposite, title: next.title(task.params), icon: next.icon,
        target: next.target(task.params), progress: 0, display: null });
      changed = true;
    }
    if (changed) this.onChange();
  }

  get cfg() {
    return this.getConfig().tasks;
  }

  get(id) {
    return this.tasks.find((t) => t.id === id) || null;
  }

  mustGet(id, status) {
    const t = this.get(id);
    if (!t) throw new TaskError('Задание не найдено');
    if (status && t.status !== status) throw new TaskError('Задание уже не активно');
    return t;
  }

  active() {
    return this.tasks.filter((t) => t.status === 'active');
  }

  mainActive() { return this.active().filter((t) => !t.situational && t.source !== 'vote'); }

  reserve() {
    return this.tasks.filter((t) => t.status === 'reserve');
  }

  currentMatchId() {
    const m = this.getMatch();
    return m && m.status !== 'ended' ? m.matchId : null;
  }

  /** Добавляет задание. spec: { type, params, source, author, difficulty, test }. */
  add(spec, { allowReserve = this.cfg.reserveWhenFull, index = null } = {}) {
    const type = getType(spec.type);
    if (!type) throw new TaskError(`Неизвестный тип задания: ${spec.type}`);
    const params = normalizeParams(spec.type, spec.params);
    const blocked = this.checkType(spec.type, params);
    if (blocked) throw new TaskError(blocked);
    let status = 'active';
    if (!spec.situational && spec.source !== 'vote' && this.mainActive().length >= this.cfg.maxActive) {
      if (!allowReserve) throw new TaskError(`Уже ${this.cfg.maxActive} активных заданий — это максимум (tasks.maxActive)`);
      status = 'reserve';
    }
    const task = buildTask(spec.type, params, {
      source: spec.source || 'streamer',
      author: spec.author || null,
      difficulty: spec.difficulty || null,
      status,
      matchId: status === 'active' ? this.currentMatchId() : null,
      createdAt: this.now(),
      ...(spec.test ? { test: true } : {}),
      ...(spec.situational ? { situational: true, situationalRound: spec.situationalRound, note: spec.note } : {}),
      ...(spec.replaces ? { replaces: spec.replaces } : {}),
    });
    if (status === 'active') this.applyLive(task, this.getCtx());
    if (index != null && index >= 0 && index <= this.tasks.length) this.tasks.splice(index, 0, task);
    else this.tasks.push(task);
    this.log.info(`Задание ${status === 'reserve' ? 'в резерв' : 'добавлено'}: ${task.title}${task.author ? ` (от ${task.author})` : ''}`);
    this.onChange();
    return task;
  }

  /** Генерирует n случайных заданий (без повторов типов с активными). */
  generate(n, { index = null } = {}) {
    if (n <= 0) return [];
    const room = this.cfg.maxActive - this.mainActive().length;
    const specs = generate({
      templates: this.getTemplates(),
      count: Math.min(n, room),
      difficultyMix: this.cfg.difficultyMix,
      rng: this.rng,
      excludeTypes: this.active().map((t) => t.type),
    });
    return specs.map((s, i) => this.add({ ...s, source: 'random' }, { allowReserve: false, index: index == null ? null : index + i }));
  }

  /** Дополнить активные до tasks.count без ошибок (при запуске и в начале матча). */
  topUp() {
    const n = this.cfg.count - this.mainActive().filter((t) => !t.test).length;
    return n > 0 ? this.generate(n) : [];
  }

  /** Одно дополнительное задание на раунд, отдельно от основного набора. */
  adaptToSituation() {
    if (!this.cfg.situational || !this.cfg.count) return;
    const ctx = this.getCtx();
    const m = ctx?.match;
    if (!m || m.phase !== 'live' || m.status !== 'live' || m.roundPhase !== 'live') return;
    const round = ctx.round?.round ?? m.round;
    const key = `${m.matchId}:${round}`;
    if (this.situationKey === key || this.active().some((t) => t.situational)) return;
    this.situationKey = key;
    const candidates = situationCandidates(this.getTemplates({ situational: true }), ctx);
    if (!candidates.length) return;
    const [spec] = generate({ templates: candidates, count: 1, rng: this.rng });
    if (!spec) return;
    if (spec.params.equip != null && ctx.round?.equipValue != null) spec.params.equip = Math.max(spec.params.equip, ctx.round.equipValue);
    if (spec.type === 'eco_round_wins') spec.params.count = 1;
    this.add({ ...spec, source: 'situation', situational: true, situationalRound: round,
      note: candidates.find((t) => t.id === spec.templateId)?.situation || 'На этот раунд' }, { allowReserve: false });
  }

  /** Нужна ли замена завершённому заданию, чтобы заданий всегда было tasks.count. */
  shouldReplace(task, status, reason) {
    if (task.test || task.situational || task.source === 'vote' || reason === 'match_changed') return false;
    if (reason === 'match_end') return !!this.cfg.autoGenerateOnMatchStart; // набор на следующий матч
    if (status === 'skipped') return !!this.cfg.replaceSkipped;
    return !!this.cfg.replaceCompleted; // выполнено или провалено по условию
  }

  /** Новое случайное задание на место старого (та же сложность, другой тип). */
  replaceTask(old) {
    if (this.mainActive().filter((t) => !t.test).length >= this.cfg.count) return null;
    if (this.mainActive().length >= this.cfg.maxActive) return null;
    const specs = generate({
      templates: this.getTemplates(),
      count: 1,
      difficultyMix: old.difficulty ? { [old.difficulty]: 1 } : this.cfg.difficultyMix,
      rng: this.rng,
      excludeTypes: [...this.active().map((t) => t.type), old.type],
    });
    if (!specs.length) return null;
    return this.add({ ...specs[0], source: 'random', replaces: old.id }, { allowReserve: false, index: this.tasks.indexOf(old) + 1 });
  }

  /** «Сгенерировать набор»: дополнить активные до tasks.count. */
  fill() {
    const n = this.cfg.count - this.mainActive().filter((t) => !t.test).length;
    if (n <= 0) throw new TaskError(`Уже есть ${this.cfg.count} или больше активных заданий`);
    const created = this.generate(n);
    if (!created.length) throw new TaskError('Не удалось подобрать задания: проверьте шаблоны');
    return created;
  }

  /** «Перегенерировать всё»: убрать случайные активные (без звука) и сгенерировать заново. */
  regenerateAll() {
    this.tasks = this.tasks.filter((t) => !(t.status === 'active' && t.source === 'random'));
    const n = this.cfg.count - this.mainActive().filter((t) => !t.test).length;
    const created = this.generate(Math.max(n, 0));
    this.onChange();
    return created;
  }

  regenerateOne(id) {
    const t = this.mustGet(id, 'active');
    const index = this.tasks.indexOf(t);
    this.tasks.splice(index, 1);
    const specs = generate({
      templates: this.getTemplates(),
      count: 1,
      difficultyMix: t.difficulty ? { [t.difficulty]: 1 } : this.cfg.difficultyMix,
      rng: this.rng,
      excludeTypes: [...this.active().map((x) => x.type), t.type],
    });
    if (!specs.length) {
      this.tasks.splice(index, 0, t);
      throw new TaskError('Нет подходящих шаблонов для замены');
    }
    return this.add({ ...specs[0], source: 'random' }, { allowReserve: false, index });
  }

  adjustProgress(id, delta) {
    const t = this.mustGet(id, 'active');
    if (t.mode === 'end') throw new TaskError('Прогресс этого задания считается автоматически');
    const d = Math.trunc(Number(delta));
    if (!Number.isFinite(d) || d === 0) throw new TaskError('Некорректное изменение прогресса');
    t.progress = Math.min(t.target, Math.max(0, t.progress + d));
    if (t.progress >= t.target) this.finish(t, 'completed', 'manual');
    else this.onChange();
    return t;
  }

  complete(id) {
    const t = this.mustGet(id, 'active');
    this.finish(t, 'completed', 'manual');
    return t;
  }

  skip(id) {
    const t = this.mustGet(id, 'active');
    this.finish(t, 'skipped', 'manual');
    return t;
  }

  /** Тихо заменяет активные случайные задания указанных типов (игра не даёт для них данных). */
  // Старое задание получает статус replaced: в оверлее это серая карточка «ЗАМЕНЕНО» с пояснением,
  // без звука, без записи в историю и без +1 к счётчику. Новое встаёт на его место.
  replaceTypes(types, reason = 'unsupported', note = null) {
    let n = 0;
    for (const t of this.active()) {
      if (!types.includes(t.type)) continue; // любой источник: невыполнимое задание не должно висеть
      t.status = 'replaced';
      t.finishedAt = this.now();
      t.reason = reason;
      t.note = note;
      this.log.info(`Заменено (${note || reason}): ${t.title}`);
      this.emit({ event: 'task_replaced', task: { ...t }, sound: null });
      try {
        this.replaceTask(t);
      } catch (e) {
        this.log.warn(`Не удалось подобрать замену для «${t.title}»:`, e.message);
      }
      n += 1;
    }
    if (n) this.onChange();
    return n;
  }

  /** Удалить без звука и без истории. */
  remove(id) {
    const t = this.mustGet(id);
    this.tasks = this.tasks.filter((x) => x !== t);
    this.promoteReserve();
    this.onChange();
    return t;
  }

  soundFor(status) {
    const s = this.getConfig().sounds;
    if (status === 'skipped') return 'skip';
    if (status === 'completed') return s.playOnComplete ? 'complete' : null;
    if (status === 'failed') return s.playOnFail ? 'skip' : null;
    return null;
  }

  finish(task, status, reason) {
    if (task.status !== 'active') return false;
    task.status = status;
    task.finishedAt = this.now();
    task.reason = reason;
    if (status === 'completed' && task.mode === 'counter') task.progress = task.target;
    if (!task.test) {
      this.history.unshift({ ...task });
      if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
      this.onFinished({ ...task });
    }
    const label = { completed: 'ВЫПОЛНЕНО', skipped: 'ПРОПУЩЕНО', failed: 'ПРОВАЛЕНО' }[status];
    this.log.info(`${label}: ${task.title}`);
    this.emit({ event: `task_${status}`, task: { ...task }, sound: this.soundFor(status) });
    this.promoteReserve(); // сначала одобренные задания зрителей из резерва
    if (this.shouldReplace(task, status, reason)) {
      try { this.replaceTask(task); } catch (e) { this.log.warn('Не удалось заменить задание:', e.message); }
    }
    this.onChange();
    return true;
  }

  promoteReserve() {
    let changed = false;
    while (this.mainActive().length < this.cfg.maxActive) {
      const r = this.reserve()[0];
      if (!r) break;
      r.status = 'active';
      r.matchId = this.currentMatchId();
      r.activeSince = this.now();
      this.applyLive(r, this.getCtx());
      this.log.info(`Из резерва: ${r.title}`);
      changed = true;
    }
    return changed;
  }

  applyLive(task, ctx) {
    const type = getType(task.type);
    // Задание, ждущее следующего матча, не показывает данные прошлого.
    if (!type?.live || !ctx || !task.matchId) return false;
    const r = type.live(task, ctx);
    if (!r) return false;
    let changed = false;
    if (r.progress != null && r.progress !== task.progress) { task.progress = r.progress; changed = true; }
    if (r.display !== undefined && r.display !== task.display) { task.display = r.display; changed = true; }
    return changed;
  }

  /** Обновляет «живые» значения и мгновенные провалы для текущего матча. */
  updateLive(ctx, matchId = this.currentMatchId()) {
    let changed = false;
    for (const t of this.active()) {
      if (!matchId || t.matchId !== matchId) continue;
      if (this.applyLive(t, ctx)) changed = true;
      const type = getType(t.type);
      // Счётчик, который растёт «вживую» (например, накопленные деньги), завершается сам.
      if (type.live && type.mode === 'counter' && t.progress >= t.target) {
        this.finish(t, 'completed', 'progress');
        changed = true;
        continue;
      }
      if (type.failNow?.(t, ctx)) {
        this.finish(t, 'failed', 'condition');
        changed = true;
      }
    }
    return changed;
  }

  onMatchStart(ev) {
    for (const t of this.active()) {
      if (t.matchId && t.matchId !== ev.matchId) this.finish(t, 'failed', 'match_changed');
    }
    // Завершённые задания прошлого матча уже в истории — убираем из текущего списка.
    this.tasks = this.tasks.filter((t) => t.status === 'active' || t.status === 'reserve');
    for (const t of this.active()) if (!t.matchId) t.matchId = ev.matchId;
    this.promoteReserve();
    if (this.cfg.autoGenerateOnMatchStart) this.topUp();
    this.onChange();
  }

  onMatchEnd(ev, ctx) {
    this.updateLive(ctx, ev.matchId);
    for (const t of this.active()) {
      if (t.matchId !== ev.matchId) continue;
      const type = getType(t.type);
      const result = type.onMatchEnd ? type.onMatchEnd(t, ctx, ev) : 'failed';
      this.finish(t, result === 'completed' ? 'completed' : 'failed', 'match_end');
    }
    this.onChange();
  }

  /** Главный вход: события от трекера матча. */
  handleEvents(events, ctx) {
    let changed = false;
    for (const ev of events) {
      if (ev.type === 'match_start') { this.onMatchStart(ev, ctx); changed = true; continue; }
      if (ev.type === 'match_end') { this.onMatchEnd(ev, ctx); changed = true; continue; }
      for (const t of this.active()) {
        if (!t.matchId || t.matchId !== ev.matchId) continue;
        const type = getType(t.type);
        if (!type?.onEvent) continue;
        if (t.situational && ev.type === 'round_start' && ev.round !== t.situationalRound) {
          this.finish(t, 'failed', 'round_end'); changed = true; continue;
        }
        const np = type.onEvent(t, ev, ctx);
        if (np != null && np !== t.progress) {
          t.progress = Math.min(np, t.target);
          changed = true;
          if (type.mode === 'counter' && t.progress >= t.target) this.finish(t, 'completed', 'progress');
        }
        if (t.status === 'active' && ev.type === 'round_end' && (type.roundScoped || t.situational)) {
          this.finish(t, 'failed', 'round_end'); changed = true;
        }
      }
    }
    if (this.updateLive(ctx)) changed = true;
    if (changed) this.onChange();
    return changed;
  }
}
