// Генератор правдоподобного матча в формате сырых пакетов GSI.
// Разминка → до 24 раундов (убийства, хедшоты, смена оружия, смерти, наблюдение
// за тиммейтами, MVP, смена сторон) → gameover → меню.
// Возвращает { packets: [{ dt, raw }], expected } — expected считается «по правде»,
// чтобы сверить с тем, что насчитало приложение.
import { mulberry32 } from '../src/tasks/generator.js';

const PRIMARY = {
  CT: [['weapon_m4a1', 'Rifle', 30, 2900], ['weapon_m4a1_silencer', 'Rifle', 20, 2900], ['weapon_famas', 'Rifle', 25, 2050],
    ['weapon_awp', 'SniperRifle', 5, 4750], ['weapon_ssg08', 'SniperRifle', 10, 1700], ['weapon_mp9', 'Submachine Gun', 30, 1250],
    ['weapon_nova', 'Shotgun', 8, 1050], ['weapon_aug', 'Rifle', 30, 3300]],
  T: [['weapon_ak47', 'Rifle', 30, 2700], ['weapon_galilar', 'Rifle', 35, 1800], ['weapon_awp', 'SniperRifle', 5, 4750],
    ['weapon_ssg08', 'SniperRifle', 10, 1700], ['weapon_mac10', 'Submachine Gun', 30, 1050], ['weapon_nova', 'Shotgun', 8, 1050],
    ['weapon_sg556', 'Rifle', 30, 3000]],
};
const START_PISTOL = { CT: ['weapon_usp_silencer', 'Pistol', 12], T: ['weapon_glock', 'Pistol', 20] };
const BUY_PISTOLS = [['weapon_deagle', 'Pistol', 7, 700], ['weapon_p250', 'Pistol', 13, 300], ['weapon_fiveseven', 'Pistol', 20, 500]];
const KNIFE = { CT: 'weapon_knife', T: 'weapon_knife_t' };

export function generateSyntheticMatch({ seed = 1, mapName = 'de_mirage', mode = 'competitive', steamid = '76561198000000001', startTs = Date.UTC(2026, 0, 1) } = {}) {
  const rng = mulberry32(seed);
  const R = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const chance = (p) => rng() < p;
  const packets = [];
  let ts = startTs;

  const exp = {
    kills: 0, headshots: 0, deaths: 0, assists: 0, mvps: 0, damage: 0,
    roundsWon: 0, roundsPlayed: 0, roundsSurvived: 0,
    weaponKills: {}, weaponTypeKills: {},
    lowHpKills30: 0, flashedKills: 0, ecoKills2000: 0,
    multikillRounds: { 2: 0, 3: 0, 4: 0, 5: 0 }, damageRounds100: 0,
    quickSwitchKills: 0, warmupKills: 0, spectatedMateKills: 0,
    result: null, myScore: 0, enemyScore: 0,
  };

  const mkPlayer = (id, name, team) => ({
    steamid: id, name, team, health: 100, armor: 0, helmet: false, flashed: 0, smoked: 0, burning: 0,
    money: 800, round_kills: 0, round_killhs: 0, round_totaldmg: 0, equip_value: 200,
    kills: 0, assists: 0, deaths: 0, mvps: 0, score: 0, weapons: [], active: 0,
  });
  const loadout = (p) => {
    const [pn, pt, pc] = START_PISTOL[p.team];
    p.weapons = [{ name: KNIFE[p.team], type: 'Knife' }, { name: pn, type: pt, clip: pc, max: pc, reserve: 24 }];
    p.active = 1;
  };
  const me = mkPlayer(steamid, 'Streamer', 'CT');
  const mates = [2, 3, 4, 5].map((i) => mkPlayer(`7656119800000000${i}`, `Mate${i}`, 'CT'));
  loadout(me);
  mates.forEach(loadout);

  const map = { mode, name: mapName, phase: 'warmup', round: 0, team_ct: { score: 0 }, team_t: { score: 0 } };
  let round = { phase: 'live' };
  let inMenu = true;
  let observed = null;

  const weaponsJson = (p) => {
    const out = {};
    p.weapons.forEach((w, i) => {
      const o = { name: w.name, paintkit: 'default', type: w.type, state: i === p.active ? 'active' : 'holstered' };
      if (w.clip != null) Object.assign(o, { ammo_clip: w.clip, ammo_clip_max: w.max, ammo_reserve: w.reserve });
      out[`weapon_${i}`] = o;
    });
    return out;
  };
  const playerJson = (p) => ({
    steamid: p.steamid, name: p.name, observer_slot: 1, team: p.team, activity: 'playing',
    state: {
      health: p.health, armor: p.armor, helmet: p.helmet, flashed: p.flashed, smoked: p.smoked, burning: p.burning,
      money: p.money, round_kills: p.round_kills, round_killhs: p.round_killhs, round_totaldmg: p.round_totaldmg, equip_value: p.equip_value,
    },
    match_stats: { kills: p.kills, assists: p.assists, deaths: p.deaths, mvps: p.mvps, score: p.score },
    weapons: weaponsJson(p),
  });
  const build = () => {
    const raw = { provider: { name: 'Counter-Strike 2', appid: 730, version: 14100, steamid, timestamp: Math.floor(ts / 1000) } };
    if (inMenu) {
      raw.player = { steamid, name: me.name, activity: 'menu' };
      return raw;
    }
    raw.map = structuredClone(map);
    raw.round = { ...round };
    raw.player = playerJson(observed || me);
    return raw;
  };
  const emit = (dt = 100) => {
    ts += dt;
    packets.push({ dt, raw: build() });
  };
  const live = () => map.phase !== 'warmup';

  // ---------- меню и разминка ----------
  emit(0);
  emit(5000);
  inMenu = false;
  emit(3000);
  for (let i = 0; i < 3; i++) {
    me.kills += 1; me.round_kills += 1; me.score += 2; me.weapons[me.active].clip -= 1;
    exp.warmupKills += 1;
    emit(2000);
  }

  // ---------- матч ----------
  const resetRoundStats = (p) => { p.round_kills = 0; p.round_killhs = 0; p.round_totaldmg = 0; p.health = 100; p.flashed = 0; };
  const enemyTeam = () => (me.team === 'CT' ? 'T' : 'CT');
  const teamScore = (team) => (team === 'CT' ? map.team_ct : map.team_t);

  map.phase = 'live';
  for (const p of [me, ...mates]) Object.assign(p, { kills: 0, assists: 0, deaths: 0, mvps: 0, score: 0, money: 800 });

  const kill = (equipAtLive) => {
    if (me.round_kills >= 5) return false;
    const w = me.weapons[me.active];
    if (w.clip != null && w.clip <= 0) { // перезарядка
      w.clip = w.max; w.reserve = Math.max(0, w.reserve - w.max);
      emit(2500);
    }
    if (w.clip != null) w.clip -= Math.min(w.clip, R(1, 3));
    const hs = w.type !== 'Knife' && chance(0.45);
    const dmg = R(60, 100);
    me.round_kills += 1; me.kills += 1; me.score += 2; me.round_totaldmg += dmg; me.money += 300;
    if (hs) me.round_killhs += 1;
    const name = w.name.startsWith('weapon_knife') ? 'weapon_knife' : w.name;
    exp.kills += 1; exp.damage += dmg;
    if (hs) exp.headshots += 1;
    exp.weaponKills[name] = (exp.weaponKills[name] || 0) + 1;
    exp.weaponTypeKills[w.type] = (exp.weaponTypeKills[w.type] || 0) + 1;
    if (me.health <= 30) exp.lowHpKills30 += 1;
    if (me.flashed > 0) exp.flashedKills += 1;
    if (equipAtLive <= 2000) exp.ecoKills2000 += 1;
    // Иногда сразу переключаемся на другое оружие в том же пакете — проверка эвристики.
    if (w.clip != null && me.weapons.length > 1 && chance(0.15)) {
      me.active = (me.active + 1) % me.weapons.length;
      exp.quickSwitchKills += 1;
    }
    emit(R(150, 900));
    return true;
  };

  for (let r = 0; r < 24; r++) {
    if (r === 12) {
      // Перерыв и смена сторон.
      map.phase = 'intermission';
      emit(3000);
      map.phase = 'live';
      for (const p of [me, ...mates]) { p.team = p.team === 'CT' ? 'T' : 'CT'; p.money = 800; loadout(p); }
      const tmp = map.team_ct.score; map.team_ct.score = map.team_t.score; map.team_t.score = tmp;
    }
    if (r === 0) for (const p of [me, ...mates]) loadout(p);
    map.round = r;
    round = { phase: 'freezetime' };
    observed = null;
    for (const p of [me, ...mates]) resetRoundStats(p);
    me.equip_value = 200 + me.weapons.slice(2).reduce((s, w) => s + (w.cost || 0), 0) + (me.armor > 0 ? 650 : 0);
    emit(R(2000, 6000));

    // Закупка.
    if (me.money >= 3700) {
      const opts = PRIMARY[me.team].filter((x) => x[3] <= me.money - 650);
      const [n, t, c, cost] = opts[R(0, opts.length - 1)];
      me.weapons = me.weapons.slice(0, 2);
      me.weapons.push({ name: n, type: t, clip: c, max: c, reserve: 90, cost });
      me.money -= cost + 650; me.armor = 100; me.helmet = true;
      me.equip_value = 200 + cost + 1000;
      me.active = 2;
    } else if (me.money >= 1000 && chance(0.5)) {
      const [n, t, c, cost] = BUY_PISTOLS[R(0, BUY_PISTOLS.length - 1)];
      me.weapons = [me.weapons[0], { name: n, type: t, clip: c, max: c, reserve: 35, cost }];
      me.money -= cost; me.equip_value = 200 + cost; me.armor = 0;
      me.active = 1;
    } else {
      me.armor = 0;
      me.equip_value = 200;
      const [pn, pt, pc] = START_PISTOL[me.team];
      me.weapons = [me.weapons[0], { name: pn, type: pt, clip: pc, max: pc, reserve: 24 }];
      me.active = 1;
    }
    emit(R(3000, 9000));

    round = { phase: 'live' };
    const equipAtLive = me.equip_value;
    emit(400);

    let alive = true;
    const actions = R(3, 10);
    for (let a = 0; a < actions && alive; a++) {
      const roll = rng();
      if (roll < 0.12) { // смена оружия
        me.active = (me.active + 1) % me.weapons.length;
        emit(R(300, 1500));
      } else if (roll < 0.27) { // получил урон
        me.health -= R(10, 60);
        if (me.health <= 0) {
          me.health = 0; me.deaths += 1; exp.deaths += 1; alive = false;
          emit(R(100, 400));
          emit(1500); // ещё пару пакетов «о себе» с 0 HP
          const aliveMates = mates.filter((m) => m.health > 0);
          observed = aliveMates[R(0, aliveMates.length - 1)];
          emit(1500);
          for (let i = 0; i < R(1, 3); i++) { // тиммейт стреляет — это не наши убийства
            observed.round_kills += 1; observed.kills += 1; observed.round_totaldmg += 100;
            exp.spectatedMateKills += 1;
            emit(R(800, 3000));
          }
        } else emit(R(200, 800));
      } else if (roll < 0.35) { // ослепили и, возможно, убил вслепую
        me.flashed = 255;
        emit(150);
        if (chance(0.5)) kill(equipAtLive);
        me.flashed = 0;
        emit(R(800, 1500));
      } else if (roll < 0.45) { // урон без убийства
        const w = me.weapons[me.active];
        if (w.clip != null && w.clip > 0) w.clip -= 1;
        const dmg = R(10, 90);
        me.round_totaldmg += dmg; exp.damage += dmg;
        emit(R(200, 1500));
      } else if (roll < 0.52) { // ассист
        me.assists += 1; me.score += 1; exp.assists += 1;
        emit(R(200, 1500));
      } else {
        kill(equipAtLive);
      }
    }

    // Конец раунда.
    let won = chance(alive ? 0.62 : 0.4);
    if (me.round_kills >= 5) won = true;
    round = { phase: 'over', win_team: won ? me.team : enemyTeam() };
    teamScore(round.win_team).score += 1;
    if (won && alive && me.round_kills >= 2 && chance(0.6)) { me.mvps += 1; exp.mvps += 1; }
    me.money = Math.min(16000, me.money + (won ? 3250 : 1900));
    exp.roundsPlayed += 1;
    if (won) exp.roundsWon += 1;
    if (alive) exp.roundsSurvived += 1;
    for (const k of [2, 3, 4, 5]) if (me.round_kills >= k) exp.multikillRounds[k] += 1;
    if (me.round_totaldmg >= 100) exp.damageRounds100 += 1;
    emit(R(200, 600));
    emit(3000);

    const my = teamScore(me.team).score;
    const enemy = teamScore(enemyTeam()).score;
    if (my >= 13 || enemy >= 13) break;
  }

  // ---------- конец матча ----------
  map.phase = 'gameover';
  emit(1000);
  emit(5000);
  exp.myScore = teamScore(me.team).score;
  exp.enemyScore = teamScore(enemyTeam()).score;
  exp.result = exp.myScore > exp.enemyScore ? 'win' : exp.myScore < exp.enemyScore ? 'loss' : 'draw';
  exp.finalStats = { kills: me.kills, deaths: me.deaths, assists: me.assists, mvps: me.mvps };
  inMenu = true;
  observed = null;
  emit(8000);
  emit(10000);
  return { packets, expected: exp };
}
