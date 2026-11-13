// Загрузка, слияние с умолчаниями и валидация config.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ASSET, readAssetText } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';
import { isPrivateIPv4 } from './overlayNetwork.js';

/** Значения по умолчанию берутся из config.example.json — единый источник. */
export const DEFAULT_CONFIG = JSON.parse(readAssetText(ASSET.configExample));

/** Ключи, которые заменяются целиком, а не сливаются по полям. */
const REPLACE_KEYS = new Set(['aliases', 'difficultyMix']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, patch) {
  if (!isObj(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(out[k]) && !REPLACE_KEYS.has(k)) out[k] = deepMerge(out[k], v);
    else out[k] = structuredClone(v);
  }
  return out;
}

export class ConfigError extends Error {}

export function validateConfig(c) {
  const errors = [];
  if (!['ru', 'en'].includes(c.language)) errors.push('language: ru | en');
  const int = (v, min, max, name) => {
    if (!Number.isInteger(v) || v < min || v > max) errors.push(`${name}: целое число от ${min} до ${max}`);
  };
  const num = (v, min, max, name) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) errors.push(`${name}: число от ${min} до ${max}`);
  };
  const bool = (v, name) => { if (typeof v !== 'boolean') errors.push(`${name}: true или false`); };
  bool(c.lowHealth?.enabled, 'lowHealth.enabled');
  num(c.lowHealth?.volume, 0, 1, 'lowHealth.volume');
  if (typeof c.lowHealth?.obsSource !== 'string' || c.lowHealth.obsSource.length > 200) errors.push('lowHealth.obsSource: string (max 200)');
  int(c.port, 1, 65535, 'port');
  if (c.overlayLanAddress !== '' && !isPrivateIPv4(c.overlayLanAddress)) errors.push('overlayLanAddress: выберите локальный IPv4 игрового ПК');
  if (typeof c.gsiToken !== 'string') errors.push('gsiToken: строка');
  if (typeof c.cs2CfgPath !== 'string') errors.push('cs2CfgPath: строка');
  if (!Array.isArray(c.allowedModes) || c.allowedModes.some((m) => typeof m !== 'string')) errors.push('allowedModes: массив строк');
  int(c.tasks?.count, 0, 10, 'tasks.count');
  int(c.tasks?.maxActive, 1, 20, 'tasks.maxActive');
  if (!isObj(c.tasks?.difficultyMix)) errors.push('tasks.difficultyMix: объект { easy, medium, hard }');
  else for (const [k, v] of Object.entries(c.tasks.difficultyMix)) {
    if (!['easy', 'medium', 'hard'].includes(k)) errors.push(`tasks.difficultyMix: неизвестная сложность «${k}»`);
    num(v, 0, 100, `tasks.difficultyMix.${k}`);
  }
  bool(c.tasks?.autoGenerateOnMatchStart, 'tasks.autoGenerateOnMatchStart');
  bool(c.tasks?.replaceSkipped, 'tasks.replaceSkipped');
  bool(c.tasks?.replaceCompleted, 'tasks.replaceCompleted');
  bool(c.tasks?.reserveWhenFull, 'tasks.reserveWhenFull');
  bool(c.tasks?.situational, 'tasks.situational');
  if (!['classic', 'bingo', 'bingo5', 'points'].includes(c.tasks?.mode)) errors.push('tasks.mode: classic | bingo | bingo5 | points');
  int(c.tasks?.points?.goal, 1, 1000000, 'tasks.points.goal');
  for (const k of ['easy', 'medium', 'hard', 'extra']) int(c.tasks?.points?.[k], 0, 100000, `tasks.points.${k}`);
  int(c.tasks?.points?.skipPenalty, 0, 100, 'tasks.points.skipPenalty (% от цены задания)');
  const obs = c.obs || {};
  bool(obs.enabled, 'obs.enabled');
  int(obs.port, 1, 65535, 'obs.port');
  if (typeof obs.password !== 'string') errors.push('obs.password: строка');
  num(c.sounds?.volume, 0, 1, 'sounds.volume');
  for (const k of ['skip', 'complete']) {
    const f = c.sounds?.[k];
    if (typeof f !== 'string' || /[\\/]|\.\./.test(f)) errors.push(`sounds.${k}: имя файла из папки sounds (без пути)`);
  }
  bool(c.sounds?.playOnComplete, 'sounds.playOnComplete');
  bool(c.sounds?.playOnFail, 'sounds.playOnFail');
  bool(c.overlay?.showHeader, 'overlay.showHeader');
  bool(c.overlay?.showCounter, 'overlay.showCounter');
  bool(c.summary?.enabled, 'summary.enabled');
  int(c.summary?.showSeconds, 5, 120, 'summary.showSeconds');
  const b = c.bonuses || {};
  bool(b.enabled, 'bonuses.enabled');
  bool(b.showTotal, 'bonuses.showTotal');
  bool(b.risk?.enabled, 'bonuses.risk.enabled');
  num(b.risk?.step, 0, 2, 'bonuses.risk.step');
  num(b.risk?.maxMultiplier, 1, 10, 'bonuses.risk.maxMultiplier');
  int(b.risk?.lowHp, 1, 100, 'bonuses.risk.lowHp');
  bool(b.diversity?.enabled, 'bonuses.diversity.enabled');
  int(b.diversity?.step, 0, 10000, 'bonuses.diversity.step');
  int(b.diversity?.maxBonus, 0, 10000, 'bonuses.diversity.maxBonus');
  if (!['slide', 'scale'].includes(b.animation)) errors.push('bonuses.animation: slide | scale');
  num(b.scaleFrom, 1, 3, 'bonuses.scaleFrom');
  int(b.base, 0, 10000, 'bonuses.base');
  int(b.comboWindowMs, 200, 30000, 'bonuses.comboWindowMs');
  int(b.mergeMs, 0, 1000, 'bonuses.mergeMs');
  num(b.comboStep, 0, 2, 'bonuses.comboStep');
  num(b.bonusMultiplier, 0, 10, 'bonuses.bonusMultiplier');
  for (const k of ['fadeInMs', 'holdMs', 'fadeOutMs']) int(b[k], k === 'holdMs' ? 0 : 1, 10000, `bonuses.${k}`);
  int(b.size, 20, 100, 'bonuses.size');
  for (const k of ['x', 'y']) num(b[k], 0, 100, `bonuses.${k}`);
  if (typeof b.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(b.color)) errors.push('bonuses.color: цвет #RRGGBB');
  for (const k of ['headshot', 'air', 'knife', 'smoke', 'blind', 'noscope', 'spin', 'inspect', 'graffiti']) int(b.points?.[k], 0, 10000, `bonuses.points.${k}`);
  num(c.overlay?.showCompletedFor, 0, 3600, 'overlay.showCompletedFor');
  const t = c.twitch || {};
  bool(t.enabled, 'twitch.enabled');
  bool(t.taskVoting, 'twitch.taskVoting');
  if (typeof t.channel !== 'string') errors.push('twitch.channel: строка');
  if (t.enabled && !t.channel.trim()) errors.push('twitch.channel: укажите канал, чтобы включить чат');
  if (typeof t.command !== 'string' || !t.command.trim() || /\s/.test(t.command.trim())) errors.push('twitch.command: команда без пробелов, например !task');
  int(t.cooldownSec, 0, 86400, 'twitch.cooldownSec');
  int(t.maxQueue, 1, 200, 'twitch.maxQueue');
  const roles = ['everyone', 'subscriber', 'vip', 'moderator'];
  for (const key of ['allowedRoles', 'voteAllowedRoles']) {
    const selected = t[key];
    if (!Array.isArray(selected) || !selected.length || selected.some((role) => !roles.includes(role))) {
      errors.push(`twitch.${key}: непустой массив из ${roles.join(', ')}`);
    }
  }
  if (!Array.isArray(t.bannedWords) || t.bannedWords.some((w) => typeof w !== 'string')) errors.push('twitch.bannedWords: массив строк');
  if (!isObj(t.aliases)) errors.push('twitch.aliases: объект');
  else for (const [code, a] of Object.entries(t.aliases)) {
    if (!/^[\p{L}\d_-]{1,20}$/u.test(code)) errors.push(`twitch.aliases: плохой код «${code}»`);
    if (!isObj(a) || typeof a.type !== 'string') errors.push(`twitch.aliases.${code}: нужен { "type": ... }`);
  }
  bool(c.input?.enabled, 'input.enabled');
  num(c.input?.sensitivity, 0, 100, 'input.sensitivity (0 — взять из настроек CS2)');
  int(c.input?.spinWithinMs, 200, 5000, 'input.spinWithinMs');
  int(c.input?.killAfterSpinMs, 200, 5000, 'input.killAfterSpinMs');
  int(c.input?.jumpKillMs, 200, 3000, 'input.jumpKillMs');
  if (!['debug', 'info', 'warn', 'error'].includes(c.debug?.logLevel)) errors.push('debug.logLevel: debug | info | warn | error');
  bool(c.debug?.recordGsi, 'debug.recordGsi');
  return errors;
}

export function loadConfig(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'config.json');
  const raw = readJson(file, null);
  const created = raw === null;
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), raw || {});
  if (!config.gsiToken) config.gsiToken = crypto.randomBytes(16).toString('hex');
  const errors = validateConfig(config);
  if (errors.length) {
    throw new ConfigError(`Ошибки в ${file}:\n  - ${errors.join('\n  - ')}`);
  }
  // Дописываем новые ключи и токен, чтобы стример видел все настройки в файле.
  if (created || JSON.stringify(raw) !== JSON.stringify(config)) writeJsonAtomic(file, config);
  return { config, file, created };
}

/** Применяет изменения из панели. Бросает ConfigError, если результат некорректен. */
export function applyConfigPatch(config, patch) {
  if (!isObj(patch)) throw new ConfigError('Ожидался объект настроек');
  const next = deepMerge(config, patch);
  next.gsiToken = config.gsiToken; // токен меняется только вручную в файле
  const errors = validateConfig(next);
  if (errors.length) throw new ConfigError(errors.join('; '));
  return next;
}
