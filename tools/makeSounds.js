// Синтезирует стандартные звуки (без чужих сэмплов): sounds/skip-synth.wav и sounds/complete-synth.wav (запасные).
// skip — «грустный тромбон» (wah-wah-wah-waaah), complete — короткое восходящее арпеджио.
import fs from 'node:fs';
import path from 'node:path';
import { SOUNDS_DIR } from '../src/paths.js';

const RATE = 22050;

function writeWav(file, samples) {
  const data = Buffer.alloc(samples.length * 2);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const k = peak > 0 ? 0.89 / peak : 1;
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s * k)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

function trombone() {
  // D4, C#4, C4, B3 (последняя длинная, с вибрато) — классический «провал».
  const notes = [[62, 0.42], [61, 0.42], [60, 0.42], [59, 1.5]];
  const out = [];
  let phase = 0;
  notes.forEach(([n, dur], idx) => {
    const len = Math.floor(dur * RATE);
    const last = idx === notes.length - 1;
    for (let i = 0; i < len; i++) {
      const t = i / RATE;
      // Нота «подъезжает» снизу, на последней — вибрато и сползание вниз.
      let f = midi(n) * (1 - 0.03 * Math.exp(-t * 18));
      if (last) f *= 1 + 0.018 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t * 2) - 0.035 * Math.max(0, t - 0.9);
      phase += (2 * Math.PI * f) / RATE;
      // «Вау»: яркость (вес гармоник) растёт и спадает внутри ноты.
      const bright = 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, t / (dur * 0.9)));
      let s = 0;
      for (let h = 1; h <= 9; h++) s += (Math.sin(phase * h) / h) * bright ** (h - 1);
      const attack = Math.min(1, t / 0.03);
      const release = Math.min(1, (dur - t) / (last ? 0.5 : 0.06));
      out.push(s * attack * release * 0.5);
    }
  });
  return out;
}

function chime() {
  const notes = [72, 76, 79, 84]; // C5 E5 G5 C6
  const total = Math.floor(1.1 * RATE);
  const out = new Array(total).fill(0);
  notes.forEach((n, idx) => {
    const start = Math.floor(idx * 0.085 * RATE);
    const f = midi(n);
    for (let i = start; i < total; i++) {
      const t = (i - start) / RATE;
      const env = Math.exp(-t * (idx === 3 ? 3.2 : 6)) * Math.min(1, t / 0.004);
      out[i] += (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 2 * t) + 0.12 * Math.sin(2 * Math.PI * f * 3.01 * t)) * env * 0.4;
    }
  });
  return out;
}

fs.mkdirSync(SOUNDS_DIR, { recursive: true });
writeWav(path.join(SOUNDS_DIR, 'skip-synth.wav'), trombone());
writeWav(path.join(SOUNDS_DIR, 'complete-synth.wav'), chime());
console.log('Готово: sounds/skip-synth.wav, sounds/complete-synth.wav');
