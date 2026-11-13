import { it, expect } from 'vitest';
import { Core } from '../src/core.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildTask } from '../src/tasks/taskTypes.js';
import { mulberry32 } from '../src/tasks/generator.js';
import { raw } from './helpers.js';

function setup(mode = 'bingo') {
  const config = structuredClone(DEFAULT_CONFIG);
  config.tasks.mode = mode;
  const log = { info() {}, warn() {}, debug() {}, error() {} };
  return new Core({ config, log, rng: mulberry32(42), templates: { templates: [], errors: [] } });
}

it('fills all nine cells with distinct supported medium or hard tasks even without custom templates or input', async () => {
  const core = setup();
  core.ingest(raw());
  const { bingo, tasks } = core.getState();
  expect(tasks).toEqual([]);
  expect(bingo.cells).toHaveLength(9);
  expect(new Set(bingo.cells.map((cell) => cell.type)).size).toBe(9);
  expect(bingo.cells.every((cell) => ['medium', 'hard'].includes(cell.difficulty))).toBe(true);
  expect(bingo.cells.filter((cell) => cell.difficulty === 'hard').length).toBeGreaterThanOrEqual(3);
  expect(bingo.focus).toHaveLength(3);
  await core.shutdown();
});

it('one GSI kill can close several cells, and a completed line pays only once', async () => {
  const core = setup();
  core.ingest(raw());
  const matchId = core.bingo.matchId;
  const specs = [
    ['kills', { count: 1 }],
    ['headshots', { count: 1 }],
    ['weapon_kills', { count: 1, weapon: 'weapon_ak47' }],
  ];
  core.bingo.cells.splice(0, 3, ...specs.map(([type, params]) => buildTask(type, params, { matchId, source: 'bingo' })));
  core.ingest(raw({ kills: 1, roundKills: 1, roundHs: 1 }));
  expect(core.getState().bingo.claimed).toEqual([0]);
  expect(core.bonuses.total).toBe(450);
  core.ingest(raw({ kills: 1, roundKills: 1, roundHs: 1 }));
  expect(core.bonuses.total).toBe(450);
  expect(core.serialize().bingo.claimed).toEqual([0]);
  await core.shutdown();
});

it('changing the selected mode takes effect on the next match', async () => {
  const core = setup('classic');
  core.ingest(raw());
  await core.updateConfig({ tasks: { mode: 'bingo' } });
  expect(core.getState().bingo).toBeNull();
  core.startNewMatch();
  expect(core.getState().bingo.cells).toHaveLength(9);
  await core.updateConfig({ tasks: { mode: 'classic' } });
  expect(core.getState().bingo.cells).toHaveLength(9);
  core.startNewMatch();
  expect(core.getState().bingo).toBeNull();
  await core.shutdown();
});

it('5×5 fills 25 distinct goals and rewards its 12 lines only once', async () => {
  const core = setup('bingo5');
  core.ingest(raw());
  const { bingo } = core.getState();
  expect(bingo.size).toBe(5);
  expect(bingo.cells).toHaveLength(25);
  expect(new Set(bingo.cells.map((cell) => cell.title)).size).toBe(25);
  expect(bingo.cells.every((cell) => ['medium', 'hard'].includes(cell.difficulty))).toBe(true);
  expect(bingo.focus).toHaveLength(3);

  for (const index of [0, 6, 12, 18]) core.bingo.manager.complete(bingo.cells[index].id);
  core.bingo.handleEvents([], core.ctx());
  expect(core.getState().bingo.claimed).toEqual([]);
  core.bingo.manager.complete(bingo.cells[24].id);
  core.bingo.handleEvents([], core.ctx());
  expect(core.getState().bingo.claimed).toEqual([10]);
  expect(core.bonuses.total).toBe(300);
  for (const cell of core.bingo.cells.filter((cell) => cell.status === 'active')) core.bingo.manager.complete(cell.id);
  core.bingo.handleEvents([], core.ctx());
  core.bingo.handleEvents([], core.ctx());
  expect(core.serialize().bingo.claimed).toHaveLength(12);
  expect(core.bonuses.total).toBe(3600);
  await core.shutdown();
});
