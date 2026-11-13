// Сборка в один файл dist/CS2Tasks.exe (Node SEA — single executable application).
//
//   npm run build:exe
//
// Шаги: esbuild собирает весь код и зависимости в один CommonJS-файл →
// Node готовит blob с кодом и встроенными файлами (страницы, звуки, шаблоны) →
// blob вшивается в копию node.exe через postject.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inject } from 'postject';
import { buildInputHelper } from './build-input.js';
import { releaseRepository } from '../src/updates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
// Позволяет собрать обновление рядом с запущенным exe.
const exeName = process.argv.includes('--update') ? 'CS2Tasks-update.exe' : 'CS2Tasks.exe';
const EXE = path.join(DIST, exeName);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const repository = releaseRepository(process.env.CS2TASKS_UPDATE_REPO || pkg.repository?.url);
if (process.env.CS2TASKS_UPDATE_REPO && !repository) throw new Error('CS2TASKS_UPDATE_REPO must be owner/repository');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(`Для сборки нужен Node.js 20.12+ (сейчас ${process.version}).`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

const step = (s) => console.log(`\n▶ ${s}`);

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. Встроенные файлы.
step('Собираю список встроенных файлов');
const assetKeys = [
  ...walk('public'),
  ...walk('sounds'),
  'config.example.json',
  'src/tasks/defaultTemplates.json',
  'gsi/gamestate_integration_cs2tasks.cfg',
  'README.md',
  'THIRD-PARTY-NOTICES.md',
];
const manifestPath = path.join(BUILD, 'manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(assetKeys, null, 2));
const assets = { 'manifest.json': manifestPath };
const releaseInfo = path.join(BUILD, 'release-info.json');
fs.writeFileSync(releaseInfo, JSON.stringify({ version: pkg.version, repository }));
assets['release-info.json'] = releaseInfo;
for (const k of assetKeys) assets[k] = path.join(ROOT, ...k.split('/'));

// Помощник ввода мыши/клавиатуры (для заданий 360°, прыжок, ноускоп) — вшивается в exe.
step('Собираю помощник ввода (C#)');
assets['bin/cs2tasks-input.exe'] = buildInputHelper({ quiet: true });
console.log(`  ${fs.statSync(assets['bin/cs2tasks-input.exe']).size} байт`);
const totalKb = Math.round(Object.values(assets).reduce((s, f) => s + fs.statSync(f).size, 0) / 1024);
console.log(`  файлов: ${assetKeys.length}, ${totalKb} КБ`);

// 2. Один JS-файл.
step('Собираю код (esbuild)');
const bundle = path.join(BUILD, 'cs2tasks.cjs');
await build({
  entryPoints: [path.join(ROOT, 'src', 'index.js')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${major}`,
  minify: false,
  legalComments: 'none',
  // Необязательные нативные ускорители ws/node-fetch — без них всё работает.
  external: ['bufferutil', 'utf-8-validate', 'encoding'],
  define: { 'import.meta.url': '__cs2tasks_import_meta_url' },
  banner: { js: 'var __cs2tasks_import_meta_url = require("url").pathToFileURL(__filename).href;' },
  logLevel: 'warning',
});
console.log(`  ${Math.round(fs.statSync(bundle).size / 1024)} КБ`);

// 3. SEA blob.
step('Готовлю SEA blob');
const blob = path.join(BUILD, 'sea-prep.blob');
const seaConfig = path.join(BUILD, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useCodeCache: true,
  assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 4. Копия node.exe + blob.
step('Вшиваю в exe');
try {
  fs.copyFileSync(process.execPath, EXE);
} catch (e) {
  if (e.code === 'EBUSY' || e.code === 'EPERM') {
    console.error(`Не могу перезаписать ${EXE} — закройте запущенный CS2Tasks.exe и повторите.`);
    process.exit(1);
  }
  throw e;
}
execFileSync('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'set-exe-icon.ps1'),
  '-Executable', EXE, '-Icon', path.join(ROOT, 'public', 'shared', 'cs2tasks.ico'),
], { stdio: 'inherit', windowsHide: true });

await inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
});

// Mark the Windows launcher as GUI so Explorer opens only the tray icon.
const binary = fs.readFileSync(EXE);
const pe = binary.readUInt32LE(0x3c);
if (binary.readUInt32LE(pe) !== 0x4550) throw new Error('Expected a Windows PE executable');
binary.writeUInt16LE(2, pe + 24 + 68); // IMAGE_SUBSYSTEM_WINDOWS_GUI
fs.writeFileSync(EXE, binary);

const mb = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ Готово: ${path.relative(ROOT, EXE)} (${mb} МБ), версия ${pkg.version}, Node ${process.version}`);
console.log('  Положите exe в отдельную папку (не в Program Files) и запустите двойным кликом.');
