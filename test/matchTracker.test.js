import { describe, it, expect, beforeEach } from 'vitest';
import { MatchTracker } from '../src/game/matchTracker.js';
import { snap, resetClock, MATE } from './helpers.js';

const cfg = { allowedModes: [] };
const tracker = () => new MatchTracker({ getConfig: () => cfg });
const types = (evs) => evs.map((e) => e.type);

describe('MatchTracker', () => {
  beforeEach(() => resetClock());

  it('первый пакет с картой начинает матч, меню — нет', () => {
    const t = tracker();
    expect(t.handle(snap({ menu: true }))).toEqual([]);
    const evs = t.handle(snap({ phase: 'warmup' }));
    expect(types(evs)).toEqual(['match_start']);
    expect(t.match.status).toBe('warmup');
  });

  it('смена карты → новый матч', () => {
    const t = tracker();
    t.handle(snap({ map: 'de_mirage' }));
    const id = t.match.matchId;
    const evs = t.handle(snap({ map: 'de_inferno' }));
    expect(evs[0]).toMatchObject({ type: 'match_start', reason: 'map_changed', previousMatchId: id });
  });

  it('сброс статистики → новый матч', () => {
    const t = tracker();
    t.handle(snap({ kills: 10, deaths: 5, assists: 2 }));
    t.handle(snap({ kills: 10, deaths: 5, assists: 2 }));
    const evs = t.handle(snap({ kills: 0, deaths: 0, assists: 0 }));
    expect(evs[0]).toMatchObject({ type: 'match_start', reason: 'stats_reset' });
  });

  it('тимкилл (убийства −1) — не новый матч', () => {
    const t = tracker();
    t.handle(snap({ kills: 10, deaths: 5 }));
    expect(types(t.handle(snap({ kills: 9, deaths: 5 })))).not.toContain('match_start');
  });

  it('разминка → бой со сбросом статистики — тот же матч', () => {
    const t = tracker();
    t.handle(snap({ phase: 'warmup', kills: 5, deaths: 3 }));
    const id = t.match.matchId;
    const evs = t.handle(snap({ phase: 'live', roundPhase: 'freezetime', kills: 0, deaths: 0 }));
    expect(types(evs)).not.toContain('match_start');
    expect(t.match.matchId).toBe(id);
    expect(t.match.status).toBe('live');
  });

  it('gameover → warmup — новый матч', () => {
    const t = tracker();
    t.handle(snap({ ct: 13, t: 5, roundPhase: 'over' }));
    const end = t.handle(snap({ phase: 'gameover', ct: 13, t: 5, roundPhase: 'over' }));
    expect(end.at(-1)).toMatchObject({ type: 'match_end', result: 'win' });
    expect(t.handle(snap({ phase: 'gameover', ct: 13, t: 5 }))).toEqual([]); // повтор не дублирует
    t.handle(snap({ menu: true }));
    const evs = t.handle(snap({ phase: 'warmup' }));
    expect(evs[0]).toMatchObject({ type: 'match_start', reason: 'after_gameover' });
  });

  it('переподключение в тот же матч продолжает его (в том числе после перезапуска)', () => {
    const t = tracker();
    t.handle(snap({ kills: 4, deaths: 2, round: 6 }));
    t.handle(snap({ kills: 5, deaths: 2, round: 6 }));
    const id = t.match.matchId;
    const saved = JSON.parse(JSON.stringify(t.serialize()));
    const t2 = new MatchTracker({ getConfig: () => cfg, initial: saved });
    t2.handle(snap({ menu: true }, 60_000));
    const evs = t2.handle(snap({ kills: 7, deaths: 3, round: 9 }, 60_000));
    expect(types(evs)).not.toContain('match_start');
    expect(t2.match.matchId).toBe(id);
    expect(t2.match.stats.kills).toBe(7);
    // После долгой паузы снапшоты не сравниваются — 2 убийства «за время простоя» не считаются.
    expect(types(evs)).not.toContain('kill');
  });

  it('победа и поражение после смены сторон берутся по команде на момент gameover', () => {
    const t = tracker();
    t.handle(snap({ team: 'CT', ct: 5, t: 7 }));
    // После перерыва стример за T; его счёт теперь в team_t.
    t.handle(snap({ team: 'T', ct: 7, t: 5 }));
    t.handle(snap({ team: 'T', ct: 9, t: 13, roundPhase: 'over' }));
    const evs = t.handle(snap({ team: 'T', phase: 'gameover', ct: 9, t: 13, roundPhase: 'over' }));
    expect(evs.at(-1)).toMatchObject({ type: 'match_end', result: 'win', myScore: 13, enemyScore: 9 });
  });

  it('поражение, когда в момент gameover пакет о тиммейте', () => {
    const t = tracker();
    t.handle(snap({ team: 'CT', ct: 10, t: 12 }));
    t.handle(snap({ steamid: MATE, team: 'CT', ct: 10, t: 12 }));
    const evs = t.handle(snap({ steamid: MATE, team: 'CT', phase: 'gameover', ct: 10, t: 13 }));
    expect(evs.at(-1)).toMatchObject({ type: 'match_end', result: 'loss' });
  });

  it('урон за раунд приходит от игры с опозданием (после начала фазы over) — всё равно засчитывается', () => {
    const t = tracker();
    t.handle(snap({ roundPhase: 'freezetime', round: 0 }));
    t.handle(snap({ roundPhase: 'live', round: 0 }));
    t.handle(snap({ roundPhase: 'live', round: 0, roundKills: 2, kills: 2 })); // урон ещё 0
    const end = t.handle(snap({ roundPhase: 'over', winTeam: 'CT', round: 0, roundKills: 2, kills: 2 }));
    expect(end.find((e) => e.type === 'round_end')).toMatchObject({ roundKills: 2 });
    t.handle(snap({ roundPhase: 'over', winTeam: 'CT', round: 1, roundKills: 2, kills: 2, roundDmg: 187 })); // догнало
    const next = t.handle(snap({ roundPhase: 'freezetime', round: 1, kills: 2 }));
    expect(next.map((e) => e.type)).toEqual(['round_final', 'round_start']);
    expect(next[0]).toMatchObject({ roundDamage: 187, roundKills: 2, won: true });
    expect(next.some((e) => e.type === 'self_state')).toBe(false);
  });

  it('итог последнего раунда выдаётся перед match_end', () => {
    const t = tracker();
    t.handle(snap({ roundPhase: 'live', ct: 12, t: 3 }));
    t.handle(snap({ roundPhase: 'live', ct: 12, t: 3, roundDmg: 140, roundKills: 1, kills: 1 }));
    t.handle(snap({ roundPhase: 'over', winTeam: 'CT', ct: 13, t: 3, roundDmg: 140, roundKills: 1, kills: 1 }));
    const evs = t.handle(snap({ phase: 'gameover', roundPhase: 'over', winTeam: 'CT', ct: 13, t: 3, roundDmg: 140, roundKills: 1, kills: 1 }));
    expect(evs.map((e) => e.type)).toEqual(['round_final', 'match_end']);
    expect(evs[0].roundDamage).toBe(140);
  });

  it('не предупреждает об отсутствии урона', () => {
    const t = tracker();
    const warnings = [];
    t.onWarning = (m) => warnings.push(m);
    t.handle(snap({ roundPhase: 'live' }));
    t.handle(snap({ roundPhase: 'live', roundKills: 3, kills: 3 }));
    t.handle(snap({ roundPhase: 'over', winTeam: 'CT', roundKills: 3, kills: 3 }));
    t.handle(snap({ roundPhase: 'freezetime', kills: 3 }));
    expect(warnings).toHaveLength(0);
  });

  it('режим не из allowedModes игнорируется', () => {
    const t = new MatchTracker({ getConfig: () => ({ allowedModes: ['competitive'] }) });
    expect(t.handle(snap({ mode: 'casual' }))).toEqual([]);
    expect(t.match).toBeNull();
    expect(t.ignoredMode).toBe('casual');
  });

  it('ручной старт без игры подхватывается первым пакетом', () => {
    const t = tracker();
    const [ev] = t.startManual();
    expect(t.match.status).toBe('pending');
    const evs = t.handle(snap({ map: 'de_nuke', kills: 3 }));
    expect(types(evs)).not.toContain('match_start');
    expect(t.match.matchId).toBe(ev.matchId);
    expect(t.match.mapName).toBe('de_nuke');
  });

  it('пропажа пакетов → disconnected', () => {
    const t = tracker();
    const s = snap({});
    t.handle(s);
    expect(t.checkConnection(s.ts + 5000)).toBe(false);
    expect(t.checkConnection(s.ts + 31_000)).toBe(true);
    expect(t.connected).toBe(false);
  });
});
