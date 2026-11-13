// Поиск папки cfg CS2 и установка файла GSI. Больше ничего в папке игры не трогаем.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ASSET, readAssetText } from '../paths.js';

export const CFG_NAME = 'gamestate_integration_cs2tasks.cfg';
const CS2_REL = ['steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg'];

/** Простой парсер Valve KeyValues (VDF): "key" "value" и "key" { ... }. */
export function parseVdf(text) {
  const re = /"((?:\\.|[^"\\])*)"|([{}])/g;
  const root = {};
  const stack = [root];
  let key = null;
  let m;
  while ((m = re.exec(text))) {
    if (m[2] === '{') {
      const obj = {};
      if (key != null) stack[stack.length - 1][key] = obj;
      stack.push(obj);
      key = null;
    } else if (m[2] === '}') {
      if (stack.length > 1) stack.pop();
      key = null;
    } else {
      const s = m[1].replace(/\\(.)/g, '$1');
      if (key == null) key = s;
      else { stack[stack.length - 1][key] = s; key = null; }
    }
  }
  return root;
}

function regQuery(keyPath, value) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('reg', ['query', keyPath, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i').exec(stdout);
      resolve(m ? m[1].trim() : null);
    });
  });
}

export async function findSteamRoots() {
  const roots = [];
  const add = (p) => { if (p && !roots.some((r) => path.resolve(r).toLowerCase() === path.resolve(p).toLowerCase())) roots.push(p); };
  add(await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath'));
  add(await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'));
  add(await regQuery('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'));
  add('C:\\Program Files (x86)\\Steam');
  add('C:\\Program Files\\Steam');
  return roots.map((r) => path.normalize(r)).filter((r) => fs.existsSync(r));
}

export function libraryFolders(steamRoot) {
  const libs = [steamRoot];
  const vdf = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  try {
    const data = parseVdf(fs.readFileSync(vdf, 'utf8'));
    const lf = data.libraryfolders || data.LibraryFolders || {};
    for (const v of Object.values(lf)) {
      const p = typeof v === 'string' ? v : v?.path;
      if (p && !libs.some((l) => path.resolve(l).toLowerCase() === path.resolve(p).toLowerCase())) libs.push(path.normalize(p));
    }
  } catch { /* файла может не быть */ }
  return libs;
}

/** Возвращает путь к папке cfg CS2 или null. */
export async function findCs2CfgDir() {
  for (const root of await findSteamRoots()) {
    for (const lib of libraryFolders(root)) {
      const dir = path.join(lib, ...CS2_REL);
      if (fs.existsSync(dir)) return dir;
    }
  }
  return null;
}

export function buildCfg({ port, token }) {
  return readAssetText(ASSET.gsiTemplate).replaceAll('{{PORT}}', String(port)).replaceAll('{{TOKEN}}', token);
}

/**
 * Устанавливает cfg. Возвращает { ok, path, changed, message }.
 */
export async function installGsiCfg(config) {
  let dir = config.cs2CfgPath?.trim() || null;
  if (dir) {
    if (!fs.existsSync(dir)) {
      return { ok: false, path: null, changed: false, message: `Папка из cs2CfgPath не найдена: ${dir}` };
    }
  } else {
    dir = await findCs2CfgDir();
  }
  if (!dir) {
    return {
      ok: false,
      path: null,
      changed: false,
      message: 'Папка CS2 не найдена автоматически. Укажите cs2CfgPath в настройках, обычно это '
        + '<Steam>\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\cfg',
    };
  }
  const file = path.join(dir, CFG_NAME);
  const content = buildCfg({ port: config.port, token: config.gsiToken });
  let existing = null;
  try { existing = fs.readFileSync(file, 'utf8'); } catch { /* нет файла */ }
  if (existing === content) {
    return { ok: true, path: file, changed: false, message: 'GSI cfg уже установлен' };
  }
  try {
    fs.writeFileSync(file, content, 'utf8');
  } catch (e) {
    return { ok: false, path: file, changed: false, message: `Не удалось записать ${file}: ${e.message}` };
  }
  return { ok: true, path: file, changed: true, message: 'GSI cfg установлен. Перезапустите CS2, чтобы игра его подхватила!' };
}
