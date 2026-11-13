import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MotionDetector } from '../src/input/detector.js';
import { InputService } from '../src/input/inputService.js';
import { parseVcfg, actionsFromBinds, accountIdFromSteamId64, loadCs2Profile, DEFAULT_BINDS } from '../src/input/cs2profile.js';
import { resolveKey } from '../src/input/keymap.js';
import { Core } from '../src/core.js';
import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { validateTemplates, migrateTemplates } from '../src/tasks/templates.js';
import { readJson } from '../src/store.js';
import { DEFAULT_TEMPLATES } from '../src/paths.js';
import { mulberry32 } from '../src/tasks/generator.js';
import { raw } from './helpers.js';

// sensitivity 0.8 × m_yaw 0.022 = 0.0176° на отсчёт → 360° ≈ 20455 отсчётов
const DEG = 0.8 * 0.022;
const PER360 = Math.ceil(360 / DEG);

/** Поворот мыши: total отсчётов за ms миллисекунд, порциями каждые 5 мс (как присылает помощник). */
function turn(d, total, ms, t0) {
  const steps = Math.max(1, Math.round(ms / 5));
  let spin = null;
  for (let i = 1; i <= steps; i++) spin = d.mouse(total / steps, t0 + (ms * i) / steps) || spin;
  return spin;
}

const SNIPER = { name: 'weapon_awp', type: 'SniperRifle' };
const RIFLE = { name: 'weapon_ak47', type: 'Rifle' };

describe('восстановление доступности ввода', () => {
  it('сохранение пяти секунд сразу обновляет распознаватель', async () => {
    let core;
    const input = new InputService({ getConfig: () => core.config, log: { info() {} } });
    core = new Core({ config: structuredClone(DEFAULT_CONFIG), templates: { templates: [], errors: [] }, input });
    await core.updateConfig({ input: { killAfterSpinMs: 5000 } });
    expect(input.detector.settings.killAfterSpinMs).toBe(5000);
    clearTimeout(core.broadcastTimer);
  });
  function service() {
    const input = new InputService({ getConfig: () => DEFAULT_CONFIG, log: { info() {} } });
    input.detector.setSettings({ degPerCount: DEG });
    input.handleLine('READY', 1000);
    return input;
  }

  it('новые движения после ошибки Raw Input снова разрешают задания', () => {
    const input = service();
    input.handleLine('ERROR raw input 5', 1100);
    expect(input.available().running).toBe(false);
    input.handleLine('M 20', 1200);
    expect(input.available()).toEqual({ running: true, spin: true });
    expect(input.status.error).toBeNull();
    expect(input.publicState().lastMouseAt).toBe(1200);
  });

  it('повторный READY снимает ошибку без движения мыши', () => {
    const input = service();
    input.handleLine('ERROR raw input 5', 1100);
    input.handleLine('READY', 1200);
    expect(input.available().spin).toBe(true);
    expect(input.status.error).toBeNull();
  });

  it('ошибка регистрации 87 запускает восстановление через новый процесс', () => {
    const input = service();
    let killed = false;
    input.proc = { kill() { killed = true; } };
    input.handleLine('ERROR raw input 87', 1100);
    expect(killed).toBe(true);
    expect(input.available().running).toBe(false);
  });
});

describe('распознавание 360°', () => {
  it('после остановки можно навестись и выстрелить через 4 секунды, но не через 6', () => {
    const d = new MotionDetector({ degPerCount: 1, killAfterSpinMs: 5000 });
    turn(d, 360, 300, 1000);
    d.mouse(-100, 1500); // наведение после паузы, а не часть разворота
    d.action('attack', 5300);
    expect(d.classifyKill(5450, RIFLE).spin).toBe(true);
    d.action('attack', 7300);
    expect(d.classifyKill(7450, RIFLE).spin).toBe(false);
  });

  it('наведение без паузы после распознавания не отменяет попытку', () => {
    const d = new MotionDetector({ degPerCount: 1, killAfterSpinMs: 5000 });
    turn(d, 360, 300, 1000);
    d.mouse(-200, 1305);
    d.mouse(300, 1310);
    d.action('attack', 1600);
    expect(d.classifyKill(1750, RIFLE).spin).toBe(true);
  });
  it.each([320, 360, 400, -320, -360, -400])('допуск: %s° засчитывается', (angle) => {
    const d = new MotionDetector({ degPerCount: 1 });
    turn(d, angle, 300, 1000);
    d.action('attack', 1400);
    expect(d.classifyKill(1550, RIFLE).spin).toBe(true);
  });

  it.each([319, -319])('вне допуска: %s° не засчитывается', (angle) => {
    const d = new MotionDetector({ degPerCount: 1 });
    turn(d, angle, 300, 1000);
    d.action('attack', 1400);
    expect(d.classifyKill(1550, RIFLE).spin).toBe(false);
  });

  it('перекрут после выстрела не отменяет убийство из-за задержки GSI', () => {
    const d = new MotionDetector({ degPerCount: 1 });
    turn(d, 360, 300, 1000);
    d.action('attack', 1320);
    d.mouse(50, 1350);
    expect(d.classifyKill(1500, RIFLE).spin).toBe(true);
  });

  it('быстрый разворот за 0,3 с засчитывается, убийство в течение секунды — «после 360»', () => {
    const d = new MotionDetector({ degPerCount: DEG });
    const spin = turn(d, PER360 + 200, 300, 1000);
    expect(spin).toBeTruthy();
    expect(Math.abs(spin.deg)).toBeGreaterThanOrEqual(320);
    d.action('attack', 1800);
    expect(d.classifyKill(2000, RIFLE).spin).toBe(true); // GSI пришёл на 200 мс позже выстрела
  });

  it('разворот влево тоже считается', () => {
    const d = new MotionDetector({ degPerCount: DEG });
    expect(turn(d, -(PER360 + 100), 500, 0).deg).toBeLessThanOrEqual(-320);
  });

  it('медленный разворот дольше окна — не 360', () => {
    const d = new MotionDetector({ degPerCount: DEG, spinWithinMs: 1000 });
    expect(turn(d, PER360 + 500, 2500, 0)).toBeNull();
  });

  it('влево-вправо по 200° — не 360', () => {
    const d = new MotionDetector({ degPerCount: DEG });
    const c = Math.round(200 / DEG);
    expect(turn(d, c, 200, 0)).toBeNull();
    expect(turn(d, -c, 200, 200)).toBeNull();
  });

  it('убийство через 1,5 с после разворота — уже не считается', () => {
    const d = new MotionDetector({ degPerCount: DEG, killAfterSpinMs: 1000 });
    turn(d, PER360 + 100, 400, 0);
    d.action('attack', 1900);
    expect(d.classifyKill(2050, RIFLE).spin).toBe(false);
  });

  it('убийство до разворота не считается', () => {
    const d = new MotionDetector({ degPerCount: DEG });
    d.action('attack', 100);
    turn(d, PER360 + 100, 300, 150); // разворот закончился после выстрела
    expect(d.classifyKill(500, RIFLE).spin).toBe(false);
  });

  it('без чувствительности разворот не считается', () => {
    const d = new MotionDetector({ degPerCount: 0 });
    expect(turn(d, PER360 * 3, 300, 0)).toBeNull();
  });
});

describe('прыжок', () => {
  it('убийство через 0,5 с после прыжка — «в прыжке», через 1,2 с — нет', () => {
    const d = new MotionDetector({ degPerCount: DEG });
    d.action('jump', 1000);
    d.action('attack', 1500);
    expect(d.classifyKill(1700, RIFLE).jump).toBe(true);
    d.action('attack', 2200);
    expect(d.classifyKill(2400, RIFLE).jump).toBe(false);
  });
});

describe('ноускоп', () => {
  it('выстрел из AWP без правой кнопки — ноускоп', () => {
    const d = new MotionDetector();
    d.action('switch', 0);
    d.action('attack', 500);
    expect(d.classifyKill(700, SNIPER).noscope).toBe(true);
  });

  it('с прицелом (ПКМ) — не ноускоп; второй уровень зума — тоже прицел; третье нажатие закрывает', () => {
    const d = new MotionDetector();
    d.action('switch', 0);
    d.action('attack2', 100); // x1
    d.action('attack', 400);
    expect(d.classifyKill(600, SNIPER).noscope).toBe(false);
    d.action('attack2', 700); // x2
    d.action('attack', 900);
    expect(d.classifyKill(1100, SNIPER).noscope).toBe(false);
    d.action('attack2', 1200); // закрыт
    d.action('attack', 1400);
    expect(d.classifyKill(1600, SNIPER).noscope).toBe(true);
  });

  it('смена оружия и перезарядка закрывают прицел', () => {
    const d = new MotionDetector();
    d.action('attack2', 0);
    d.action('switch', 100);
    d.action('attack', 300);
    expect(d.classifyKill(500, SNIPER).noscope).toBe(true);
    d.action('attack2', 600);
    d.action('reload', 700);
    d.action('attack', 900);
    expect(d.classifyKill(1000, SNIPER).noscope).toBe(true);
  });

  it('смена оружия из GSI (с задержкой) не сбрасывает только что открытый прицел', () => {
    const d = new MotionDetector();
    d.weapon('weapon_glock', 0);
    d.action('switch', 1000); // нажал «1»
    d.action('attack2', 1150); // сразу прицелился
    d.weapon('weapon_awp', 1250); // GSI сообщил о смене позже
    d.action('attack', 1500);
    expect(d.classifyKill(1700, SNIPER).noscope).toBe(false);
  });

  it('смена оружия только по GSI (без клавиши) сбрасывает прицел', () => {
    const d = new MotionDetector();
    d.weapon('weapon_ssg08', 0);
    d.action('attack2', 100);
    d.weapon('weapon_knife', 2000);
    d.weapon('weapon_ssg08', 3000);
    d.action('attack', 3500);
    expect(d.classifyKill(3700, { name: 'weapon_ssg08', type: 'SniperRifle' }).noscope).toBe(true);
  });

  it('не снайперка — никогда не ноускоп', () => {
    const d = new MotionDetector();
    d.action('attack', 100);
    expect(d.classifyKill(300, RIFLE).noscope).toBe(false);
  });
});

describe('настройки CS2', () => {
  const KEYS = String.raw`"config"
{
	"bindings"
	{
		"MOUSE4"		"+jb_"
		"1"		"slot1"
		"q"		"lastinv"
		"r"		"+reload"
		"\"		"say ？？？"
		"ENTER"		"say Привет"
		"SPACE"		"+jump"
		"ALT"		"+lj"
		"MOUSE1"		"+attack; exec RifleCrosshair"
		"MOUSE2"		"+attack2; exec ExtraCrosshair1"
		"MWHEELUP"		"+jump"
		"MWHEELDOWN"		"+jump"
		"KP_3"		"+jump_"
	}
	"analogbindings"
	{
		"MOUSE_X"		"yaw"
	}
}`;
  const CONV = `"config"\n{\n\t"convars"\n\t{\n\t\t"m_yaw"\t\t"0.022"\n\t\t"sensitivity"\t\t"0.8"\n\t}\n}\n`;

  it('разбор биндов (в т.ч. бинд на обратный слэш и кириллица)', () => {
    const b = parseVcfg(KEYS).sections.bindings;
    expect(b['\\']).toBe('say ？？？');
    expect(b.ENTER).toBe('say Привет');
    const a = actionsFromBinds(b);
    expect(a.jump.sort()).toEqual(['ALT', 'KP_3', 'MOUSE4', 'MWHEELDOWN', 'MWHEELUP', 'SPACE'].sort());
    expect(a.attack).toEqual(['MOUSE1']);
    expect(a.attack2).toEqual(['MOUSE2']);
    expect(a.switch.sort()).toEqual(['1', 'q']);
    expect(a.reload).toEqual(['r']);
    expect(parseVcfg(KEYS).sections.analogbindings.MOUSE_X).toBe('yaw');
  });

  it('стандартные бинды, если файла нет', () => {
    const a = actionsFromBinds(DEFAULT_BINDS);
    expect(a.jump).toEqual(['SPACE']);
    expect(a.switch).toContain('MWHEELDOWN');
  });

  it('коды клавиш', () => {
    expect(resolveKey('SPACE')).toEqual({ kind: 'vk', code: 0x20 });
    expect(resolveKey('q')).toEqual({ kind: 'vk', code: 0x51 });
    expect(resolveKey('1')).toEqual({ kind: 'vk', code: 0x31 });
    expect(resolveKey('KP_3')).toEqual({ kind: 'vk', code: 0x63 });
    expect(resolveKey('F5')).toEqual({ kind: 'vk', code: 0x74 });
    expect(resolveKey('MOUSE4')).toEqual({ kind: 'mouse', button: '4' });
    expect(resolveKey('MWHEELDOWN')).toEqual({ kind: 'wheel', dir: 'D' });
    expect(resolveKey('\\')).toEqual({ kind: 'vk', code: 0xdc });
  });

  it('профиль из папки Steam по SteamID', () => {
    expect(accountIdFromSteamId64('76561198000000001')).toBe('39734273');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2tasks-steam-'));
    const dir = path.join(root, 'userdata', '39734273', '730', 'local', 'cfg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cs2_user_keys_0_slot0.vcfg'), KEYS);
    fs.writeFileSync(path.join(dir, 'cs2_user_convars_0_slot0.vcfg'), CONV);
    const p = loadCs2Profile({ steamId: '76561198000000001', steamRoots: [root] });
    expect(p).toMatchObject({ sensitivity: 0.8, yaw: 0.022, guessed: false, bindsFromFile: true });
    const guessed = loadCs2Profile({ steamId: null, steamRoots: [root] });
    expect(guessed.guessed).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('задания 360 / прыжок / ноускоп в программе', () => {
  const templates = { raw: [], ...validateTemplates(readJson(DEFAULT_TEMPLATES, [])) };
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };

  /** Поддельный сервис ввода с настоящим детектором. */
  function fakeInput(running = true) {
    const d = new MotionDetector({ degPerCount: DEG });
    return {
      detector: d,
      available: () => ({ running, spin: running }),
      classifyKill: (t, w) => d.classifyKill(t, w),
      onWeapon: (n, t) => d.weapon(n, t),
      publicState: () => ({ state: running ? 'running' : 'off' }),
      stop: async () => {},
    };
  }

  it('без работающего ввода такие задания не выпадают и не добавляются', () => {
    const core = new Core({ config: deepMerge(structuredClone(DEFAULT_CONFIG), { gsiToken: 't' }), templates, log: quiet, rng: mulberry32(1), input: fakeInput(false) });
    for (let s = 1; s <= 30; s++) {
      core.tasks.rng = mulberry32(s);
      core.tasks.tasks = [];
      core.ensureInitialTasks();
      expect(core.tasks.active().some((t) => ['spin_kills', 'jump_kills', 'noscope_kills'].includes(t.type))).toBe(false);
    }
    expect(() => core.tasks.add({ type: 'jump_kills', params: { count: 1 } })).toThrow(/мыши/);
  });

  it('убийство в прыжке после 360° засчитывает оба задания', () => {
    let now = 100_000;
    const input = fakeInput(true);
    const core = new Core({ config: deepMerge(structuredClone(DEFAULT_CONFIG), { gsiToken: 't', tasks: { autoGenerateOnMatchStart: false, count: 0 } }), templates, log: quiet, rng: mulberry32(1), input, now: () => now });
    core.ingest(raw({ roundPhase: 'live' }), (now += 100));
    const spin = core.tasks.add({ type: 'spin_kills', params: { count: 1 } });
    const jump = core.tasks.add({ type: 'jump_kills', params: { count: 2 } });
    const nos = core.tasks.add({ type: 'noscope_kills', params: { count: 1 } });
    core.ingest(raw({ roundPhase: 'live', weapons: [{ name: 'weapon_awp', type: 'SniperRifle', state: 'active', clip: 5 }] }), (now += 100));
    turn(input.detector, PER360 + 300, 350, now);
    now += 400;
    input.detector.action('jump', now);
    input.detector.action('attack', now + 200);
    core.ingest(raw({ roundPhase: 'live', roundKills: 1, kills: 1, weapons: [{ name: 'weapon_awp', type: 'SniperRifle', state: 'active', clip: 4 }] }), (now += 350));
    expect(core.tasks.get(spin.id).status).toBe('completed');
    expect(core.tasks.get(jump.id).progress).toBe(1);
    expect(core.tasks.get(nos.id).status).toBe('completed'); // AWP без ПКМ
  });
});

describe('миграция шаблонов', () => {
  it('дописывает новые типы в старый templates.json один раз', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2tasks-tpl-'));
    const old = [{ type: 'kills', weight: 1, difficulty: 'easy', params: { count: [5, 10] } }];
    fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify(old));
    expect(migrateTemplates(dir, 1)).toBe(51);
    const after = readJson(path.join(dir, 'templates.json'), []);
    expect(after[0]).toEqual(old[0]);
    expect(after.map((t) => t.type)).toEqual(expect.arrayContaining(['spin_kills', 'jump_kills', 'noscope_kills']));
    expect(migrateTemplates(dir, 1)).toBe(0); // повторно не дублирует
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
