import { describe, it, expect } from 'vitest';
import { buildTask, normalizeParams, getType } from '../src/tasks/taskTypes.js';
import { diffPlayer, diff, emptyRound } from '../src/game/events.js';
import { snap, raw } from './helpers.js';
import { Core } from '../src/core.js';
import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';

function task(type, params) { return buildTask(type, normalizeParams(type, params)); }
function feed(t, ...events) {
  for (const e of events) {
    const n = getType(t.type).onEvent(t, e, {});
    if (n != null) t.progress = Math.min(n, t.target);
  }
  return t.progress;
}
const kill = (name = 'weapon_ak47', count = 1) => ({ type: 'kill', count, weapon: { name } });
const end = (extra = {}) => ({ type: 'round_end', won: true, survived: true, health: 100, ...extra });

describe('новые задания GSI', () => {
  it('настоящий путь пакетов: условия убийства, конец раунда и автоматическое выполнение', () => {
    const core = new Core({
      config: deepMerge(structuredClone(DEFAULT_CONFIG), { tasks: { count: 0, maxActive: 12, autoGenerateOnMatchStart: false } }),
      templates: { templates: [], errors: [] }, log: { info() {}, warn() {}, debug() {} },
    });
    let time = 100000;
    const send = (opts, state = {}) => {
      const p = raw(opts);
      Object.assign(p.player.state, state);
      core.ingest(p, time += 200);
    };
    send({ roundPhase: 'freezetime', equip: 1800 });
    const types = ['kill_streak', 'survival_streak', 'win_streak', 'full_hp_kill_rounds', 'smoked_kills', 'burning_kills', 'different_weapon_round', 'eco_round_wins'];
    const tasks = Object.fromEntries(types.map((type) => [type, core.tasks.add({ type, params: { count: type.includes('streak') ? 2 : type === 'different_weapon_round' ? 2 : 1, equip: 2000 } })]));
    send({ equip: 1800 });
    send({ equip: 1800, kills: 1, roundKills: 1 }, { smoked: 255, burning: 255 });
    const pistol = [{ name: 'weapon_p250', type: 'Pistol', state: 'active', clip: 13 }];
    send({ equip: 1800, kills: 1, roundKills: 1, weapons: pistol });
    send({ equip: 1800, kills: 2, roundKills: 2, weapons: [{ ...pistol[0], clip: 12 }] });
    send({ roundPhase: 'over', winTeam: 'CT', ct: 1, equip: 6000, kills: 2, roundKills: 2 });
    for (const type of ['kill_streak', 'full_hp_kill_rounds', 'smoked_kills', 'burning_kills', 'different_weapon_round', 'eco_round_wins']) {
      expect(core.tasks.get(tasks[type].id).status, type).toBe('completed');
    }
    expect(core.tasks.get(tasks.survival_streak.id).progress).toBe(1);
    expect(core.tasks.get(tasks.win_streak.id).progress).toBe(1);
    clearTimeout(core.broadcastTimer);
  });
  it('серия убийств продолжается между раундами, смерть или наблюдение сбрасывают', () => {
    const t = task('kill_streak', { count: 5 });
    expect(feed(t, kill(), end(), { type: 'round_start' }, kill('weapon_deagle', 2))).toBe(3);
    expect(feed(t, { type: 'death' }, kill())).toBe(1);
    expect(feed(t, { type: 'spectate' })).toBe(0);
  });
  it('серия выживания и командная победная серия имеют разные условия сброса', () => {
    const alive = task('survival_streak', { count: 3 });
    const wins = task('win_streak', { count: 3 });
    expect(feed(alive, end(), end({ won: false }))).toBe(2);
    expect(feed(wins, end(), end({ won: false }))).toBe(0);
    expect(feed(alive, { type: 'death' }, end({ survived: false }))).toBe(0);
    expect(feed(wins, { type: 'death' }, end({ survived: false }))).toBe(1);
  });
  it('100 HP: нужно собственное убийство после появления задания и выживание', () => {
    const t = task('full_hp_kill_rounds', { count: 3 });
    expect(feed(t, end({ roundKills: 4 }))).toBe(0);
    expect(feed(t, kill(), end({ health: 99 }))).toBe(0);
    expect(feed(t, kill(), end({ survived: false, health: 100 }))).toBe(0);
    expect(feed(t, kill(), end())).toBe(1);
    expect(feed(t, end())).toBe(1);
    expect(feed(t, kill(), { type: 'round_start' }, end())).toBe(1);
  });
  it('дым и огонь берутся из текущего собственного пакета с убийством', () => {
    const a = snap().player;
    const b = { ...a, kills: 2, roundKills: 2, smoked: 100, burning: 255 };
    const events = diffPlayer(a, b);
    expect(events[0]).toMatchObject({ type: 'kill', smoked: 100, burning: 255 });
    expect(feed(task('smoked_kills', { count: 3 }), ...events)).toBe(2);
    expect(feed(task('burning_kills', { count: 3 }), ...events)).toBe(2);
    expect(feed(task('smoked_kills', {}), kill())).toBe(0);
    expect(feed(task('burning_kills', {}), { ...kill(), burning: 0 })).toBe(0);
  });
  it('разное оружие: повторные убийства и неизвестное оружие не увеличивают счётчик', () => {
    let t = task('different_weapon_round', { count: 3 });
    expect(feed(t, kill(), kill(), kill('unknown', 3))).toBe(1);
    t = JSON.parse(JSON.stringify(t)); // состояние сохраняется при перезапуске
    expect(feed(t, kill('weapon_deagle'))).toBe(2);
    expect(feed(t, { type: 'round_start' }, kill('weapon_deagle'))).toBe(1);
    expect(feed(t, kill('weapon_awp'), kill())).toBe(3);
  });
  it('победа на эко: нужен известный бюджет после закупки, выживать не обязательно', () => {
    const t = task('eco_round_wins', { count: 3, equip: 2000 });
    expect(feed(t, end(), end({ roundEquipValue: 2001 }), end({ won: false, roundEquipValue: 0 }))).toBe(0);
    expect(feed(t, end({ survived: false, roundEquipValue: 2000 }))).toBe(1);
  });
  it('конец раунда передаёт здоровье и бюджет с начала боевой фазы', () => {
    const prev = snap({ equip: 1800 });
    const next = snap({ roundPhase: 'over', winTeam: 'CT', health: 100, equip: 6000 });
    const events = diff(prev, next, { lastSelf: prev, round: { ...emptyRound(0), equipValue: 1800 } });
    expect(events.find((e) => e.type === 'round_end')).toMatchObject({ health: 100, roundEquipValue: 1800, won: true });
  });
});
