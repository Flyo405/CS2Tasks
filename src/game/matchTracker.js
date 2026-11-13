// Состояние текущего матча: детект нового матча и конца, подключение, статистика.
import { diff, emptyRound, reduceRound, roundFinal } from './events.js';

const ZERO_STATS = { kills: 0, assists: 0, deaths: 0, mvps: 0, score: 0 };
const ACTIVE_STATUSES = new Set(['warmup', 'live', 'pending']);

function pickStats(p) {
  return { kills: p.kills, assists: p.assists, deaths: p.deaths, mvps: p.mvps, score: p.score };
}

export function scoresFor(team, scoreCT, scoreT) {
  if (team === 'CT') return { my: scoreCT, enemy: scoreT };
  if (team === 'T') return { my: scoreT, enemy: scoreCT };
  return { my: null, enemy: null };
}

export class MatchTracker {
  /**
   * @param {object} opts
   * @param {() => object} opts.getConfig
   * @param {object} [opts.initial] — сохранённое состояние из state.json
   */
  constructor({ getConfig, initial = null }) {
    this.getConfig = getConfig;
    this.match = initial?.match ?? null;
    this.lastSnapshot = initial?.lastSnapshot ?? null;
    this.lastSelf = initial?.lastSelf ?? null;
    this.round = { ...emptyRound(), ...(initial?.round || {}) };
    this.lastPacketAt = 0;
    this.connected = false;
    this.everConnected = false;
    this.ignoredMode = null;
  }

  serialize() {
    return { match: this.match, lastSnapshot: this.lastSnapshot, lastSelf: this.lastSelf, round: this.round };
  }

  get heartbeatMs() {
    // Учитываем старый cfg с интервалом 10 с, пока CS2 не перезапустили.
    return 10_000;
  }

  /** Пауза между пакетами, после которой не сравниваем снапшоты (приложение/игра были выключены). */
  get gapMs() {
    return this.heartbeatMs * 3;
  }

  modeAllowed(mode) {
    const allowed = this.getConfig().allowedModes || [];
    return !allowed.length || allowed.includes(mode);
  }

  isActive() {
    return !!this.match && ACTIVE_STATUSES.has(this.match.status);
  }

  newMatchReason(prev, snap) {
    const m = this.match;
    if (!m) return snap.mapPhase === 'gameover' ? null : 'first';
    if (m.status === 'pending') return null; // ручной матч ждёт игру — подхватим его
    if (m.status === 'ended') return snap.mapPhase === 'gameover' ? null : 'after_gameover';
    if (m.mapName !== snap.mapName) return 'map_changed';
    const ls = this.lastSelf;
    if (ls?.player && snap.isSelf && snap.player && ls.mapPhase !== 'warmup' && snap.mapPhase !== 'warmup') {
      const a = ls.player;
      const b = snap.player;
      // Смерти и ассисты в матче не уменьшаются; убийства могут уменьшиться на 1 из-за тимкилла.
      if (b.deaths < a.deaths || b.assists < a.assists || b.kills <= a.kills - 3) return 'stats_reset';
    }
    if (prev && !prev.hasMap && snap.mapPhase === 'warmup' && m.phase !== 'warmup') return 'rejoin_warmup';
    return null;
  }

  startMatch(snap, reason) {
    const prevMatch = this.match;
    const mapName = snap?.mapName ?? null;
    const ts = snap?.ts ?? Date.now();
    this.match = {
      matchId: `${ts}-${mapName || 'manual'}`,
      mapName,
      mode: snap?.mapMode ?? null,
      startedAt: ts,
      endedAt: null,
      team: snap?.isSelf && snap.player ? snap.player.team : null,
      status: !snap || !snap.hasMap || snap.mapPhase === 'gameover' ? 'pending' : snap.mapPhase === 'warmup' ? 'warmup' : 'live',
      phase: snap?.mapPhase ?? null,
      round: snap?.mapRound ?? null,
      roundPhase: snap?.roundPhase ?? null,
      scoreCT: snap?.scoreCT ?? 0,
      scoreT: snap?.scoreT ?? 0,
      roundsWon: 0,
      roundsPlayed: 0,
      stats: { ...ZERO_STATS },
      result: null,
      reason,
    };
    this.round = emptyRound(snap?.mapRound ?? null);
    this.lastSelf = null;
    return {
      type: 'match_start',
      matchId: this.match.matchId,
      mapName,
      mode: this.match.mode,
      reason,
      previousMatchId: prevMatch?.matchId ?? null,
    };
  }

  /** Ручной старт нового матча из панели. */
  startManual(now = Date.now()) {
    const s = this.lastSnapshot;
    const snap = s && s.hasMap ? { ...s, ts: now } : { ts: now, hasMap: false };
    return [this.startMatch(snap, 'manual')];
  }

  /** Обрабатывает нормализованный снапшот, возвращает события. */
  handle(snap) {
    const events = [];
    const prev = this.lastSnapshot;
    this.lastPacketAt = snap.ts;
    this.connected = true;
    this.everConnected = true;
    const resync = !prev || snap.ts - prev.ts > this.gapMs || snap.ts < prev.ts;

    if (!snap.hasMap) {
      // Главное меню. Матч не трогаем: возможно, это переподключение.
      this.lastSnapshot = snap;
      return events;
    }
    if (!this.modeAllowed(snap.mapMode)) {
      this.ignoredMode = snap.mapMode;
      this.lastSnapshot = snap;
      return events;
    }
    this.ignoredMode = null;

    const reason = this.newMatchReason(prev, snap);
    if (reason) events.push(this.startMatch(snap, reason));
    const m = this.match;
    if (!m) {
      this.lastSnapshot = snap;
      return events;
    }
    let adopted = false;
    if (m.status === 'pending') {
      if (snap.mapPhase === 'gameover') { this.lastSnapshot = snap; return events; }
      adopted = true;
      m.mapName = snap.mapName;
      m.mode = snap.mapMode;
      this.round = emptyRound();
      this.lastSelf = null;
    }

    const prevPhase = m.phase;
    m.phase = snap.mapPhase;
    m.round = snap.mapRound;
    m.roundPhase = snap.roundPhase;
    m.scoreCT = snap.scoreCT;
    m.scoreT = snap.scoreT;
    if (snap.isSelf && snap.player?.team) m.team = snap.player.team;

    if (m.status !== 'ended') {
      const fresh = !!reason || adopted || resync;
      const evs = diff(fresh ? null : prev, snap, { lastSelf: fresh ? null : this.lastSelf, round: this.round });
      for (const ev of evs) {
        this.round = reduceRound(this.round, ev);
        if (ev.type === 'round_end') {
          m.roundsPlayed += 1;
          if (ev.won) m.roundsWon += 1;
        }
        if (ev.type === 'self_state' || ev.type === 'self_flags') continue; // служебные, наружу не отдаём
        ev.matchId = m.matchId;
        events.push(ev);
      }
      if (snap.mapPhase === 'warmup') m.status = 'warmup';
      else if (snap.mapPhase !== 'gameover') m.status = 'live';
    }

    if (snap.isSelf && snap.player) {
      m.stats = snap.mapPhase === 'warmup' ? { ...ZERO_STATS } : pickStats(snap.player);
      this.lastSelf = snap;
    }

    if (snap.mapPhase === 'gameover' && prevPhase !== 'gameover' && m.status !== 'ended') {
      const { my, enemy } = scoresFor(m.team, m.scoreCT, m.scoreT);
      // Итог последнего раунда — до конца матча.
      const fin = roundFinal(this.round);
      if (fin) {
        this.round = reduceRound(this.round, fin);
        events.push({ ...fin, matchId: m.matchId });
      }
      m.status = 'ended';
      m.endedAt = snap.ts;
      m.result = my == null ? 'unknown' : my > enemy ? 'win' : my < enemy ? 'loss' : 'draw';
      events.push({
        type: 'match_end',
        matchId: m.matchId,
        result: m.result,
        myScore: my,
        enemyScore: enemy,
        team: m.team,
        stats: { ...m.stats },
      });
    }

    this.lastSnapshot = snap;
    return events;
  }

  /** Возвращает true, если статус подключения изменился. */
  checkConnection(now = Date.now()) {
    if (this.connected && now - this.lastPacketAt > this.heartbeatMs * 3) {
      this.connected = false;
      return true;
    }
    return false;
  }

  publicState() {
    const m = this.match;
    const s = this.lastSnapshot;
    const observing = s && s.player && !s.isSelf && s.hasMap ? s.player.name || s.playerSteamId : null;
    return {
      gsi: {
        connected: this.connected,
        everConnected: this.everConnected,
        lastPacketAt: this.lastPacketAt || null,
        ignoredMode: this.ignoredMode,
        inMenu: !!s && !s.hasMap,
        observing,
      },
      match: m ? { ...m, ...(() => { const sc = scoresFor(m.team, m.scoreCT, m.scoreT); return { myScore: sc.my, enemyScore: sc.enemy }; })() } : null,
      round: this.round,
    };
  }
}
