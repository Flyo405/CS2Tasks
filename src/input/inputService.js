// Запуск помощника ввода (cs2tasks-input.exe), разбор его вывода и распознавание 360 / прыжка / прицела.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { IS_SEA, ROOT, readAsset } from '../paths.js';
import { findSteamRoots } from '../gsi/installer.js';
import { MotionDetector, STANCE_KEYS } from './detector.js';
import { loadCs2Profile, actionsFromBinds } from './cs2profile.js';
import { resolveKey } from './keymap.js';

export const HELPER_ASSET = 'bin/cs2tasks-input.exe';
const PROFILE_CHECK_MS = 30_000;

/** Где лежит помощник: в exe — распаковывается в data/bin, при разработке — build/. */
export async function resolveHelperPath(dataDir, log) {
  if (IS_SEA) {
    const buf = readAsset(HELPER_ASSET);
    if (!buf) return null;
    const target = path.join(dataDir, 'bin', 'cs2tasks-input-v4.exe');
    let same = false;
    try {
      const cur = fs.readFileSync(target);
      same = crypto.createHash('sha1').update(cur).digest('hex') === crypto.createHash('sha1').update(buf).digest('hex');
    } catch { /* ещё нет */ }
    if (!same) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
      } catch (e) {
        log?.warn?.(`Не удалось распаковать помощник ввода: ${e.message}`);
        if (!fs.existsSync(target)) return null;
      }
    }
    return target;
  }
  const dev = path.join(ROOT, 'build', 'cs2tasks-input.exe');
  if (fs.existsSync(dev)) return dev;
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, 'tools', 'build-input.js')).href);
    return mod.buildInputHelper({ quiet: true });
  } catch (e) {
    log?.warn?.(`Помощник ввода не собран (${e.message}). Выполните: node tools/build-input.js`);
    return null;
  }
}

export class InputService {
  /**
   * @param {object} o
   * @param {() => object} o.getConfig
   * @param {() => string|null} o.getSteamId — SteamID стримера из GSI
   * @param {string} o.dataDir
   * @param {(kind: string, info: object) => void} o.onEvent — spin / jump / zoom / status
   */
  constructor({ getConfig, getSteamId = () => null, dataDir, log, onEvent = () => {}, now = () => Date.now() }) {
    Object.assign(this, { getConfig, getSteamId, dataDir, log, onEvent, now });
    this.detector = new MotionDetector();
    this.proc = null;
    this.stopping = false;
    this.restartTimer = null;
    this.profileTimer = null;
    this.profile = null;
    this.actions = null;
    this.lastMouseAt = null;
    this.vkActions = new Map();
    this.status = { state: 'off', error: null, focus: false, helper: null };
  }

  get cfg() {
    return this.getConfig().input;
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.onEvent('status', this.status);
  }

  /** Чувствительность: из настроек программы или из конфига CS2. */
  sensitivity() {
    if (this.cfg.sensitivity > 0) return { value: this.cfg.sensitivity, source: 'manual' };
    if (this.profile?.sensitivity) return { value: this.profile.sensitivity, source: 'cs2' };
    return { value: null, source: null };
  }

  applySettings() {
    const sens = this.sensitivity();
    const yaw = this.profile?.yaw || 0.022;
    this.detector.setSettings({
      degPerCount: sens.value ? sens.value * yaw : 0,
      pitchPerCount: sens.value ? sens.value * (this.profile?.pitch ?? 0.022) : 0,
      spinWithinMs: this.cfg.spinWithinMs,
      killAfterSpinMs: this.cfg.killAfterSpinMs,
      jumpKillMs: this.cfg.jumpKillMs,
    });
  }

  async loadProfile() {
    try {
      this.profile = loadCs2Profile({ steamId: this.getSteamId(), steamRoots: await findSteamRoots() });
    } catch (e) {
      this.log.warn('Не удалось прочитать настройки CS2:', e.message);
      this.profile = null;
    }
    this.actions = actionsFromBinds(this.profile?.binds);
    this.vkActions = new Map();
    this.mouseActions = new Map();
    for (const [action, keys] of Object.entries(this.actions)) {
      for (const k of keys) {
        const r = resolveKey(k);
        if (!r) continue;
        const map = r.kind === 'vk' ? this.vkActions : this.mouseActions;
        const id = r.kind === 'vk' ? r.code : r.kind === 'mouse' ? `B${r.button}` : `W${r.dir}`;
        if (!map.has(id)) map.set(id, new Set());
        map.get(id).add(action);
      }
    }
    this.applySettings();
  }

  vkList() {
    return [...new Set([...this.vkActions.keys(), ...STANCE_KEYS])].sort((a, b) => a - b).join(',');
  }

  async start() {
    this.stopping = false;
    if (!this.cfg.enabled) { this.setStatus({ state: 'off', error: null }); return; }
    if (process.platform !== 'win32') { this.setStatus({ state: 'unavailable', error: 'Только для Windows' }); return; }
    this.setStatus({ state: 'starting', error: null });
    await this.loadProfile();
    const helper = await resolveHelperPath(this.dataDir, this.log);
    if (!helper) { this.setStatus({ state: 'error', error: 'Помощник ввода не найден' }); return; }
    this.helperPath = helper;
    this.spawnHelper();
    clearInterval(this.profileTimer);
    this.profileTimer = setInterval(() => this.checkProfile(), PROFILE_CHECK_MS);
  }

  spawnHelper() {
    if (this.stopping) return;
    this.detector.focus(false);
    const vks = this.vkList();
    this.spawnedVks = vks;
    let proc;
    try {
      proc = spawn(this.helperPath, [vks], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.setStatus({ state: 'error', error: e.message });
      return;
    }
    this.proc = proc;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.handleLine(line, this.now());
      }
    });
    proc.stderr.on('data', (d) => this.log.debug('input helper:', String(d).trim()));
    proc.on('error', (e) => {
      this.setStatus({ state: 'error', error: e.message });
    });
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      if (this.stopping) return;
      this.setStatus({ state: 'error', error: `Помощник ввода завершился (код ${code}), перезапуск…`, focus: false });
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.spawnHelper(), 5000);
    });
  }

  handleLine(line, t) {
    const [kind, a, b] = line.split(' ');
    const d = this.detector;
    switch (kind) {
      case 'READY':
        this.setStatus({ state: 'running', error: null });
        this.log.info('Мышь и клавиатура: слушаю ввод, пока CS2 в фокусе (360, прыжок, ноускоп)');
        return;
      case 'ERROR':
        this.setStatus({ state: 'error', error: line.slice(6) });
        // Повреждённый HWND повторной регистрацией не восстановить.
        // Перезапуск создаст новое окно; exit-обработчик повторит запуск.
        if (line.startsWith('ERROR raw input 87')) this.proc?.kill();
        return;
      case 'F':
        d.focus(a === '1', t);
        this.setStatus({ focus: a === '1' });
        return;
      case 'M': {
        this.lastMouseAt = t;
        // Реальное движение подтверждает восстановление после временной ошибки
        // Raw Input, даже если помощник старой версии не прислал повторный READY.
        if (this.status.state === 'error' && this.status.error?.startsWith('raw input ')) {
          this.setStatus({ state: 'running', error: null });
        }
        const before = d.peakTurn.deg;
        const spin = d.mouse(Number(a), t, Number(b) || 0);
        if (spin) this.onEvent('spin', spin);
        else if (Math.abs(d.peakTurn.deg - before) >= 30) this.onEvent('turn', d.peakTurn); // живое значение для панели
        return;
      }
      case 'B':
        this.button(this.mouseActions?.get(`B${a}`), b === '1', t);
        return;
      case 'W':
        this.fire(this.mouseActions.get(`W${a}`), t);
        return;
      case 'K':
        d.key(Number(a), b === '1', t);
        this.button(this.vkActions.get(Number(a)), b === '1', t);
        return;
      default:
    }
  }

  button(actions, down, t) {
    if (down) this.fire(actions, t);
    else if (actions?.has('attack')) this.detector.releaseAttack(t);
  }

  fire(actions, t) {
    if (!actions) return;
    const zoomBefore = this.detector.zoom;
    for (const a of actions) {
      this.detector.action(a, t);
      if (a === 'jump') this.onEvent('jump', { at: t });
      if (a === 'inspect' || a === 'graffiti') this.onEvent(a, { at: t });
    }
    if (this.detector.zoom !== zoomBefore) this.onEvent('zoom', { level: this.detector.zoom });
  }

  async checkProfile() {
    const before = this.profile?.mtime;
    const beforeSteam = this.profile?.accountId;
    await this.loadProfile();
    if (this.profile?.mtime === before && this.profile?.accountId === beforeSteam) return;
    this.onEvent('status', this.status);
    if (this.vkList() !== this.spawnedVks && this.proc) {
      this.log.info('Бинды CS2 изменились — перезапускаю помощник ввода');
      this.proc.kill();
    }
  }

  /** Вызывается при первом пакете GSI со SteamID — уточняем, чьи настройки читать. */
  async onSteamId() {
    if (this.profile && !this.profile.guessed) return;
    await this.checkProfile();
  }

  onWeapon(name, t) {
    const before = this.detector.zoom;
    this.detector.weapon(name, t);
    if (this.detector.zoom !== before) this.onEvent('zoom', { level: this.detector.zoom });
  }

  classifyKill(t, weapon, event) {
    return this.detector.classifyKill(t, weapon, event);
  }

  /** Доступны ли признаки: running — помощник работает; spin — ещё и чувствительность известна. */
  available() {
    const running = this.status.state === 'running';
    return { running, spin: running && this.detector.settings.degPerCount > 0 };
  }

  publicState() {
    const sens = this.sensitivity();
    const d = this.detector;
    const spin = d.lastSpin();
    return {
      enabled: !!this.cfg.enabled,
      state: this.status.state,
      error: this.status.error,
      focus: !!this.status.focus,
      sensitivity: sens.value,
      sensitivitySource: sens.source,
      yaw: this.profile?.yaw ?? null,
      countsPer360: d.settings.degPerCount ? Math.round(360 / d.settings.degPerCount) : null,
      profileDir: this.profile?.dir ?? null,
      bindsFromFile: !!this.profile?.bindsFromFile,
      jumpKeys: this.actions?.jump ?? [],
      lastSpin: spin,
      lastMouseAt: this.lastMouseAt,
      lastAttackTurn: d.lastAttackTurn,
      lastJumpAt: d.lastJump(),
      zoom: d.zoom,
      peakTurn: d.peakTurn,
    };
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearInterval(this.profileTimer);
    const p = this.proc;
    this.proc = null;
    if (p) {
      try { p.stdin.end(); } catch { /* уже закрыт */ }
      setTimeout(() => { try { p.kill(); } catch { /* уже вышел */ } }, 500);
    }
    this.setStatus({ state: 'off', focus: false });
  }
}
