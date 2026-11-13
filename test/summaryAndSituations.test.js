import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SITUATIONS, situationCandidates } from '../src/tasks/situational.js';
import { Core } from '../src/core.js';
import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { loadTemplates } from '../src/tasks/templates.js';
import { getType } from '../src/tasks/taskTypes.js';
import { raw } from './helpers.js';
const dirs = [], cores = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
afterEach(async () => { for (const c of cores.splice(0)) await c.shutdown(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function dir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-situation-')); dirs.push(d); return d; }
function make(dataDir = dir()) {
  const c = new Core({ config: deepMerge(structuredClone(DEFAULT_CONFIG), { tasks: { count: 3, maxActive: 3 } }), dataDir, templates: loadTemplates(dataDir), log: quiet });
  cores.push(c); return c;
}
const ctx = (player = {}) => ({ match: { round: 3 }, round: { round: 3, equipValue: 6000 }, player: { armor: 100, ...player } });

describe('расширенные ситуации', () => {
  it('12 вариантов; оружейные цели соответствуют имеющемуся оружию', () => {
    expect(SITUATIONS).toHaveLength(12);
    const c = make();
    const sniper = situationCandidates(c.templates, ctx({ weapons: [{ name: 'weapon_awp', type: 'SniperRifle' }] }));
    expect(sniper).toHaveLength(1);
    expect(sniper[0]).toMatchObject({ type: 'weapon_type_kills', params: { weaponType: 'SniperRifle', count: 1 } });
    const shotgun = situationCandidates(c.templates, ctx({ weapons: [{ name: 'weapon_nova', type: 'Shotgun' }] }));
    expect(shotgun[0].params.weaponType).toBe('Shotgun');
    expect(situationCandidates(c.templates, ctx()).every((t) => !['pistol_round_kills', 'eco_kills', 'eco_round_wins', 'unarmored_kills'].includes(t.type))).toBe(true);
  });
  it('без брони предлагает соответствующую цель, а неизвестная броня не означает её отсутствие', () => {
    const c = make();
    expect(situationCandidates(c.templates, ctx({ armor: 0 }))[0].type).toBe('unarmored_kills');
    const task = { progress: 0 };
    expect(getType('unarmored_kills').onEvent(task, { type: 'kill', count: 1 })).toBeUndefined();
    expect(getType('unarmored_kills').onEvent(task, { type: 'kill', count: 1, armorAtKill: 0 })).toBe(1);
  });
  it('обычный раунд также получает дополнительную цель, три основных не меняются', () => {
    const c = make(); c.ensureInitialTasks();
    const ids = c.tasks.mainActive().map((t) => t.id);
    c.ingest(raw({ round: 3, roundPhase: 'freezetime', equip: 6000 }), 100000);
    c.ingest(raw({ round: 3, equip: 6000 }), 100200);
    expect(c.tasks.active()).toHaveLength(4);
    expect(c.tasks.mainActive().map((t) => t.id)).toEqual(ids);
    const extra = c.tasks.active().find((t) => t.situational);
    expect(['headshots', 'assists', 'multikill_rounds', 'full_hp_kill_rounds', 'survive_rounds']).toContain(extra.type);
  });
});

describe('удаление заданий и проверки урона', () => {
  it('старые шаблоны удаляются без предупреждений; активная старая цель заменяется', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'templates.json'), JSON.stringify([
      { type: 'damage_rounds', difficulty: 'medium', weight: 1, params: { damage: 113, count: 4 } },
      { type: 'kills', difficulty: 'medium', weight: 1, params: { count: 8 } },
    ]));
    fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ tasks: { tasks: [{ id: 'old', type: 'damage_rounds',
      status: 'active', source: 'random', difficulty: 'medium', target: 4, progress: 0, params: { damage: 113, count: 4 } }] } }));
    const c = make(d);
    expect(c.templateErrors).toEqual([]);
    expect(c.tasks.get('old')).toMatchObject({ status: 'replaced', reason: 'retired' });
    expect(c.tasks.mainActive()[0].type).toBe('kills');
    expect(c.getState().warnings).toEqual([]);
    expect(c.getState()).not.toHaveProperty('damageSupport');
    expect(JSON.parse(fs.readFileSync(path.join(d, 'templates.json'), 'utf8')).map((t) => t.type)).toEqual(['kills']);
  });
});

it('конец раунда не выдаёт итог матча; событие появляется только на gameover', () => {
  const c = make(); const reports = [];
  c.subscribe((m) => { if (m.kind === 'match_report') reports.push(m.report); });
  c.ingest(raw({ roundPhase: 'freezetime' }), 100000);
  c.ingest(raw(), 100200);
  c.ingest(raw({ roundPhase: 'over', winTeam: 'CT', ct: 1 }), 100400);
  expect(reports).toHaveLength(0);
  c.ingest(raw({ phase: 'gameover', roundPhase: 'over', ct: 13, t: 7 }), 100600);
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ result: 'win', myScore: 13, enemyScore: 7 });
});
