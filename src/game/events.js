// Превращает разницу снапшотов в игровые события. Чистые функции — легко тестировать.
import { activeWeapon } from '../gsi/normalize.js';
import { weaponTypeByName, canonicalWeapon } from '../tasks/weapons.js';

export function emptyRound(round = null) {
  // dmg — сумма приростов round_totaldmg, dmgSeen — максимум, который присылала игра.
  // ended/finalized — был ли конец раунда и подведён ли итог по урону (round_final).
  // liveAt / plantedAt — когда кончился фризтайм и когда заложили бомбу (время получения пакета, мс).
  // usedPrimary / reloaded — для заданий-ограничений («только нож и пистолет», «без перезарядки»).
  return { round, died: false, kills: 0, hs: 0, dmg: 0, dmgSeen: 0, equipValue: null, money: null, ended: false, won: false, survived: false, finalized: false,
    liveAt: null, plantedAt: null, bomb: null, usedPrimary: false, reloaded: false };
}

// Соревновательный и премьер (MR12): раунд 1:55 после фризтайма, бомба взрывается через 40 с после закладки.
export const ROUND_TIME_MS = 115_000;
export const BOMB_TIME_MS = 40_000;
const PRIMARY_TYPES = ['Rifle', 'SniperRifle', 'Submachine Gun', 'Shotgun', 'Machine Gun'];
const primaryWeapons = (player) => (player?.weapons ?? [])
  .filter((w) => PRIMARY_TYPES.includes(w.type || weaponTypeByName(w.name)))
  .map((w) => canonicalWeapon(w.name));

/** Сколько секунд оставалось до конца раунда (или до взрыва бомбы) в момент at. null — неизвестно. */
export function timeLeftAt(round, at) {
  if (round.plantedAt != null) return (round.plantedAt + BOMB_TIME_MS - at) / 1000;
  if (round.liveAt != null) return (round.liveAt + ROUND_TIME_MS - at) / 1000;
  return null;
}

/** Урон за раунд: CS2 иногда обновляет round_totaldmg с опозданием, берём максимум из двух оценок. */
export function roundDamage(round) {
  return Math.max(round.dmg || 0, round.dmgSeen || 0);
}

/**
 * Итог прошлого раунда. Выдаётся в начале следующего раунда (или в конце матча),
 * когда урон за раунд уже точно дошёл от игры.
 */
export function roundFinal(round) {
  if (!round.ended || round.finalized) return null;
  return {
    type: 'round_final',
    round: round.round,
    won: round.won,
    survived: round.survived,
    roundKills: round.kills,
    roundHs: round.hs,
    roundDamage: roundDamage(round),
  };
}

/** Обновляет контекст текущего раунда по событию. */
export function reduceRound(round, ev) {
  switch (ev.type) {
    case 'round_start':
      return { ...emptyRound(ev.round), equipValue: ev.equipValue, money: ev.money };
    case 'round_live':
      return { ...round, equipValue: ev.equipValue ?? round.equipValue, liveAt: ev.at ?? round.liveAt };
    case 'bomb_planted':
      return { ...round, bomb: 'planted', plantedAt: ev.at ?? round.plantedAt };
    case 'bomb_defused':
      return { ...round, bomb: 'defused' };
    case 'bomb_exploded':
      return { ...round, bomb: 'exploded' };
    case 'self_flags':
      return { ...round, usedPrimary: round.usedPrimary || !!ev.primary, reloaded: round.reloaded || !!ev.reloading };
    case 'kill':
      return { ...round, kills: round.kills + ev.count, hs: round.hs + ev.headshots };
    case 'damage':
      return { ...round, dmg: round.dmg + ev.amount };
    case 'round_end':
      return { ...round, ended: true, won: ev.won, survived: ev.survived };
    case 'round_final':
      return { ...round, finalized: true };
    case 'self_state':
      return ev.roundDmg > (round.dmgSeen || 0) ? { ...round, dmgSeen: ev.roundDmg } : round;
    case 'death':
    case 'spectate':
      return { ...round, died: true };
    default:
      return round;
  }
}

function weaponInfo(w) {
  if (!w) return { name: 'unknown', type: null };
  return { name: canonicalWeapon(w.name), type: w.type || weaponTypeByName(w.name) };
}

/**
 * Эвристика оружия убийства (GSI его не сообщает):
 * 1) оружие, у которого уменьшилась обойма между пакетами;
 * 2) активное оружие; если оно сменилось между пакетами — активное в предыдущем.
 */
export function detectKillWeapon(prevWeapons = [], nextWeapons = []) {
  const dropped = [];
  for (const w of nextWeapons) {
    if (w.ammoClip == null) continue;
    const p = prevWeapons.find((x) => x.slot === w.slot && x.name === w.name) || prevWeapons.find((x) => x.name === w.name);
    if (p && p.ammoClip != null && w.ammoClip < p.ammoClip) dropped.push(w);
  }
  if (dropped.length === 1) return weaponInfo(dropped[0]);
  const an = activeWeapon(nextWeapons);
  const ap = activeWeapon(prevWeapons);
  if (dropped.length > 1) return weaponInfo(dropped.find((w) => an && w.name === an.name) || dropped[0]);
  if (an && ap && an.name !== ap.name) return weaponInfo(ap);
  return weaponInfo(an || ap);
}

const delta = (a, b) => (b >= a ? b - a : b); // счётчик раунда сбросился → считаем с нуля

/** События по данным самого стримера: a — прошлый снапшот игрока, b — текущий. */
export function diffPlayer(a, b, round = emptyRound()) {
  const out = [];
  const dmg = delta(a.roundDmg, b.roundDmg);
  if (dmg > 0) out.push({ type: 'damage', amount: dmg });

  // Основной источник — round_kills; запасной — match_stats.kills (если сброс раунда пропущен).
  const count = Math.max(delta(a.roundKills, b.roundKills), b.kills - a.kills, 0);
  if (count > 0) {
    const hs = Math.min(Math.max(delta(a.roundKillHs, b.roundKillHs), 0), count);
    const weapon = detectKillWeapon(a.weapons, b.weapons);
    const before = a.weapons.find((w) => canonicalWeapon(w.name) === weapon.name);
    const after = b.weapons.find((w) => canonicalWeapon(w.name) === weapon.name);
    // Одно убийство и расход патронов до нуля в том же оружии.
    // Несколько убийств в одном пакете не позволяют понять, какое было последним.
    const lastBullet = count === 1 && before?.ammoClip > 0 && after?.ammoClip === 0
      && !['Knife', 'Grenade', 'C4'].includes(weapon.type);
    out.push({
      type: 'kill',
      count,
      headshots: hs,
      weapon,
      team: b.team,
      lastBullet,
      ammoSpent: before?.ammoClip != null && after?.ammoClip != null ? before.ammoClip - after.ammoClip : null,
      round: round.round,
      hpAtKill: b.health > 0 ? b.health : a.health,
      armorAtKill: b.health > 0 ? b.armor : a.armor,
      flashed: b.flashed,
      smoked: b.smoked,
      burning: b.burning,
      roundKillsAfter: b.roundKills,
      roundEquipValue: round.equipValue ?? b.equipValue,
    });
  }
  const assists = b.assists - a.assists;
  if (assists > 0) out.push({ type: 'assist', count: assists });
  const deaths = b.deaths - a.deaths;
  if (deaths > 0) out.push({ type: 'death', count: deaths });
  const mvps = b.mvps - a.mvps;
  if (mvps > 0) out.push({ type: 'mvp', count: mvps });
  return out;
}

/**
 * Главная функция: prev — предыдущий снапшот (любой), next — текущий.
 * ctx.lastSelf — последний снапшот, где игрок = стример; ctx.round — контекст раунда.
 * Возвращает список событий (без match_*: их порождает трекер матча).
 */
export function diff(prev, next, ctx = {}) {
  const out = [];
  if (!next || !next.hasMap || next.mapPhase === 'warmup') return out;
  let round = ctx.round || emptyRound();
  const push = (ev) => { out.push(ev); round = reduceRound(round, ev); };
  const pp = prev && prev.hasMap ? prev : null;
  const selfNow = next.isSelf && next.player ? next.player : null;
  const lastSelf = ctx.lastSelf && ctx.lastSelf.player ? ctx.lastSelf : null;

  if (pp?.mapPhase === 'live' && next.mapPhase === 'live' && selfNow) {
    const team = selfNow.team;
    const before = pp.timeouts?.[team];
    const after = next.timeouts?.[team];
    if (Number.isInteger(before) && Number.isInteger(after) && after >= 0 && after < before) {
      push({ type: 'team_timeout', team, count: 1 });
    }
    if (pp.isSelf && pp.roundPhase === 'freezetime' && next.roundPhase === 'freezetime'
      && pp.mapRound === next.mapRound && pp.player?.team === team && pp.player.health > 0 && selfNow.health > 0
      && pp.player.hasWeapons && selfNow.hasWeapons) {
      const nextPrimary = primaryWeapons(selfNow);
      if (primaryWeapons(pp.player).some((name) => !nextPrimary.includes(name))) {
        push({ type: 'primary_removed' });
      }
    }
  }
  // 1. Переходы фаз раунда.
  if (pp) {
    const startInfo = () => ({
      type: 'round_start',
      round: next.mapRound,
      equipValue: selfNow ? selfNow.equipValue : null,
      money: selfNow ? selfNow.money : null,
    });
    const liveInfo = () => ({ type: 'round_live', round: next.mapRound, equipValue: selfNow ? selfNow.equipValue : null, at: next.ts });
    const startRound = () => {
      const fin = roundFinal(round);
      if (fin) push(fin);
      push(startInfo());
    };
    if (next.roundPhase === 'freezetime' && pp.roundPhase !== 'freezetime') startRound();
    else if (next.roundPhase === 'live' && pp.roundPhase === 'over') { startRound(); push(liveInfo()); }
    else if (next.roundPhase === 'live' && (pp.roundPhase === 'freezetime' || pp.mapPhase === 'warmup')) push(liveInfo());
  }

  // Бомба: закладка, разминирование, взрыв (кто именно — GSI не сообщает).
  if (pp && next.roundPhase !== 'freezetime' && next.bomb && next.bomb !== pp.bomb) {
    const kind = { planted: 'bomb_planted', defused: 'bomb_defused', exploded: 'bomb_exploded' }[next.bomb];
    if (kind) push({ type: kind, at: next.ts });
  }

  // 2. События стримера — только если оба пакета о нём и прошлый не из разминки.
  if (selfNow && lastSelf && lastSelf.mapPhase !== 'warmup') {
    for (const ev of diffPlayer(lastSelf.player, selfNow, round)) {
      if (ev.type === 'kill') {
        const wasLive = next.roundPhase === 'live' || (pp?.roundPhase === 'live' && !round.ended);
        ev.roundElapsedMs = wasLive && round.liveAt != null ? next.ts - round.liveAt : null;
        ev.plantedTeam = wasLive && (next.bomb ?? pp?.bomb ?? round.bomb) === 'planted' ? selfNow.team : null;
      }
      push(ev);
    }
  }

  // Урон, который сейчас показывает игра (кроме фризтайма, где он может быть ещё прошлым).
  // Служебное событие только для контекста раунда, задания его не используют.
  if (selfNow && next.roundPhase !== 'freezetime' && selfNow.roundDmg > (round.dmgSeen || 0)) {
    push({ type: 'self_state', roundDmg: selfNow.roundDmg });
  }

  // Ограничения раунда: держал ли стример основное оружие, перезаряжался ли (служебное событие).
  if (selfNow && next.roundPhase === 'live') {
    const act = activeWeapon(selfNow.weapons);
    const primary = !!act && PRIMARY_TYPES.includes(act.type || weaponTypeByName(act.name));
    const reloading = selfNow.weapons.some((w) => w.state === 'reloading');
    if ((primary && !round.usedPrimary) || (reloading && !round.reloaded)) push({ type: 'self_flags', primary, reloading });
  }

  // 3. Пакет о другом игроке во время раунда → стример мёртв и наблюдает.
  if (!next.isSelf && next.player && next.roundPhase === 'live' && !round.died) {
    push({ type: 'spectate', steamid: next.playerSteamId });
  }

  // 4. Конец раунда — по последним данным самого стримера.
  if (pp && next.roundPhase === 'over' && pp.roundPhase !== 'over') {
    const me = selfNow || lastSelf?.player || null;
    const team = me?.team ?? null;
    // При отсутствии инвентаря в финальном пакете используем свой последний пакет этого раунда.
    const inventory = selfNow?.hasWeapons ? selfNow
      : lastSelf?.mapRound === pp.mapRound && lastSelf.player.team === team && lastSelf.player.hasWeapons
        ? lastSelf.player : null;
    push({
      type: 'round_end',
      round: next.mapRound,
      winTeam: next.roundWinTeam,
      team,
      won: !!team && next.roundWinTeam === team,
      survived: !round.died && !!me && me.health > 0,
      died: round.died || (!!me && me.health <= 0) ? true : me ? false : null,
      savedPrimary: primaryWeapons(inventory),
      roundKills: round.kills,
      roundDamage: roundDamage(round),
      roundHs: round.hs,
      health: me?.health ?? null,
      roundEquipValue: round.equipValue,
      roundNumber: round.round, // номер раунда с 0 (map.round в пакете конца раунда уже следующий)
      liveAt: round.liveAt,
      endedAt: next.ts,
      bomb: next.bomb ?? round.bomb,
      timeLeft: timeLeftAt(round, next.ts),
      usedPrimary: round.usedPrimary,
      reloaded: round.reloaded,
    });
  }
  return out;
}
