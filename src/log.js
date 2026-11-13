const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let current = LEVELS.info;

export function setLogLevel(level) {
  current = LEVELS[level] ?? LEVELS.info;
}

function ts() {
  return new Date().toLocaleTimeString('ru-RU');
}

export const log = {
  debug: (...a) => current <= LEVELS.debug && console.log(`[${ts()}] [debug]`, ...a),
  info: (...a) => current <= LEVELS.info && console.log(`[${ts()}]`, ...a),
  warn: (...a) => current <= LEVELS.warn && console.warn(`[${ts()}] [!]`, ...a),
  error: (...a) => console.error(`[${ts()}] [ОШИБКА]`, ...a),
};
