import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffPlayer } from '../src/game/events.js';
import { snap, raw } from './helpers.js';
import { Core } from '../src/core.js';
import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { loadTemplates } from '../src/tasks/templates.js';
import { generateSyntheticMatch } from '../tools/synthetic.js';
import { MatchReports } from '../src/game/matchReports.js';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const cores = [];
const dirs = [];
afterEach(async () => { for (const c of cores.splice(0)) await c.shutdown(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function core(patch = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2-features-')); dirs.push(dataDir);
  const c = new Core({ config: deepMerge(structuredClone(DEFAULT_CONFIG), patch), dataDir, templates: loadTemplates(dataDir), log: quiet });
  cores.push(c); return c;
}
const gun = (clip) => [{ name: 'weapon_deagle', type: 'Pistol', clip }];

describe('последний патрон', () => {
  function events(a, b, count = 1) {
    return diffPlayer(snap({ weapons: gun(a) }).player, snap({ kills: count, roundKills: count, weapons: gun(b) }).player);
  }
  it('совпавшее убийство и опустевшая обойма считаются приблизительно', () => {
    expect(events(1, 0).find((e) => e.type === 'kill').lastBullet).toBe(true);
    expect(events(3, 0).find((e) => e.type === 'kill').lastBullet).toBe(true);
    expect(events(3, 2).find((e) => e.type === 'kill').lastBullet).toBe(false);
    expect(events(0, 0).find((e) => e.type === 'kill').lastBullet).toBe(false);
    expect(events(2, 0, 2).find((e) => e.type === 'kill').lastBullet).toBe(false);
  });
  it('срабатывает задание через полный путь пакетов', () => {
    const c = core({ tasks: { count: 0, autoGenerateOnMatchStart: false } });
    c.ingest(raw({ weapons: gun(1) }));
    const task = c.tasks.add({ type: 'last_bullet_kills', params: { count: 1 } });
    c.ingest(raw({ kills: 1, roundKills: 1, weapons: gun(0) }));
    expect(c.tasks.get(task.id).status).toBe('completed');
  });
});

describe('ситуационное задание отдельно от основного набора', () => {
  it('пистолетное идёт четвёртым даже при maxActive=3, основной набор не меняется', () => {
    const c = core({ tasks: { count: 3, maxActive: 3 } });
    c.ensureInitialTasks();
    const ids = c.tasks.mainActive().map((t) => t.id);
    let clock = 100000;
    const send = (p) => c.ingest(raw(p), clock += 200);
    send({ roundPhase: 'freezetime' }); send({ weapons: gun(7) });
    expect(c.tasks.active()).toHaveLength(4);
    expect(c.tasks.mainActive().map((t) => t.id)).toEqual(ids);
    const extra = c.tasks.active().find((t) => t.situational);
    expect(extra.type).toBe('pistol_round_kills');
    // Выполнение основной цели всё равно создаёт ей замену, дополнительная не занимает слот.
    c.tasks.complete(ids[0]);
    expect(c.tasks.mainActive()).toHaveLength(3);
    expect(c.tasks.active()).toHaveLength(4);
    send({ weapons: gun(7) }); expect(c.tasks.active()).toHaveLength(4); // не дублируется
    send({ roundPhase: 'over', winTeam: 'CT' });
    expect(c.tasks.get(extra.id).status).toBe('failed');
    expect(c.tasks.mainActive()).toHaveLength(3);
    expect(c.tasks.active()).toHaveLength(3);
  });
  it('ситуационная победа на эко учитывает выигрыш до истечения задания', () => {
    const c = core({ tasks: { count: 3, maxActive: 3 } });
    c.ensureInitialTasks();
    c.ingest(raw({ round: 2, roundPhase: 'freezetime', equip: 1800 }), 100000);
    c.ingest(raw({ round: 2, equip: 1800 }), 100200);
    expect(c.tasks.active().filter((t) => t.situational)).toHaveLength(1);
    const existing = c.tasks.active().find((t) => t.situational);
    c.tasks.remove(existing.id);
    const t = c.tasks.add({ type: 'eco_round_wins', params: { equip: 2000, count: 1 }, source: 'situation', situational: true, situationalRound: 2 });
    c.ingest(raw({ round: 3, roundPhase: 'over', winTeam: 'CT', ct: 1, equip: 6000 }), 100400);
    expect(c.tasks.get(t.id).status).toBe('completed');
    expect(c.tasks.active().some((x) => x.situational)).toBe(false);
  });
  it('в выключенном режиме дополнительные задания не появляются', () => {
    const c = core({ tasks: { situational: false } });
    c.ensureInitialTasks(); c.ingest(raw({ roundPhase: 'freezetime' })); c.ingest(raw());
    expect(c.tasks.active().some((t) => t.situational)).toBe(false);
    expect(c.availableTemplates().some((t) => t.type === 'pistol_round_kills')).toBe(false);
  });
});

describe('итоги матчей', () => {
  it('сохраняет завершённый матч, его задания и бонусы; повторный gameover не дублирует', () => {
    const c = core(); c.ensureInitialTasks();
    const { packets, expected } = generateSyntheticMatch({ seed: 11 });
    let t = 100000;
    for (const p of packets) { t += p.dt; c.ingest(p.raw, t); }
    expect(c.reports.history).toHaveLength(1);
    const report = c.reports.history[0];
    expect(report.stats.kills).toBe(expected.kills);
    expect(report.headshots).toBe(expected.headshots);
    expect(report.bonusPoints).toBeGreaterThan(0);
    expect(report.taskCounts.completed).toBeGreaterThan(0);
    expect(report.tasks.every((task) => typeof task.title === 'string')).toBe(true);
    const final = packets.findLast((p) => p.raw.map?.phase === 'gameover');
    c.ingest(final.raw, t + 200);
    expect(c.reports.history).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(c.dataDir, 'match-reports.json'), 'utf8'))[0].matchId).toBe(report.matchId);
    const next = new Core({ config: c.config, dataDir: c.dataDir, templates: loadTemplates(c.dataDir), log: quiet }); cores.push(next);
    expect(next.reports.history[0].matchId).toBe(report.matchId);
  });
  it('данные серий текущего матча восстанавливаются, чужое задание не попадает в отчёт', () => {
    const r = new MatchReports();
    const match = { matchId: 'm', round: 5, startedAt: 1, mapName: 'de_mirage' };
    r.observe([{ type: 'kill', count: 2, headshots: 1 }], match);
    const restored = new MatchReports({ current: JSON.parse(JSON.stringify(r.current)) });
    restored.observe([{ type: 'kill', count: 1, headshots: 0 }], match);
    restored.taskFinished({ matchId: 'other', status: 'completed' });
    expect(restored.current).toMatchObject({ bestStreak: 3, partial: true, taskCounts: { completed: 0 } });
  });
});

 describe('выполненные задания в итогах отдельного матча', () => {
   it('не переносит выполненные задания из предыдущей игры и не считает тестовые', () => {
     const reports = new MatchReports();
     const match = (matchId) => ({ matchId, mapName: 'de_mirage', startedAt: 1, endedAt: 5 });
     const complete = (id, extra = {}) => reports.taskFinished({ matchId: id, title: 'Задание', status: 'completed', ...extra });
     reports.observe([], match('first'));
     complete('first'); complete('first');
     expect(reports.finish({ matchId: 'first' }, match('first')).taskCounts.completed).toBe(2);
     reports.observe([], match('second'));
     complete('first'); complete('second', { test: true }); complete('second');
     expect(reports.finish({ matchId: 'second' }, match('second')).taskCounts.completed).toBe(1);
     expect(reports.history[1].taskCounts.completed).toBe(2);
   });
   it('ручной старт сразу создаёт отдельный счётчик заданий для нового матча', () => {
     const c = core({ tasks: { count: 0, autoGenerateOnMatchStart: false } });
     c.startNewMatch();
     const first = c.tasks.add({ type: 'manual', params: { text: 'First', count: 1 } });
     c.tasks.complete(first.id);
     expect(c.reports.current.taskCounts.completed).toBe(1);
     const nextStart = c.now() + 1000; c.now = () => nextStart;
     c.startNewMatch();
     expect(c.reports.current.taskCounts.completed).toBe(0);
     const second = c.tasks.add({ type: 'manual', params: { text: 'Second', count: 1 } });
     c.tasks.complete(second.id);
     expect(c.reports.current.taskCounts.completed).toBe(1);
     expect(c.session.completed).toBe(2);
   });
 });
