import { it, expect, vi, afterEach } from 'vitest';
import { ScoreStyle } from '../src/bonuses/scoreStyle.js';
import { KillBonuses } from '../src/bonuses/killBonuses.js';
import { DEFAULT_CONFIG, deepMerge, validateConfig } from '../src/config.js';
import { Core } from '../src/core.js';
import { raw } from './helpers.js';

afterEach(() => vi.useRealTimers());
it('P90 awards SCORE for a confirmed kill, while shooting without a kill does not', async () => {
  const c = new Core({ config: deepMerge(structuredClone(DEFAULT_CONFIG), { tasks: { count: 0, situational: false } }),
    templates: { templates: [], errors: [] }, log: { info() {}, warn() {}, debug() {} } });
  const weapons = (clip) => [{ name: 'weapon_p90', type: 'Submachine Gun', clip }];
  const start = Date.now();
  c.ingest(raw({ weapons: weapons(50) }), start);
  c.ingest(raw({ weapons: weapons(40) }), start + 100);
  expect(c.bonuses.flush()).toBeNull();
  c.ingest(raw({ weapons: weapons(35), kills: 1, roundKills: 1 }), start + 200);
  expect(c.bonuses.flush()).toMatchObject({ points: 50, kills: 1 });
  await c.shutdown();
});
const kill = (extra = {}) => ({ type: 'kill', count: 1, headshots: 0, hpAtKill: 100,
  weapon: { name: 'weapon_ak47', type: 'Rifle' }, ...extra });
function setup(patch = {}) {
  vi.useFakeTimers();
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), { bonuses: patch });
  const b = new KillBonuses({ getConfig: () => config });
  return { b, config, score: (e) => { b.handle([kill(e)]); return b.flush(); } };
}
it('low HP raises risk, ordinary kills keep it, and death resets the multiplier without erasing SCORE', () => {
  const { b, score } = setup();
  expect(score({ hpAtKill: 20 })).toMatchObject({ points: 62, riskMultiplier: 1.25, riskBonus: 12 });
  expect(score({}).riskMultiplier).toBe(1.25);
  const total = b.total; b.handle([{ type: 'death' }]);
  expect(b.total).toBe(total); expect(b.state().style.riskMultiplier).toBe(1);
  expect(score({})).toMatchObject({ points: 50, combo: 1 });
});
it('knife, last bullet and combos qualify once per kill, even with several risky conditions', () => {
  const c = structuredClone(DEFAULT_CONFIG.bonuses), s = new ScoreStyle(() => c);
  expect(s.kill(kill({ lastBullet: true })).riskMultiplier).toBe(1.25);
  expect(s.kill(kill({ weapon: { name: 'weapon_knife' } })).riskMultiplier).toBe(1.5);
  expect(s.kill(kill({ jump: true, noscope: true, hpAtKill: 10, lastBullet: true,
    weapon: { name: 'weapon_awp', type: 'SniperRifle' } })).riskMultiplier).toBe(1.75);
  for (let i = 0; i < 20; i++) s.kill(kill({ hpAtKill: 1 }));
  expect(s.state().riskMultiplier).toBe(3);
});
it('variety rewards only new weapons in the current life, with a capped increasing bonus', () => {
  const { score, b } = setup({ risk: { enabled: false } });
  const reward = (name) => score({ weapon: { name } }).diversityBonus;
  expect(reward('weapon_ak47')).toBe(0);
  expect(reward('weapon_deagle')).toBe(50);
  expect(reward('weapon_ak47')).toBe(0);
  expect(reward('weapon_awp')).toBe(100);
  expect(reward('weapon_nova')).toBe(150);
  expect(reward('weapon_mp9')).toBe(200);
  expect(reward('weapon_m4a1')).toBe(200);
  expect(reward('unknown')).toBe(0);
  b.handle([{ type: 'death' }]); expect(reward('weapon_deagle')).toBe(0);
});
it('knife variants share a single variety entry; a multi-kill packet pays variety once', () => {
  const { score } = setup({ risk: { enabled: false } });
  score({}); expect(score({ weapon: { name: 'weapon_knife_butterfly' }, count: 3 }).diversityBonus).toBe(50);
  expect(score({ weapon: { name: 'weapon_bayonet' } }).diversityBonus).toBe(0);
});
it('360 + no-scope bonuses stack, risk applies first, variety is added afterward and breakdown adds up', () => {
  const { score } = setup(); score({});
  const p = score({ spin: true, noscope: true, weapon: { name: 'weapon_awp', type: 'SniperRifle' } });
  expect(p).toMatchObject({ base: 60, standardBonus: 900, riskMultiplier: 1.25, riskBonus: 240, diversityBonus: 50, points: 1250 });
  expect(p.base + p.parts.reduce((n, part) => n + part.points, 0)).toBe(p.points);
  expect(p.parts.map((part) => part.key)).toEqual(['spin', 'noscope', 'risk', 'diversity']);
});
it('flushing pending kills before death preserves points, then clears style; a new match clears everything', () => {
  const { b } = setup(); b.handle([kill({ hpAtKill: 10 }), { type: 'death' }]);
  expect(b.total).toBe(62); expect(b.state().style).toEqual({ riskMultiplier: 1, weaponCount: 0 });
  b.handle([{ type: 'match_start' }]); expect(b.total).toBe(0);
});
it('toggling the systems off clears their chain; invalid settings are rejected', () => {
  const { b, score, config } = setup(); score({ hpAtKill: 10 });
  const previous = structuredClone(config.bonuses);
  config.bonuses.risk.enabled = false; config.bonuses.diversity.enabled = false;
  b.configChanged(previous, config.bonuses);
  expect(score({ hpAtKill: 1 })).toMatchObject({ riskMultiplier: 1, riskBonus: 0, diversityBonus: 0 });
  expect(b.style.weapons.size).toBe(0);
  config.bonuses.risk.maxMultiplier = 0; config.bonuses.diversity.step = -1;
  expect(validateConfig(config).join(' ')).toMatch(/maxMultiplier/);
  expect(validateConfig(config).join(' ')).toMatch(/diversity.step/);
});
