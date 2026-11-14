import { it, expect, describe } from 'vitest';
import { Core } from '../src/core.js';
import { DEFAULT_CONFIG, applyConfigPatch } from '../src/config.js';
import { buildTask } from '../src/tasks/taskTypes.js';
import { PointsGame } from '../src/tasks/points.js';
import { mulberry32 } from '../src/tasks/generator.js';
import { raw } from './helpers.js';

const quiet = { info() {}, warn() {}, debug() {}, error() {} };

function setup(mode = 'points', patch = {}) {
  const config = applyConfigPatch(structuredClone(DEFAULT_CONFIG), { tasks: { mode, autoGenerateOnMatchStart: false, situational: false, ...patch } });
  return new Core({ config, log: quiet, rng: mulberry32(7), templates: { templates: [], errors: [] } });
}

/** Добавляет задание прямо в текущий матч. */
function put(core, type, params, extra = {}) {
  const t = buildTask(type, params, { matchId: core.tracker.match.matchId, source: 'random', ...extra });
  core.tasks.tasks.push(t);
  return t;
}

describe('PointsGame', () => {
  const cfg = { tasks: { points: { goal: 500, easy: 100, medium: 200, hard: 350, extra: 25 } } };
  it('цена по сложности, доп. задание — мало, без сложности — как среднее, тест — 0', () => {
    const p = new PointsGame({ getConfig: () => cfg });
    expect(p.valueOf({ difficulty: 'easy' })).toBe(100);
    expect(p.valueOf({ difficulty: 'hard' })).toBe(350);
    expect(p.valueOf({ difficulty: 'hard', situational: true })).toBe(25);
    expect(p.valueOf({ difficulty: null, source: 'viewer' })).toBe(200);
    expect(p.valueOf({ difficulty: 'hard', test: true })).toBe(0);
  });

  it('цель достигается один раз, очки копятся дальше; чужой матч не считается', () => {
    const p = new PointsGame({ getConfig: () => cfg, now: () => 1 });
    p.start('m1');
    const done = (difficulty, matchId = 'm1') => p.award({ id: Math.random(), title: 't', difficulty, matchId, status: 'completed' });
    expect(done('hard')).toMatchObject({ points: 350, score: 350, reached: false });
    expect(done('medium')).toMatchObject({ score: 550, goal: 500, reached: true });
    expect(done('easy')).toMatchObject({ score: 650, reached: false });
    expect(done('hard', 'm0')).toBeNull();
    expect(p.award({ difficulty: 'hard', matchId: 'm1', status: 'skipped' })).toBeNull();
  });
});

describe('режим «Очки» в программе', () => {
  it('выполненные задания дают очки по сложности, доп. задание — мало, пропуск отнимает половину цены', async () => {
    const core = setup('points', { points: { goal: 500 } });
    core.ingest(raw());
    expect(core.pointsActive).toBe(true);
    const events = [];
    core.subscribe((m) => { if (m.kind === 'task_points') events.push(m); });
    const hard = put(core, 'kills', { count: 1 }, { difficulty: 'hard' });
    const extra = put(core, 'headshots', { count: 1 }, { difficulty: 'hard', situational: true, situationalRound: 0 });
    const easy = put(core, 'assists', { count: 1 }, { difficulty: 'easy' });
    core.tasks.skip(easy.id);
    core.ingest(raw({ kills: 1, roundKills: 1, roundHs: 1 }));
    expect(core.tasks.get(hard.id).status).toBe('completed');
    expect(core.tasks.get(extra.id).status).toBe('completed');
    expect(core.points.score).toBe(-50 + 500 + 25);
    expect(events.map((e) => e.points).sort((a, b) => a - b)).toEqual([-50, 25, 500]);
    expect(core.points.reachedAt).toBeNull();
    const medium = put(core, 'mvps', { count: 1 }, { difficulty: 'medium' });
    core.tasks.complete(medium.id);
    expect(core.points.score).toBe(725);
    expect(core.points.reachedAt).not.toBeNull();
    expect(events.at(-1)).toMatchObject({ reached: true, score: 725, goal: 500 });
    const st = core.getState();
    expect(st.points).toMatchObject({ score: 725, goal: 500, skipPenalty: 50, values: { easy: 100, medium: 250, hard: 500, extra: 25 } });
    expect(st.tasks.find((t) => t.id === hard.id)).toMatchObject({ points: 500, penalty: 250 });
    await core.shutdown();
  });

  it('в режиме «Очки» задания генерируются как в обычном (набор при запуске и замена)', async () => {
    const core = setup('points', { count: 3, autoGenerateOnMatchStart: true });
    core.templates = (await import('../src/tasks/templates.js')).validateTemplates(
      JSON.parse((await import('node:fs')).readFileSync(new URL('../src/tasks/defaultTemplates.json', import.meta.url), 'utf8')),
    ).templates;
    core.ensureInitialTasks();
    expect(core.tasks.mainActive()).toHaveLength(3);
    core.ingest(raw());
    expect(core.getState().bingo).toBeNull();
    expect(core.tasks.mainActive()).toHaveLength(3);
    const first = core.tasks.mainActive()[0];
    core.tasks.complete(first.id);
    expect(core.tasks.mainActive()).toHaveLength(3); // замена
    expect(core.points.score).toBeGreaterThan(0);
    await core.shutdown();
  });

  it('режим включается со следующего матча и выключается обратно', async () => {
    const core = setup('classic');
    core.ingest(raw());
    expect(core.getState().points).toBeNull();
    await core.updateConfig({ tasks: { mode: 'points' } });
    expect(core.getState().points).toBeNull();
    core.startNewMatch();
    expect(core.getState().points).toMatchObject({ score: 0 });
    await core.updateConfig({ tasks: { mode: 'classic' } });
    core.startNewMatch();
    expect(core.getState().points).toBeNull();
    await core.shutdown();
  });

  it('очки переживают перезапуск и попадают в итоги матча', async () => {
    const core = setup('points', { points: { goal: 300 } });
    core.ingest(raw({ ct: 12, t: 3 }));
    const t = put(core, 'kills', { count: 1 }, { difficulty: 'hard' });
    core.tasks.complete(t.id);
    const saved = JSON.parse(JSON.stringify(core.serialize()));
    await core.shutdown();

    const core2 = setup('points', { points: { goal: 300 } });
    core2.tracker = new (core2.tracker.constructor)({ getConfig: () => core2.config, initial: saved.tracker });
    core2.points = new PointsGame({ initial: saved.points, getConfig: () => core2.config });
    core2.reports.current = saved.reportCurrent;
    expect(core2.pointsActive).toBe(true);
    expect(core2.points.score).toBe(500);
    core2.ingest(raw({ phase: 'gameover', ct: 13, t: 3, roundPhase: 'over' }));
    const report = core2.reports.history[0];
    expect(report.points).toEqual({ score: 500, goal: 300, reached: true });
    await core2.shutdown();
  });

  it('штраф за пропуск: процент от цены, счёт уходит в минус, достигнутая цель остаётся', async () => {
    const core = setup('points', { points: { goal: 300, skipPenalty: 50 } });
    core.ingest(raw());
    const skip = (difficulty, extra = {}) => core.tasks.skip(put(core, 'kills', { count: 5 }, { difficulty, ...extra }).id);
    skip('hard');
    expect(core.points.score).toBe(-250);
    skip('easy', { situational: true, situationalRound: 0 }); // доп. задание: 25 × 50% = 12.5 → 13
    expect(core.points.score).toBe(-263);
    const done = put(core, 'kills', { count: 5 }, { difficulty: 'hard' });
    core.tasks.complete(done.id);
    const done2 = put(core, 'kills', { count: 5 }, { difficulty: 'hard' });
    core.tasks.complete(done2.id);
    expect(core.points.score).toBe(737);
    expect(core.points.reachedAt).not.toBeNull();
    skip('hard');
    skip('hard');
    expect(core.points.score).toBe(237); // ниже цели, но «цель достигнута» не отбирается
    expect(core.getState().points.reachedAt).not.toBeNull();
    // «Удалить» — без штрафа, тестовые задания — без штрафа
    core.tasks.remove(put(core, 'kills', { count: 5 }, { difficulty: 'hard' }).id);
    core.tasks.skip(put(core, 'kills', { count: 5 }, { difficulty: 'hard', test: true }).id);
    expect(core.points.score).toBe(237);
    await core.shutdown();
  });

  it('штраф 0% — пропуск бесплатный; в обычном режиме очков нет вовсе', async () => {
    const free = setup('points', { points: { skipPenalty: 0 } });
    free.ingest(raw());
    free.tasks.skip(put(free, 'kills', { count: 5 }, { difficulty: 'hard' }).id);
    expect(free.points.score).toBe(0);
    await free.shutdown();
    const classic = setup('classic');
    classic.ingest(raw());
    classic.tasks.skip(put(classic, 'kills', { count: 5 }, { difficulty: 'hard' }).id);
    expect(classic.getState().points).toBeNull();
    await classic.shutdown();
  });

  it('настройки проверяются', () => {
    expect(() => applyConfigPatch(structuredClone(DEFAULT_CONFIG), { tasks: { points: { skipPenalty: 150 } } })).toThrow(/skipPenalty/);
    expect(() => applyConfigPatch(structuredClone(DEFAULT_CONFIG), { tasks: { points: { goal: 0 } } })).toThrow(/tasks.points.goal/);
    expect(() => applyConfigPatch(structuredClone(DEFAULT_CONFIG), { tasks: { mode: 'score' } })).toThrow(/tasks.mode/);
  });
});
