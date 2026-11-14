// Интеграционный тест: синтетический матч → normalize → tracker → taskManager.
import { describe, it, expect } from 'vitest';
import { Core } from '../src/core.js';
import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { validateTemplates } from '../src/tasks/templates.js';
import { readJson } from '../src/store.js';
import { DEFAULT_TEMPLATES } from '../src/paths.js';
import { mulberry32 } from '../src/tasks/generator.js';
import { generateSyntheticMatch } from '../tools/synthetic.js';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const templates = { raw: [], ...validateTemplates(readJson(DEFAULT_TEMPLATES, [])) };

function makeCore(patch = {}) {
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), { gsiToken: 'test', ...patch });
  return new Core({ config, templates, log: quietLog, rng: mulberry32(7) });
}

/** Подаёт пакеты; перед первым боевым пакетом вызывает hook (добавить задания). */
function feed(core, packets, { onFirstMapPacket } = {}) {
  let ts = Date.UTC(2026, 0, 1);
  let hooked = false;
  for (const { dt, raw } of packets) {
    ts += dt;
    core.ingest(raw, ts);
    if (!hooked && raw.map && onFirstMapPacket) { hooked = true; onFirstMapPacket(); }
  }
}

describe('синтетический матч целиком', () => {
  for (const seed of [1, 2, 3, 11, 42]) {
    it(`seed ${seed}: статистика и прогресс совпадают с ожидаемыми`, () => {
      const { packets, expected: e } = generateSyntheticMatch({ seed });
      const core = makeCore({ tasks: { autoGenerateOnMatchStart: false, maxActive: 20 } });
      const big = (type, params) => core.tasks.add({ type, params, source: 'streamer' });
      const [topWeapon] = Object.entries(e.weaponKills).sort((a, b) => b[1] - a[1])[0] || ['weapon_ak47'];
      const t = {};
      feed(core, packets, {
        onFirstMapPacket: () => {
          t.kills = big('kills', { count: 100 });
          t.hs = big('headshots', { count: 100 });
          t.weapon = big('weapon_kills', { weapon: topWeapon, count: 50 });
          t.rifles = big('weapon_type_kills', { weaponType: 'Rifle', count: 50 });
          t.mvp = big('mvps', { count: 30 });
          t.assists = big('assists', { count: 50 });
          t.survive = big('survive_rounds', { count: 30 });
          t.wins = big('round_wins', { count: 30 });
          t.multi = big('multikill_rounds', { kills: 2, count: 10 });
          t.lowhp = big('low_hp_kills', { hp: 30, count: 20 });
          t.flash = big('flashed_kills', { count: 20 });
          t.eco = big('eco_kills', { equip: 2000, count: 30 });
        },
      });

      const m = core.tracker.match;
      expect(m.status).toBe('ended');
      expect(m.result).toBe(e.result);
      expect(m.stats).toMatchObject({ kills: e.kills, deaths: e.deaths, assists: e.assists, mvps: e.mvps });
      expect(m.roundsPlayed).toBe(e.roundsPlayed);
      expect(m.roundsWon).toBe(e.roundsWon);

      const p = (x) => core.tasks.get(x.id);
      // Счётчики к концу матча провалены (цели заведомо недостижимы), но прогресс сохранён.
      expect(p(t.kills).progress).toBe(e.kills);
      expect(p(t.hs).progress).toBe(e.headshots);
      expect(p(t.weapon).progress).toBe(e.weaponKills[topWeapon] || 0);
      expect(p(t.rifles).progress).toBe(e.weaponTypeKills.Rifle || 0);
      expect(p(t.mvp).progress).toBe(e.mvps);
      expect(p(t.assists).progress).toBe(e.assists);
      expect(p(t.survive).progress).toBe(e.roundsSurvived);
      expect(p(t.wins).progress).toBe(e.roundsWon);
      expect(p(t.multi).progress).toBe(Math.min(10, e.multikillRounds[2]));
      expect(p(t.lowhp).progress).toBe(Math.min(20, e.lowHpKills30));
      expect(p(t.flash).progress).toBe(Math.min(20, e.flashedKills));
      expect(p(t.eco).progress).toBe(Math.min(30, e.ecoKills2000));
      expect(core.tasks.active()).toHaveLength(0);
    });
  }

  it('всегда 3 задания: замена выполненных, перезапуск не теряет прогресс, счётчик за сессию', () => {
    const { packets, expected: e } = generateSyntheticMatch({ seed: 5 });
    const core = makeCore();
    core.ensureInitialTasks(); // как при запуске программы — ещё до игры
    expect(core.tasks.active()).toHaveLength(3);
    expect(core.tasks.active().every((t) => t.matchId === null)).toBe(true);

    const half = Math.floor(packets.length / 2);
    let minActive = Infinity;
    let ts = Date.UTC(2026, 0, 1);
    for (const { dt, raw } of packets.slice(0, half)) {
      ts += dt;
      core.ingest(raw, ts);
      if (core.tracker.match?.status === 'live') minActive = Math.min(minActive, core.tasks.active().length);
    }
    expect(minActive).toBe(3); // во время матча активных всегда 3
    const id = core.tracker.match.matchId;
    expect(core.tasks.active().every((t) => t.matchId === id)).toBe(true);
    const completedAtHalf = core.session.completed;
    expect(completedAtHalf).toBeGreaterThan(0);
    // Замена встала на место выполненного и помнит, кого заменила.
    const replaced = core.tasks.tasks.find((t) => t.replaces);
    expect(replaced).toBeTruthy();
    const old = core.tasks.get(replaced.replaces);
    expect(old.status).not.toBe('active');
    expect(replaced.difficulty).toBe(old.difficulty);
    expect(replaced.type).not.toBe(old.type);

    // «Перезапуск»: новое ядро из сохранённого состояния. Задания сохранились, счётчик — с нуля.
    const saved = JSON.parse(JSON.stringify(core.serialize()));
    const core2 = makeCore();
    core2.tracker = new (core.tracker.constructor)({ getConfig: () => core2.config, initial: saved.tracker });
    core2.tasks.tasks = saved.tasks.tasks;
    core2.tasks.history = saved.tasks.history;
    core2.ensureInitialTasks();
    expect(core2.tasks.active()).toHaveLength(3);
    expect(core2.session.completed).toBe(0);
    expect(core2.getState().session.completed).toBe(0);

    for (const { dt, raw } of packets.slice(half)) { ts += dt; core2.ingest(raw, ts); }
    expect(core2.tracker.match.matchId).toBe(id);
    expect(core2.tracker.match.stats.kills).toBe(e.kills);
    // После конца матча: незавершённые закрыты, уже готов набор на следующий матч.
    expect(core2.tasks.active()).toHaveLength(3);
    expect(core2.tasks.active().every((t) => t.matchId === null)).toBe(true);
    const s = core2.session;
    expect(s.completed + s.skipped + s.failed).toBeGreaterThan(0);

    // Следующий матч: ждущие задания переходят в него, лишних не появляется.
    const pending = core2.tasks.active().map((t) => t.id);
    const next = generateSyntheticMatch({ seed: 6, mapName: 'de_inferno' });
    for (const { dt, raw } of next.packets.slice(0, 10)) { ts += dt; core2.ingest(raw, ts); }
    expect(core2.tracker.match.matchId).not.toBe(id);
    expect(core2.tasks.mainActive().map((t) => t.id)).toEqual(pending);
    expect(core2.tasks.active().every((t) => t.matchId === core2.tracker.match.matchId)).toBe(true);
  });

  it('пропуск заменяется новым заданием, если replaceSkipped; иначе нет', () => {
    const core = makeCore();
    core.ensureInitialTasks();
    const t = core.tasks.active()[1];
    core.tasks.skip(t.id);
    expect(core.tasks.active()).toHaveLength(3);
    expect(core.session.skipped).toBe(1);
    expect(core.tasks.active()[1].replaces).toBe(t.id);

    const core2 = makeCore({ tasks: { replaceSkipped: false, replaceCompleted: false } });
    core2.ensureInitialTasks();
    core2.tasks.skip(core2.tasks.active()[0].id);
    core2.tasks.complete(core2.tasks.active()[0].id);
    expect(core2.tasks.active()).toHaveLength(1);
    expect(core2.session).toMatchObject({ completed: 1, skipped: 1 });
  });

  it('пакеты без урона не создают предупреждений и заданий на урон', () => {
    const { packets } = generateSyntheticMatch({ seed: 9 });
    for (const { raw } of packets) delete raw.player?.state?.round_totaldmg;
    const core = makeCore();
    feed(core, packets);
    expect(core.getState().warnings).toEqual([]);
    expect(core.getState()).not.toHaveProperty('damageSupport');
    expect(core.tasks.tasks.some((t) => t.type.startsWith('damage'))).toBe(false);
    expect(core.rawBuffer[0].p.auth).toBeUndefined();
  });

  it('тестовые задания оверлея не трогают счётчик и не заменяются', () => {
    const core = makeCore();
    const t = core.tasks.add({ type: 'manual', params: { text: 'тест', count: 1 }, test: true });
    core.tasks.complete(t.id);
    expect(core.session.completed).toBe(0);
    expect(core.tasks.tasks.some((x) => x.replaces === t.id)).toBe(false);
  });

  it('предложение из чата: !task hs 5 → очередь → одобрение → активное задание с автором', () => {
    const core = makeCore({ twitch: { enabled: false } });
    const said = [];
    core.chat = { say: (s) => said.push(s) };
    core.handleChat({ user: 'viewer1', displayName: 'Viewer1', text: '!task hs 5', roles: new Set(['everyone']) });
    expect(core.suggestions.queue).toHaveLength(1);
    expect(core.suggestions.queue[0]).toMatchObject({ type: 'headshots', params: { count: 5 }, displayName: 'Viewer1' });
    // Повтор сразу — кулдаун / уже в очереди.
    core.handleChat({ user: 'viewer1', displayName: 'Viewer1', text: '!task deagle 3', roles: new Set(['everyone']) });
    expect(core.suggestions.queue).toHaveLength(1);
    // Число вне диапазона обрезается.
    core.handleChat({ user: 'viewer2', displayName: 'V2', text: '!task deagle 999', roles: new Set(['everyone']) });
    expect(core.suggestions.queue[1].params).toEqual({ weapon: 'weapon_deagle', count: 4 });
    // Ссылки в custom запрещены.
    core.handleChat({ user: 'viewer3', displayName: 'V3', text: '!task custom зайди на spam.ru', roles: new Set(['everyone']) });
    expect(core.suggestions.queue).toHaveLength(2);
    core.handleChat({ user: 'viewer4', displayName: 'V4', text: '!task custom выиграть раунд с ножом', roles: new Set(['everyone']) });
    expect(core.suggestions.queue[2]).toMatchObject({ type: 'manual', title: 'выиграть раунд с ножом' });

    const task = core.approveSuggestion(core.suggestions.queue[0].id);
    expect(task).toMatchObject({ status: 'active', source: 'viewer', author: 'Viewer1', title: '5 хедшотов' });
    expect(core.suggestions.queue).toHaveLength(2);
    core.rejectSuggestion(core.suggestions.queue[0].id);
    expect(core.suggestions.queue).toHaveLength(1);
    expect(said.some((s) => s.includes('was approved'))).toBe(true);
  });

  it('роли: только подписчики', () => {
    const core = makeCore({ twitch: { allowedRoles: ['subscriber'] } });
    core.handleChat({ user: 'a', displayName: 'a', text: '!task hs 4', roles: new Set(['everyone']) });
    expect(core.suggestions.queue).toHaveLength(0);
    core.handleChat({ user: 'b', displayName: 'b', text: '!task hs 4', roles: new Set(['everyone', 'subscriber']) });
    expect(core.suggestions.queue).toHaveLength(1);
  });
});
