// Распознавание по вводу мыши и клавиатуры (без доступа к игре):
//   - разворот на 360°: сумма горизонтального движения мыши × sensitivity × m_yaw за короткое время;
//   - прыжок: нажатие клавиши, на которую в CS2 забинден прыжок;
//   - прицел снайперки: правая кнопка циклически переключает зум 0 → 1 → 2 → 0,
//     смена оружия и перезарядка сбрасывают его в 0.
// Убийство из GSI приходит с задержкой (~0,1–0,3 с), поэтому момент убийства берётся
// по последнему нажатию атаки перед ним.

export const DEFAULT_MOTION = {
  spinWithinMs: 1000, // 360° нужно успеть провернуть за это время
  killAfterSpinMs: 1000, // и после этого убить в течение этого времени
  jumpKillMs: 750, // убийство засчитывается «в прыжке», если с прыжка прошло не больше
  latencyMs: 300, // запас на задержку GSI, если нажатия атаки не было
};

const FLICK_WINDOW_MS = 450;
const FLICK_GSI_WINDOW_MS = 1000;
const ATTACK_GAP_MS = 500;
const TAP_HOLD_MS = 100;
const MOVEMENT_KEYS = [65, 68, 83, 87]; // A, D, S, W
const SHIFT_KEYS = [16, 161];
const ANGLE_CORRECTION_MS = 350;
const ANGLE_HOLD_MS = 2000;
export const STANCE_KEYS = [17, 163, ...SHIFT_KEYS, ...MOVEMENT_KEYS];

export class MotionDetector {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_MOTION, degPerCount: 0, ...settings };
    this.reset();
  }

  setSettings(settings) {
    const prevDeg = this.settings.degPerCount;
    this.settings = { ...this.settings, ...settings };
    if (prevDeg !== this.settings.degPerCount) this.resetSpin();
  }

  reset() {
    this.resetSpin();
    this.spins = [];
    this.jumps = [];
    this.reloads = [];
    this.shots = [];
    this.attack = null;
    this.keys = new Set();
    this.focusSince = null;
    this.lastWrongDirection = -Infinity;
    this.lastRun = -Infinity;
    this.lastWalk = -Infinity;
    this.lastForward = -Infinity;
    this.lastDrop = null;
    this.lastAttackTurn = null;
    this.zoom = 0;
    this.zoomHistory = [{ t: -Infinity, level: 0 }];
    this.lastSwitchAt = -Infinity;
    this.weaponName = null;
    this.peakTurn = { deg: 0, at: 0 };
  }

  resetSpin() {
    this.cum = 0;
    this.samples = [];
    this.flickSamples = [];
    this.flickAttackAt = null;
    this.angleSamples = [];
  }

  /** Горизонтальное движение мыши (в «сырых» отсчётах). Возвращает спин, если он только что завершился. */
  mouse(dx, t, dy = 0) {
    const k = this.settings.degPerCount;
    if (!k || (!dx && !dy)) return null;
    this.angleSamples.push({ t, degrees: Math.hypot(dx, dy) * k });
    while (this.angleSamples[0].t < t - ANGLE_HOLD_MS - ANGLE_CORRECTION_MS) this.angleSamples.shift();
    this.flickSamples.push({ t, yaw: dx * k, pitch: dy * (this.settings.pitchPerCount || k) });
    while (this.flickSamples[0].t <= t - FLICK_WINDOW_MS) this.flickSamples.shift();
    if (!dx) return null;
    // Исходная точка перед первым движением — иначе первая порция поворота теряется.
    if (!this.samples.length) this.samples.push({ t, cum: this.cum });
    this.cum += dx * k;
    // Распознанный разворот фиксируется: последующее наведение его не отменяет.
    this.samples.push({ t, cum: this.cum });
    const from = t - this.settings.spinWithinMs;
    // Оставляем одну точку на границе окна: она хранит положение на момент его начала.
    while (this.samples.length > 1 && this.samples[1].t <= from) this.samples.shift();
    let min = this.samples[0];
    let max = this.samples[0];
    for (const s of this.samples) {
      if (s.cum < min.cum) min = s;
      if (s.cum > max.cum) max = s;
    }
    const right = this.cum - min.cum;
    const left = max.cum - this.cum;
    const turn = Math.max(right, left);
    if (turn > this.peakTurn.deg || t - this.peakTurn.at > 3000) this.peakTurn = { deg: Math.round(turn), at: t };
    if (turn >= 320 - 1e-6 && turn <= 400 + 1e-6) {
      const start = right >= left ? min : max;
      const spin = { at: t, deg: Math.round(right >= left ? right : -left), ms: Math.max(0, t - start.t) };
      this.spins.push(spin);
      if (this.spins.length > 20) this.spins.shift();
      this.samples = [{ t, cum: this.cum }];
      return spin;
    }
    return null;
  }

  /** Действие по биндам: jump / attack / attack2 / switch / reload. */
  action(name, t) {
    switch (name) {
      case 'jump':
        this.jumps.push(t);
        if (this.jumps.length > 50) this.jumps.shift();
        return;
      case 'attack':
      case 'attack2':
        if (name === 'attack') this.recordAttack(t);
        this.shots.push({ t, kind: name });
        if (this.shots.length > 50) this.shots.shift();
        if (name === 'attack2') this.setZoom((this.zoom + 1) % 3, t);
        return;
      case 'switch':
        this.lastSwitchAt = t;
        this.setZoom(0, t);
        return;
      case 'reload':
        this.reloads.push(t);
        if (this.reloads.length > 50) this.reloads.shift();
        this.setZoom(0, t);
        return;
      case 'drop':
        this.lastDrop = t;
        return;
      default:
    }
  }

  key(code, down, t) {
    this.trackMovement(t);
    if (down) this.keys.add(code);
    else this.keys.delete(code);
    this.trackMovement(t);
  }

  trackMovement(t) {
    if (this.keys.has(87)) this.lastForward = t;
    if (MOVEMENT_KEYS.some((code) => code !== 87 && this.keys.has(code))) this.lastWrongDirection = t;
    if (MOVEMENT_KEYS.some((code) => this.keys.has(code))) {
      if (SHIFT_KEYS.some((code) => this.keys.has(code))) this.lastWalk = t;
      else this.lastRun = t;
    }
  }

  roundMovement(start, end) {
    if (start == null || this.focusSince == null || this.focusSince > start) return {};
    this.trackMovement(end);
    return { forwardOnly: this.lastForward >= start && this.lastWrongDirection < start,
      walkOnly: this.lastWalk >= start && this.lastRun < start };
  }

  consumeDrop(t) {
    if (this.lastDrop == null || t - this.lastDrop > 1500 || t < this.lastDrop) return false;
    this.lastDrop = null;
    return true;
  }

  heldAngle(t) {
    const correctionStart = t - ANGLE_CORRECTION_MS;
    const holdStart = correctionStart - ANGLE_HOLD_MS;
    if (!this.settings.degPerCount || this.focusSince == null || this.focusSince > holdStart) return false;
    let quiet = 0;
    let correction = 0;
    for (const sample of this.angleSamples) {
      if (sample.t >= correctionStart) correction += sample.degrees;
      else if (sample.t >= holdStart) quiet += sample.degrees;
    }
    return quiet <= 1 && correction <= 7;
  }

  recordAttack(t) {
    const previous = this.attack;
    const gap = previous && t - (previous.releasedAt ?? previous.t);
    const clicks = previous && gap < ATTACK_GAP_MS ? previous.clicks + 1 : 1;
    let yaw = 0, pitch = 0, turn = 0;
    for (let i = this.flickSamples.length - 1; i >= 0; i--) {
      const sample = this.flickSamples[i];
      if (t - sample.t >= FLICK_WINDOW_MS) break;
      yaw += sample.yaw;
      pitch += sample.pitch;
      turn = Math.max(turn, Math.hypot(yaw, pitch));
    }
    const flick = turn >= 45 - 1e-6;
    this.lastAttackTurn = { at: t, degrees: Math.round(turn), flick };
    if (flick) {
      this.flickAttackAt = t;
      this.flickSamples = [];
    }
    this.attack = {
      t, clicks, heldAngle: this.heldAngle(t),
      crouched: this.keys.has(17) || this.keys.has(163),
      stationary: !MOVEMENT_KEYS.some((code) => this.keys.has(code)),
      used: false,
    };
  }

  releaseAttack(t) {
    if (this.attack && this.attack.releasedAt == null) this.attack.releasedAt = t;
  }

  /** Активное оружие из GSI (приходит с задержкой). Смена оружия сбрасывает прицел. */
  weapon(name, t) {
    if (!name || name === this.weaponName) return;
    const first = this.weaponName == null;
    this.weaponName = name;
    if (first) return;
    // Если смену уже увидели по клавише — не сбрасываем повторно (могли успеть открыть прицел).
    if (t - this.lastSwitchAt < 800) return;
    const lastZoomChange = this.zoomHistory[this.zoomHistory.length - 1];
    if (t - lastZoomChange.t < 400) return;
    this.setZoom(0, t);
  }

  focus(on, t) {
    if (on) this.focusSince ??= t;
    else {
      this.focusSince = null;
      this.resetSpin();
      this.keys.clear();
      this.attack = null;
      this.lastDrop = null;
    }
  }

  setZoom(level, t) {
    if (level === this.zoom) return;
    this.zoom = level;
    this.zoomHistory.push({ t, level });
    if (this.zoomHistory.length > 100) this.zoomHistory.splice(1, 1);
  }

  zoomAt(t) {
    let level = 0;
    for (const z of this.zoomHistory) {
      if (z.t <= t) level = z.level;
      else break;
    }
    return level;
  }

  /** Момент выстрела, которым, вероятно, сделано убийство, полученное из GSI в момент t. */
  shotTime(t) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      if (s.t <= t && t - s.t <= 1500) return s.t;
      if (s.t < t - 1500) break;
    }
    return t - this.settings.latencyMs / 2;
  }

  /** Сопоставляет убийство с последним подходящим нажатием атаки. */
  classifyKill(t, weapon, { count = 1, ammoSpent = null } = {}) {
    const shotT = this.shotTime(t);
    const spin = this.spins.some((s) => s.at <= shotT + 60 && shotT - s.at <= this.settings.killAfterSpinMs);
    const jump = this.jumps.some((j) => j <= shotT + 30 && shotT - j <= this.settings.jumpKillMs);
    const noscope = weapon?.type === 'SniperRifle' ? this.zoomAt(shotT - 5) === 0 : false;
    const result = { spin, jump, noscope, shotT };
    const firearm = weapon?.type && !['Knife', 'Grenade', 'C4'].includes(weapon.type);
    if (firearm && this.flickAttackAt != null && t >= this.flickAttackAt) {
      result.flick = t - this.flickAttackAt <= FLICK_GSI_WINDOW_MS;
      this.flickAttackAt = null;
    }
    const attack = this.attack;
    const age = attack ? t - attack.t : Infinity;
    const freshAttack = attack && !attack.used && age >= 0 && age <= this.settings.latencyMs + 150;
    if (!freshAttack) return result;
    attack.used = true;
    if (count !== 1 || !firearm) return result;
    const hold = Math.min(t, attack.releasedAt ?? t) - attack.t;
    const singleShot = attack.clicks === 1 && hold <= TAP_HOLD_MS && (ammoSpent == null || ammoSpent <= 1);
    return { ...result, flick: result.flick ?? false, heldAngle: attack.heldAngle, crouched: attack.crouched,
      stationary: attack.stationary, oneTap: singleShot };
  }

  lastSpin() {
    return this.spins[this.spins.length - 1] || null;
  }

  lastJump() {
    return this.jumps[this.jumps.length - 1] ?? null;
  }
}
