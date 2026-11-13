// Превращает сырой пакет GSI в плоский снапшот, с которым удобно работать.
import { weaponTypeByName } from '../tasks/weapons.js';

const num = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

function normalizeWeapons(weapons) {
  if (!weapons || typeof weapons !== 'object') return [];
  return Object.keys(weapons)
    .sort((a, b) => num(a.replace(/\D/g, '')) - num(b.replace(/\D/g, '')))
    .map((slot) => {
      const w = weapons[slot] || {};
      return {
        slot,
        name: w.name ?? 'unknown',
        type: w.type || weaponTypeByName(w.name),
        state: w.state ?? 'holstered',
        ammoClip: w.ammo_clip == null ? null : num(w.ammo_clip, null),
      };
    });
}

/** "x, y, z" → { x, y, z } или null. */
export function parseVec(v) {
  if (typeof v !== 'string') return null;
  const parts = v.split(',').map((x) => Number(x.trim()));
  if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x))) return null;
  return { x: parts[0], y: parts[1], z: parts[2] };
}

/** Угол поворота по горизонтали (yaw) в градусах из вектора взгляда. */
export function yawOf(forward) {
  if (!forward) return null;
  return (Math.atan2(forward.y, forward.x) * 180) / Math.PI;
}

export function normalize(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = raw.provider || {};
  const map = raw.map || null;
  const round = raw.round || null;
  const p = raw.player || null;
  const st = p?.state || null;
  const ms = p?.match_stats || null;

  const snap = {
    ts: now,
    providerSteamId: provider.steamid ? String(provider.steamid) : null,
    hasMap: !!(map && map.name),
    mapName: map?.name ?? null,
    mapMode: map?.mode ?? null,
    mapPhase: map?.phase ?? null,
    mapRound: map?.round == null ? null : num(map.round, null),
    scoreCT: num(map?.team_ct?.score),
    scoreT: num(map?.team_t?.score),
    timeouts: { CT: map?.team_ct?.timeouts_remaining ?? null, T: map?.team_t?.timeouts_remaining ?? null },
    roundPhase: round?.phase ?? null,
    roundWinTeam: round?.win_team ?? null,
    bomb: round?.bomb ?? null, // planted | defused | exploded (кто заложил — GSI не сообщает)
    playerSteamId: p?.steamid ? String(p.steamid) : null,
    activity: p?.activity ?? null,
    position: parseVec(p?.position),
    forward: parseVec(p?.forward),
    isSelf: false,
    player: null,
  };
  snap.isSelf = !!(snap.playerSteamId && snap.providerSteamId && snap.playerSteamId === snap.providerSteamId);

  // Данные игрока считаем полными, только если есть и state, и match_stats:
  // иначе отсутствующие поля выглядели бы как «сброс статистики».
  if (p && st && ms) {
    snap.player = {
      steamid: snap.playerSteamId,
      name: p.name ?? '',
      team: p.team ?? null,
      health: num(st.health),
      armor: st.armor == null ? null : num(st.armor),
      money: num(st.money),
      flashed: num(st.flashed),
      smoked: num(st.smoked),
      burning: num(st.burning),
      equipValue: num(st.equip_value),
      roundKills: num(st.round_kills),
      roundKillHs: num(st.round_killhs),
      roundDmg: num(st.round_totaldmg),
      hasRoundDmg: st.round_totaldmg !== undefined,
      kills: num(ms.kills),
      assists: num(ms.assists),
      deaths: num(ms.deaths),
      mvps: num(ms.mvps),
      score: num(ms.score),
      weapons: normalizeWeapons(p.weapons),
      hasWeapons: !!p.weapons && typeof p.weapons === 'object',
    };
  }
  return snap;
}

export function activeWeapon(weapons) {
  return (weapons || []).find((w) => w.state === 'active' || w.state === 'reloading') || null;
}
