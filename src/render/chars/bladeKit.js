import * as THREE from 'three';

// The Daywalker kit shared by the VRM characters (chars/katana.js) and the mech (mech/mechPilot.js): Blade's kit from
// Marvel Rivals.
//   primary              Ancestral Sword: a five-hit slash chain / Hunter's Pistol: single bolts, twelve to a cell
//   swap                 switch between the sword and the pistol
//   Daywalker Dash       two charges. A short invulnerable dash, upward too if jump is held. With the sword it ends
//                        in a cleaving strike that slows; with the pistol in a fan of shots that wounds (the target takes
//                        more damage for a while)
//   Scarlet Shroud       hold: block with the sword. Every blow it takes shortens the dash cooldown
//   Bloodline Awakening  a stance, sword only. Landing hits fills a meter that speeds the cuts up, until the chain
//                        turns into a whirlwind; every hit steals life. Drawing the pistol drops the stance (half
//                        the meter is kept)
//   Thousand-Fold Slash  the ultimate, charged by dealing damage: lay a path on the ground, confirm, and dash down
//                        it; the path is then cut to ribbons while you fight on
// This class is the kit's state (weapon, ammo, charges, meter); the two controllers own the motion and effects.

export const KIT = {
  mag: 12, fireT: 0.19, reloadT: 1.1, pellets: 1, spread: 0.02,        // the pistol: one bolt a shot
  dashN: 2, dashCd: 7, blockRefund: 1, woundT: 5, woundMul: 1.3, slowT: 3,
  meterHit: 0.085, meterHold: 2.5, meterDecay: 0.14, rageSpeed: 0.75, rageDmg: 1.15, lifesteal: 0.3, whirlAt: 0.45,
  ultFull: 420, ultT: 2.6, ultTick: 0.15,
};
export const RAGE_COLOR = 0xff2a3a;

export class BladeKit {
  constructor() { this.reset(); }
  reset() {
    this.weapon = 'sword';
    this.ammo = KIT.mag; this.reload = 0; this.fireCd = 0; this.idleT = 0;
    this.dashes = KIT.dashN; this.dashCd = 0;
    this.stance = false; this.meter = 0; this.meterT = 9; this.rageLock = 0;
    this.ult = 1;                          // 0..1; starts ready so it can be tried, then it has to be earned
    this.aiming = false;                   // laying the ultimate's path
    this.aimT = 0;                         // seconds the gun stays raised after a shot
    this.used = {};                        // what has been done, for the tutorial: { name: count }
  }
  mark(name) { this.used[name] = (this.used[name] || 0) + 1; }
  get raging() { return this.stance; }
  get speed() { return this.stance ? 1 + KIT.rageSpeed * this.meter : 1; }
  get dmg() { return this.stance ? KIT.rageDmg : 1; }
  get gun() { return this.weapon === 'gun'; }
  get whirl() { return this.stance && this.meter >= KIT.whirlAt; }

  update(dt) {
    this.fireCd = Math.max(0, this.fireCd - dt);
    this.rageLock = Math.max(0, this.rageLock - dt);
    this.aimT = Math.max(0, this.aimT - dt);
    // dash charges come back one at a time
    if (this.dashes < KIT.dashN) { this.dashCd -= dt; if (this.dashCd <= 0) { this.dashes++; this.dashCd = this.dashes < KIT.dashN ? KIT.dashCd : 0; } }
    // the awakening meter holds for a moment after the last hit, then drains
    this.meterT += dt;
    if (this.meterT > KIT.meterHold) this.meter = Math.max(0, this.meter - KIT.meterDecay * dt);
    // reloading: on an empty magazine at once, on a partly used one after a quiet moment
    this.idleT += dt;
    if (this.reload > 0) { this.reload -= dt; if (this.reload <= 0) { this.reload = 0; this.ammo = KIT.mag; } }
    else if (this.ammo <= 0 || (this.ammo < KIT.mag && this.idleT > 2.2)) this.reload = KIT.reloadT;
  }

  // drawing the pistol drops the awakening stance, keeping half the meter
  swap(to = null) {
    const w = to || (this.weapon === 'sword' ? 'gun' : 'sword');
    if (w !== this.weapon) { this.weapon = w; this.mark('swap'); if (w === 'gun' && this.stance) this.leaveStance(); }
    return this.weapon;
  }
  canFire() { return this.fireCd <= 0 && this.reload <= 0 && this.ammo > 0; }
  // one round; free: the dash's fan of shots costs nothing
  fire(free = false) {
    if (!free) { this.ammo--; this.fireCd = KIT.fireT; this.mark('shot'); }
    this.idleT = 0; this.aimT = 0.9;
  }
  canDash() { return this.dashes > 0; }
  useDash() { if (this.dashes === KIT.dashN) this.dashCd = KIT.dashCd; this.dashes--; this.mark(this.gun ? 'dashGun' : 'dashSword'); this.mark('dash'); }
  blocked() { if (this.dashes < KIT.dashN) this.dashCd -= KIT.blockRefund; this.mark('blocked'); }
  canRage() { return this.rageLock <= 0; }
  // toggles the stance; returns whether it is now on
  toggleStance() {
    this.rageLock = 0.4;
    if (this.stance) this.leaveStance(); else { this.stance = true; this.weapon = 'sword'; this.meterT = 0; this.mark('awaken'); }
    return this.stance;
  }
  leaveStance() { this.stance = false; this.meter *= 0.5; }
  // a sword hit landed
  swordHit() { this.mark('swordHit'); if (this.stance) { this.meter = Math.min(1, this.meter + KIT.meterHit); this.meterT = 0; if (this.whirl) this.mark('whirl'); } }
  // damage dealt charges the ultimate
  dealt(dmg) { this.ult = Math.min(1, this.ult + dmg / KIT.ultFull); }
  canUlt() { return this.ult >= 1; }
  useUlt() { this.ult = 0; this.aiming = false; this.mark('ult'); }
}

// The ultimate's path marker: a strip on the ground from its origin along +Z, unit sized (scale x = width, z =
// length). setLane() lays it from a point along a yaw.
export function makeLane() {
  const g = new THREE.Group();
  const mat = (o) => new THREE.MeshBasicMaterial({ color: new THREE.Color(RAGE_COLOR).multiplyScalar(2.2), transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  g.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5), mat(0.16)));
  for (const x of [-0.5, 0.5]) g.add(new THREE.Mesh(new THREE.PlaneGeometry(0.03, 1).rotateX(-Math.PI / 2).translate(x, 0.01, 0.5), mat(0.9)));
  g.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 0.012).rotateX(-Math.PI / 2).translate(0, 0.01, 1), mat(0.9)));
  for (let i = 1; i < 6; i++) g.add(new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.006).rotateX(-Math.PI / 2).translate(0, 0.01, i / 6), mat(0.5)));
  g.traverse((o) => { o.frustumCulled = false; o.renderOrder = 2; });
  g.visible = false;
  return g;
}
export function setLane(g, from, yaw, len, width) {
  g.position.copy(from); g.position.y += 0.07;
  g.rotation.set(0, yaw, 0);
  g.scale.set(width, 1, len);
  g.visible = true;
}
export function distToLane(p, a, b) {
  const abx = b.x - a.x, abz = b.z - a.z, l2 = abx * abx + abz * abz;
  const t = l2 > 1e-6 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
}

// Gun mode keeps the body on the crosshair, so the legs have to follow the ground instead: the hips turn toward the
// way you are moving (up to about 80 degrees, the spine twisting back onto the aim) and the run plays forward; past
// that the hips turn the other way and the same run plays backward, a backpedal. s: { leg, back } kept by the
// caller; (vx, vz): ground velocity; yaw: the facing; on: gun mode on the ground. Returns s, with s.leg the hips'
// turn (radians, added to the facing) and s.back whether the stride runs in reverse.
const LEG_MAX = 1.4;
export function strafeLegs(s, vx, vz, yaw, on, dt) {
  let want = 0;
  if (on && Math.hypot(vx, vz) > 0.6) {
    const m = Math.atan2(vx, vz) - yaw, a = Math.atan2(Math.sin(m), Math.cos(m));
    s.back = Math.abs(a) > (s.back ? 1.45 : 1.85);              // sticky, so a diagonal does not flicker
    want = Math.max(-LEG_MAX, Math.min(LEG_MAX, s.back ? a - Math.sign(a) * Math.PI : a));
  } else s.back = false;
  s.leg += (want - s.leg) * Math.min(1, dt * 12);
  if (Math.abs(s.leg) < 1e-3 && want === 0) s.leg = 0;
  // how fast you can go that way: full speed ahead, a little less sideways, less again backward
  s.speed = s.back ? 0.7 : 1 - 0.15 * Math.abs(s.leg) / LEG_MAX;
  return s;
}

// A target counts as wounded for a while after the sword dash: it takes more damage from everything.
export function wound(t, now) { t.woundUntil = now + KIT.woundT; }
export function woundMul(t, now) { return t.woundUntil && t.woundUntil > now ? KIT.woundMul : 1; }
// The sword dash's cleaving strike slows what it hits (anything that moves reads t.slowUntil against the same clock).
export function slow(t, now) { t.slowUntil = now + KIT.slowT; t.slowT = KIT.slowT; }

const _d = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
// One pull of the trigger: pellets in a cone (the pistol fires one, the dash's fan several) from `origin` along `dir` (unit). Each pellet stops at the first target it
// meets; targets are upright capsules { pos (feet), radius, height?, alive }. Returns
// { hits: Map(target -> pellets), ends: [Vector3] } with every pellet's end point for the tracers.
// world: an optional (origin, dir, max) -> { t, n } ray against the level (chars/bullets.js): a pellet stops at the
// first wall or floor, and nothing behind it is hit. shots: per pellet { to, kind: 'target' | 'world' | 'air', n }.
export function shotgun(origin, dir, targets, { range = 22, spread = KIT.spread, pellets = KIT.pellets, tall = 1.9, world = null } = {}) {
  const hits = new Map(), ends = [], shots = [];
  _r.set(dir.z, 0, -dir.x); if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0); _r.normalize();
  _u.crossVectors(dir, _r).normalize();
  for (let i = 0; i < pellets; i++) {
    // an even disc: the first pellet flies true, the rest ring it
    const a = Math.random() * Math.PI * 2, s = i === 0 ? 0 : Math.sqrt(Math.random()) * spread;
    _d.copy(dir).addScaledVector(_r, Math.cos(a) * s).addScaledVector(_u, Math.sin(a) * s).normalize();
    let best = null, bt = range, wn = null;
    const w = world ? world(origin, _d, range) : null;
    if (w) { bt = w.t; wn = w.n.clone(); }
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
    const to = new THREE.Vector3().copy(origin).addScaledVector(_d, bt);
    ends.push(to);
    shots.push({ to, kind: best ? 'target' : wn ? 'world' : 'air', n: best ? null : wn });
    if (best) hits.set(best, (hits.get(best) || 0) + 1);
  }
  return { hits, ends, shots };
}
