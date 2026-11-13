// Итоги завершённых матчей и накопленные данные текущего матча.
export class MatchReports {
  constructor({ current = null, history = [], save = () => {} } = {}) {
    Object.assign(this, { current, history, save });
  }
  observe(events, match) {
    if (!match?.matchId) return;
    if (this.current?.matchId !== match.matchId && !this.history.some((r) => r.matchId === match.matchId)) {
      this.current = { matchId: match.matchId, mapName: match.mapName, startedAt: match.startedAt,
        observedKills: 0, headshots: 0, streak: 0, bestStreak: 0, bestRoundKills: 0,
        bonusPoints: 0, taskCounts: { completed: 0, skipped: 0, failed: 0 }, tasks: [], weapons: {},
        partial: (match.round ?? 0) > 0 };
    }
    const c = this.current;
    if (!c || c.matchId !== match.matchId) return;
    c.mapName = match.mapName;
    for (const e of events) {
      if (e.type === 'kill') {
        c.observedKills += e.count;
        c.headshots += e.headshots || 0;
        c.streak += e.count;
        c.bestStreak = Math.max(c.bestStreak, c.streak);
        c.bestRoundKills = Math.max(c.bestRoundKills, e.roundKillsAfter || e.count);
        const weapon = e.weapon?.name || 'unknown';
        c.weapons[weapon] = (c.weapons[weapon] || 0) + e.count;
      }
      if (e.type === 'death' || e.type === 'spectate') c.streak = 0;
      if (e.type === 'round_end') c.bestRoundKills = Math.max(c.bestRoundKills, e.roundKills || 0);
    }
  }
  taskFinished(t) {
    const c = this.current;
    if (t.test || !c || t.matchId !== c.matchId || !(t.status in c.taskCounts)) return;
    c.taskCounts[t.status]++;
    if (c.tasks.length < 200) c.tasks.push({ title: t.title, status: t.status });
  }
  addBonus(p) {
    if (this.current && p.matchId === this.current.matchId) this.current.bonusPoints += p.points;
  }
  finish(event, match) {
    const c = this.current;
    if (!c || c.matchId !== event.matchId || this.history.some((r) => r.matchId === event.matchId)) return null;
    const report = { ...structuredClone(c), endedAt: match.endedAt, result: event.result,
      myScore: event.myScore, enemyScore: event.enemyScore, stats: { ...event.stats },
      roundsPlayed: match.roundsPlayed, roundsWon: match.roundsWon };
    this.history.unshift(report);
    this.history = this.history.slice(0, 100);
    this.current = null;
    this.save(this.history);
    return report;
  }
}
