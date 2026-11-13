// Компилирует помощник ввода (tools/input-helper/InputHelper.cs) встроенным в Windows компилятором C#.
//   node tools/build-input.js  →  build/cs2tasks-input.exe
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HELPER_SRC = path.join(ROOT, 'tools', 'input-helper', 'InputHelper.cs');
export const HELPER_EXE = path.join(ROOT, 'build', 'cs2tasks-input.exe');

export function findCsc() {
  const win = process.env.WINDIR || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function buildInputHelper({ quiet = false } = {}) {
  const csc = findCsc();
  if (!csc) throw new Error('Не найден компилятор C# (csc.exe из .NET Framework 4). Помощник ввода собирается только на Windows.');
  fs.mkdirSync(path.dirname(HELPER_EXE), { recursive: true });
  execFileSync(csc, [
    '/nologo', '/optimize+', '/target:exe', '/platform:anycpu',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    `/resource:${path.join(ROOT, 'public', 'shared', 'cs2tasks.ico')},CS2Tasks.ico`,
    `/out:${HELPER_EXE}`, HELPER_SRC,
  ], { stdio: quiet ? 'pipe' : 'inherit', windowsHide: true });
  return HELPER_EXE;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildInputHelper();
  console.log(`✓ ${path.relative(ROOT, out)} (${fs.statSync(out).size} байт)`);
}
