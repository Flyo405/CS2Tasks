// Словарь оружия CS2: внутреннее имя GSI → красивое название и тип.

export const WEAPONS = {
  // Пистолеты
  weapon_glock: { name: 'Glock-18', type: 'Pistol' },
  weapon_hkp2000: { name: 'P2000', type: 'Pistol' },
  weapon_usp_silencer: { name: 'USP-S', type: 'Pistol' },
  weapon_p250: { name: 'P250', type: 'Pistol' },
  weapon_elite: { name: 'Dual Berettas', type: 'Pistol' },
  weapon_fiveseven: { name: 'Five-SeveN', type: 'Pistol' },
  weapon_tec9: { name: 'Tec-9', type: 'Pistol' },
  weapon_cz75a: { name: 'CZ75-Auto', type: 'Pistol' },
  weapon_deagle: { name: 'Desert Eagle', type: 'Pistol' },
  weapon_revolver: { name: 'R8 Revolver', type: 'Pistol' },
  // Пистолеты-пулемёты
  weapon_mac10: { name: 'MAC-10', type: 'Submachine Gun' },
  weapon_mp9: { name: 'MP9', type: 'Submachine Gun' },
  weapon_mp7: { name: 'MP7', type: 'Submachine Gun' },
  weapon_mp5sd: { name: 'MP5-SD', type: 'Submachine Gun' },
  weapon_ump45: { name: 'UMP-45', type: 'Submachine Gun' },
  weapon_p90: { name: 'P90', type: 'Submachine Gun' },
  weapon_bizon: { name: 'PP-Bizon', type: 'Submachine Gun' },
  // Дробовики
  weapon_nova: { name: 'Nova', type: 'Shotgun' },
  weapon_xm1014: { name: 'XM1014', type: 'Shotgun' },
  weapon_sawedoff: { name: 'Sawed-Off', type: 'Shotgun' },
  weapon_mag7: { name: 'MAG-7', type: 'Shotgun' },
  // Пулемёты
  weapon_m249: { name: 'M249', type: 'Machine Gun' },
  weapon_negev: { name: 'Negev', type: 'Machine Gun' },
  // Винтовки
  weapon_famas: { name: 'FAMAS', type: 'Rifle' },
  weapon_galilar: { name: 'Galil AR', type: 'Rifle' },
  weapon_ak47: { name: 'AK-47', type: 'Rifle' },
  weapon_m4a1: { name: 'M4A4', type: 'Rifle' },
  weapon_m4a1_silencer: { name: 'M4A1-S', type: 'Rifle' },
  weapon_sg556: { name: 'SG 553', type: 'Rifle' },
  weapon_aug: { name: 'AUG', type: 'Rifle' },
  // Снайперские
  weapon_ssg08: { name: 'SSG 08', type: 'SniperRifle' },
  weapon_awp: { name: 'AWP', type: 'SniperRifle' },
  weapon_g3sg1: { name: 'G3SG1', type: 'SniperRifle' },
  weapon_scar20: { name: 'SCAR-20', type: 'SniperRifle' },
  // Прочее
  weapon_taser: { name: 'Zeus x27', type: 'Taser', with: 'с Zeus' },
  weapon_knife: { name: 'Нож', type: 'Knife', with: 'ножом' },
  weapon_hegrenade: { name: 'HE-граната', type: 'Grenade', with: 'HE-гранатой' },
  weapon_molotov: { name: 'Коктейль Молотова', type: 'Grenade', with: 'молотовым' },
  weapon_incgrenade: { name: 'Зажигательная граната', type: 'Grenade', with: 'зажигательной гранатой' },
  weapon_flashbang: { name: 'Флешка', type: 'Grenade', with: 'флешкой' },
  weapon_smokegrenade: { name: 'Дымовая граната', type: 'Grenade', with: 'дымом' },
  weapon_decoy: { name: 'Ложная граната', type: 'Grenade', with: 'декоем' },
  weapon_c4: { name: 'C4', type: 'C4', with: 'бомбой' },
};

export const WEAPON_TYPES = {
  Pistol: { name: 'Пистолеты', with: 'из пистолетов' },
  Rifle: { name: 'Винтовки', with: 'из винтовок' },
  SniperRifle: { name: 'Снайперские винтовки', with: 'из снайперских винтовок' },
  'Submachine Gun': { name: 'Пистолеты-пулемёты', with: 'из ПП' },
  Shotgun: { name: 'Дробовики', with: 'из дробовиков' },
  'Machine Gun': { name: 'Пулемёты', with: 'из пулемётов' },
  Knife: { name: 'Нож', with: 'ножом' },
};

export function isKnife(name) {
  return typeof name === 'string' && (name.startsWith('weapon_knife') || name === 'weapon_bayonet' || name.startsWith('weapon_bayonet'));
}

/** Нормализует имя: все ножи (скины-модели) сводятся к weapon_knife. */
export function canonicalWeapon(name) {
  if (isKnife(name)) return 'weapon_knife';
  return name;
}

export function weaponName(name) {
  return WEAPONS[canonicalWeapon(name)]?.name ?? String(name || '').replace(/^weapon_/, '');
}

export function weaponWith(name) {
  const w = WEAPONS[canonicalWeapon(name)];
  return w?.with ?? `с ${weaponName(name)}`;
}

export function weaponTypeByName(name) {
  return WEAPONS[canonicalWeapon(name)]?.type ?? null;
}

/** Подходит ли оружие убийства под условие задания. */
export function weaponMatches(killWeapon, wanted) {
  if (!killWeapon || !killWeapon.name) return false;
  return canonicalWeapon(killWeapon.name) === canonicalWeapon(wanted);
}

export function weaponTypeMatches(killWeapon, wantedType) {
  if (!killWeapon) return false;
  const type = killWeapon.type || weaponTypeByName(killWeapon.name);
  if (wantedType === 'Knife') return type === 'Knife' || isKnife(killWeapon.name);
  return type === wantedType;
}
