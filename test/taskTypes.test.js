import { describe, it, expect } from 'vitest';
import { TASK_TYPES, buildTask, normalizeParams, getType, plural } from '../src/tasks/taskTypes.js';
import { TaskManager } from '../src/tasks/taskManager.js';

/** Прогоняет события через onEvent одного задания (как это делает менеджер). */
function run(typeId, params, events, ctx = {}) {
  const task = buildTask(typeId, normalizeParams(typeId, params));
  const type = getType(typeId);
  for (const e of events) {
    const np = type.onEvent?.(task, e, ctx);
    if (np != null) task.progress = Math.min(np, task.target);
  }
  return task;
}

const kill = (o = {}) => ({ type: 'kill', count: 1, headshots: 0, weapon: { name: 'weapon_ak47', type: 'Rifle' }, hpAtKill: 100, flashed: 0, roundEquipValue: 5000, ...o });
const roundEnd = (o = {}) => ({ type: 'round_end', won: false, survived: false, roundKills: 0, roundDamage: 0, roundHs: 0, ...o });

describe('типы заданий', () => {
  it('у каждого типа есть заголовок и цель', () => {
    for (const [id, t] of Object.entries(TASK_TYPES)) {
      const p = normalizeParams(id, id === 'manual' ? { text: 'тест' } : {});
      expect(typeof t.title(p)).toBe('string');
      expect(t.target(p)).toBeGreaterThanOrEqual(0);
    }
  });

  it('kills / headshots', () => {
    expect(run('kills', { count: 5 }, [kill(), kill({ count: 2 })]).progress).toBe(3);
    expect(run('headshots', { count: 5 }, [kill({ headshots: 1 }), kill()]).progress).toBe(1);
  });

  it('weapon_kills: конкретное оружие, все ножи считаются ножом', () => {
    const evs = [kill(), kill({ weapon: { name: 'weapon_deagle', type: 'Pistol' } }), kill({ weapon: { name: 'weapon_knife', type: 'Knife' } })];
    expect(run('weapon_kills', { weapon: 'weapon_deagle', count: 3 }, evs).progress).toBe(1);
    expect(run('weapon_kills', { weapon: 'weapon_knife', count: 3 }, evs).progress).toBe(1);
  });

  it('weapon_type_kills', () => {
    const evs = [kill(), kill({ weapon: { name: 'weapon_p250', type: 'Pistol' } }), kill({ weapon: { name: 'weapon_glock', type: null } })];
    expect(run('weapon_type_kills', { weaponType: 'Pistol', count: 5 }, evs).progress).toBe(2);
  });

  it('multikill_rounds / ace', () => {
    const evs = [roundEnd({ roundKills: 3 }), roundEnd({ roundKills: 2 }), roundEnd({ roundKills: 5 })];
    expect(run('multikill_rounds', { kills: 3, count: 5 }, evs).progress).toBe(2);
    expect(run('ace', {}, evs).progress).toBe(1);
  });

  it('типы заданий на урон удалены', () => {
    expect(getType('damage_total')).toBeNull();
    expect(getType('damage_rounds')).toBeNull();
  });

  it('mvps / assists / survive_rounds / round_wins', () => {
    expect(run('mvps', { count: 3 }, [{ type: 'mvp', count: 1 }]).progress).toBe(1);
    expect(run('assists', { count: 3 }, [{ type: 'assist', count: 2 }]).progress).toBe(2);
    const ends = [roundEnd({ survived: true, won: true }), roundEnd({ won: true }), roundEnd({ survived: true })];
    expect(run('survive_rounds', { count: 5 }, ends).progress).toBe(2);
    expect(run('round_wins', { count: 5 }, ends).progress).toBe(2);
  });

  it('low_hp_kills / flashed_kills / eco_kills', () => {
    const evs = [kill({ hpAtKill: 25 }), kill({ hpAtKill: 31, flashed: 255 }), kill({ roundEquipValue: 1500 })];
    expect(run('low_hp_kills', { hp: 30, count: 5 }, evs).progress).toBe(1);
    expect(run('flashed_kills', { count: 5 }, evs).progress).toBe(1);
    expect(run('eco_kills', { equip: 2000, count: 5 }, evs).progress).toBe(1);
  });

  it('прогресс не превышает цель', () => {
    expect(run('kills', { count: 2 }, [kill({ count: 5 })]).progress).toBe(2);
  });

  it('параметры обрезаются по схеме, плохое оружие — ошибка', () => {
    expect(normalizeParams('kills', { count: 9999 }).count).toBe(100);
    expect(normalizeParams('weapon_kills', { weapon: 'awp' }).weapon).toBe('weapon_awp');
    expect(() => normalizeParams('weapon_kills', { weapon: 'weapon_bfg' })).toThrow();
    expect(() => normalizeParams('manual', { text: '   ' })).toThrow();
  });

  it('русские окончания', () => {
    expect([1, 2, 5, 11, 21, 22].map((n) => plural(n, 'убийство', 'убийства', 'убийств')))
      .toEqual(['убийство', 'убийства', 'убийств', 'убийств', 'убийство', 'убийства']);
  });
});

describe('задания с проверкой в конце матча (через TaskManager)', () => {
  function setup(ctx) {
    const match = { matchId: 'm1', status: 'live' };
    const emitted = [];
    const tm = new TaskManager({
      getConfig: () => ({ tasks: { count: 0, maxActive: 10, reserveWhenFull: true, replaceSkipped: false, autoGenerateOnMatchStart: false, difficultyMix: {} }, sounds: { playOnComplete: true, playOnFail: false } }),
      getTemplates: () => [],
      getMatch: () => match,
      getCtx: () => ctx,
      emit: (e) => emitted.push(e),
      log: { info() {}, warn() {}, debug() {} },
    });
    return { tm, match, emitted };
  }

  it.each(['win_match', 'max_deaths'])('retired challenge %s cannot be added', (type) => {
    const { tm } = setup({});
    expect(() => tm.add({ type })).toThrow();
  });

  it('positive_kd проверяет только полные раунды после активации', () => {
    const ctx = { match: { stats: { kills: 12, deaths: 10 } } };
    const { tm } = setup(ctx);
    const ok = tm.add({ type: 'positive_kd', params: { kd: 1.2 } });
    const bad = tm.add({ type: 'positive_kd', params: { kd: 1.5 } });
    const end = (liveAt, roundKills, died) => tm.handleEvents([roundEnd({ matchId: 'm1', liveAt, roundKills, died })], ctx);
    const start = Math.max(ok.createdAt, bad.createdAt);
    end(start - 1000, 5, false);
    expect(ok.progress).toBe(0);
    end(start, 1, true);
    end(start + 60_000, 1, true);
    expect(ok.display).toBe('K/D 1.00 / 1.20 · 2/3');
    expect(bad.status).toBe('active');
    end(start + 120_000, 2, true);
    expect(ok.status).toBe('completed');
    expect(bad.status).toBe('failed');
    expect(ok.display).toBe('K/D 1.33 / 1.20 · 3/3');
  });

  it('незавершённые счётчики на match_end', () => {
    const ctx = { match: { stats: { kills: 0, deaths: 0 }, myScore: 13, enemyScore: 7 } };
    const { tm, match } = setup(ctx);
    const kills = tm.add({ type: 'kills', params: { count: 30 } });
    match.status = 'ended';
    tm.handleEvents([{ type: 'match_end', matchId: 'm1', result: 'win' }], ctx);
    expect(kills.status).toBe('failed');
  });

  it('пропуск — звук skip; выполнение — звук complete; резерв поднимается', () => {
    const ctx = { match: { stats: { kills: 0, deaths: 0 } } };
    const { tm, emitted } = setup(ctx);
    tm.getConfig = () => ({ tasks: { count: 0, maxActive: 1, reserveWhenFull: true, replaceSkipped: false, difficultyMix: {} }, sounds: { playOnComplete: true, playOnFail: false } });
    const a = tm.add({ type: 'kills', params: { count: 1 } });
    const b = tm.add({ type: 'assists', params: { count: 1 }, source: 'viewer', author: 'nick' });
    expect(b.status).toBe('reserve');
    tm.skip(a.id);
    expect(emitted.at(-1)).toMatchObject({ event: 'task_skipped', sound: 'skip' });
    expect(b.status).toBe('active');
    expect(b.matchId).toBe('m1');
    tm.adjustProgress(b.id, 1);
    expect(b.status).toBe('completed');
    expect(emitted.at(-1)).toMatchObject({ event: 'task_completed', sound: 'complete' });
  });
});
