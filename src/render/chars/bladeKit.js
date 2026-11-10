import * as THREE from 'three';

// The Daywalker kit shared by the VRM characters (chars/katana.js) and the mech (mech/mechPilot.js), modelled on
// Blade's kit in Marvel Rivals:
//   primary            Ancestral Sword: a chain of fast slashes / Hunter's Shotgun: pellet blasts, six shells
//   swap               switch between the sword and the shotgun
//   Daywalker Dash     a short invulnerable dash. With the sword it cuts everything on the way and leaves the
//                      targets wounded (they take more damage for a while); with the shotgun it ends in a wide
//                      point-blank blast that staggers
//   Scarlet Shroud     hold: block with the sword. Every blow it takes shortens the dash cooldown
//   Bloodline Awakening  a frenzy: faster attacks, harder hits, life steal
//   Thousand-Fold Slash  the ultimate, charged by dealing damage: a dash into a zone that is then cut to ribbons
// This class is the kit's state (weapon, ammo, cooldowns, charge); the two controllers own the motion and effects.

export const KIT = {
  mag: 6, fireT: 0.52, reloadT: 1.3, pellets: 9, spread: 0.11,
  dashCd: 3.2, blockRefund: 1, woundT: 5, woundMul: 1.3,
  rageT: 8, rageCd: 12, rageSpeed: 1.3, rageDmg: 1.25, lifesteal: 0.3,
  ultFull: 420, ultT: 2.4, ultTick: 0.16,
};
export const RAGE_COLOR = 0xff2a3a;

export class BladeKit {
  constructor() { this.reset(); }
  reset() {
    this.weapon = 'sword';
    this.ammo = KIT.mag; this.reload = 0; this.fireCd = 0; this.idleT = 0;
    this.dashCd = 0; this.rage = 0; this.rageCd = 0;
    this.ult = 1;                          // 0..1; starts ready so it can be tried, then it has to be earned
    this.aimT = 0;                         // seconds the gun stays raised after a shot
  }
  get raging() { return this.rage > 0; }
  get speed() { return this.rage > 0 ? KIT.rageSpeed : 1; }
  get dmg() { return this.rage > 0 ? KIT.rageDmg : 1; }
  get gun() { return this.weapon === 'gun'; }

  update(dt) {
    this.fireCd = Math.max(0, this.fireCd - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.rageCd = Math.max(0, this.rageCd - dt);
    this.aimT = Math.max(0, this.aimT - dt);
    if (this.rage > 0) { this.rage -= dt; if (this.rage <= 0) { this.rage = 0; this.rageCd = KIT.rageCd; this.rageEnded = true; } }
    // reloading: on an empty magazine at once, on a partly used one after a quiet moment
    this.idleT += dt;
    if (this.reload > 0) { this.reload -= dt; if (this.reload <= 0) { this.reload = 0; this.ammo = KIT.mag; } }
    else if (this.ammo <= 0 || (this.ammo < KIT.mag && this.idleT > 2.2)) this.reload = KIT.reloadT;
  }

  swap(to = null) { this.weapon = to || (this.weapon === 'sword' ? 'gun' : 'sword'); return this.weapon; }
  canFire() { return this.fireCd <= 0 && this.reload <= 0 && this.ammo > 0; }
  // one shell; free: the dash's blast costs nothing
  fire(free = false) {
    if (!free) { this.ammo--; this.fireCd = KIT.fireT / this.speed; }
    this.idleT = 0; this.aimT = 0.9;
  }
  canDash() { return this.dashCd <= 0; }
  useDash() { this.dashCd = KIT.dashCd; }
  blocked() { this.dashCd = Math.max(0, this.dashCd - KIT.blockRefund); }
  canRage() { return this.rage <= 0 && this.rageCd <= 0; }
  startRage() { this.rage = KIT.rageT; }
  // damage dealt charges the ultimate
  dealt(dmg) { this.ult = Math.min(1, this.ult + dmg / KIT.ultFull); }
  canUlt() { return this.ult >= 1; }
  useUlt() { this.ult = 0; }
}

// A target counts as wounded for a while after the sword dash: it takes more damage from everything.
export function wound(t, now) { t.woundUntil = now + KIT.woundT; }
export function woundMul(t, now) { return t.woundUntil && t.woundUntil > now ? KIT.woundMul : 1; }

const _d = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
// One shotgun blast: pellets in a cone from `origin` along `dir` (unit). Each pellet stops at the first target it
// meets; targets are upright capsules { pos (feet), radius, height?, alive }. Returns
// { hits: Map(target -> pellets), ends: [Vector3] } with every pellet's end point for the tracers.
export function shotgun(origin, dir, targets, { range = 22, spread = KIT.spread, pellets = KIT.pellets, tall = 1.9 } = {}) {
  const hits = new Map(), ends = [];
  _r.set(dir.z, 0, -dir.x); if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0); _r.normalize();
  _u.crossVectors(dir, _r).normalize();
  for (let i = 0; i < pellets; i++) {
    // an even disc: the first pellet flies true, the rest ring it
    const a = Math.random() * Math.PI * 2, s = i === 0 ? 0 : Math.sqrt(Math.random()) * spread;
    _d.copy(dir).addScaledVector(_r, Math.cos(a) * s).addScaledVector(_u, Math.sin(a) * s).normalize();
    let best = null, bt = range;
    for (const t of targets) {
      if (!t.alive) continue;
      // ray against the capsule's circle seen from above, then the height at that distance
      const ox = origin.x - t.pos.x, oz = origin.z - t.pos.z, R = t.radius * 1.05;
      const A = _d.x * _d.x + _d.z * _d.z, B = ox * _d.x + oz * _d.z, C = ox * ox + oz * oz - R * R;
      let tt;
      if (C <= 0) tt = 0;
      else {
        if (A < 1e-8) continue;
        const disc = B * B - A * C;
        if (disc < 0) continue;
        tt = (-B - Math.sqrt(disc)) / A;
        if (tt < 0) continue;
      }
      if (tt >= bt) continue;
      const y = origin.y + _d.y * tt, h = t.height || tall * (t.scale || 1);
      if (y < t.pos.y - 0.2 || y > t.pos.y + h + 0.2) continue;
      best = t; bt = tt;
    }
    ends.push(new THREE.Vector3().copy(origin).addScaledVector(_d, bt));
    if (best) hits.set(best, (hits.get(best) || 0) + 1);
  }
  return { hits, ends };
}
