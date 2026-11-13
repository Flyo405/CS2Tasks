// Очередь предложений зрителей: кулдауны, лимиты, одно ожидающее на пользователя.
import { randomUUID } from 'node:crypto';
import { normalizeParams, titleFor, getType } from '../tasks/taskTypes.js';

export class Suggestions {
  constructor({ getConfig, initial = [], now = () => Date.now() }) {
    this.getConfig = getConfig;
    this.now = now;
    this.queue = Array.isArray(initial) ? initial : [];
    this.lastAt = new Map();
  }

  serialize() {
    return this.queue;
  }

  /** Возвращает { ok: true, item } или { ok: false, error }. */
  propose({ user, displayName, type, params }) {
    const cfg = this.getConfig().twitch;
    const u = String(user || '').toLowerCase();
    if (!u) return { ok: false, error: 'неизвестный пользователь' };
    const now = this.now();
    const last = this.lastAt.get(u);
    const cd = cfg.cooldownSec * 1000;
    if (last && now - last < cd) return { ok: false, error: `подожди ещё ${Math.ceil((cd - (now - last)) / 1000)} с` };
    if (this.queue.some((s) => s.user === u)) return { ok: false, error: 'твоё прошлое предложение ещё ждёт модерации' };
    if (this.queue.length >= cfg.maxQueue) return { ok: false, error: 'очередь предложений заполнена, попробуй позже' };
    if (!getType(type)) return { ok: false, error: 'неизвестный тип задания' };
    let norm;
    try {
      norm = normalizeParams(type, params);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const item = { id: randomUUID(), user: u, displayName: displayName || u, type, params: norm, title: titleFor(type, norm), createdAt: now };
    this.queue.push(item);
    this.lastAt.set(u, now);
    return { ok: true, item };
  }

  get(id) {
    return this.queue.find((s) => s.id === id) || null;
  }

  take(id) {
    const item = this.get(id);
    if (item) this.queue = this.queue.filter((s) => s !== item);
    return item;
  }

  putBack(item) {
    if (!this.get(item.id)) this.queue.unshift(item);
  }
}
