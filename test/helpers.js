import { normalize } from '../src/gsi/normalize.js';

export const ME = '76561198000000001';
export const MATE = '76561198000000002';

/** Строит сырой пакет GSI. Поля игрока передаются плоско. */
export function raw({
  map = 'de_mirage', mode = 'competitive', phase = 'live', round = 0, ct = 0, t = 0,
  roundPhase = 'live', winTeam, steamid = ME, team = 'CT', menu = false,
  health = 100, flashed = 0, money = 800, equip = 1000,
  roundKills = 0, roundHs = 0, roundDmg = 0,
  kills = 0, assists = 0, deaths = 0, mvps = 0, score = 0,
  weapons = [{ name: 'weapon_ak47', type: 'Rifle', state: 'active', clip: 30 }],
} = {}) {
  const r = { provider: { steamid: ME, name: 'Counter-Strike 2', appid: 730 } };
  if (menu) {
    r.player = { steamid: ME, activity: 'menu' };
    return r;
  }
  r.map = { mode, name: map, phase, round, team_ct: { score: ct }, team_t: { score: t } };
  r.round = { phase: roundPhase };
  if (winTeam) r.round.win_team = winTeam;
  const w = {};
  weapons.forEach((x, i) => {
    w[`weapon_${i}`] = { name: x.name, type: x.type, state: x.state || 'holstered', ...(x.clip != null ? { ammo_clip: x.clip } : {}) };
  });
  r.player = {
    steamid, name: steamid === ME ? 'Me' : 'Mate', team, activity: 'playing',
    state: { health, armor: 100, flashed, smoked: 0, burning: 0, money, equip_value: equip, round_kills: roundKills, round_killhs: roundHs, round_totaldmg: roundDmg },
    match_stats: { kills, assists, deaths, mvps, score },
    weapons: w,
  };
  return r;
}

let clock = 1_000_000;
export function snap(opts = {}, dt = 100) {
  clock += dt;
  return normalize(raw(opts), clock);
}

export function resetClock() {
  clock = 1_000_000;
}
