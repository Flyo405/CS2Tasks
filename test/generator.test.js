import { describe, it, expect } from 'vitest';
import { generate, mulberry32, buildSlots } from '../src/tasks/generator.js';
import { validateTemplates } from '../src/tasks/templates.js';
import { readJson } from '../src/store.js';
import { DEFAULT_TEMPLATES } from '../src/paths.js';

const { templates, errors } = validateTemplates(readJson(DEFAULT_TEMPLATES, []));

describe('шаблоны', () => {
  it('стандартные шаблоны валидны', () => {
    expect(errors).toEqual([]);
    expect(templates.length).toBeGreaterThan(10);
  });

  it('кривые шаблоны пропускаются с понятной ошибкой', () => {
    const res = validateTemplates([
      { type: 'nope', params: {} },
      { type: 'kills', params: { count: [5, 2] } },
      { type: 'kills', params: { foo: 1 } },
      { type: 'weapon_kills', params: { weapon: ['weapon_bfg'] } },
      { type: 'kills', difficulty: 'insane' },
      { type: 'kills', params: { count: [3, 5] } },
    ]);
    expect(res.templates).toHaveLength(1);
    expect(res.errors).toHaveLength(5);
    expect(res.errors[0]).toMatch(/неизвестный тип/);
  });
});

describe('генератор', () => {
  it('нет дублей типов и соблюдается difficultyMix', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const set = generate({ templates, count: 3, difficultyMix: { easy: 1, medium: 1, hard: 1 }, rng: mulberry32(seed) });
      expect(set).toHaveLength(3);
      expect(new Set(set.map((s) => s.type)).size).toBe(3);
      expect(set.map((s) => s.difficulty)).toEqual(['easy', 'medium', 'hard']);
    }
  });

  it('параметры в диапазонах шаблона', () => {
    for (let seed = 1; seed <= 300; seed++) {
      for (const s of generate({ templates, count: 5, difficultyMix: { easy: 2, medium: 2, hard: 1 }, rng: mulberry32(seed) })) {
        const tpl = templates.find((t) => t.id === s.templateId);
        for (const [k, v] of Object.entries(tpl.params)) {
          if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
            expect(s.params[k]).toBeGreaterThanOrEqual(v[0]);
            expect(s.params[k]).toBeLessThanOrEqual(v[1]);
          } else if (Array.isArray(v)) {
            expect(v).toContain(s.params[k]);
          } else {
            expect(s.params[k]).toBe(v);
          }
        }
      }
    }
  });

  it('детерминизм с seed', () => {
    const a = generate({ templates, count: 3, difficultyMix: { easy: 1, medium: 1, hard: 1 }, rng: mulberry32(42) });
    const b = generate({ templates, count: 3, difficultyMix: { easy: 1, medium: 1, hard: 1 }, rng: mulberry32(42) });
    expect(a).toEqual(b);
  });

  it('excludeTypes и нехватка шаблонов', () => {
    const set = generate({ templates, count: 3, difficultyMix: {}, rng: mulberry32(1), excludeTypes: ['kills', 'headshots'] });
    expect(set.some((s) => s.type === 'kills' || s.type === 'headshots')).toBe(false);
    const few = generate({ templates: templates.filter((t) => t.type === 'kills'), count: 3, difficultyMix: {}, rng: mulberry32(1) });
    expect(few).toHaveLength(1);
  });

  it('слоты при count != сумме mix', () => {
    const slots = buildSlots(4, { easy: 1, medium: 1 }, mulberry32(3));
    expect(slots).toHaveLength(4);
    expect(slots.filter((s) => s === 'easy').length).toBeGreaterThanOrEqual(2);
  });
});
