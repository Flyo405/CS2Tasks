// Перенос начисления очков и серий из предоставленного Kill Combo.lua.
// Получает только подтверждённые события нашего трекера; доступа к игре нет.
import { randomUUID } from 'node:crypto';
import { ScoreStyle } from './scoreStyle.js';
export class KillBonuses {
  constructor({ getConfig, emit = () => {}, now = () => Date.now() }) {
    Object.assign(this, { getConfig, emit, now });
    this.total = 0;
    this.combo = 0;
    this.lastKillAt = null;
    this.styleWindow = null;
    this.pending = [];
    this.lastPopup = null;
    this.timer = null;
    this.sequence = 0;
    this.sessionId = randomUUID();
    this.style = new ScoreStyle(() => this.cfg);
  }

  get cfg() { return this.getConfig().bonuses; }

  configChanged(previous, next) {
    if (previous.enabled !== next.enabled) { this.style.reset(); this.combo = 0; this.lastKillAt = null; this.styleWindow = null; }
    if (previous.risk.enabled !== next.risk.enabled) this.style.risk = 1;
    if (previous.diversity.enabled !== next.diversity.enabled) this.style.weapons.clear();
  }

  handle(events, at = this.now()) {
    for (const e of events) {
      if (e.type === 'match_start') this.reset();
      if (e.type === 'death' || e.type === 'spectate') {
        this.flush(); this.style.reset(); this.combo = 0; this.lastKillAt = null;
        this.styleWindow = null;
      }
      if (e.type === 'match_end') {
        this.flush();
        this.style.reset();
        this.combo = 0;
        this.lastKillAt = null;
        this.styleWindow = null;
      }
      if (e.type !== 'kill' || !this.cfg?.enabled || !(e.count > 0)) continue;
      // Пакеты, разнесённые дальше окна объединения, не сливаются при задержке таймера.
      if (this.pending.length && at - this.lastKillAt >= this.cfg.mergeMs) this.flush();
      if (this.lastKillAt == null || at - this.lastKillAt > this.cfg.comboWindowMs) this.combo = 0;
      this.pending.push(e);
      this.lastKillAt = at;
      this.styleWindow = { at, matchId: e.matchId, awarded: new Set() };
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), this.cfg.mergeMs);
      this.timer.unref?.();
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return null;
    const events = this.pending;
    this.pending = [];
    const c = this.cfg;
    if (!c?.enabled) return null;
    const parts = new Map();
    const add = (key, label, n) => {
      const points = (c.points[key] || 0) * n;
      if (points <= 0) return;
      const old = parts.get(key) || { key, label, points: 0, count: 0 };
      old.points += points;
      old.count += n;
      parts.set(key, old);
    };
    let kills = 0;
    let diversityBonus = 0, riskMultiplier = 1;
    const riskReasons = new Set();
    for (const e of events) {
      const style = this.style.kill(e);
      diversityBonus += style.diversityPoints;
      riskMultiplier = style.riskMultiplier;
      style.reasons.forEach((r) => riskReasons.add(r));
      kills += e.count;
      add('headshot', 'HS', Math.min(e.headshots || 0, e.count));
      if (e.jump) add('air', 'AIR', e.count);
      if (e.spin) add('spin', '360°', e.count);
      if (/knife|bayonet/.test(e.weapon?.name || '')) add('knife', 'KNIFE', e.count);
      if (e.smoked > 0) add('smoke', 'IN SMOKE', e.count);
      if (e.flashed > 0) add('blind', 'BLIND', e.count);
      if (e.noscope && e.weapon?.type === 'SniperRifle') add('noscope', 'NOSCOPE', e.count);
    }
    this.combo += kills;
    const multiplier = 1 + c.comboStep * (this.combo - 1);
    // Как в Lua: база начисляется один раз на объединённую группу убийств.
    const base = Math.floor(c.base * multiplier);
    let runningBonus = 0;
    let allocated = 0;
    const details = [...parts.values()].map((p) => {
      runningBonus += p.points * c.bonusMultiplier;
      const points = Math.floor(runningBonus) - allocated;
      allocated += points;
      return { ...p, points };
    });
    const standardBonus = Math.floor([...parts.values()].reduce((n, p) => n + p.points, 0) * c.bonusMultiplier);
    const riskBonus = Math.floor((base + standardBonus) * (riskMultiplier - 1) + 1e-8);
    if (riskBonus > 0) details.push({ key: 'risk', label: `RISK ×${riskMultiplier.toFixed(2)}`, points: riskBonus, count: 1 });
    if (diversityBonus > 0) details.push({ key: 'diversity', label: 'VARIETY', points: diversityBonus, count: 1 });
    const bonus = standardBonus + riskBonus + diversityBonus;
    const points = base + bonus;
    this.total += points;
    const labels = { 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'QUAD KILL', 5: 'PENTA KILL' };
    const popup = {
      id: `${this.sessionId}:${++this.sequence}`, at: this.now(), points, base, bonus, kills,
      combo: this.combo, multiplier, label: labels[this.combo] || (this.combo > 5 ? `${this.combo}x KILL` : ''),
      riskMultiplier, riskBonus, diversityBonus, standardBonus, riskReasons: [...riskReasons],
      parts: details, bonusCount: details.reduce((n, p) => n + p.count, 0), total: this.total,
      matchId: events[0]?.matchId ?? null,
    };
    this.lastPopup = popup;
    this.emit(popup);
    return popup;
  }

  awardBingo(lines, matchId) {
    if (!this.cfg.enabled) return;
    this.awardStandalone(lines * 300, lines === 1 ? 'BINGO' : `BINGO ×${lines}`, matchId);
  }

  awardStyle(kind, at) {
    const window = this.styleWindow;
    const label = { inspect: 'INSPECT', graffiti: 'GRAFFITI' }[kind];
    const points = this.cfg.points[kind];
    if (!this.cfg.enabled || !label || !points || !window || at < window.at
      || at - window.at > 2000 || window.awarded.has(kind)) return;
    window.awarded.add(kind);
    this.awardStandalone(points, label, window.matchId);
  }

  awardStandalone(points, label, matchId) {
    this.flush();
    this.total += points;
    const popup = {
      id: `${this.sessionId}:${++this.sequence}`, at: this.now(), points, base: points,
      bonus: 0, label, parts: [],
      bonusCount: 0, total: this.total, matchId,
    };
    this.lastPopup = popup;
    this.emit(popup);
  }

  reset() {
    this.stop();
    this.total = 0;
    this.combo = 0;
    this.lastKillAt = null;
    this.styleWindow = null;
    this.lastPopup = null;
    this.style.reset();
  }

  stop() { clearTimeout(this.timer); this.timer = null; this.pending = []; }
  state() { return { total: this.total, lastPopup: this.lastPopup, style: this.style.state() }; }
}
