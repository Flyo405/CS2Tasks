import { describe, it, expect } from 'vitest';
import { normalize, parseVec, yawOf } from '../src/gsi/normalize.js';
import { buildCfg } from '../src/gsi/installer.js';
import { Core } from '../src/core.js';
import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { raw, ME } from './helpers.js';

describe('позиция и взгляд (player_position)', () => {
  it('cfg не запрашивает player_position (CS2 не присылает его игроку)', () => {
    expect(buildCfg({ port: 3000, token: 't' })).not.toContain('player_position');
  });

  it('разбор векторов и угла', () => {
    expect(parseVec('-1214.32, 645.09, -167.97')).toEqual({ x: -1214.32, y: 645.09, z: -167.97 });
    expect(parseVec('1, 2')).toBeNull();
    expect(parseVec(undefined)).toBeNull();
    expect(yawOf({ x: 0, y: 1, z: 0 })).toBeCloseTo(90);
    expect(yawOf({ x: -1, y: 0, z: 0 })).toBeCloseTo(180);
  });

  it('снапшот содержит позицию и взгляд, диагностика считает частоту', () => {
    const core = new Core({
      config: deepMerge(structuredClone(DEFAULT_CONFIG), { gsiToken: 't' }),
      templates: { raw: [], templates: [], errors: [] },
      log: { info() {}, warn() {}, error() {}, debug() {} },
      now: () => 10_000,
    });
    for (let i = 0; i < 20; i++) {
      const r = raw({});
      r.player.position = `100, 200, ${i}`;
      r.player.forward = `${Math.cos(i / 3)}, ${Math.sin(i / 3)}, 0`;
      const snap = normalize(r, 5_000 + i * 250);
      expect(snap.position.z).toBe(i);
      expect(snap.playerSteamId).toBe(ME);
      core.trackMotion(snap);
    }
    const m = core.motionState();
    expect(m.self).toBe(true);
    expect(m.ratePerSec).toBe(4);
    expect(m.z).toBe(19);
  });
});
