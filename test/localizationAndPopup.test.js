import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { localizeTask, localizeTypes, translate } from '../src/i18n.js';
import { describeTypes, buildTask, normalizeParams } from '../src/tasks/taskTypes.js';
import { canShowBonus } from '../public/bonuses/timing.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('language projection', () => {
  it('translates every type, default title, and parameter label', () => {
    for (const type of localizeTypes(describeTypes(), 'en')) {
      expect(type.name).not.toMatch(/[а-яё]/i);
      const defaults = type.manual ? { text: 'Custom challenge' } : {};
      const task = buildTask(type.id, normalizeParams(type.id, defaults));
      expect(localizeTask(task, 'en').title).not.toMatch(/[а-яё]/i);
      for (const param of Object.values(type.params)) {
        expect(param.label).not.toMatch(/[а-яё]/i);
        for (const option of param.options ?? []) expect(option.label).not.toMatch(/[а-яё]/i);
      }
    }
  });
  it.each(['panel', 'overlay', 'bonuses', 'summary'])('translates static labels and hints in %s', (page) => {
    const html = fs.readFileSync(new URL(`../public/${page}/index.html`, import.meta.url), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '');
    for (const match of html.matchAll(/(?:title|placeholder|aria-label)="([^"]+)"|>([^<>]+)</g)) {
      const label = (match[1] ?? match[2]).trim();
      if (/[а-яё]/i.test(label)) expect(translate(label, 'en'), label).not.toMatch(/[а-яё]/i);
    }
  });
  it('translates runtime feedback and old K/D history entries', () => {
    expect(translate('Шаблон #2 (kills): count: значение 100 вне пределов 1..60', 'en'))
      .toBe('Template #2 (kills): count: value 100 is outside 1..60');
    expect(translate('Чат: #channel (чтение)', 'en')).toBe('Chat: #channel (read-only)');
    expect(localizeTask({ type: 'positive_kd', params: { kd: 1.2 }, title: 'Старое задание' }, 'en').title)
      .toBe('Finish the match with K/D ≥ 1.20');
    expect(localizeTask({ type: 'manual', test: true, title: 'Тест: выполнить задание' }, 'en').title)
      .toBe('Test: complete a challenge');
  });
  it('preserves task identity, progress and the stored Russian title', () => {
    const task = buildTask('kills', { count: 10 });
    task.progress = 4;
    const original = task.title;
    expect(localizeTask(task, 'en')).toMatchObject({ id: task.id, progress: 4, title: '10 kills this match' });
    expect(task.title).toBe(original);
    expect(localizeTask(task, 'ru').title).toBe(original);
  });
  it('leaves viewer-authored custom text unchanged', () => {
    const task = buildTask('manual', { text: 'Матч', count: 1 });
    expect(localizeTask(task, 'en').title).toBe(task.title);
  });
});

describe('delayed bonus rendering', () => {
  function renderer() {
    const nodes = new Map();
    const animations = [];
    const element = () => ({ style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, replaceChildren() {},
      animate(frames, options) { animations.push(options); this.lastAnimation = { cancel() {} }; return this.lastAnimation; } });
    let socket;
    const context = { locale: { setLanguage() {}, t: (text) => text }, canShowBonus,
      renderBingo(node, board) { node.hidden = !board; node.board = board; },
      document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
        documentElement: element(), createElement: element },
      location: { protocol: 'http:', host: 'localhost' },
      WebSocket: class { constructor() { socket = this; } },
      setTimeout() { return 1; }, clearTimeout() {}, Date, Set, JSON,
    };
    vm.runInNewContext(fs.readFileSync(new URL('../public/bonuses/bonuses.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, ''), context);
    return { send: (m) => socket.onmessage({ data: JSON.stringify(m) }), animations, nodes };
  }
  const popup = (age = 3000) => ({ id: 'session:1', at: Date.now() - age, points: 150, parts: [], bonusCount: 0 });
  const state = (lastPopup = null) => ({ type: 'state', state: { serverTime: Date.now(),
    settings: { language: 'en', bonuses: DEFAULT_CONFIG.bonuses }, bonuses: { total: 150, lastPopup } } });
  it('shows a delayed event for the full animation instead of dropping it', () => {
    const r = renderer(); r.send(state()); r.send({ type: 'event', kind: 'kill_bonus', popup: popup() });
    expect(r.animations).toHaveLength(1);
    expect(r.animations[0].duration).toBe(1550);
    expect(r.nodes.get('popup').hidden).toBe(false);
  });
  it('recovers a missing event from later state and deduplicates the event', () => {
    const r = renderer(), p = popup(); r.send(state()); r.send(state(p));
    r.send({ type: 'event', kind: 'kill_bonus', popup: p }); r.send(state(p));
    expect(r.animations).toHaveLength(1);
    expect(r.nodes.get('total').textContent).toBe(150);
  });
  it('does not replay stale bonuses when opening the overlay much later', () => {
    const r = renderer(); r.send(state(popup(30000)));
    expect(r.animations).toHaveLength(0);
  });
  it('hides match score and animations in the lobby, then restores the score on return', () => {
    const r = renderer(), p = popup();
    r.send(state(p));
    const lobby = state(p);
    lobby.state.gsi = { inMenu: true };
    r.send(lobby);
    expect(r.nodes.get('session-score').hidden).toBe(true);
    expect(r.nodes.get('popup').hidden).toBe(true);
    r.send({ type: 'event', kind: 'kill_bonus', popup: { ...p, id: 'lobby' } });
    expect(r.animations).toHaveLength(1);
    r.send(state(p));
    expect(r.nodes.get('session-score').hidden).toBe(false);
    expect(r.animations).toHaveLength(1);
  });
  it('shows the complete board only during the buy phase of a connected bingo match', () => {
    const r = renderer(), message = state();
    Object.assign(message.state, {
      gsi: { connected: true, inMenu: false },
      match: { phase: 'live', roundPhase: 'freezetime' },
      bingo: { size: 5, cells: Array.from({ length: 25 }, (_, index) => ({ index })) },
    });
    r.send(message);
    const board = r.nodes.get('buy-bingo');
    expect(board.board.cells).toHaveLength(25);
    const entrance = board.lastAnimation;
    r.send(message);
    expect(board.lastAnimation).toBe(entrance);
    entrance.onfinish();
    message.state.match.roundPhase = 'live';
    r.send(message);
    expect(board.hidden).toBe(false);
    board.lastAnimation.onfinish();
    expect(board.hidden).toBe(true);
    message.state.match.roundPhase = 'freezetime';
    message.state.gsi.inMenu = true;
    r.send(message);
    expect(r.nodes.get('buy-bingo').hidden).toBe(true);
  });
});
