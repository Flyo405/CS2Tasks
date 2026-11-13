import { describe, it, expect } from 'vitest';
import { diff, diffPlayer, detectKillWeapon, emptyRound } from '../src/game/events.js';
import { snap, MATE } from './helpers.js';

const kinds = (evs) => evs.map((e) => e.type);

describe('events.diff', () => {
  it('убийство и хедшот', () => {
    const a = snap({});
    const b = snap({ roundKills: 1, roundHs: 1, kills: 1, roundDmg: 100, weapons: [{ name: 'weapon_ak47', type: 'Rifle', state: 'active', clip: 27 }] });
    const evs = diff(a, b, { lastSelf: a });
    const kill = evs.find((e) => e.type === 'kill');
    expect(kill).toMatchObject({ count: 1, headshots: 1, weapon: { name: 'weapon_ak47', type: 'Rifle' }, hpAtKill: 100 });
    expect(evs.find((e) => e.type === 'damage').amount).toBe(100);
  });

  it('сброс round_kills на новом раунде — не убийство', () => {
    const a = snap({ roundKills: 3, roundHs: 2, kills: 10, roundPhase: 'over', round: 4 });
    const b = snap({ roundKills: 0, roundHs: 0, kills: 10, roundPhase: 'freezetime', round: 5 });
    const evs = diff(a, b, { lastSelf: a });
    expect(kinds(evs)).toEqual(['round_start']);
  });

  it('пропущенный сброс раунда: убийства берутся из match_stats', () => {
    const a = snap({ roundKills: 2, kills: 5, round: 3 });
    const b = snap({ roundKills: 2, kills: 7, round: 4 });
    const kill = diff(a, b, { lastSelf: a }).find((e) => e.type === 'kill');
    expect(kill.count).toBe(2);
  });

  it('пакеты наблюдения за чужим игроком игнорируются', () => {
    const a = snap({});
    const spec = snap({ steamid: MATE, roundKills: 2, kills: 9, deaths: 3 });
    const evs = diff(a, spec, { lastSelf: a });
    expect(kinds(evs)).toEqual(['spectate']);
  });

  it('разминка игнорируется', () => {
    const a = snap({ phase: 'warmup' });
    const b = snap({ phase: 'warmup', roundKills: 1, kills: 1 });
    expect(diff(a, b, { lastSelf: a })).toEqual([]);
    // Первый боевой пакет после разминки — только база, без событий игрока.
    const c = snap({ phase: 'live', roundPhase: 'freezetime', kills: 0 });
    expect(kinds(diff(b, c, { lastSelf: b }))).toEqual(['round_start']);
  });

  it('оружие сменилось в момент убийства — берём то, у которого уменьшилась обойма', () => {
    const before = [{ name: 'weapon_awp', type: 'SniperRifle', state: 'active', clip: 5, slot: 'weapon_2' }, { name: 'weapon_knife', type: 'Knife', state: 'holstered', slot: 'weapon_0' }];
    const after = [{ name: 'weapon_awp', type: 'SniperRifle', state: 'holstered', clip: 4, slot: 'weapon_2' }, { name: 'weapon_knife', type: 'Knife', state: 'active', slot: 'weapon_0' }];
    expect(detectKillWeapon(before, after).name).toBe('weapon_awp');
  });

  it('оружие сменилось, обойма не менялась — берём активное в прошлом пакете', () => {
    const before = [{ name: 'weapon_knife_karambit', type: 'Knife', state: 'active', slot: 'weapon_0' }, { name: 'weapon_glock', type: 'Pistol', state: 'holstered', clip: 20, slot: 'weapon_1' }];
    const after = [{ name: 'weapon_knife_karambit', type: 'Knife', state: 'holstered', slot: 'weapon_0' }, { name: 'weapon_glock', type: 'Pistol', state: 'active', clip: 20, slot: 'weapon_1' }];
    expect(detectKillWeapon(before, after)).toEqual({ name: 'weapon_knife', type: 'Knife' });
  });

  it('конец раунда: победа, выживание, статистика раунда', () => {
    let round = emptyRound();
    const a = snap({ roundPhase: 'live' });
    const b = snap({ roundPhase: 'live', roundKills: 3, roundHs: 1, kills: 3, roundDmg: 300 });
    for (const e of diff(a, b, { lastSelf: a, round })) if (e.type === 'kill') round = { ...round, kills: round.kills + e.count, hs: round.hs + e.headshots };
    round.dmg = 300;
    const c = snap({ roundPhase: 'over', winTeam: 'CT', roundKills: 3, roundHs: 1, kills: 3, roundDmg: 300 });
    const end = diff(b, c, { lastSelf: b, round }).find((e) => e.type === 'round_end');
    expect(end).toMatchObject({ won: true, survived: true, roundKills: 3, roundDamage: 300, roundHs: 1 });
  });

  it('конец раунда после смерти стримера (наблюдает за тиммейтом)', () => {
    const a = snap({ health: 0, deaths: 1 });
    const spec = snap({ steamid: MATE, team: 'CT' });
    let round = emptyRound();
    for (const e of diff(a, spec, { lastSelf: a, round })) if (e.type === 'spectate') round = { ...round, died: true };
    const over = snap({ steamid: MATE, team: 'CT', roundPhase: 'over', winTeam: 'CT' });
    const end = diff(spec, over, { lastSelf: a, round }).find((e) => e.type === 'round_end');
    expect(end).toMatchObject({ won: true, survived: false });
  });

  it('смерть, ассист, MVP', () => {
    const a = snap({});
    const b = snap({ deaths: 1, assists: 2, mvps: 1, health: 0 });
    expect(kinds(diffPlayer(a.player, b.player))).toEqual(['assist', 'death', 'mvp']);
  });

  it('убийство вслепую и с малым HP', () => {
    const a = snap({ health: 20 });
    const b = snap({ health: 20, flashed: 200, roundKills: 1, kills: 1 });
    const kill = diffPlayer(a.player, b.player).find((e) => e.type === 'kill');
    expect(kill.flashed).toBe(200);
    expect(kill.hpAtKill).toBe(20);
  });
});
