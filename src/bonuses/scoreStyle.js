import { canonicalWeapon, WEAPONS } from '../tasks/weapons.js';

export class ScoreStyle {
  constructor(getConfig) { this.getConfig = getConfig; this.reset(); }
  reset() { this.risk = 1; this.weapons = new Set(); }
  kill(e) {
    const { risk, diversity } = this.getConfig();
    const reasons = [];
    if (Number.isFinite(e.hpAtKill) && e.hpAtKill > 0 && e.hpAtKill <= risk.lowHp) reasons.push('LOW HP');
    if (/knife|bayonet/.test(e.weapon?.name || '')) reasons.push('KNIFE');
    if (e.lastBullet) reasons.push('LAST BULLET');
    // A mixed multi-kill packet does not establish which kill was a headshot.
    const conditions = [e.jump, e.spin, e.noscope && e.weapon?.type === 'SniperRifle',
      e.headshots === e.count, e.flashed > 0, e.smoked > 0, e.burning > 0];
    if (conditions.filter(Boolean).length >= 2) reasons.push('COMBO');
    if (!risk.enabled) this.risk = 1;
    else if (reasons.length) this.risk = Math.min(risk.maxMultiplier,
      Math.round((this.risk + risk.step * e.count) * 10000) / 10000);
    let diversityPoints = 0;
    if (!diversity.enabled) this.weapons.clear();
    const weapon = canonicalWeapon(e.weapon?.name);
    if (diversity.enabled && WEAPONS[weapon] && !this.weapons.has(weapon)) {
      this.weapons.add(weapon);
      diversityPoints = Math.min(diversity.maxBonus, diversity.step * (this.weapons.size - 1));
    }
    return { riskMultiplier: risk.enabled ? Math.min(risk.maxMultiplier, this.risk) : 1,
      diversityPoints, reasons: risk.enabled ? reasons : [] };
  }
  state() {
    const c = this.getConfig();
    return { riskMultiplier: c.risk.enabled ? Math.min(c.risk.maxMultiplier, this.risk) : 1,
      weaponCount: c.diversity.enabled ? this.weapons.size : 0 };
  }
}
