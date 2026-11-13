// Случайная генерация набора заданий из шаблонов.
import { isRange } from './templates.js';
import { DIFFICULTIES, normalizeParams } from './taskTypes.js';

/** Детерминированный ГПСЧ для тестов (seed → функция 0..1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

export function weightedPick(items, rng, weightOf = (x) => x.weight ?? 1) {
  const total = items.reduce((s, x) => s + weightOf(x), 0);
  let r = rng() * total;
  for (const x of items) {
    r -= weightOf(x);
    if (r < 0) return x;
  }
  return items[items.length - 1];
}

export function instantiateParams(spec = {}, rng = Math.random) {
  const out = {};
  for (const [k, v] of Object.entries(spec)) {
    if (isRange(v)) {
      const [min, max] = v;
      out[k] = Number.isInteger(min) && Number.isInteger(max)
        ? randInt(rng, min, max)
        : Math.round((min + rng() * (max - min)) * 10) / 10;
    } else if (Array.isArray(v)) {
      out[k] = v[Math.floor(rng() * v.length)];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Список сложностей для слотов набора по difficultyMix. */
export function buildSlots(count, mix = {}, rng = Math.random) {
  const entries = DIFFICULTIES.map((d) => [d, Number(mix[d]) || 0]).filter(([, w]) => w > 0);
  if (!entries.length) return Array(count).fill(null);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const slots = [];
  if (total === count) {
    for (const [d, w] of entries) for (let i = 0; i < w; i++) slots.push(d);
  } else {
    // Пропорционально, остаток — случайно по весам.
    for (const [d, w] of entries) for (let i = 0; i < Math.floor((count * w) / total); i++) slots.push(d);
    while (slots.length < count) slots.push(weightedPick(entries, rng, ([, w]) => w)[0]);
  }
  const order = (d) => (d == null ? 99 : DIFFICULTIES.indexOf(d));
  return slots.sort((a, b) => order(a) - order(b));
}

/**
 * Генерирует спецификации заданий: [{ type, params, difficulty, templateId }].
 * Без двух заданий одного типа в наборе (и без типов из excludeTypes).
 */
export function generate({ templates, count, difficultyMix, rng = Math.random, excludeTypes = [] }) {
  const used = new Set(excludeTypes);
  const out = [];
  for (const diff of buildSlots(count, difficultyMix, rng)) {
    let cands = templates.filter((t) => (diff == null || t.difficulty === diff) && !used.has(t.type));
    if (!cands.length) cands = templates.filter((t) => !used.has(t.type));
    if (!cands.length) break;
    const tpl = weightedPick(cands, rng);
    used.add(tpl.type);
    out.push({
      type: tpl.type,
      params: normalizeParams(tpl.type, instantiateParams(tpl.params, rng)),
      difficulty: tpl.difficulty,
      templateId: tpl.id,
    });
  }
  return out;
}
