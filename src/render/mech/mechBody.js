import * as THREE from 'three';
import { buildMechRig, applyPose, solveArm, S, SCHEMES } from './mechRig.js';
import { newPose, JOINTS, ease } from './swordAnim.js';

// The animated body shared by the player mech and arena enemies: rig, pose springs, sword arm IK, thrusters,
// laser blade and emissive tint (hit flash / attack telegraph). Controllers (MechPilot, MechEnemy) only decide
// WHAT pose to aim for each frame; this class decides HOW the body gets there.
//
// Poses are chased with damped springs (per joint, per axis) instead of exponential smoothing: a pose change
// accelerates, overshoots a touch and settles, which reads as mass. Hits push the springs directly (recoil), so
// reactions come from the same system as the authored poses. Everything is allocation-free per frame.

const NJ = JOINTS.length;
const UP = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3(), _d = new THREE.Vector3(), _u = new THREE.Vector3(), _pole = new THREE.Vector3();
const _pv = new THREE.Vector3(), _pv2 = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _white = new THREE.Color(1, 1, 1);
const lerp = THREE.MathUtils.lerp;

export class MechBody {
  // opts: { scheme, lod, size (uniform scale on top of S) }
  constructor(scene, fx, { scheme = 'player', lod = false, size = 1 } = {}) {
    this.scheme = scheme;
    this.rig = buildMechRig({ scheme, lod });
    this.root = this.rig.root;
    this.k = S * size;                               // rig units -> metres for this body
    this.rig.body.scale.setScalar(this.k);
    this.rig.lengths.UA *= size; this.rig.lengths.FA *= size;
    scene.add(this.root);
    this.fx = fx;
    const P = SCHEMES[scheme] || SCHEMES.player;
    this.trail = fx.makeTrail(scheme === 'player' ? 0x5fdcff : P.blade);
    this.slashColor = scheme === 'player' ? 0x9fefff : P.blade;
    // The blade light must never leave the scene: toggling a light's visibility changes the scene's light count
    // and recompiles every material (a visible hitch each time the sword ignited). The player's light lives on the
    // socket and just dims to 0; enemy blades go without one (several extra point lights cost every pixel).
    const sw = this.rig.sword, light = sw.userData.light;
    sw.remove(light);
    if (scheme === 'player') { light.intensity = 0; sw.parent.add(light); } else sw.userData.light = null;
    this.pose = newPose(); this.target = newPose(); this.vel = newPose();
    this.hand = { p: new THREE.Vector3(-0.27, 1.04, 0.32).multiplyScalar(this.k), d: new THREE.Vector3(0, 0, 1), u: new THREE.Vector3(0, 1, 0), w: 1 };
    this.thr = { back: 0, wing: 0, sh: 0, calf: 0, foot: 0 };
    this.ignite = 0;
    this.tint = new THREE.Color(); this.tintK = 0; this.tintWant = 0; this.tintColor = new THREE.Color();
    this.flash = 0;
    this.time = 0;
    this._lastTint = -1;
  }

  // the pose spring: omega = stiffness (rad/s), zeta = damping ratio (<1 overshoots)
  spring(dt, omega, zeta) {
    const n = Math.max(1, Math.ceil(dt * omega / 0.8));
    const h = dt / n, kk = omega * omega, c = 2 * zeta * omega;
    const P = this.pose, T = this.target, V = this.vel;
    for (let s = 0; s < n; s++) {
      for (let i = 0; i < NJ; i++) {
        const j = JOINTS[i], x = P[j], t = T[j], v = V[j];
        for (let a = 0; a < 3; a++) {
          v[a] += (kk * (t[a] - x[a]) - c * v[a]) * h;
          x[a] += v[a] * h;
        }
      }
      V.drop += (kk * (T.drop - P.drop) - c * V.drop) * h; P.drop += V.drop * h;
      V.shift += (kk * (T.shift - P.shift) - c * V.shift) * h; P.shift += V.shift * h;
    }
  }
  snapPose() { for (let i = 0; i < NJ; i++) { const j = JOINTS[i]; for (let a = 0; a < 3; a++) { this.pose[j][a] = this.target[j][a]; this.vel[j][a] = 0; } } this.pose.drop = this.target.drop; this.vel.drop = 0; }

  // a blow from character-space direction (lx, lz) (where the hit came FROM): the torso whips away, head snaps
  recoil(lx, lz, k = 1) {
    const V = this.vel;
    V.spine[0] -= lz * 7 * k; V.chest[0] -= lz * 6 * k; V.neck[0] += lz * 5 * k;
    V.spine[2] += lx * 6 * k; V.chest[2] += lx * 5 * k;
    V.spine[1] += (Math.random() - 0.5) * 6 * k;
    V.shL[2] += 6 * k; V.drop -= 0.8 * k;
  }

  setTint(hex, k) { this.tintColor.set(hex); this.tintWant = k; }
  hitFlash(k = 1) { this.flash = Math.max(this.flash, k); }

  // o: { pos, yaw, pitch, roll, pivot, omega, zeta, H: {p, d, u, w, snap, rate, pole}, spin, thr (targets), lit, swinging }
  solve(dt, o) {
    this.time += dt;
    this.spring(dt, o.omega ?? 16, o.zeta ?? 0.82);
    const rig = this.rig, k = this.k;
    rig.root.rotation.set(o.pitch || 0, o.yaw, o.roll || 0, 'YXZ');
    _pv.set(0, o.pivot ?? 0, 0);
    _pv2.copy(_pv).applyEuler(rig.root.rotation);
    rig.root.position.copy(o.pos).add(_pv).sub(_pv2);
    if (o.lift) rig.root.position.y += o.lift;
    applyPose(rig, this.pose);
    if (o.spin) rig.J.hips.rotation.y += o.spin;
    rig.root.updateMatrixWorld(true);

    const H = o.H, h = this.hand;
    if (H) {
      const kk = H.snap ? 1 : 1 - Math.exp(-dt * (H.rate ?? 18));
      h.p.lerp(H.p, kk);
      h.d.lerp(H.d, kk).normalize();
      h.u.lerp(H.u, kk).normalize();
      h.w += ((H.w ?? 1) - h.w) * Math.min(1, kk * 1.5 + dt * 4);
      if (H.force) h.w = 1;
      if (h.w > 0.01) {
        const m = rig.root.matrixWorld;
        _p.copy(h.p).applyMatrix4(m);
        _d.copy(h.d).transformDirection(m);
        _u.copy(h.u).transformDirection(m);
        _pole.set(-0.45 * k, (h.p.y > 1.5 * k ? 1.65 : 0.75) * k, -0.5 * k).applyMatrix4(m);
        if (o.spin) {
          // the hand target is in the un-spun frame; rotate it with the hips
          for (const v of [_p, _pole]) v.sub(rig.root.position).applyAxisAngle(UP, o.spin).add(rig.root.position);
          _d.applyAxisAngle(UP, o.spin); _u.applyAxisAngle(UP, o.spin);
        }
        solveArm(rig, 'R', _p, _pole, _d, _u, h.w);
      }
    }
    this.updateThrusters(dt, o.thr);
    this.updateSword(dt, o.lit, o.swinging);
    this.updateTint(dt);
  }

  // per-group throttle targets (back + wings boost, feet + calves lift, shoulder verniers trim attitude)
  updateThrusters(dt, want) {
    const thr = this.thr, t = this.time;
    if (want) for (const g in thr) thr[g] += ((want[g] || 0) - thr[g]) * Math.min(1, dt * 12);
    else for (const g in thr) thr[g] *= Math.max(0, 1 - dt * 12);
    for (const th of this.rig.thrusters) {
      const v = thr[th.group] ?? 0;
      const on = v > 0.03;
      th.plume.visible = th.glow.visible = on;
      if (!on) continue;
      const flick = 0.85 + Math.random() * 0.3;
      th.plume.scale.set(0.7 + v * 0.5, (0.4 + v * 1.4) * flick, 0.7 + v * 0.5);
      th.plume.material.uniforms.uThr.value = Math.min(1.4, v) * 0.75;
      th.plume.material.uniforms.uTime.value = t;
      th.glow.scale.setScalar(0.1 * th.k * (0.5 + v * 0.6) * flick);
    }
  }

  updateSword(dt, lit, swinging) {
    this.ignite = lit ? Math.min(1, this.ignite + dt * 14) : Math.max(0, this.ignite - dt * 3.5);
    const sw = this.rig.sword, u = sw.userData;
    const flick = 0.92 + Math.sin(this.time * 61) * 0.04 + Math.sin(this.time * 37) * 0.04;
    const ig = ease.outCubic(this.ignite);
    sw.visible = this.ignite > 0.01;
    if (!sw.visible) { if (u.light) u.light.intensity = 0; this.trail.fade = 0; return; }
    u.core.scale.set(1, 1, Math.max(0.001, ig));
    u.sheath.scale.set(1 + (swinging ? 0.35 : 0), 1 + (swinging ? 0.25 : 0), Math.max(0.001, ig * 1.03));
    u.sheathMat.opacity = (swinging ? 0.8 : 0.5) * flick;
    if (u.light) u.light.intensity = (swinging ? 22 : 7) * flick * ig;
    sw.updateWorldMatrix(true, false);
    this.fx.pushTrail(_a.copy(u.base).applyMatrix4(sw.matrixWorld), _b.copy(u.tip).applyMatrix4(sw.matrixWorld), swinging, this.trail);
  }

  updateTint(dt) {
    this.tintK += (this.tintWant - this.tintK) * Math.min(1, dt * 14);
    this.flash = Math.max(0, this.flash - dt * 6);
    const sig = this.tintK * 7 + this.flash * 13;
    if (sig < 0.002 && this._lastTint < 0.002) return;       // nothing lit and nothing to clear
    this._lastTint = sig;
    this.tint.copy(this.tintColor).multiplyScalar(this.tintK).lerp(_white, Math.min(1, this.flash) * 0.6);
    const f = this.flash * 0.5;
    for (const m of this.rig.lit) m.emissive.setRGB(this.tint.r + f, this.tint.g + f, this.tint.b + f);
  }

  bladeWorld(outBase, outTip) {
    const sw = this.rig.sword, u = sw.userData;
    outBase.copy(u.base).applyMatrix4(sw.matrixWorld);
    outTip.copy(u.tip).applyMatrix4(sw.matrixWorld);
  }

  setVisible(v) {
    this.root.visible = v;
    this.trail.on = v;
    if (!v) this.trail.mesh.visible = false;
  }
}

// thruster throttle targets for common situations (shared by player and enemies)
export function thrustFor({ boost = 0, climb = 0, burst = 0, steer = 0 }) {
  return {
    back: Math.max(boost * 1.1, climb * 0.55, burst),
    wing: Math.max(boost, climb * 0.7, burst * 0.9),
    sh: Math.max(boost * 0.35 + steer * 0.6, burst * 0.5, climb * 0.25),
    calf: Math.max(climb * 0.9, boost * 0.4, burst),
    foot: Math.max(climb, burst * 1.1),
  };
}
export { lerp };
