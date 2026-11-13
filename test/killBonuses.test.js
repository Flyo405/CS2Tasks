import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { KillBonuses } from '../src/bonuses/killBonuses.js';
import { DEFAULT_CONFIG, deepMerge, validateConfig } from '../src/config.js';
import { Core } from '../src/core.js';
import { raw, MATE } from './helpers.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const kill = (extra = {}) => ({ type: 'kill', count: 1, headshots: 0, weapon: { name: 'weapon_ak47', type: 'Rifle' }, ...extra });
function setup(patch = {}) {
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), { bonuses: { risk: { enabled: false }, diversity: { enabled: false }, ...patch } });
  const popups = [];
  const svc = new KillBonuses({ getConfig: () => config, emit: (p) => popups.push(p) });
  return { svc, config, popups };
}

it('awards each style action once per kill and only inside the post-kill window', () => {
  const { svc, popups } = setup();
  svc.awardStyle('inspect', 99_900);
  svc.handle([kill({ matchId: 'test' })], 100_000);
  svc.awardStyle('inspect', 100_200);
  svc.awardStyle('inspect', 100_250);
  svc.awardStyle('graffiti', 102_000);
  expect(popups.map(({ label, points }) => [label, points])).toEqual([['', 50], ['INSPECT', 50], ['GRAFFITI', 75]]);
  svc.handle([kill()], 104_000);
  svc.awardStyle('inspect', 106_001);
  expect(svc.total).toBe(175);
});

describe('очки и серии из Lua', () => {
  it('HS +100 и базовые 50; следующее убийство за 5 секунд получает базу 60', () => {
    const { svc, popups } = setup();
    svc.handle([kill({ headshots: 1 })]);
    vi.advanceTimersByTime(200);
    expect(popups[0]).toMatchObject({ points: 150, total: 150, combo: 1 });
    vi.advanceTimersByTime(800);
    svc.handle([kill({ jump: true })]);
    vi.advanceTimersByTime(200);
    expect(popups[1]).toMatchObject({ points: 310, base: 60, total: 460, label: 'DOUBLE KILL' });
  });
  it('все поддержанные бонусы складываются, но не начисляются за недоступные признаки Lua', () => {
    const { svc } = setup();
    svc.handle([kill({ headshots: 1, jump: true, noscope: true, smoked: 50, flashed: 255,
      wallbang: true, damage: 200, edgebug: true, weapon: { name: 'weapon_awp', type: 'SniperRifle' } })]);
    const p = svc.flush();
    expect(p.points).toBe(1300); // 50 + 100 + 250 + 500 + 200 + 200
    expect(p.parts.map((p) => p.label)).toEqual(['HS', 'AIR', 'IN SMOKE', 'BLIND', 'NOSCOPE']);
    expect(p.bonusCount).toBe(5);
  });
  it('нож +300, но ложный ноускоп на ноже не считается', () => {
    const { svc } = setup();
    svc.handle([kill({ noscope: true, weapon: { name: 'weapon_knife', type: 'Knife' } })]);
    expect(svc.flush().points).toBe(350);
  });
  it('группирует убийства за 200 мс: как в Lua, одна база на группу', () => {
    const { svc, popups } = setup();
    svc.handle([kill({ headshots: 1 })]);
    vi.advanceTimersByTime(100);
    svc.handle([kill({ headshots: 1 })]);
    vi.advanceTimersByTime(200);
    expect(popups).toHaveLength(1);
    expect(popups[0]).toMatchObject({ points: 260, combo: 2, kills: 2, label: 'DOUBLE KILL' });
  });
  it('если таймер задержался, разнесённые по времени убийства не сливаются', () => {
    const { svc, popups } = setup();
    svc.handle([kill()], 100000);
    svc.handle([kill()], 100500);
    svc.flush();
    expect(popups.map((p) => p.points)).toEqual([50, 60]);
  });
  it('в объединённом GSI-пакете считает количество убийств и только фактические хедшоты', () => {
    const { svc } = setup();
    svc.handle([kill({ count: 3, headshots: 1, jump: true })]);
    expect(svc.flush()).toMatchObject({ points: 920, base: 70, bonus: 850, combo: 3, label: 'TRIPLE KILL' });
  });
  it('множитель бонусов не умножает базу', () => {
    const { svc } = setup({ bonusMultiplier: 2 });
    svc.handle([kill({ headshots: 1 })]);
    expect(svc.flush().points).toBe(250);
  });
  it('округление разбивки согласуется с итогом и id не повторяется после перезапуска', () => {
    const a = setup({ bonusMultiplier: 1.5, points: { headshot: 1, air: 1 } }).svc;
    a.handle([kill({ headshots: 1, jump: true })]);
    const popup = a.flush();
    expect(popup.parts.reduce((n, p) => n + p.points, 0)).toBe(popup.bonus);
    const b = setup().svc;
    b.handle([kill()]);
    expect(b.flush().id).not.toBe(popup.id);
  });
  it('серия истекает через 5 секунд, а начало матча сбрасывает серию и очки', () => {
    const { svc } = setup();
    svc.handle([kill()]); svc.flush();
    vi.advanceTimersByTime(5001);
    svc.handle([kill()]); expect(svc.flush().combo).toBe(1);
    svc.handle([{ type: 'match_start' }, kill()]);
    expect(svc.flush()).toMatchObject({ combo: 1, total: 50 });
  });
  it('отключение, сброс и остановка отменяют ожидающие начисления', () => {
    const { svc, config, popups } = setup();
    svc.handle([kill()]); svc.reset(); vi.advanceTimersByTime(500);
    expect(svc.state()).toMatchObject({ total: 0, lastPopup: null });
    expect(popups).toHaveLength(0);
    config.bonuses.enabled = false; svc.handle([kill()]); expect(svc.flush()).toBeNull();
    config.bonuses.enabled = true; svc.handle([kill()]); svc.stop(); vi.advanceTimersByTime(500);
    expect(popups).toHaveLength(0);
  });
  it('проверяет новые настройки и отклоняет неверную длительность/цвет/бонусы', () => {
    const c = structuredClone(DEFAULT_CONFIG);
    expect(validateConfig(c)).toEqual([]);
    c.bonuses.fadeInMs = 0; c.bonuses.color = 'red'; c.bonuses.points.air = -1;
    expect(validateConfig(c).join(' ')).toMatch(/fadeInMs/);
    expect(validateConfig(c).join(' ')).toMatch(/color/);
    expect(validateConfig(c).join(' ')).toMatch(/points.air/);
  });
});

it('начисляет очки только за свои боевые убийства, а не пакеты наблюдаемого игрока', () => {
  const core = new Core({ config: deepMerge(structuredClone(DEFAULT_CONFIG), { tasks: { count: 0, autoGenerateOnMatchStart: false } }),
    templates: { templates: [], errors: [] }, log: { info() {}, warn() {}, debug() {} } });
  core.ingest(raw({ phase: 'warmup' }));
  core.ingest(raw({ phase: 'warmup', kills: 2, roundKills: 2 }));
  expect(core.bonuses.flush()).toBeNull();
  core.ingest(raw({ roundPhase: 'freezetime' }));
  core.ingest(raw({ roundPhase: 'live' }));
  core.ingest(raw({ kills: 1, roundKills: 1, roundHs: 1 }));
  expect(core.bonuses.flush().points).toBe(150);
  core.ingest(raw({ steamid: MATE, kills: 4, roundKills: 4 }));
  expect(core.bonuses.flush()).toBeNull();
  expect(core.getState().bonuses.total).toBe(150);
  expect(core.serialize()).not.toHaveProperty('bonuses'); // сессия начинается с нуля после перезапуска
});

 it('новый матч очищает последний popup и отменяет ожидающее начисление', () => {
   const { svc } = setup();
   svc.handle([kill()]); svc.flush(); svc.handle([kill()]);
   svc.handle([{ type: 'match_start' }]); vi.advanceTimersByTime(500);
   expect(svc.state()).toMatchObject({ total: 0, lastPopup: null });
   svc.handle([kill()]); expect(svc.flush()).toMatchObject({ total: 50, combo: 1 });
 });
 it('ручной новый матч сбрасывает SCORE, завершение матча сохраняет итог', () => {
   const core = new Core({ config: structuredClone(DEFAULT_CONFIG), templates: { templates: [], errors: [] },
     log: { info() {}, warn() {}, debug() {} } });
   core.bonuses.handle([kill()]); core.bonuses.handle([{ type: 'match_end' }]);
   expect(core.bonuses.total).toBe(50);
   core.startNewMatch(); expect(core.getState().bonuses).toMatchObject({ total: 0, lastPopup: null });
 });
