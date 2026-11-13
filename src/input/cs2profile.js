// Чтение настроек игрока CS2 из его конфигов (только чтение текстовых файлов, игра не затрагивается):
//   <Steam>/userdata/<AccountID>/730/local/cfg/cs2_user_convars_0_slot0.vcfg — sensitivity, m_yaw
//   <Steam>/userdata/<AccountID>/730/local/cfg/cs2_user_keys_0_slot0.vcfg    — бинды
import fs from 'node:fs';
import path from 'node:path';
import { resolveKey } from './keymap.js';

const STEAMID64_BASE = 76561197960265728n;

export function accountIdFromSteamId64(steamId) {
  try {
    const id = BigInt(String(steamId)) - STEAMID64_BASE;
    return id > 0n ? String(id) : null;
  } catch {
    return null;
  }
}

/**
 * Построчный разбор vcfg. Экранирование не используется: CS2 пишет бинд обратного слэша как "\".
 * Возвращает { sections: { имя: { ключ: значение } } } для разделов первого уровня внутри "config".
 */
export function parseVcfg(text) {
  const sections = {};
  const stack = [];
  let pending = null;
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '{') { stack.push(pending); pending = null; continue; }
    if (line === '}') { stack.pop(); continue; }
    const pair = /^"([^"]*)"\s+"(.*)"$/.exec(line);
    if (pair) {
      const sec = stack[stack.length - 1];
      if (sec != null) (sections[sec] ||= {})[pair[1]] = pair[2];
      continue;
    }
    const name = /^"([^"]*)"$/.exec(line);
    if (name) pending = name[1];
  }
  return { sections };
}

export const DEFAULT_BINDS = {
  SPACE: '+jump', MOUSE1: '+attack', MOUSE2: '+attack2', r: '+reload', q: 'lastinv',
  1: 'slot1', 2: 'slot2', 3: 'slot3', 4: 'slot4', 5: 'slot5', MWHEELUP: 'invprev', MWHEELDOWN: 'invnext',
  g: 'drop', f: '+lookatweapon', t: '+spray_menu',
};

const ACTIONS = {
  // Прыжок: +jump, а также популярные бинды прыжка (+jb, +jumpthrow, +lj — longjump).
  jump: /\+jump|\+jb|\+lj\b|\+lj_|jumpthrow|longjump/i,
  attack2: /\+attack2\b/i,
  attack: /\+attack(?!2)\b/i,
  switch: /\bslot\d+\b|\blastinv\b|\binvprev\b|\binvnext\b|\binvnextgrenade\b|\binvnextitem\b|\binvnextnongrenade\b/i,
  reload: /\+reload\b/i,
  drop: /(?:^|;)\s*drop\b/i,
  inspect: /\+lookatweapon\b/i,
  graffiti: /\+spray_menu\b|\bapply_spray\b/i,
};

/** Бинды → какие клавиши что делают. */
export function actionsFromBinds(binds) {
  const out = Object.fromEntries(Object.keys(ACTIONS).map((action) => [action, []]));
  for (const [key, cmd] of Object.entries(binds || {})) {
    if (!resolveKey(key)) continue;
    for (const [action, re] of Object.entries(ACTIONS)) if (re.test(cmd)) out[action].push(key);
  }
  return out;
}

function newestUserCfg(steamRoots) {
  let best = null;
  for (const root of steamRoots) {
    const ud = path.join(root, 'userdata');
    let ids = [];
    try { ids = fs.readdirSync(ud); } catch { continue; }
    for (const id of ids) {
      const f = path.join(ud, id, '730', 'local', 'cfg', 'cs2_user_keys_0_slot0.vcfg');
      try {
        const st = fs.statSync(f);
        if (!best || st.mtimeMs > best.mtime) best = { dir: path.dirname(f), mtime: st.mtimeMs, accountId: id };
      } catch { /* нет CS2 у этого аккаунта */ }
    }
  }
  return best;
}

/** Находит папку настроек CS2 игрока. */
export function findCs2UserCfgDir({ steamId, steamRoots }) {
  const acc = steamId ? accountIdFromSteamId64(steamId) : null;
  if (acc) {
    for (const root of steamRoots) {
      const dir = path.join(root, 'userdata', acc, '730', 'local', 'cfg');
      if (fs.existsSync(path.join(dir, 'cs2_user_keys_0_slot0.vcfg'))) return { dir, accountId: acc, guessed: false };
    }
  }
  const n = newestUserCfg(steamRoots);
  return n ? { dir: n.dir, accountId: n.accountId, guessed: true } : null;
}

/** Читает чувствительность и бинды. Возвращает профиль или null. */
export function loadCs2Profile({ steamId = null, steamRoots = [] } = {}) {
  const found = findCs2UserCfgDir({ steamId, steamRoots });
  if (!found) return null;
  const convFile = path.join(found.dir, 'cs2_user_convars_0_slot0.vcfg');
  const keysFile = path.join(found.dir, 'cs2_user_keys_0_slot0.vcfg');
  let convars = {};
  let binds = null;
  let mtime = 0;
  try {
    convars = parseVcfg(fs.readFileSync(convFile, 'utf8')).sections.convars || {};
    mtime = Math.max(mtime, fs.statSync(convFile).mtimeMs);
  } catch { /* нет файла */ }
  try {
    binds = parseVcfg(fs.readFileSync(keysFile, 'utf8')).sections.bindings || null;
    mtime = Math.max(mtime, fs.statSync(keysFile).mtimeMs);
  } catch { /* нет файла */ }
  const sens = Number(convars.sensitivity);
  const yaw = Number(convars.m_yaw);
  const pitch = Number(convars.m_pitch);
  return {
    dir: found.dir,
    accountId: found.accountId,
    guessed: found.guessed,
    sensitivity: Number.isFinite(sens) && sens > 0 ? sens : null,
    yaw: Number.isFinite(yaw) && yaw > 0 ? yaw : 0.022,
    pitch: Number.isFinite(pitch) && pitch !== 0 ? pitch : 0.022,
    binds: binds || DEFAULT_BINDS,
    bindsFromFile: !!binds,
    mtime,
  };
}
