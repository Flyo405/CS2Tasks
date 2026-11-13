export const isPistolRound = (round) => round === 0 || round === 12;

const firearms = (ctx) => (ctx.player?.weapons || []).filter((w) => !['Knife', 'Grenade', 'C4'].includes(w.type));
export const SITUATIONS = [
  { id: 'pistol', label: 'Пистолетный раунд', type: 'pistol_round_kills' },
  { id: 'eco_kill', label: 'Дешёвая закупка', type: 'eco_kills', contextual: true,
    when: (c) => c.round?.equipValue != null && c.round.equipValue <= 2500,
    params: (c) => ({ count: 1, equip: Math.max(2000, c.round.equipValue) }) },
  { id: 'eco_win', label: 'Дешёвая закупка', type: 'eco_round_wins', contextual: true,
    when: (c) => c.round?.equipValue != null && c.round.equipValue <= 2500,
    params: (c) => ({ count: 1, equip: Math.max(2000, c.round.equipValue) }) },
  { id: 'no_armor', label: 'Без брони', type: 'unarmored_kills', contextual: true,
    when: (c) => c.player?.armor === 0, params: () => ({ count: 1 }) },
  { id: 'sniper', label: 'Со снайперской винтовкой', type: 'weapon_type_kills', contextual: true,
    when: (c) => firearms(c).some((w) => w.type === 'SniperRifle'), params: () => ({ weaponType: 'SniperRifle', count: 1 }) },
  { id: 'shotgun', label: 'С дробовиком', type: 'weapon_type_kills', contextual: true,
    when: (c) => firearms(c).some((w) => w.type === 'Shotgun'), params: () => ({ weaponType: 'Shotgun', count: 1 }) },
  { id: 'headshot', label: 'Хедшот за этот раунд', type: 'headshots', params: () => ({ count: 1 }) },
  { id: 'assist', label: 'Помощь команде', type: 'assists', params: () => ({ count: 1 }) },
  { id: 'double', label: 'Два убийства за раунд', type: 'multikill_rounds', params: () => ({ kills: 2, count: 1 }) },
  { id: 'full_hp', label: 'Убийство и 100 HP', type: 'full_hp_kill_rounds', params: () => ({ count: 1 }) },
  { id: 'different_weapons', label: 'Разное оружие за раунд', type: 'different_weapon_round',
    when: (c) => new Set(firearms(c).map((w) => w.name)).size >= 2, params: () => ({ count: 2 }) },
  { id: 'survive', label: 'Выжить в этом раунде', type: 'survive_rounds', params: () => ({ count: 1 }) },
];

export function situationCandidates(templates, ctx) {
  const pistol = isPistolRound(ctx.round?.round ?? ctx.match?.round);
  const eligible = SITUATIONS.filter((s) => pistol ? s.id === 'pistol' : s.id !== 'pistol' && (!s.when || s.when(ctx)));
  const make = (s) => {
    const tpl = templates.find((t) => t.type === s.type);
    return tpl ? { ...tpl, id: `${tpl.id || tpl.type}:situation:${s.id}`, situation: s.label, params: s.params ? s.params(ctx) : tpl.params } : null;
  };
  const contextual = eligible.filter((s) => s.contextual).map(make).filter(Boolean);
  return contextual.length ? contextual : eligible.map(make).filter(Boolean);
}

// MR12: пистолетные раунды — первый и тринадцатый. При другом формате этот режим отключается в панели.
export function situationalTemplates(templates, ctx, enabled = true) {
  const m = ctx?.match;
  const live = m?.status === 'live' && m.phase === 'live' && m.roundPhase !== 'over';
  const pistol = live && isPistolRound(ctx.round?.round ?? m.round);
  const equip = ctx?.round?.equipValue;
  return templates.filter((t) => t.type !== 'pistol_round_kills' || (enabled && pistol))
    .map((t) => {
      if (!enabled || !live) return t;
      const favored = pistol ? (t.type === 'pistol_round_kills' || (t.type === 'weapon_type_kills' && t.params.weaponType === 'Pistol'))
        : equip != null && equip <= 2500 && ['eco_kills', 'eco_round_wins'].includes(t.type);
      return favored ? { ...t, weight: (t.weight || 1) * 4 } : t;
    });
}
