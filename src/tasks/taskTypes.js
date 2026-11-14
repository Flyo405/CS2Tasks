// Реестр типов заданий. Чтобы добавить тип — добавьте объект в TASK_TYPES (и строку в README).
//
// Поля типа:
//   name        — короткое название для панели
//   icon        — эмодзи для оверлея (или iconFor(params))
//   mode        — 'counter' (выполняется при progress >= target) или 'end' (решается в конце матча)
//   bar         — стиль полоски: 'normal' | 'danger' | 'none'
//   params      — схема параметров { key: { kind, label, min, max, default } }
//   title(p)    — русский текст для оверлея
//   target(p)   — цель
//   onEvent(task, event, ctx) → новый прогресс или undefined
//   live(task, ctx) → { progress, display } — живое значение (для 'end')
//   failNow(task, ctx) → true, если условие уже нарушено
//   onMatchEnd(task, ctx, event) → 'completed' | 'failed'
import { randomUUID } from 'node:crypto';
import { WEAPONS, WEAPON_TYPES, weaponName, weaponWith, weaponMatches, weaponTypeMatches, canonicalWeapon } from './weapons.js';

export class TaskError extends Error {}
export const MATCH_END_TYPES = ['win_match', 'max_deaths'];
export const RETIRED_TYPES = ['damage_total', 'damage_rounds', 'teamkill', ...MATCH_END_TYPES];

export const DIFFICULTIES = ['easy', 'medium', 'hard'];

export function plural(n, one, few, many) {
  const a = Math.abs(Math.trunc(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

const P = {
  int: (label, min, max, def) => ({ kind: 'int', label, min, max, default: def }),
  float: (label, min, max, def) => ({ kind: 'float', label, min, max, default: def }),
  weapon: (def = 'weapon_deagle') => ({ kind: 'weapon', label: 'Оружие', default: def }),
  weaponType: (def = 'Pistol') => ({ kind: 'weaponType', label: 'Тип оружия', default: def }),
  text: (label, maxLength) => ({ kind: 'text', label, maxLength, default: '' }),
};

const killsWord = (n) => plural(n, 'убийство', 'убийства', 'убийств');
const roundsWord = (n) => plural(n, 'раунд', 'раунда', 'раундов');

const sumOf = (evType, field = 'count') => (t, e) => (e.type === evType ? t.progress + e[field] : undefined);

export const KILL_COMBOS = {
  jump_noscope: { label: 'В прыжке + ноускоп', conditions: ['jump', 'noscope'] },
  spin_noscope: { label: 'После 360° + ноускоп', conditions: ['spin', 'noscope'] },
  spin_jump: { label: 'После 360° + в прыжке', conditions: ['spin', 'jump'] },
  spin_jump_noscope: { label: 'После 360° + в прыжке + ноускоп', conditions: ['spin', 'jump', 'noscope'] },
  jump_headshot: { label: 'В прыжке + хедшот', conditions: ['jump', 'headshot'] },
  jump_flashed: { label: 'В прыжке + ослеплённым', conditions: ['jump', 'flashed'] },
  noscope_headshot: { label: 'Ноускоп + хедшот', conditions: ['noscope', 'headshot'] },
  noscope_flashed: { label: 'Ноускоп + ослеплённым', conditions: ['noscope', 'flashed'] },
  smoke_headshot: { label: 'Находясь в дыму + хедшот', conditions: ['smoked', 'headshot'] },
  fire_headshot: { label: 'Пока горишь + хедшот', conditions: ['burning', 'headshot'] },
  lowhp_headshot: { label: 'С HP ≤ 30 + хедшот', conditions: ['lowhp', 'headshot'] },
};

export function comboRequirement(params = {}) {
  const c = KILL_COMBOS[params.combo || 'jump_noscope']?.conditions || [];
  return c.includes('spin') ? 'spin' : c.some((x) => ['jump', 'noscope'].includes(x)) ? 'input' : null;
}

function comboKills(t, e) {
  if (e.type !== 'kill') return undefined;
  const c = KILL_COMBOS[t.params.combo].conditions;
  const checks = { jump: e.jump, spin: e.spin, noscope: e.noscope && e.weapon?.type === 'SniperRifle',
    headshot: e.headshots > 0, flashed: e.flashed > 0, smoked: e.smoked > 0,
    burning: e.burning > 0, lowhp: e.hpAtKill > 0 && e.hpAtKill <= 30 };
  if (!c.every((x) => checks[x])) return undefined;
  return t.progress + (c.includes('headshot') ? Math.min(e.headshots, e.count) : e.count);
}

/** Победа «на последних секундах»: осталось ≤ s секунд, но не взрыв бомбы и не победа CT по времени. */
export function lastSecondsWin(e, seconds) {
  if (e.type !== 'round_end' || !e.won || e.timeLeft == null) return false;
  if (e.bomb === 'exploded') return false; // взрыв всегда на нуле
  if (!e.bomb && e.team === 'CT' && e.timeLeft <= 1) return false; // время вышло — победа CT без боя
  return e.timeLeft <= seconds && e.timeLeft > -3;
}

const pistolRound = (n) => n === 0 || n === 12;
const taskKd = (t) => Math.round(100 * (t.roundKd?.kills ?? 0) / Math.max(1, t.roundKd?.deaths ?? 0)) / 100;
const roundKdDisplay = (t) => `K/D ${taskKd(t).toFixed(2)} / ${t.params.kd.toFixed(2)} · ${t.roundKd?.rounds ?? 0}/${t.target}`;
const ENEMY_WEAPONS = {
  CT: new Set(['weapon_ak47', 'weapon_galilar', 'weapon_tec9', 'weapon_mac10']),
  T: new Set(['weapon_m4a1', 'weapon_m4a1_silencer', 'weapon_famas', 'weapon_aug', 'weapon_mp9', 'weapon_usp_silencer']),
};

function fullRoundInputTask(name, title, flag) {
  return {
    name, icon: '🎯', mode: 'counter', requires: 'input', params: {}, title: () => title, target: () => 1,
    onEvent: (t, e) => e.type === 'round_end' && e.liveAt >= (t.activeSince ?? t.createdAt) && e[flag] ? 1 : undefined,
  };
}

function killChallenge(name, icon, condition, matches, requires) {
  return {
    name, icon, mode: 'counter', requires,
    params: { count: P.int('Убийств', 1, 10, 1) },
    title: (p) => `${p.count} ${killsWord(p.count)} ${condition}`,
    target: (p) => p.count,
    onEvent: (t, e) => e.type === 'kill' && matches(e) ? t.progress + (requires ? 1 : e.count) : undefined,
  };
}

export const TASK_TYPES = {
  enemy_weapon_kills: killChallenge('Убийства вражеским оружием', '🎯', 'из оружия другой стороны',
    (e) => ENEMY_WEAPONS[e.team]?.has(e.weapon?.name)),
  match_arsenal: {
    name: 'Арсенал за матч', icon: '🎯', mode: 'counter',
    params: { count: P.int('Разных видов оружия', 2, 20, 8) },
    title: (p) => `Убить из ${p.count} разных видов оружия за матч`,
    target: (p) => p.count,
    onEvent: (t, e) => {
      const name = canonicalWeapon(e.weapon?.name);
      if (e.type !== 'kill' || !WEAPONS[name] || name === 'weapon_c4' || t.arsenal?.includes(name)) return;
      t.arsenal = [...(t.arsenal ?? []), name];
      return t.arsenal.length;
    },
  },
  team_timeout: {
    name: 'Тайм-аут команды', icon: '⏱️', mode: 'counter', params: {},
    title: () => 'Взять тайм-аут своей командой', target: () => 1, onEvent: sumOf('team_timeout', 'count'),
  },
  forward_only_round: fullRoundInputTask('Только вперёд', 'Пройти раунд, двигаясь только вперёд (W)', 'forwardOnly'),
  walk_only_round: fullRoundInputTask('Тихий раунд', 'Пройти раунд, двигаясь только с зажатым Shift', 'walkOnly'),
  team_drops: {
    name: 'Дроп тиммейту', icon: '🎯', mode: 'counter', requires: 'input',
    params: { count: P.int('Сколько раз', 1, 10, 2) },
    title: (p) => `Отдать основное оружие тиммейту ${p.count} ${plural(p.count, 'раз', 'раза', 'раз')} за матч`,
    target: (p) => p.count,
    onEvent: (t, e) => e.type === 'team_drop' ? t.progress + 1 : undefined,
  },
  held_angle_kills: killChallenge('Убийство с удержания угла', '🎯', 'с удержания угла', (e) => e.heldAngle, 'spin'),
  early_round_kills: killChallenge('Агрессивный вход', '⏱️', 'в первые 20 секунд раунда',
    (e) => e.roundElapsedMs != null && e.roundElapsedMs >= 0 && e.roundElapsedMs <= 20_000),
  save_primary: {
    name: 'Сейв основного оружия', icon: '🛡️', mode: 'counter',
    params: { weapon: { kind: 'choice', label: 'Оружие', default: 'any', options: [
      { value: 'any', label: 'Любое основное оружие' }, { value: 'weapon_awp', label: 'AWP' },
    ] } },
    title: (p) => `Выжить в проигранном раунде и сохранить ${p.weapon === 'weapon_awp' ? 'AWP' : 'основное оружие'}`,
    target: () => 1,
    onEvent: (t, e) => e.type === 'round_end' && ['CT', 'T'].includes(e.team)
      && e.winTeam === (e.team === 'CT' ? 'T' : 'CT') && e.survived
      && e.savedPrimary?.some((name) => t.params.weapon === 'any' || name === t.params.weapon) ? t.progress + 1 : undefined,
  },
  defuse_survive: {
    name: 'Победа разминированием с выживанием', icon: '🏁', mode: 'counter', side: 'CT', opposite: 'plant_survive',
    params: {}, title: () => 'Выиграть раунд разминированием и выжить', target: () => 1,
    onEvent: (t, e) => e.type === 'round_end' && e.team === 'CT' && e.won && e.survived && e.bomb === 'defused' ? t.progress + 1 : undefined,
  },
  plant_survive: {
    name: 'Победа после закладки с выживанием', icon: '🏁', mode: 'counter', side: 'T', opposite: 'defuse_survive',
    params: {}, title: () => 'Выиграть раунд после закладки и выжить', target: () => 1,
    onEvent: (t, e) => e.type === 'round_end' && e.team === 'T' && e.won && e.survived
      && ['planted', 'exploded'].includes(e.bomb) ? t.progress + 1 : undefined,
  },
  post_plant_kills: {
    ...killChallenge('Убийства после закладки', '🎯', 'за T после закладки бомбы', (e) => e.plantedTeam === 'T'),
    side: 'T', opposite: 'retake_kills',
  },
  retake_kills: {
    ...killChallenge('Убийства на ретейке', '🎯', 'за CT, пока бомба заложена', (e) => e.plantedTeam === 'CT'),
    side: 'CT', opposite: 'post_plant_kills',
  },
  flick_kills: killChallenge('Флик-убийства', '🎯', 'фликом', (e) => e.flick, 'spin'),
  crouch_kills: killChallenge('Убийства присев', '🎯', 'с зажатым Ctrl', (e) => e.crouched, 'input'),
  stationary_kills: killChallenge('Убийства с места', '🎯', 'без нажатия WASD в момент выстрела', (e) => e.stationary, 'input'),
  one_tap_kills: killChallenge('Убийства с первого выстрела', '🎯', 'с первого выстрела (one tap)', (e) => e.oneTap, 'input'),
  // ---------- Экономика ----------
  money_saved: {
    name: 'Накопить деньги', icon: '💰', mode: 'counter',
    params: { money: P.int('Сумма, $', 1000, 16000, 10000) },
    title: (p) => `Накопить $${p.money}`, target: (p) => p.money,
    // Деньги берутся из последнего пакета о самом стримере; разминка не считается.
    live: (t, ctx) => {
      const live = ctx.match?.phase === 'live' && ctx.match?.status === 'live';
      const money = live ? (ctx.player?.money ?? 0) : 0;
      const progress = Math.min(t.target, Math.max(t.progress, money));
      return { progress, display: `$${progress} / $${t.target}` };
    },
  },
  full_buy_streak: {
    name: 'Полная закупка подряд', icon: '🛡️', mode: 'counter',
    params: { equip: P.int('Снаряжение от, $', 2000, 10000, 4500), count: P.int('Раундов подряд', 2, 10, 3) },
    title: (p) => `Полная закупка (снаряжение ≥ $${p.equip}) ${p.count} ${roundsWord(p.count)} подряд`, target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'round_live' && e.equipValue != null ? (e.equipValue >= t.params.equip ? t.progress + 1 : 0) : undefined),
  },
  force_buy_wins: {
    name: 'Победа на форс-бае', icon: '💸', mode: 'counter',
    params: { min: P.int('Снаряжение от, $', 0, 8000, 2000), max: P.int('Снаряжение до, $', 500, 10000, 3800), count: P.int('Побед', 1, 5, 1) },
    title: (p) => `Выиграть ${p.count === 1 ? 'форс-бай' : `${p.count} ${plural(p.count, 'форс-бай', 'форс-бая', 'форс-баев')}`} (снаряжение $${p.min}–$${p.max})`, target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'round_end' && e.won && e.roundEquipValue != null
      && e.roundEquipValue >= t.params.min && e.roundEquipValue <= t.params.max ? t.progress + 1 : undefined),
  },
  // ---------- Время раунда ----------
  last_seconds_wins: {
    name: 'Победа на последних секундах', icon: '⏱️', mode: 'counter',
    params: { seconds: P.int('Секунд до конца, не больше', 2, 20, 20), count: P.int('Побед', 1, 5, 1) },
    title: (p) => `Выиграть ${p.count === 1 ? 'раунд' : `${p.count} ${roundsWord(p.count)}`}, когда до конца ≤ ${p.seconds} с`, target: (p) => p.count,
    onEvent: (t, e) => (lastSecondsWin(e, t.params.seconds) ? t.progress + 1 : undefined),
  },
  // ---------- Ограничения на раунд (победа + хотя бы одно своё убийство) ----------
  no_jump_wins: {
    name: 'Раунд без прыжков', icon: '🚫', mode: 'counter', requires: 'input',
    params: { count: P.int('Раундов', 1, 5, 1) },
    title: (p) => `Выиграть ${p.count === 1 ? 'раунд' : `${p.count} ${roundsWord(p.count)}`} с убийством, ни разу не прыгнув`, target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'round_end' && e.won && e.roundKills >= 1 && e.jumped === false ? t.progress + 1 : undefined),
  },
  pistol_only_wins: {
    name: 'Раунд только с ножом и пистолетом', icon: '🔫', mode: 'counter',
    params: { count: P.int('Раундов', 1, 5, 1) },
    title: (p) => `Выиграть ${p.count === 1 ? 'раунд' : `${p.count} ${roundsWord(p.count)}`} с убийством, используя только нож и пистолет`, target: (p) => p.count,
    // Пистолетные раунды не в счёт — там это не ограничение.
    onEvent: (t, e) => (e.type === 'round_end' && e.won && e.roundKills >= 1 && !e.usedPrimary
      && e.roundNumber != null && !pistolRound(e.roundNumber) ? t.progress + 1 : undefined),
  },
  no_reload_wins: {
    name: 'Раунд без перезарядки', icon: '🔫', mode: 'counter',
    params: { count: P.int('Раундов', 1, 5, 1) },
    title: (p) => `Выиграть ${p.count === 1 ? 'раунд' : `${p.count} ${roundsWord(p.count)}`} с убийством, ни разу не перезарядившись`, target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'round_end' && e.won && e.roundKills >= 1 && !e.reloaded && !e.reloadKey ? t.progress + 1 : undefined),
  },

  unarmored_kills: {
    name: 'Убийства без брони', icon: '🛡️', mode: 'counter',
    params: { count: P.int('Убийств', 1, 10, 1) },
    title: (p) => `${p.count} ${killsWord(p.count)} без брони`, target: (p) => p.count,
    onEvent: (t, e) => e.type === 'kill' && e.armorAtKill === 0 ? t.progress + e.count : undefined,
  },
  last_bullet_kills: {
    name: 'Убийство последним патроном (приблизительно)', icon: '🎯', mode: 'counter',
    params: { count: P.int('Убийств', 1, 10, 1) },
    title: (p) => `${p.count} ${killsWord(p.count)} последним патроном`, target: (p) => p.count,
    onEvent: (t, e) => e.type === 'kill' && e.lastBullet ? t.progress + 1 : undefined,
  },
  pistol_round_kills: {
    name: 'Убийства в пистолетном раунде', icon: '🔫', mode: 'counter', roundScoped: true,
    params: { count: P.int('Убийств', 1, 5, 1) },
    title: (p) => `${p.count} ${killsWord(p.count)} из пистолета в этом пистолетном раунде`, target: (p) => p.count,
    onEvent: (t, e) => e.type === 'kill' && e.pistolRound && e.weapon?.type === 'Pistol' ? t.progress + e.count : undefined,
  },
  combo_kills: {
    name: 'Комбо на одном убийстве', icon: '🎯', mode: 'counter',
    params: {
      combo: { kind: 'choice', label: 'Сочетание условий', default: 'jump_noscope',
        options: Object.entries(KILL_COMBOS).map(([value, c]) => ({ value, label: c.label, requires: comboRequirement({ combo: value }) })) },
      count: P.int('Убийств с комбо', 1, 10, 1),
    },
    title: (p) => `${p.count} ${killsWord(p.count)}: ${KILL_COMBOS[p.combo].label.toLowerCase()}`,
    target: (p) => p.count,
    onEvent: comboKills,
  },
  kill_streak: {
    name: 'Серия убийств без смерти', icon: '🔥', mode: 'counter',
    params: { count: P.int('Убийств подряд', 2, 30, 5) },
    title: (p) => `${p.count} ${killsWord(p.count)} без смерти`, target: (p) => p.count,
    onEvent: (t, e) => e.type === 'kill' ? t.progress + e.count
      : ['death', 'spectate'].includes(e.type) ? 0 : undefined,
  },
  survival_streak: {
    name: 'Серия раундов без смерти', icon: '🛡️', mode: 'counter',
    params: { count: P.int('Раундов подряд', 2, 15, 3) },
    title: (p) => `Выжить ${p.count} ${roundsWord(p.count)} подряд`, target: (p) => p.count,
    onEvent: (t, e) => ['death', 'spectate'].includes(e.type) ? 0
      : e.type === 'round_end' ? (e.survived ? t.progress + 1 : 0) : undefined,
  },
  win_streak: {
    name: 'Победная серия команды', icon: '🏁', mode: 'counter',
    params: { count: P.int('Побед подряд', 2, 15, 3) },
    title: (p) => `Выиграть ${p.count} ${roundsWord(p.count)} подряд`, target: (p) => p.count,
    onEvent: (t, e) => e.type === 'round_end' ? (e.won ? t.progress + 1 : 0) : undefined,
  },
  full_hp_kill_rounds: {
    name: 'Убийство и 100 HP в конце раунда', icon: '❤️', mode: 'counter',
    params: { count: P.int('Раундов', 1, 10, 1) },
    title: (p) => `Убить и закончить раунд со 100 HP — ${p.count} ${plural(p.count, 'раз', 'раза', 'раз')}`,
    target: (p) => p.count,
    onEvent: (t, e) => {
      if (e.type === 'round_start') t.roundHadKill = false;
      if (e.type === 'kill') t.roundHadKill = true;
      if (e.type !== 'round_end') return undefined;
      const ok = t.roundHadKill && e.survived && e.health === 100;
      t.roundHadKill = false;
      return t.progress + (ok ? 1 : 0);
    },
  },
  smoked_kills: {
    name: 'Убийства находясь в дыму', icon: '☁️', mode: 'counter',
    params: { count: P.int('Убийств', 1, 10, 1) },
    title: (p) => `${p.count} ${killsWord(p.count)}, находясь в дыму`, target: (p) => p.count,
    onEvent: (t, e) => e.type === 'kill' && e.smoked > 0 ? t.progress + e.count : undefined,
  },
  burning_kills: {
    name: 'Убийства пока горишь', icon: '🔥', mode: 'counter',
    params: { count: P.int('Убийств', 1, 10, 1) },
    title: (p) => `${p.count} ${killsWord(p.count)}, пока горишь`, target: (p) => p.count,
    onEvent: (t, e) => e.type === 'kill' && e.burning > 0 ? t.progress + e.count : undefined,
  },
  different_weapon_round: {
    name: 'Убийства разным оружием за раунд', icon: '🔫', mode: 'counter',
    params: { count: P.int('Разных видов оружия', 2, 5, 2) },
    title: (p) => `Убить из ${p.count} разных видов оружия за раунд`, target: (p) => p.count,
    onEvent: (t, e) => {
      if (e.type === 'round_start') { t.killWeapons = []; return 0; }
      if (e.type !== 'kill' || !e.weapon?.name || e.weapon.name === 'unknown') return undefined;
      const name = canonicalWeapon(e.weapon.name);
      t.killWeapons = [...new Set([...(t.killWeapons || []), name])];
      return t.killWeapons.length;
    },
  },
  eco_round_wins: {
    name: 'Победа на эко', icon: '💸', mode: 'counter',
    params: { equip: P.int('Снаряжение до, $', 0, 10000, 2000), count: P.int('Побед', 1, 10, 1) },
    title: (p) => `Выиграть ${p.count} ${roundsWord(p.count)} со снаряжением ≤ $${p.equip}`,
    target: (p) => p.count,
    onEvent: (t, e) => e.type === 'round_end' && e.won && e.roundEquipValue != null
      && e.roundEquipValue <= t.params.equip ? t.progress + 1 : undefined,
  },
  kills: {
    name: 'Убийства',
    icon: '🔫',
    mode: 'counter',
    params: { count: P.int('Убийств', 1, 100, 15) },
    title: (p) => `${p.count} ${killsWord(p.count)} за матч`,
    target: (p) => p.count,
    onEvent: sumOf('kill'),
  },
  headshots: {
    name: 'Хедшоты',
    icon: '🎯',
    mode: 'counter',
    params: { count: P.int('Хедшотов', 1, 100, 5) },
    title: (p) => `${p.count} ${plural(p.count, 'хедшот', 'хедшота', 'хедшотов')}`,
    target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'kill' ? t.progress + e.headshots : undefined),
  },
  weapon_kills: {
    name: 'Убийства оружием',
    icon: '🔫',
    mode: 'counter',
    params: { weapon: P.weapon(), count: P.int('Убийств', 1, 50, 3) },
    title: (p) => `${p.count} ${killsWord(p.count)} ${weaponWith(p.weapon)}`,
    iconFor: (p) => (canonicalWeapon(p.weapon) === 'weapon_knife' ? '🔪' : p.weapon === 'weapon_taser' ? '⚡' : '🔫'),
    target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'kill' && weaponMatches(e.weapon, t.params.weapon) ? t.progress + e.count : undefined),
  },
  weapon_type_kills: {
    name: 'Убийства типом оружия',
    icon: '🔫',
    mode: 'counter',
    params: { weaponType: P.weaponType(), count: P.int('Убийств', 1, 50, 4) },
    title: (p) => `${p.count} ${killsWord(p.count)} ${WEAPON_TYPES[p.weaponType]?.with ?? p.weaponType}`,
    iconFor: (p) => (p.weaponType === 'Knife' ? '🔪' : '🔫'),
    target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'kill' && weaponTypeMatches(e.weapon, t.params.weaponType) ? t.progress + e.count : undefined),
  },
  multikill_rounds: {
    name: 'Мультикиллы',
    icon: '🔥',
    mode: 'counter',
    params: { kills: P.int('Убийств за раунд', 2, 5, 3), count: P.int('Сколько раз', 1, 10, 1) },
    title: (p) => (p.count === 1
      ? `${p.kills}+ ${killsWord(p.kills)} за раунд`
      : `${p.kills}+ ${killsWord(p.kills)} за раунд — ${p.count} ${plural(p.count, 'раз', 'раза', 'раз')}`),
    target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'round_end' && e.roundKills >= t.params.kills ? t.progress + 1 : undefined),
  },
  ace: {
    name: 'Эйс',
    icon: '💀',
    mode: 'counter',
    params: {},
    title: () => 'Эйс (5 убийств за раунд)',
    target: () => 1,
    onEvent: (t, e) => (e.type === 'round_end' && e.roundKills >= 5 ? t.progress + 1 : undefined),
  },
  mvps: {
    name: 'MVP',
    icon: '⭐',
    mode: 'counter',
    params: { count: P.int('MVP', 1, 30, 2) },
    title: (p) => `${p.count} MVP`,
    target: (p) => p.count,
    onEvent: sumOf('mvp'),
  },
  assists: {
    name: 'Ассисты',
    icon: '🤝',
    mode: 'counter',
    params: { count: P.int('Ассистов', 1, 50, 3) },
    title: (p) => `${p.count} ${plural(p.count, 'ассист', 'ассиста', 'ассистов')}`,
    target: (p) => p.count,
    onEvent: sumOf('assist'),
  },
  survive_rounds: {
    name: 'Выжить в раундах',
    icon: '❤️',
    mode: 'counter',
    params: { count: P.int('Раундов', 1, 30, 5) },
    title: (p) => `Выжить в ${p.count} ${plural(p.count, 'раунде', 'раундах', 'раундах')}`,
    target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'round_end' && e.survived ? t.progress + 1 : undefined),
  },
  low_hp_kills: {
    name: 'Убийства с малым HP',
    icon: '🩸',
    mode: 'counter',
    params: { hp: P.int('Максимум HP', 1, 99, 30), count: P.int('Убийств', 1, 20, 2) },
    title: (p) => `${p.count} ${killsWord(p.count)}, имея ≤ ${p.hp} HP`,
    target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'kill' && e.hpAtKill > 0 && e.hpAtKill <= t.params.hp ? t.progress + e.count : undefined),
  },
  flashed_kills: {
    name: 'Убийства ослеплённым',
    icon: '😵',
    mode: 'counter',
    params: { count: P.int('Убийств', 1, 20, 1) },
    title: (p) => `${p.count} ${killsWord(p.count)} ослеплённым`,
    target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'kill' && e.flashed > 0 ? t.progress + e.count : undefined),
  },
  eco_kills: {
    name: 'Убийства на эко',
    icon: '💸',
    mode: 'counter',
    params: { equip: P.int('Снаряжение до, $', 0, 10000, 2000), count: P.int('Убийств', 1, 30, 3) },
    title: (p) => `${p.count} ${killsWord(p.count)} на эко (снаряжение ≤ $${p.equip})`,
    target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'kill' && e.roundEquipValue != null && e.roundEquipValue <= t.params.equip ? t.progress + e.count : undefined),
  },
  round_wins: {
    name: 'Победы в раундах',
    icon: '🏁',
    mode: 'counter',
    params: { count: P.int('Раундов', 1, 30, 8) },
    title: (p) => `Выиграть ${p.count} ${roundsWord(p.count)}`,
    target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'round_end' && e.won ? t.progress + 1 : undefined),
  },
  // Три типа ниже требуют помощника ввода (мышь и клавиатура Windows), см. src/input/.
  spin_kills: {
    name: 'Убийство после 360°',
    icon: '🌀',
    mode: 'counter',
    requires: 'spin',
    params: { count: P.int('Убийств', 1, 10, 1) },
    title: (p) => (p.count === 1 ? 'Убийство после разворота на 360°' : `${p.count} ${killsWord(p.count)} после разворота на 360°`),
    target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'kill' && e.spin ? t.progress + e.count : undefined),
  },
  jump_kills: {
    name: 'Убийства в прыжке',
    icon: '🦘',
    mode: 'counter',
    requires: 'input',
    params: { count: P.int('Убийств', 1, 20, 1) },
    title: (p) => (p.count === 1 ? 'Убийство в прыжке' : `${p.count} ${killsWord(p.count)} в прыжке`),
    target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'kill' && e.jump ? t.progress + e.count : undefined),
  },
  noscope_kills: {
    name: 'Ноускоп',
    icon: '🔭',
    mode: 'counter',
    requires: 'input',
    params: { count: P.int('Убийств', 1, 10, 1) },
    title: (p) => (p.count === 1 ? 'Ноускоп со снайперки' : `${p.count} ${plural(p.count, 'ноускоп', 'ноускопа', 'ноускопов')} со снайперки`),
    target: (p) => p.count,
    onEvent: (t, e) => (e.type === 'kill' && e.noscope ? t.progress + e.count : undefined),
  },
  positive_kd: {
    name: 'K/D за несколько раундов',
    icon: '📈',
    mode: 'counter',
    params: { kd: P.float('K/D не меньше', 0.1, 10, 1), rounds: P.int('Раундов', 2, 5, 3) },
    title: (p) => `Набрать K/D ≥ ${p.kd.toFixed(2)} за ${p.rounds} ${roundsWord(p.rounds)}`,
    target: (p) => p.rounds,
    onEvent: (t, e) => {
      if (e.type !== 'round_end' || e.liveAt == null || e.liveAt < (t.activeSince ?? t.createdAt)
        || typeof e.died !== 'boolean' || t.roundKd?.rounds >= t.target) return;
      const totals = t.roundKd ?? { rounds: 0, kills: 0, deaths: 0 };
      t.roundKd = { rounds: totals.rounds + 1, kills: totals.kills + e.roundKills, deaths: totals.deaths + Number(e.died) };
      t.display = roundKdDisplay(t);
      if (t.roundKd.rounds < t.target || taskKd(t) >= t.params.kd) return t.roundKd.rounds;
    },
    live: (t) => ({ display: roundKdDisplay(t) }),
    failNow: (t) => t.roundKd?.rounds >= t.target && taskKd(t) < t.params.kd,
  },
  manual: {
    name: 'Своё задание (вручную)',
    icon: '✍️',
    mode: 'counter',
    manual: true,
    params: { text: P.text('Текст', 80), count: P.int('Сколько раз', 1, 100, 1) },
    title: (p) => p.text,
    target: (p) => p.count,
  },
};

export function getType(id) {
  return !RETIRED_TYPES.includes(id) && Object.prototype.hasOwnProperty.call(TASK_TYPES, id) ? TASK_TYPES[id] : null;
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function normalizeParamValue(schema, value) {
  let v = value;
  if (v === undefined || v === null || v === '') v = schema.default;
  switch (schema.kind) {
    case 'choice': {
      if (!schema.options.some((o) => o.value === v)) throw new TaskError(`Неизвестное сочетание: ${v}`);
      return v;
    }
    case 'int': {
      let n = Math.round(Number(v));
      if (!Number.isFinite(n)) n = schema.default;
      return clamp(n, schema.min, schema.max);
    }
    case 'float': {
      let n = Number(v);
      if (!Number.isFinite(n)) n = schema.default;
      return Math.round(clamp(n, schema.min, schema.max) * 100) / 100;
    }
    case 'weapon': {
      let s = String(v).trim().toLowerCase();
      if (!s.startsWith('weapon_')) s = `weapon_${s}`;
      s = canonicalWeapon(s);
      if (!WEAPONS[s]) throw new TaskError(`Неизвестное оружие: ${value}`);
      return s;
    }
    case 'weaponType': {
      if (!WEAPON_TYPES[v]) throw new TaskError(`Неизвестный тип оружия: ${value}`);
      return v;
    }
    case 'text': {
      const s = String(v).replace(/\s+/g, ' ').trim().slice(0, schema.maxLength);
      if (!s) throw new TaskError('Пустой текст задания');
      return s;
    }
    default:
      return v;
  }
}

/** Проверяет и обрезает параметры по схеме типа. Бросает TaskError. */
export function normalizeParams(typeId, input = {}) {
  const type = getType(typeId);
  if (!type) throw new TaskError(`Неизвестный тип задания: ${typeId}`);
  const out = {};
  for (const [key, schema] of Object.entries(type.params)) out[key] = normalizeParamValue(schema, input?.[key]);
  return out;
}

export function titleFor(typeId, params) {
  return getType(typeId).title(params);
}

export function buildTask(typeId, params, extra = {}) {
  const type = getType(typeId);
  if (!type) throw new TaskError(`Неизвестный тип задания: ${typeId}`);
  return {
    id: randomUUID(),
    type: typeId,
    params,
    title: type.title(params),
    icon: type.iconFor ? type.iconFor(params) : type.icon,
    mode: type.mode,
    bar: type.bar || 'normal',
    progress: 0,
    target: type.target(params),
    display: null,
    status: 'active',
    source: 'random',
    author: null,
    difficulty: null,
    createdAt: Date.now(),
    finishedAt: null,
    matchId: null,
    reason: null,
    ...extra,
  };
}

/** Описание типов для панели (без функций). */
export function describeTypes() {
  return Object.entries(TASK_TYPES).filter(([id]) => !RETIRED_TYPES.includes(id)).map(([id, t]) => ({
    id,
    name: t.name,
    icon: t.icon,
    mode: t.mode,
    manual: !!t.manual,
    requires: t.requires || null,
    params: t.params,
  }));
}

export { weaponName };
