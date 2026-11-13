// Чтение и атомарная запись JSON (tmp + rename), чтобы файл не бился при падении.
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

export function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`Не удалось прочитать ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`Файл ${file} содержит некорректный JSON: ${e.message}`);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  // На Windows антивирус или индексатор иногда держат файл — повторяем.
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
      sleepSync(25 * (i + 1));
    }
  }
}

/** Отложенное сохранение: много изменений подряд → одна запись. */
export function createSaver(file, getData, delayMs = 400) {
  let timer = null;
  const save = () => {
    try {
      writeJsonAtomic(file, getData());
    } catch (e) {
      log.error(`Не удалось сохранить ${path.basename(file)}:`, e.message);
    }
  };
  return {
    schedule() {
      if (timer) return;
      timer = setTimeout(() => { timer = null; save(); }, delayMs);
    },
    now() {
      if (timer) { clearTimeout(timer); timer = null; }
      save();
    },
    cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
