// Загрузка и валидация шаблонов заданий (data/templates.json).
import fs from 'node:fs';
import path from 'node:path';
import { ASSET, readAssetText } from '../paths.js';
import { readJson, writeJsonAtomic } from '../store.js';
import { getType, normalizeParamValue, DIFFICULTIES, TaskError, RETIRED_TYPES } from './taskTypes.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Значение параметра в шаблоне: скаляр, [min, max] (два числа) или массив вариантов. */
export function isRange(v) {
  return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number');
}

function checkParam(schema, key, v) {
  const check = (x) => normalizeParamValue(schema, x);
  if (isRange(v)) {
    if (schema.kind !== 'int' && schema.kind !== 'float') throw new TaskError(`${key}: диапазон допустим только для чисел`);
    if (v[0] > v[1]) throw new TaskError(`${key}: min больше max`);
    if (v[0] < schema.min || v[1] > schema.max) throw new TaskError(`${key}: диапазон должен быть в пределах ${schema.min}..${schema.max}`);
    return;
  }
  if (Array.isArray(v)) {
    if (!v.length) throw new TaskError(`${key}: пустой список вариантов`);
    for (const x of v) {
      const n = check(x);
      if ((schema.kind === 'int' || schema.kind === 'float') && n !== Number(x)) throw new TaskError(`${key}: значение ${x} вне пределов ${schema.min}..${schema.max}`);
    }
    return;
  }
  const n = check(v);
  if ((schema.kind === 'int' || schema.kind === 'float') && v != null && n !== Number(v)) {
    throw new TaskError(`${key}: значение ${v} вне пределов ${schema.min}..${schema.max}`);
  }
}

/** Возвращает { templates, errors }. Плохие шаблоны пропускаются с понятной ошибкой. */
export function validateTemplates(list) {
  const templates = [];
  const errors = [];
  if (!Array.isArray(list)) return { templates, errors: ['templates.json: ожидался массив шаблонов'] };
  list.forEach((raw, i) => {
    if (RETIRED_TYPES.includes(raw?.type)) return;
    const where = `Шаблон #${i + 1}${raw?.type ? ` (${raw.type})` : ''}`;
    try {
      if (!isObj(raw)) throw new TaskError('ожидался объект');
      const type = getType(raw.type);
      if (!type) throw new TaskError(`неизвестный тип «${raw.type}»`);
      if (type.manual) throw new TaskError('тип manual нельзя генерировать случайно');
      const weight = raw.weight ?? 1;
      if (typeof weight !== 'number' || !(weight > 0)) throw new TaskError('weight должен быть числом больше 0');
      const difficulty = raw.difficulty ?? 'medium';
      if (!DIFFICULTIES.includes(difficulty)) throw new TaskError(`difficulty: ${DIFFICULTIES.join(' | ')}`);
      const params = raw.params ?? {};
      if (!isObj(params)) throw new TaskError('params должен быть объектом');
      for (const key of Object.keys(params)) {
        if (!type.params[key]) throw new TaskError(`неизвестный параметр «${key}» (есть: ${Object.keys(type.params).join(', ') || 'нет параметров'})`);
        checkParam(type.params[key], key, params[key]);
      }
      if (raw.enabled === false) return;
      templates.push({ id: raw.id || `tpl_${i + 1}`, type: raw.type, weight, difficulty, params: structuredClone(params) });
    } catch (e) {
      errors.push(`${where}: ${e.message}`);
    }
  });
  return { templates, errors };
}

export function templatesFile(dataDir) {
  return path.join(dataDir, 'templates.json');
}

/** Загружает шаблоны; при первом запуске копирует стандартные. */
export function loadTemplates(dataDir) {
  const file = templatesFile(dataDir);
  if (!fs.existsSync(file)) {
    writeJsonAtomic(file, JSON.parse(readAssetText(ASSET.defaultTemplates)));
  }
  let raw;
  try {
    raw = readJson(file, []);
  } catch (e) {
    return { raw: [], templates: [], errors: [e.message] };
  }
  if (Array.isArray(raw)) {
    const clean = raw.filter((t) => !RETIRED_TYPES.includes(t?.type));
    if (clean.length !== raw.length) { raw = clean; writeJsonAtomic(file, raw); }
  }
  return { raw, ...validateTemplates(raw) };
}

/**
 * Однократно дописывает в templates.json стримера шаблоны новых типов заданий из стандартного набора
 * (только тех типов, которых в файле ещё нет). Возвращает число добавленных шаблонов.
 */
export const TEMPLATE_MIGRATIONS = [
  { version: 2, types: ['spin_kills', 'jump_kills', 'noscope_kills'] },
  { version: 3, types: ['kill_streak', 'survival_streak', 'win_streak', 'full_hp_kill_rounds', 'smoked_kills', 'burning_kills', 'different_weapon_round', 'eco_round_wins'] },
  { version: 4, types: ['combo_kills'] },
  { version: 5, types: ['last_bullet_kills', 'pistol_round_kills'] },
  { version: 6, types: ['unarmored_kills'] },
  { version: 7, types: ['money_saved', 'full_buy_streak', 'force_buy_wins', 'last_seconds_wins', 'no_jump_wins', 'pistol_only_wins', 'no_reload_wins'] },
  { version: 8, types: ['early_round_kills', 'save_primary', 'defuse_survive', 'post_plant_kills', 'retake_kills',
    'flick_kills', 'crouch_kills', 'stationary_kills', 'one_tap_kills'] },
  { version: 9, types: ['enemy_weapon_kills', 'match_arsenal', 'team_timeout', 'forward_only_round',
    'walk_only_round', 'team_drops', 'held_angle_kills'] },
  { version: 10, types: [] },
  { version: 11, types: [] },
];
export const TEMPLATES_VERSION = TEMPLATE_MIGRATIONS[TEMPLATE_MIGRATIONS.length - 1].version;

export function migrateTemplates(dataDir, fromVersion = 1) {
  const file = templatesFile(dataDir);
  let raw;
  try { raw = readJson(file, null); } catch { return 0; }
  if (!Array.isArray(raw)) return 0;
  const defaults = JSON.parse(readAssetText(ASSET.defaultTemplates));
  let added = 0;
  let updated = false;
  if (fromVersion < 11) {
    const oldEasy = { kills: [10, 16], headshots: [3, 6], round_wins: [6, 9] };
    const changedTypes = new Set();
    for (const template of raw) {
      const type = template?.type;
      if (!Object.hasOwn(oldEasy, type)) continue;
      const count = template.params?.count;
      if (!isRange(count)) continue;
      if (template.difficulty === 'easy' && count[0] === oldEasy[type][0] && count[1] === oldEasy[type][1]) {
        template.params.count = defaults.find((t) => t.type === type && t.difficulty === 'easy').params.count;
        changedTypes.add(type);
        updated = true;
      } else if (type === 'headshots' && template.difficulty === 'medium' && count[0] === 8 && count[1] === 12) {
        template.difficulty = 'hard';
        changedTypes.add(type);
        updated = true;
      }
    }
    for (const type of changedTypes) {
      if (raw.some((t) => t?.type === type && t.difficulty === 'medium')) continue;
      raw.push(defaults.find((t) => t.type === type && t.difficulty === 'medium'));
      added++;
    }
  }
  if (fromVersion < 10) {
    for (const template of raw) {
      const seconds = template?.params?.seconds;
      if (template?.type !== 'last_seconds_wins' || !Array.isArray(seconds) || seconds.length !== 2
        || seconds[0] !== 5 || seconds[1] !== 10) continue;
      template.params.seconds = 20;
      updated = true;
    }
  }
  for (const m of TEMPLATE_MIGRATIONS) {
    if (m.version <= fromVersion) continue;
    for (const type of m.types) {
      if (raw.some((t) => t?.type === type)) continue;
      for (const t of defaults.filter((d) => d.type === type)) { raw.push(t); added += 1; }
    }
  }
  if (added || updated) writeJsonAtomic(file, raw);
  return added;
}

export function saveTemplates(dataDir, raw) {
  writeJsonAtomic(templatesFile(dataDir), raw);
}
