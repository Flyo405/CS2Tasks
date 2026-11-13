// Настоящие пакеты CS2 (обезличены): раунд на de_mirage, 2 убийства с P250 в голову, победа T.
// В CS2 в player.state нет round_totaldmg — урон игрок не получает вообще.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Core } from '../src/core.js';
import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { validateTemplates } from '../src/tasks/templates.js';
import { readJson } from '../src/store.js';
import { DEFAULT_TEMPLATES } from '../src/paths.js';
import { mulberry32 } from '../src/tasks/generator.js';
import { normalize } from '../src/gsi/normalize.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const rows = fs.readFileSync(path.join(dir, 'fixtures', 'cs2-real-round-no-damage.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const templates = { raw: [], ...validateTemplates(readJson(DEFAULT_TEMPLATES, [])) };
const makeCore = () => new Core({
  config: deepMerge(structuredClone(DEFAULT_CONFIG), { gsiToken: 't' }),
  templates,
  log: quietLog,
  rng: mulberry32(3),
});

describe('настоящие пакеты CS2', () => {
  it('в player.state нет round_totaldmg', () => {
    for (const { p } of rows) expect(p.player.state).not.toHaveProperty('round_totaldmg');
    expect(normalize(rows[0].p).player.hasRoundDmg).toBe(false);
  });

  it('убийства, хедшоты, оружие и конец раунда считаются', () => {
    const core = makeCore();
    const events = [];
    for (const { t, p } of rows) events.push(...core.ingest(p, t));
    const kills = events.filter((e) => e.type === 'kill');
    expect(kills.reduce((s, e) => s + e.count, 0)).toBe(2);
    expect(kills.reduce((s, e) => s + e.headshots, 0)).toBe(2);
    expect(kills.every((e) => e.weapon.name === 'weapon_p250' && e.weapon.type === 'Pistol')).toBe(true);
    const end = events.find((e) => e.type === 'round_end');
    expect(end).toMatchObject({ won: true, survived: true, roundKills: 2, team: 'T' });
    const fin = events.find((e) => e.type === 'round_final');
    expect(fin).toMatchObject({ roundKills: 2, roundDamage: 0 });
    expect(core.getState().warnings).toEqual([]);
  });

  it('удалённые задания на урон не выпадают', () => {
    const core = makeCore();
    expect(core.getState()).not.toHaveProperty('damageSupport');
    for (let seed = 1; seed <= 40; seed++) {
      core.tasks.rng = mulberry32(seed);
      core.tasks.tasks = [];
      core.ensureInitialTasks();
      expect(core.tasks.active().some((t) => t.type.startsWith('damage'))).toBe(false);
    }
  });

  it('удалённые задания недоступны зрителям и в панели', () => {
    const core = makeCore();
    const said = [];
    core.chat = { say: (s) => said.push(s) };
    core.handleChat({ user: 'v', displayName: 'V', text: '!task dmg 1500', roles: new Set(['everyone']) });
    expect(core.suggestions.queue).toHaveLength(0);
    expect(said.at(-1)).toMatch(/unknown code/);
    for (const { t, p } of rows) core.ingest(p, t);
    expect(() => core.tasks.add({ type: 'damage_total', params: { amount: 1000 } })).toThrow(/Неизвестный тип/);
  });
});
