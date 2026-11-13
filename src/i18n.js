import { translate } from '../public/shared/text.js';
import { weaponName } from './tasks/weapons.js';
export { translate };
const word = (n, singular, plural = `${singular}s`) => n === 1 ? singular : plural;
const weaponTypes = { Pistol: 'pistols', Rifle: 'rifles', SniperRifle: 'sniper rifles', Shotgun: 'shotguns', Knife: 'a knife', 'Submachine Gun': 'SMGs', 'Machine Gun': 'machine guns' };
export const comboNames = {
  jump_noscope: 'jump + no-scope', spin_noscope: '360° + no-scope', spin_jump: '360° + jump',
  spin_jump_noscope: '360° + jump + no-scope', jump_headshot: 'jump + headshot', jump_flashed: 'jump + blinded',
  noscope_headshot: 'no-scope + headshot', noscope_flashed: 'no-scope + blinded',
  smoke_headshot: 'inside smoke + headshot', fire_headshot: 'on fire + headshot', lowhp_headshot: 'HP ≤ 30 + headshot',
};
export const typeNames = {
  plant_survive: 'Survive a post-plant win',
  enemy_weapon_kills: 'Enemy weapon kills', match_arsenal: 'Match arsenal', team_timeout: 'Team timeout',
  forward_only_round: 'Forward only', walk_only_round: 'Walk-only round', team_drops: 'Drop for a teammate',
  held_angle_kills: 'Angle-hold kills',
  early_round_kills: 'Aggressive entry', save_primary: 'Save a primary weapon',
  defuse_survive: 'Survive a defuse win', post_plant_kills: 'T post-plant kills', retake_kills: 'CT retake kills',
  flick_kills: 'Flick kills', crouch_kills: 'Crouch kills', stationary_kills: 'Stationary kills', one_tap_kills: 'One-tap kills',
  unarmored_kills: 'Kills without armor', last_bullet_kills: 'Last-bullet kills (approximate)', pistol_round_kills: 'Pistol-round kills',
  combo_kills: 'Single-kill combo', kill_streak: 'Kill streak without dying', survival_streak: 'Consecutive rounds survived',
  win_streak: 'Team win streak', full_hp_kill_rounds: 'Get a kill and finish at 100 HP', smoked_kills: 'Kills while inside smoke',
  burning_kills: 'Kills while on fire', different_weapon_round: 'Different weapons in one round', eco_round_wins: 'Eco round wins',
  kills: 'Kills', headshots: 'Headshots', weapon_kills: 'Kills with a weapon', weapon_type_kills: 'Kills with a weapon class',
  multikill_rounds: 'Multi-kill rounds', ace: 'Ace', mvps: 'MVP awards', assists: 'Assists', survive_rounds: 'Rounds survived',
  low_hp_kills: 'Low-HP kills', flashed_kills: 'Kills while blinded', eco_kills: 'Eco kills', round_wins: 'Round wins',
  spin_kills: 'Kills after a 360° turn', jump_kills: 'Jump kills', noscope_kills: 'No-scope kills',
  win_match: 'Match victory', max_deaths: 'Death limit', positive_kd: 'K/D over several rounds', manual: 'Custom challenge (manual)',
  money_saved: 'Save up money', full_buy_streak: 'Full buys in a row', force_buy_wins: 'Force-buy wins',
  last_seconds_wins: 'Last-seconds round wins', no_jump_wins: 'Round without jumping', pistol_only_wins: 'Round with knife and pistol only',
  no_reload_wins: 'Round without reloading',
};
export function taskTitle(task, language) {
  if (language !== 'en' || task.type === 'manual') return task.title;
  const p = task.params || {}, n = p.count, kills = `${n} ${word(n, 'kill')}`;
  const titles = {
    plant_survive: () => 'Win after planting and survive',
    enemy_weapon_kills: () => `${kills} with weapons from the other side`,
    match_arsenal: () => `Get kills with ${n} different weapons in one match`,
    team_timeout: () => 'Take a timeout with your team',
    forward_only_round: () => 'Finish a round moving only forward (W)',
    walk_only_round: () => 'Finish a round moving only with Shift held',
    team_drops: () => `Drop a primary weapon for a teammate ${n} ${word(n, 'time')} in one match`,
    held_angle_kills: () => `${kills} while holding an angle`,
    early_round_kills: () => `${kills} in the first 20 seconds of a round`,
    save_primary: () => `Survive a lost round and save ${p.weapon === 'weapon_awp' ? 'an AWP' : 'a primary weapon'}`,
    defuse_survive: () => 'Win by defuse and survive',
    post_plant_kills: () => `${kills} as T after the bomb is planted`,
    retake_kills: () => `${kills} as CT while the bomb is planted`,
    flick_kills: () => `${kills} with a flick`,
    crouch_kills: () => `${kills} while holding Ctrl`,
    stationary_kills: () => `${kills} with no WASD held at the shot`,
    one_tap_kills: () => `${kills} with a single tap`,
    unarmored_kills: () => `${kills} without armor`, last_bullet_kills: () => `${kills} with the last bullet`,
    pistol_round_kills: () => `${kills} with a pistol this pistol round`, combo_kills: () => `${kills}: ${comboNames[p.combo]}`,
    kill_streak: () => `${kills} without dying`, survival_streak: () => `Survive ${n} consecutive rounds`,
    win_streak: () => `Win ${n} consecutive rounds`, full_hp_kill_rounds: () => `Get a kill and finish at 100 HP — ${n} ${word(n, 'round')}`,
    smoked_kills: () => `${kills} while inside smoke`, burning_kills: () => `${kills} while on fire`,
    different_weapon_round: () => `Get kills with ${n} different weapons in one round`,
    eco_round_wins: () => `Win ${n} ${word(n, 'round')} with equipment ≤ $${p.equip}`,
    kills: () => `${kills} this match`, headshots: () => `${n} ${word(n, 'headshot')}`,
    weapon_kills: () => `${kills} with ${translate(weaponName(p.weapon), 'en')}`,
    weapon_type_kills: () => `${kills} with ${weaponTypes[p.weaponType] || p.weaponType}`,
    multikill_rounds: () => `${p.kills}+ kills in one round${n > 1 ? ` — ${n} times` : ''}`,
    ace: () => 'Ace (5 kills in one round)', mvps: () => `${n} MVP ${word(n, 'award')}`, assists: () => `${n} ${word(n, 'assist')}`,
    survive_rounds: () => `Survive ${n} ${word(n, 'round')}`, low_hp_kills: () => `${kills} at HP ≤ ${p.hp}`,
    flashed_kills: () => `${kills} while blinded`, eco_kills: () => `${kills} on eco (equipment ≤ $${p.equip})`,
    round_wins: () => `Win ${n} ${word(n, 'round')}`, spin_kills: () => `${kills} after a 360° turn`,
    jump_kills: () => `${kills} while jumping`, noscope_kills: () => `${n} sniper no-scope ${word(n, 'kill')}`,
    win_match: () => 'Win the match', max_deaths: () => `Finish with no more than ${p.deaths} ${word(p.deaths, 'death')}`,
    positive_kd: () => p.rounds == null ? `Finish the match with K/D ≥ ${Number(p.kd).toFixed(2)}` : `Reach K/D ≥ ${Number(p.kd).toFixed(2)} over ${p.rounds} rounds`,
    money_saved: () => `Save up $${p.money}`,
    full_buy_streak: () => `Full buy (equipment ≥ $${p.equip}) ${n} rounds in a row`,
    force_buy_wins: () => `Win ${n === 1 ? 'a force buy' : `${n} force buys`} (equipment $${p.min}–$${p.max})`,
    last_seconds_wins: () => `Win ${n === 1 ? 'a round' : `${n} rounds`} with ≤ ${p.seconds}s left`,
    no_jump_wins: () => `Win ${n === 1 ? 'a round' : `${n} rounds`} with a kill without jumping`,
    pistol_only_wins: () => `Win ${n === 1 ? 'a round' : `${n} rounds`} with a kill using only a knife and pistol`,
    no_reload_wins: () => `Win ${n === 1 ? 'a round' : `${n} rounds`} with a kill without reloading`,
  };
  return titles[task.type]?.() || task.title;
}
export function localizeTask(task, language) {
  if (!task || language !== 'en') return task;
  const title = task.test && task.type === 'manual' ? translate(task.title, language) : taskTitle(task, language);
  return { ...task, title, note: translate(task.note, language),
    display: task.type === 'max_deaths' && task.display ? `${task.progress}/${task.params.deaths} deaths` : task.display };
}
const params = {
  'Убийств': 'Kills', 'Убийств подряд': 'Consecutive kills', 'Раундов подряд': 'Consecutive rounds',
  'Раундов': 'Rounds', 'Убийств за раунд': 'Kills per round', 'Сколько раз': 'Times', 'Разных видов оружия': 'Different weapons',
  'Снаряжение до, $': 'Maximum equipment value, $', 'Побед подряд': 'Consecutive wins', 'Побед': 'Wins', 'Оружие': 'Weapon', 'Тип оружия': 'Weapon class',
  'Хедшотов': 'Headshots', 'Ассистов': 'Assists', 'Максимум HP': 'Maximum HP', 'Убийств с комбо': 'Combo kills',
  'Сочетание условий': 'Combo conditions', 'Максимум смертей': 'Maximum deaths', 'K/D не меньше': 'Minimum K/D', 'Текст': 'Text',
  'Сумма, $': 'Amount, $', 'Снаряжение от, $': 'Minimum equipment value, $', 'Секунд до конца, не больше': 'Seconds left, at most',
};
export function localizeTypes(types, language) {
  if (language !== 'en') return types;
  return types.map((t) => ({ ...t, name: typeNames[t.id] || t.name,
    params: Object.fromEntries(Object.entries(t.params).map(([k, schema]) => [k, { ...schema,
      label: params[schema.label] || schema.label,
      ...(schema.options ? { options: schema.options.map((o) => ({ ...o, label: comboNames[o.value] || translate(o.label, language) })) } : {}),
    }])) }));
}
