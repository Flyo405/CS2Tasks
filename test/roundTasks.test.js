// Экономика, победа на последних секундах и ограничения на раунд.
import { describe, it, expect } from 'vitest';
import { diff, emptyRound, timeLeftAt, reduceRound } from '../src/game/events.js';
import { MatchTracker } from '../src/game/matchTracker.js';
import { buildTask, normalizeParams, getType, lastSecondsWin } from '../src/tasks/taskTypes.js';
import { Core } from '../src/core.js';
import { DEFAULT_CONFIG, applyConfigPatch } from '../src/config.js';
import { MotionDetector } from '../src/input/detector.js';
import { mulberry32 } from '../src/tasks/generator.js';
import { normalize } from '../src/gsi/normalize.js';
import { raw, snap, resetClock } from './helpers.js';

const quiet = { info() {}, warn() {}, debug() {}, error() {} };

/** Пакет с явным временем получения и бомбой. */
function at(ts, opts = {}, bomb) {
  const r = raw(opts);
  if (bomb) r.round.bomb = bomb;
  return normalize(r, ts);
}

function run(typeId, params, events, ctx = {}) {
  const task = buildTask(typeId, normalizeParams(typeId, params));
  const type = getType(typeId);
  for (const e of events) {
    const np = type.onEvent?.(task, e, ctx);
    if (np != null) task.progress = Math.min(np, task.target);
  }
  return task;
}

const end = (o = {}) => ({ type: 'round_end', won: true, team: 'T', roundKills: 1, timeLeft: 30, bomb: null, usedPrimary: true, reloaded: false, roundNumber: 5, ...o });

it('changes bomb challenges in place when the player changes sides', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.tasks.count = 0;
  const template = { type: 'defuse_survive', difficulty: 'hard', weight: 1, params: {} };
  const core = new Core({ config, log: quiet, templates: { templates: [template], errors: [] } });
  core.ingest(raw({ team: 'CT' }));
  const win = core.tasks.add({ type: 'defuse_survive' });
  const kills = core.tasks.add({ type: 'retake_kills', params: { count: 2 } });
  core.tasks.adjustProgress(kills.id, 1);
  core.ingest(raw({ team: 'T' }));
  expect(core.tasks.get(win.id).type).toBe('plant_survive');
  expect(core.tasks.get(kills.id)).toMatchObject({ type: 'post_plant_kills', target: 2, progress: 0 });
  expect(core.availableTemplates()[0].type).toBe('plant_survive');
  expect(core.blockedTypes().defuse_survive).toBeTruthy();
  expect(run('plant_survive', {}, [end({ survived: true, bomb: 'exploded' })]).progress).toBe(1);
  expect(run('plant_survive', {}, [end({ survived: true, bomb: null })]).progress).toBe(0);
  core.ingest(raw({ team: 'CT' }));
  expect(core.tasks.get(win.id).type).toBe('defuse_survive');
});

it('detects a team timeout and a primary weapon disappearing in freeze time', () => {
  const first = at(1000, { roundPhase: 'freezetime' });
  first.timeouts.CT = 1;
  const second = at(1500, { roundPhase: 'freezetime', weapons: [] });
  second.timeouts.CT = 0;
  const events = diff(first, second, { lastSelf: first });
  expect(events.map((e) => e.type)).toEqual(['team_timeout', 'primary_removed']);
  expect(run('team_timeout', {}, events).progress).toBe(1);
  const d = new MotionDetector();
  d.action('drop', 1200);
  expect(d.consumeDrop(1500)).toBe(true);
  expect(d.consumeDrop(1501)).toBe(false);
  expect(diff(second, second)).toEqual([]);
});

it('counts weapons by model across rounds and checks the killer’s team', () => {
  const kill = (name, team) => ({ type: 'kill', count: 1, weapon: { name }, team });
  expect(run('enemy_weapon_kills', {}, [kill('weapon_ak47', 'T'), kill('weapon_ak47', 'CT')]).progress).toBe(1);
  const kills = ['ak47', 'm4a1', 'glock', 'awp', 'p90', 'nova', 'mp9', 'knife'].map((name) => kill('weapon_' + name, 'T'));
  expect(run('match_arsenal', {}, [kills[0], ...kills.slice(0, 4), end(), ...kills.slice(4)]).progress).toBe(8);
});

it('tracks held keys across a round and requires uninterrupted focus', () => {
  const d = new MotionDetector();
  d.focus(true, 1000);
  d.key(16, true, 1100);
  d.key(87, true, 1200);
  expect(d.roundMovement(1500, 2000)).toEqual({ forwardOnly: true, walkOnly: true });
  d.key(16, false, 2100);
  d.key(65, true, 2200);
  d.key(65, false, 2300);
  expect(d.roundMovement(1500, 2400)).toEqual({ forwardOnly: false, walkOnly: false });
  d.focus(false, 2500);
  expect(d.roundMovement(1500, 2600)).toEqual({});
});

it('counts a held angle only with two quiet seconds and up to seven degrees of correction', () => {
  const d = new MotionDetector({ degPerCount: 1 });
  const gun = { type: 'Rifle' };
  d.focus(true, 1000);
  d.mouse(0, 3370, 7);
  d.action('attack', 3400);
  expect(d.classifyKill(3500, gun).heldAngle).toBe(true);
  d.mouse(0, 5970, 8);
  d.action('attack', 6000);
  expect(d.classifyKill(6100, gun).heldAngle).toBe(false);
});

it.each(['T', 'CT'])('распознаёт раннее убийство и сторону после закладки (%s)', (team) => {
  const freeze = at(1000, { roundPhase: 'freezetime', team });
  const live = at(2000, { team });
  const round = diff(freeze, live).reduce(reduceRound, emptyRound());
  const planted = at(17_000, { team }, 'planted');
  const killAt = (ts) => diff(planted, at(ts, { team, kills: 1, roundKills: 1 }, 'planted'), { lastSelf: planted, round });
  expect(run('early_round_kills', {}, killAt(22_000)).progress).toBe(1);
  expect(run('early_round_kills', {}, killAt(22_001)).progress).toBe(0);
  expect(run('post_plant_kills', {}, killAt(22_000)).progress).toBe(team === 'T' ? 1 : 0);
  expect(run('retake_kills', {}, killAt(22_000)).progress).toBe(team === 'CT' ? 1 : 0);
});

it('засчитывает сейв AWP и выживание при разминировании с разными условиями', () => {
  const weapons = [{ name: 'weapon_awp', type: 'SniperRifle', state: 'holstered' }];
  const freeze = at(1000, { roundPhase: 'freezetime', weapons });
  const live = at(2000, { weapons });
  const round = diff(freeze, live).reduce(reduceRound, emptyRound());
  const finish = (opts, bomb) => diff(live, at(9000, { roundPhase: 'over', weapons, ...opts }, bomb), { lastSelf: live, round });
  expect(run('save_primary', { weapon: 'weapon_awp' }, finish({ winTeam: 'T' })).progress).toBe(1);
  expect(run('save_primary', { weapon: 'weapon_awp' }, finish({ winTeam: 'T', weapons: [] })).progress).toBe(0);
  const startedWithPistol = { ...live, player: { ...live.player, weapons: [] } };
  expect(run('save_primary', { weapon: 'weapon_awp' }, diff(startedWithPistol,
    at(9000, { roundPhase: 'over', winTeam: 'T', weapons }), { lastSelf: startedWithPistol, round: emptyRound() })).progress).toBe(1);
  const noInventory = raw({ roundPhase: 'over', winTeam: 'T' });
  delete noInventory.player.weapons;
  expect(run('save_primary', {}, diff(live, normalize(noInventory, 9000), { lastSelf: live, round })).progress).toBe(1);
  expect(run('save_primary', {}, finish({ winTeam: 'T', health: 0 })).progress).toBe(0);
  expect(run('defuse_survive', {}, finish({ winTeam: 'CT' }, 'defused')).progress).toBe(1);
  expect(run('defuse_survive', {}, finish({ winTeam: 'CT', health: 0 }, 'defused')).progress).toBe(0);
});

it('фиксирует флик и клавиши на момент выстрела и не повторяет зачёт одного клика', () => {
  const d = new MotionDetector({ degPerCount: 1 });
  const gun = { type: 'Rifle' };
  d.mouse(45, 1000);
  d.key(17, true);
  d.action('attack', 1449);
  d.releaseAttack(1499);
  d.key(17, false);
  d.key(87, true);
  expect(d.classifyKill(1600, gun, { ammoSpent: 1 })).toMatchObject({
    flick: true, crouched: true, stationary: true, oneTap: true,
  });
  expect(d.classifyKill(1700, gun).oneTap).toBeUndefined();
  d.mouse(45, 1800);
  d.action('attack', 2250);
  d.releaseAttack(2300);
  expect(d.classifyKill(2350, gun, { ammoSpent: 2 })).toMatchObject({
    flick: false, crouched: false, stationary: false, oneTap: false,
  });
  d.action('attack', 2500);
  d.releaseAttack(2540);
  expect(d.classifyKill(2600, gun).oneTap).toBe(false);
});

it('сохраняет флик через повторный клик и задержку GSI, даже если пакет объединяет убийства', () => {
  const d = new MotionDetector({ degPerCount: 1 });
  const gun = { type: 'Rifle' };
  d.mouse(45, 1000);
  d.action('attack', 1100);
  d.action('attack', 1230);
  const result = d.classifyKill(1700, gun, { count: 2 });
  expect(result.flick).toBe(true);
  expect(run('flick_kills', { count: 2 }, [{ ...result, type: 'kill', count: 2 }]).progress).toBe(1);
  expect(d.classifyKill(1750, gun).flick).toBeUndefined();
  d.mouse(-45, 2000);
  d.action('attack', 2050);
  expect(d.classifyKill(3051, gun).flick).toBe(false);
});

it('засчитывает диагональный флик, даже если во время поворота был ранний клик', () => {
  const d = new MotionDetector({ degPerCount: 1 });
  const gun = { type: 'Rifle' };
  d.mouse(20, 1000, 20);
  d.action('attack', 1010);
  expect(d.lastAttackTurn.flick).toBe(false);
  d.mouse(12, 1070, 12);
  d.action('attack', 1080);
  expect(d.lastAttackTurn).toMatchObject({ degrees: 45, flick: true });
  expect(d.classifyKill(1300, gun).flick).toBe(true);
  d.action('attack', 1320);
  expect(d.classifyKill(1400, gun).flick).toBe(false);
});
describe('время раунда и бомба в событиях', () => {
  it('round_live даёт время старта, закладка — время бомбы, конец раунда — сколько осталось', () => {
    const t0 = 1_000_000;
    const tracker = new MatchTracker({ getConfig: () => ({ allowedModes: [] }) });
    tracker.handle(at(t0, { roundPhase: 'freezetime', round: 3 }));
    tracker.handle(at(t0 + 15_000, { roundPhase: 'live', round: 3 }));
    expect(tracker.round.liveAt).toBe(t0 + 15_000);
    // Игра шлёт пакет минимум раз в 10 с (heartbeat), без этого трекер считает связь прерванной.
    for (let s = 25_000; s < 60_000; s += 10_000) tracker.handle(at(t0 + s, { roundPhase: 'live', round: 3 }));
    const planted = tracker.handle(at(t0 + 60_000, { roundPhase: 'live', round: 3 }, 'planted'));
    expect(planted.map((e) => e.type)).toContain('bomb_planted');
    for (let s = 70_000; s < 95_000; s += 10_000) tracker.handle(at(t0 + s, { roundPhase: 'live', round: 3 }, 'planted'));
    const evs = tracker.handle(at(t0 + 95_000, { roundPhase: 'over', winTeam: 'CT', round: 4 }, 'defused'));
    expect(evs.map((e) => e.type)).toEqual(['bomb_defused', 'round_end']);
    const re = evs[1];
    expect(re).toMatchObject({ bomb: 'defused', won: true, roundNumber: 3, liveAt: t0 + 15_000 });
    expect(re.timeLeft).toBeCloseTo(5, 5); // 40 с бомбы − 35 с
  });

  it('без закладки время считается от конца фризтайма (1:55)', () => {
    const r = { ...emptyRound(), liveAt: 0 };
    expect(timeLeftAt(r, 110_000)).toBe(5);
    expect(timeLeftAt(emptyRound(), 1)).toBeNull();
  });

  it('основное оружие и перезарядка отмечаются в раунде, но не уходят наружу', () => {
    resetClock();
    const tracker = new MatchTracker({ getConfig: () => ({ allowedModes: [] }) });
    tracker.handle(snap({ roundPhase: 'freezetime' }));
    tracker.handle(snap({ roundPhase: 'live', weapons: [{ name: 'weapon_glock', type: 'Pistol', state: 'active', clip: 20 }] }));
    expect(tracker.round.usedPrimary).toBe(false);
    const evs = tracker.handle(snap({ roundPhase: 'live', weapons: [{ name: 'weapon_glock', type: 'Pistol', state: 'reloading', clip: 3 }] }));
    expect(evs.some((e) => e.type === 'self_flags')).toBe(false);
    expect(tracker.round.reloaded).toBe(true);
    tracker.handle(snap({ roundPhase: 'live', weapons: [{ name: 'weapon_ak47', type: 'Rifle', state: 'active', clip: 30 }] }));
    expect(tracker.round.usedPrimary).toBe(true);
    const out = tracker.handle(snap({ roundPhase: 'over', winTeam: 'CT' }));
    expect(out.find((e) => e.type === 'round_end')).toMatchObject({ usedPrimary: true, reloaded: true });
  });
});

describe('победа на последних секундах', () => {
  it('осталось ≤ X — да; больше — нет; взрыв и победа CT по времени — нет; разминирование на 2 с — да', () => {
    expect(lastSecondsWin(end({ timeLeft: 4 }), 5)).toBe(true);
    expect(lastSecondsWin(end({ timeLeft: 9 }), 5)).toBe(false);
    expect(lastSecondsWin(end({ timeLeft: 0.2, bomb: 'exploded' }), 5)).toBe(false);
    expect(lastSecondsWin(end({ team: 'CT', timeLeft: 0.1, bomb: null }), 5)).toBe(false);
    expect(lastSecondsWin(end({ team: 'CT', timeLeft: 2, bomb: 'defused' }), 5)).toBe(true);
    expect(lastSecondsWin(end({ team: 'CT', timeLeft: 3, bomb: null }), 5)).toBe(true); // добил последнего за 3 с до конца
    expect(lastSecondsWin(end({ won: false, timeLeft: 1 }), 5)).toBe(false);
    expect(lastSecondsWin(end({ timeLeft: null }), 5)).toBe(false);
    expect(run('last_seconds_wins', { seconds: 5, count: 2 }, [end({ timeLeft: 3 }), end({ timeLeft: 50 }), end({ timeLeft: 1 })]).progress).toBe(2);
    expect(run('last_seconds_wins', { count: 2 }, [end({ timeLeft: 20 }), end({ timeLeft: 20.1 })]).progress).toBe(1);
  });
});

describe('экономика', () => {
  it('полная закупка подряд: счётчик сбрасывается на неполной', () => {
    const live = (equipValue) => ({ type: 'round_live', equipValue });
    expect(run('full_buy_streak', { equip: 4500, count: 5 }, [live(5000), live(4700), live(1200), live(6000)]).progress).toBe(1);
    expect(run('full_buy_streak', { equip: 4500, count: 3 }, [live(5000), live(4700), live(4600)]).progress).toBe(3);
  });

  it('форс-бай: победа со снаряжением в диапазоне', () => {
    const evs = [end({ roundEquipValue: 3000 }), end({ roundEquipValue: 5200 }), end({ roundEquipValue: 2500, won: false }), end({ roundEquipValue: 1000 })];
    expect(run('force_buy_wins', { min: 2000, max: 3800, count: 5 }, evs).progress).toBe(1);
  });

  it('накопить деньги: по деньгам стримера в бою, разминка не считается, выполняется само', async () => {
    const config = applyConfigPatch(structuredClone(DEFAULT_CONFIG), { tasks: { autoGenerateOnMatchStart: false, situational: false } });
    const core = new Core({ config, log: quiet, rng: mulberry32(1), templates: { templates: [], errors: [] } });
    core.ingest(raw({ phase: 'warmup', money: 16000 }));
    const t = core.tasks.add({ type: 'money_saved', params: { money: 10000 } });
    expect(core.tasks.get(t.id).progress).toBe(0); // разминка
    core.ingest(raw({ money: 4200 }));
    expect(core.tasks.get(t.id)).toMatchObject({ progress: 4200, display: '$4200 / $10000', status: 'active' });
    core.ingest(raw({ money: 1500 })); // потратил — прогресс не падает
    expect(core.tasks.get(t.id).progress).toBe(4200);
    core.ingest(raw({ money: 10350 }));
    expect(core.tasks.get(t.id).status).toBe('completed');
    await core.shutdown();
  });
});

describe('ограничения на раунд', () => {
  it('без прыжков: победа с убийством и jumped === false; неизвестно (null) — не в счёт', () => {
    const evs = [end({ jumped: false }), end({ jumped: true }), end({ jumped: null }), end({ jumped: false, roundKills: 0 })];
    expect(run('no_jump_wins', { count: 5 }, evs).progress).toBe(1);
  });

  it('только нож и пистолет: не держал основное оружие, не пистолетный раунд', () => {
    const evs = [end({ usedPrimary: false }), end({ usedPrimary: true }), end({ usedPrimary: false, roundNumber: 0 }), end({ usedPrimary: false, roundNumber: 12 })];
    expect(run('pistol_only_wins', { count: 5 }, evs).progress).toBe(1);
  });

  it('без перезарядки: ни состояния reloading, ни клавиши', () => {
    const evs = [end({ reloaded: false, reloadKey: false }), end({ reloaded: true }), end({ reloaded: false, reloadKey: true })];
    expect(run('no_reload_wins', { count: 5 }, evs).progress).toBe(1);
  });

  it('прыжки и перезарядка с клавиатуры попадают в конец раунда только из времени раунда', async () => {
    const config = applyConfigPatch(structuredClone(DEFAULT_CONFIG), { tasks: { autoGenerateOnMatchStart: false, situational: false } });
    const d = new MotionDetector();
    const input = { detector: d, available: () => ({ running: true, spin: true }), classifyKill: () => ({}), onWeapon() {}, publicState: () => ({}), stop: async () => {} };
    let now = 2_000_000;
    const core = new Core({ config, log: quiet, rng: mulberry32(1), templates: { templates: [], errors: [] }, input, now: () => now });
    core.ingest(raw({ roundPhase: 'freezetime' }), (now += 100));
    d.action('jump', now + 50); // прыжок во фризтайм — не в счёт
    core.ingest(raw({ roundPhase: 'live' }), (now += 5000));
    const noJump = core.tasks.add({ type: 'no_jump_wins', params: { count: 1 } });
    const noReload = core.tasks.add({ type: 'no_reload_wins', params: { count: 1 } });
    core.ingest(raw({ roundPhase: 'live', roundKills: 1, kills: 1 }), (now += 3000));
    d.action('reload', now + 100);
    core.ingest(raw({ roundPhase: 'over', winTeam: 'CT', roundKills: 1, kills: 1 }), (now += 4000));
    expect(core.tasks.get(noJump.id).status).toBe('completed');
    expect(core.tasks.get(noReload.id).status).toBe('active');
    await core.shutdown();
  });
});

it('reduceRound не теряет старое снаряжение, если round_live без него', () => {
  const r = reduceRound({ ...emptyRound(), equipValue: 3000 }, { type: 'round_live', equipValue: null, at: 5 });
  expect(r).toMatchObject({ equipValue: 3000, liveAt: 5 });
});
