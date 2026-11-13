// Пути и встроенные файлы. Два режима:
//  - из исходников (node src/index.js): всё читается из папки проекта;
//  - из CS2Tasks.exe (Node SEA): страницы, шаблоны и звуки зашиты в exe,
//    а data/ и sounds/ лежат рядом с exe.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

let sea = null;
try {
  // eslint-disable-next-line no-undef
  const req = typeof require === 'function' ? require : createRequire(import.meta.url);
  sea = req('node:sea');
} catch { /* старый Node без node:sea */ }

export const IS_SEA = !!(sea && typeof sea.isSea === 'function' && sea.isSea());

/** Папка исходников (только в режиме разработки). */
export const ROOT = IS_SEA ? path.dirname(process.execPath) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Папка, где лежат data/ и sounds/ (рядом с exe или в проекте). */
export const APP_DIR = IS_SEA ? path.dirname(process.execPath) : ROOT;

export const SOUNDS_DIR = path.join(APP_DIR, 'sounds');
export const DEFAULT_DATA_DIR = path.join(APP_DIR, 'data');

// Ключи встроенных файлов (пути относительно проекта, через «/»).
export const ASSET = {
  configExample: 'config.example.json',
  defaultTemplates: 'src/tasks/defaultTemplates.json',
  gsiTemplate: 'gsi/gamestate_integration_cs2tasks.cfg',
  manifest: 'manifest.json',
};

// Пути для тестов и инструментов разработки.
export const CONFIG_EXAMPLE = path.join(ROOT, ASSET.configExample);
export const DEFAULT_TEMPLATES = path.join(ROOT, ASSET.defaultTemplates);
export const GSI_TEMPLATE = path.join(ROOT, ASSET.gsiTemplate);

/** Читает встроенный файл. Возвращает Buffer или null, если файла нет. */
export function readAsset(key) {
  if (key.includes('..')) return null;
  if (IS_SEA) {
    try {
      return Buffer.from(sea.getAsset(key));
    } catch {
      return null;
    }
  }
  try {
    return fs.readFileSync(path.join(ROOT, ...key.split('/')));
  } catch {
    return null;
  }
}

export function readAssetText(key) {
  const buf = readAsset(key);
  if (!buf) throw new Error(`Не найден встроенный файл ${key}`);
  return buf.toString('utf8').replace(/^﻿/, '');
}

/**
 * В режиме exe при первом запуске раскладывает рядом с exe стандартные звуки и README,
 * чтобы стример мог их заменить. Существующие файлы не трогает.
 */
export function extractDefaultFiles(log) {
  if (!IS_SEA) return;
  let keys = [];
  try {
    keys = JSON.parse(readAssetText(ASSET.manifest));
  } catch {
    return;
  }
  for (const key of keys) {
    if (!(key.startsWith('sounds/') || key === 'README.md')) continue;
    const target = path.join(APP_DIR, ...key.split('/'));
    if (fs.existsSync(target)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, readAsset(key));
      log?.debug?.(`Распакован ${key}`);
    } catch (e) {
      log?.warn?.(`Не удалось распаковать ${key}: ${e.message}`);
    }
  }
}
