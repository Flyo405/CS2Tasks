// Названия клавиш CS2 (как в cs2_user_keys_*.vcfg) → источник ввода в Windows.
//   { kind: 'vk', code }       — клавиша клавиатуры (виртуальный код Windows)
//   { kind: 'mouse', button }  — кнопка мыши L/R/M/4/5
//   { kind: 'wheel', dir }     — колёсико U/D

const VK = {
  SPACE: 0x20, TAB: 0x09, ENTER: 0x0d, ESCAPE: 0x1b, BACKSPACE: 0x08,
  SHIFT: 0x10, CTRL: 0x11, ALT: 0x12, RSHIFT: 0xa1, RCTRL: 0xa3, RALT: 0xa5,
  CAPSLOCK: 0x14, DEL: 0x2e, INS: 0x2d, HOME: 0x24, END: 0x23, PGUP: 0x21, PGDN: 0x22,
  LEFTARROW: 0x25, UPARROW: 0x26, RIGHTARROW: 0x27, DOWNARROW: 0x28,
  PAUSE: 0x13, NUMLOCK: 0x90, SCROLLLOCK: 0x91,
  ',': 0xbc, '.': 0xbe, '/': 0xbf, ';': 0xba, SEMICOLON: 0xba, "'": 0xde, '[': 0xdb, ']': 0xdd,
  '\\': 0xdc, '-': 0xbd, '=': 0xbb, '`': 0xc0,
  KP_ENTER: 0x0d, KP_PLUS: 0x6b, KP_MINUS: 0x6d, KP_MULTIPLY: 0x6a, KP_SLASH: 0x6f, KP_DEL: 0x6e,
  // Цифровой блок в «навигационных» названиях
  KP_INS: 0x60, KP_END: 0x61, KP_DOWNARROW: 0x62, KP_PGDN: 0x63, KP_LEFTARROW: 0x64,
  KP_RIGHTARROW: 0x66, KP_HOME: 0x67, KP_UPARROW: 0x68, KP_PGUP: 0x69,
};

const MOUSE = { MOUSE1: 'L', MOUSE2: 'R', MOUSE3: 'M', MOUSE4: '4', MOUSE5: '5' };

export function resolveKey(name) {
  if (typeof name !== 'string' || !name) return null;
  const up = name.toUpperCase();
  if (MOUSE[up]) return { kind: 'mouse', button: MOUSE[up] };
  if (up === 'MWHEELUP') return { kind: 'wheel', dir: 'U' };
  if (up === 'MWHEELDOWN') return { kind: 'wheel', dir: 'D' };
  if (/^[A-Z]$/.test(up)) return { kind: 'vk', code: up.charCodeAt(0) };
  if (/^[0-9]$/.test(up)) return { kind: 'vk', code: up.charCodeAt(0) };
  let m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(up);
  if (m) return { kind: 'vk', code: 0x6f + Number(m[1]) };
  m = /^KP_([0-9])$/.exec(up);
  if (m) return { kind: 'vk', code: 0x60 + Number(m[1]) };
  if (VK[up] != null) return { kind: 'vk', code: VK[up] };
  if (VK[name] != null) return { kind: 'vk', code: VK[name] };
  if (up === 'KP_5') return { kind: 'vk', code: 0x65 };
  return null;
}

/** Обратное: строка события помощника → название клавиши CS2. */
export function mouseButtonName(button) {
  return Object.keys(MOUSE).find((k) => MOUSE[k] === button) || null;
}

export function wheelName(dir) {
  return dir === 'U' ? 'MWHEELUP' : dir === 'D' ? 'MWHEELDOWN' : null;
}
