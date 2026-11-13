import { describe, it, expect } from 'vitest';
import { KILL_COMBOS, buildTask, normalizeParams, getType } from '../src/tasks/taskTypes.js';
import { Core } from '../src/core.js';
import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';

const good = { type: 'kill', count: 1, jump: true, spin: true, noscope: true, headshots: 1,
  hpAtKill: 20, smoked: 255, burning: 255, flashed: 255,
  weapon: { name: 'weapon_awp', type: 'SniperRifle' } };
const negate = { jump: { jump: false }, spin: { spin: false }, noscope: { noscope: false },
  headshot: { headshots: 0 }, lowhp: { hpAtKill: 60 }, smoked: { smoked: 0 },
  burning: { burning: 0 }, flashed: { flashed: 0 } };
const make = (combo, count = 1) => buildTask('combo_kills', normalizeParams('combo_kills', { combo, count }));
const apply = (t, e) => { const p = getType(t.type).onEvent(t, e); if (p != null) t.progress = p; return t.progress; };

describe('комбо на одном убийстве', () => {
  for (const [id, combo] of Object.entries(KILL_COMBOS)) {
    it(`${id}: требует все условия на одном событии`, () => {
      expect(apply(make(id), good)).toBe(1);
      const t = make(id);
      for (const condition of combo.conditions) expect(apply(t, { ...good, ...negate[condition] })).toBe(0);
      expect(apply(t, { type: 'round_end' })).toBe(0);
    });
  }
  it('для комбо с хедшотом не считает остальные убийства в объединённом пакете', () => {
    expect(apply(make('noscope_headshot', 5), { ...good, count: 3, headshots: 1 })).toBe(1);
    expect(apply(make('jump_noscope', 5), { ...good, count: 3 })).toBe(3);
  });
  it('ноускоп с неснайперским оружием не считается', () => {
    expect(apply(make('jump_noscope'), { ...good, weapon: { name: 'weapon_ak47', type: 'Rifle' } })).toBe(0);
  });
  it('неизвестные сочетания отклоняются', () => {
    expect(() => normalizeParams('combo_kills', { combo: 'bad' })).toThrow(/сочетание/);
  });
  it('повторные комбо накапливаются и сохраняются', () => {
    const t = make('spin_jump_noscope', 3);
    apply(t, good);
    const restored = JSON.parse(JSON.stringify(t));
    expect(apply(restored, good)).toBe(2);
  });
  it('GSI-комбо доступны без помощника, а комбо с 360 требуют чувствительность', () => {
    const templates = Object.keys(KILL_COMBOS).map((combo) => ({ type: 'combo_kills', params: { combo } }));
    const core = new Core({ config: deepMerge(structuredClone(DEFAULT_CONFIG), { tasks: { count: 0 } }),
      templates: { templates, errors: [] } });
    expect(core.availableTemplates().map((t) => t.params.combo)).toEqual(['smoke_headshot', 'fire_headshot', 'lowhp_headshot']);
    expect(() => core.tasks.add({ type: 'combo_kills', params: { combo: 'jump_noscope' } })).toThrow(/ввод мыши/);
    core.input = { available: () => ({ running: true, spin: false }) };
    expect(core.inputBlock('combo_kills', { combo: 'jump_noscope' })).toBeNull();
    expect(core.inputBlock('combo_kills', { combo: 'spin_noscope' })).toMatch(/чувствительность/);
  });
  it('зритель может предложить GSI-комбо без помощника ввода', () => {
    const core = new Core({ config: structuredClone(DEFAULT_CONFIG), templates: { templates: [], errors: [] },
      log: { info() {}, warn() {}, debug() {} } });
    core.handleChat({ user: 'viewer', displayName: 'Viewer', text: '!task smokehs 1', roles: new Set(['everyone']) });
    expect(core.suggestions.queue).toHaveLength(1);
    expect(core.suggestions.queue[0].params).toMatchObject({ combo: 'smoke_headshot', count: 1 });
    clearTimeout(core.broadcastTimer);
  });
});
