import { it, expect } from 'vitest';
import { lowHealthVitals } from '../src/game/lowHealth.js';
import { LowHealthFilter, HEALTH_FILTER } from '../src/obs/lowHealthFilter.js';
import { Core } from '../src/core.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { raw } from './helpers.js';
import vm from 'node:vm';
import fs from 'node:fs';

function tracker(hp = 19) {
  return { connected: true, lastPacketAt: 1000, match: { matchId: 'a', status: 'live' },
    lastSnapshot: { isSelf: true, hasMap: true, mapPhase: 'live', roundPhase: 'live', mapRound: 1, player: { health: hp } } };
}
it('triggers only at 1–19 HP, not 20, and ignores death, spectating and stale packets', () => {
  for (const hp of [1, 19]) expect(lowHealthVitals(tracker(hp), { enabled: true }, 1000).active).toBe(true);
  for (const hp of [0, 20, 100]) expect(lowHealthVitals(tracker(hp), { enabled: true }, 1000).active).toBe(false);
  const t = tracker();
  expect(lowHealthVitals(t, { enabled: false }, 1000).active).toBe(false);
  expect(lowHealthVitals(t, { enabled: true }, 16000).active).toBe(false);
  t.lastSnapshot.isSelf = false; expect(lowHealthVitals(t, { enabled: true }, 1000).active).toBe(false);
  t.lastSnapshot.isSelf = true; t.lastSnapshot.roundPhase = 'over';
  expect(lowHealthVitals(t, { enabled: true }, 1000).active).toBe(false);
});
function filter() {
  const calls = [], cfg = { enabled: true, obsSource: 'CS2' };
  const obs = { status: { connected: true }, async request(type, data) { calls.push([type, data]); return { filters: [] }; } };
  return { service: new LowHealthFilter({ obs, getConfig: () => cfg }), calls, cfg, obs };
}
it('creates an independent grayscale filter and disables it when the effect is switched off', async () => {
  const { service, cfg, calls } = filter();
  await service.sync(true);
  expect(calls.find(([t]) => t === 'CreateSourceFilter')[1]).toMatchObject({ sourceName: 'CS2', filterName: HEALTH_FILTER,
    filterKind: 'color_filter_v2', filterSettings: { saturation: -1 } });
  expect(calls.at(-1)[1].filterEnabled).toBe(true);
  cfg.enabled = false; await service.sync(false);
  expect(calls.at(-1)).toEqual(['SetSourceFilterEnabled', { sourceName: 'CS2', filterName: HEALTH_FILTER, filterEnabled: false }]);
});
it('switching sources restores the old source; clean shutdown restores the current one', async () => {
  const { service, cfg, calls } = filter();
  await service.sync(true); cfg.obsSource = 'Other'; await service.sync(true);
  expect(calls).toContainEqual(['SetSourceFilterEnabled', { sourceName: 'CS2', filterName: HEALTH_FILTER, filterEnabled: false }]);
  await service.close(); expect(calls.at(-1)[1]).toMatchObject({ sourceName: 'Other', filterEnabled: false });
});
it('does not issue OBS commands when disconnected or no source is selected', async () => {
  const { service, cfg, obs, calls } = filter(); cfg.obsSource = '';
  await service.sync(true); expect(calls).toHaveLength(0);
  cfg.obsSource = 'CS2'; obs.status.connected = false; await service.sync(true); expect(calls).toHaveLength(0);
});
it('a death while a filter request is pending wins over the initial low HP state', async () => {
  const { service, obs, calls } = filter(); let resume;
  obs.request = async (type, data) => { calls.push([type, data]);
    if (type === 'GetSourceFilterList') await new Promise((r) => { resume = r; });
    return { filters: [] }; };
  const running = service.sync(true); service.sync(false); resume(); await running;
  expect(calls.at(-1)[1].filterEnabled).toBe(false);
});
it('exposes own live HP to the overlay and disables it immediately from settings', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  const c = new Core({ config: cfg, now: () => 1000, templates: { templates: [], errors: [] }, log: { info() {}, warn() {}, debug() {} } });
  c.ingest(raw({ health: 19 }), 1000);
  expect(c.getState().healthEffect.active).toBe(true);
  await c.updateConfig({ lowHealth: { enabled: false } });
  expect(c.getState().healthEffect.active).toBe(false);
  await c.shutdown();
});

function renderer() {
  let socket; const sounds = [], layer = { hidden: true };
  const ctx = { document: { createElement: () => layer, body: { prepend() {} } },
    Audio: class { constructor() { sounds.push(this); } play() { return Promise.resolve(); } pause() { this.paused = true; } },
    WebSocket: class { constructor() { socket = this; } }, location: { protocol: 'http:', host: 'localhost' },
    Date, JSON, Math, setInterval() {}, setTimeout() {},
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/bonuses/low-health.js', import.meta.url), 'utf8'), ctx);
  return { layer, sounds, state(active, age = 0) {
    const serverTime = Date.now(); socket.onmessage({ data: JSON.stringify({ type: 'state', state: { serverTime,
      settings: { lowHealth: { enabled: true, volume: .5 } }, healthEffect: { active, key: 'match:round', startedAt: serverTime - age, lastPacketAt: serverTime } } }) });
  } };
}
it('plays the heartbeat once per low HP episode and stops immediately on recovery', () => {
  const r = renderer(); r.state(true); r.state(true, 1000); r.state(true, 3000);
  expect(r.sounds).toHaveLength(1); expect(r.layer.hidden).toBe(false);
  r.state(false); expect(r.sounds[0].paused).toBe(true); expect(r.layer.hidden).toBe(true);
  r.state(true); expect(r.sounds).toHaveLength(2);
});
it('joining after the first ten seconds does not replay audio; within ten seconds seeks past elapsed audio', () => {
  const old = renderer(); old.state(true, 11000); expect(old.sounds).toHaveLength(0); expect(old.layer.hidden).toBe(false);
  const fresh = renderer(); fresh.state(true, 3000); expect(fresh.sounds[0].currentTime).toBe(3);
});
it('the synthesized heartbeat is ten seconds long and fades toward silence', () => {
  const wav = fs.readFileSync(new URL('../sounds/heartbeat.wav', import.meta.url));
  expect(wav.readUInt32LE(24)).toBe(22050);
  expect(wav.readUInt32LE(40) / 2 / 22050).toBe(10);
  const rms = (start) => {
    let sum = 0; for (let i = start * 22050; i < (start + 1) * 22050; i++) sum += wav.readInt16LE(44 + i * 2) ** 2;
    return Math.sqrt(sum / 22050);
  };
  expect(rms(9)).toBeLessThan(rms(0) * .1);
});
