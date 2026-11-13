// Симулятор GSI: шлёт пакеты в POST /gsi запущенного приложения.
//
//   node tools/simulate.js --synthetic [--seed 1] [--map de_mirage] [--speed 10]
//   node tools/simulate.js --replay data/gsi-log-2026-01-01.jsonl [--speed 10]
//
// Общие флаги: --port 3000 (или --url http://127.0.0.1:3000), --token <токен>, --data <папка data>
// Токен по умолчанию берётся из <data>/config.json.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DEFAULT_DATA_DIR } from '../src/paths.js';
import { generateSyntheticMatch } from './synthetic.js';

function parseArgs(argv) {
  const a = { mode: null, file: null, seed: 1, map: 'de_mirage', speed: 10, url: null, port: null, token: null, data: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--synthetic') a.mode = 'synthetic';
    else if (k === '--replay') { a.mode = 'replay'; a.file = v(); }
    else if (k === '--seed') a.seed = Number(v());
    else if (k === '--map') a.map = v();
    else if (k === '--speed') a.speed = Number(v());
    else if (k === '--url') a.url = v();
    else if (k === '--port') a.port = Number(v());
    else if (k === '--token') a.token = v();
    else if (k === '--data') a.data = v();
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function* replayPackets(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let prevT = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const { t, p } = JSON.parse(line);
    yield { dt: prevT == null ? 0 : t - prevT, raw: p };
    prevT = t;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode) {
    console.log('Использование:\n  node tools/simulate.js --synthetic [--seed 1] [--map de_mirage] [--speed 10]\n  node tools/simulate.js --replay <файл.jsonl> [--speed 10]');
    process.exit(1);
  }
  const dataDir = path.resolve(args.data || DEFAULT_DATA_DIR);
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')); } catch { /* нет конфига */ }
  const token = args.token || cfg.gsiToken;
  if (!token) {
    console.error('Нет токена: запустите приложение хотя бы раз или передайте --token');
    process.exit(1);
  }
  const base = args.url || `http://127.0.0.1:${args.port || cfg.port || 3000}`;
  const speed = args.speed > 0 ? args.speed : 1;

  let expected = null;
  let source;
  if (args.mode === 'synthetic') {
    const m = generateSyntheticMatch({ seed: args.seed, mapName: args.map, startTs: Date.now() });
    expected = m.expected;
    source = m.packets;
    const total = m.packets.reduce((s, p) => s + p.dt, 0);
    console.log(`Синтетический матч: ${m.packets.length} пакетов, ~${Math.round(total / speed / 1000)} с при скорости x${speed}`);
  } else {
    source = replayPackets(args.file);
    console.log(`Повтор ${args.file} со скоростью x${speed}`);
  }

  let sent = 0;
  for await (const { dt, raw } of source) {
    // Задержки между пакетами ограничены, чтобы паузы в записи не тянулись вечно.
    if (dt > 0) await sleep(Math.min(dt, 20_000) / speed);
    const body = { ...raw, auth: { token } };
    const res = await fetch(`${base}/gsi`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch((e) => ({ ok: false, status: e.message }));
    if (!res.ok) {
      console.error(`Ошибка отправки пакета #${sent + 1}: ${res.status}. Приложение запущено? Порт и токен верные?`);
      process.exit(1);
    }
    sent += 1;
    if (sent % 50 === 0) process.stdout.write(`  отправлено ${sent}\r`);
  }
  console.log(`\nОтправлено пакетов: ${sent}`);

  if (expected) {
    await sleep(500);
    const state = await (await fetch(`${base}/api/state`)).json();
    const m = state.match || {};
    const rows = [
      ['Результат', expected.result, m.result],
      ['Счёт', `${expected.myScore}:${expected.enemyScore}`, `${m.myScore}:${m.enemyScore}`],
      ['Убийства', expected.kills, m.stats?.kills],
      ['Смерти', expected.deaths, m.stats?.deaths],
      ['Ассисты', expected.assists, m.stats?.assists],
      ['MVP', expected.mvps, m.stats?.mvps],
      ['Раунды сыграно', expected.roundsPlayed, m.roundsPlayed],
      ['Раунды выиграно', expected.roundsWon, m.roundsWon],
    ];
    console.log('\nПроверка (ожидалось → в приложении):');
    let ok = true;
    for (const [name, exp, got] of rows) {
      const same = String(exp) === String(got);
      ok &&= same;
      console.log(`  ${same ? '✓' : '✗'} ${name.padEnd(16)} ${String(exp).padStart(6)} → ${got}`);
    }
    console.log(`\nДругое из генератора: хедшоты ${expected.headshots}, урон ${expected.damage}, выжил в ${expected.roundsSurvived} раундах, `
      + `убийства по оружию ${JSON.stringify(expected.weaponKills)}, убийств тиммейтов во время наблюдения (не должны считаться): ${expected.spectatedMateKills}`);
    console.log('\nЗадания матча:');
    for (const t of state.tasks) console.log(`  [${t.status}] ${t.title} — ${t.display || `${t.progress}/${t.target}`}`);
    if (!ok) { console.error('\nЕсть расхождения!'); process.exit(2); }
    console.log('\nВсё сходится ✓');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
