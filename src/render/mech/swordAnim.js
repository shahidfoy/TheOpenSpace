import * as THREE from 'three';

// Procedural sword animation, ported from the Noir arena (src/arena/anim.js): FK body poses for legs, torso and
// the free arm, plus move definitions whose sword hand follows an arc through IK. The slash crescent, the hit
// window and the hand motion all come from the same arc, so what you see is what hits.
// Proportions are retuned for the mech rig (taller hips, broader shoulders); positions are in rig units and get
// multiplied by the rig scale. Poses are targets: MechBody chases them with damped springs, so a pose snap reads
// as a fast, weighted motion with a little overshoot rather than a pop.

export const ease = {
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  outBack: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = THREE.MathUtils.lerp;

export const JOINTS = ['hips', 'spine', 'chest', 'neck', 'head', 'shL', 'elL', 'haL', 'shR', 'elR', 'haR', 'thL', 'knL', 'anL', 'thR', 'knR', 'anR'];
const NJ = JOINTS.length;
export function newPose() {
  const p = { drop: 0, shift: 0 };
  for (const j of JOINTS) p[j] = [0, 0, 0];
  return p;
}
export function copyPose(out, a) {
  for (let i = 0; i < NJ; i++) { const k = JOINTS[i], o = out[k], s = a[k]; o[0] = s[0]; o[1] = s[1]; o[2] = s[2]; }
  out.drop = a.drop; out.shift = a.shift;
  return out;
}
export function mixPose(out, a, b, w) {
  for (let i = 0; i < NJ; i++) {
    const k = JOINTS[i], o = out[k], x = a[k], y = b[k];
    o[0] = x[0] + (y[0] - x[0]) * w; o[1] = x[1] + (y[1] - x[1]) * w; o[2] = x[2] + (y[2] - x[2]) * w;
  }
  out.drop = a.drop + (b.drop - a.drop) * w;
  out.shift = a.shift + (b.shift - a.shift) * w;
  return out;
}

// locomotion: s = 0 idle guard stance, 1 run, 1.6 sprint. ph = stride phase (radians)
export function locoPose(out, ph, s, t) {
  const st = clamp01(1 - s * 2);
  const r = Math.min(s, 1.6);
  const sn = Math.sin(ph), cs = Math.cos(ph);
  const A = 0.2 + 0.5 * Math.min(r, 1.3);
  out.thL[0] = -sn * A * (1 - st) + st * 0.1; out.thR[0] = sn * A * (1 - st) + st * -0.36;
  out.thL[1] = 0; out.thR[1] = 0;
  out.thL[2] = 0.06 + st * 0.08; out.thR[2] = -0.06 - st * 0.05;
  out.knL[0] = (1 - st) * ((0.25 + 0.95 * r) * Math.max(0, cs) + 0.15 * r) + st * 0.38;
  out.knR[0] = (1 - st) * ((0.25 + 0.95 * r) * Math.max(0, -cs) + 0.15 * r) + st * 0.44;
  // toe-off: the trailing foot rolls onto its toes, the leading one lands heel first
  out.anL[0] = (1 - st) * (-0.25 * r * Math.max(0, -cs) + 0.18 * r * Math.max(0, sn)) - st * 0.28;
  out.anR[0] = (1 - st) * (-0.25 * r * Math.max(0, cs) + 0.18 * r * Math.max(0, -sn)) - st * 0.08;
  out.knL[1] = out.knL[2] = out.knR[1] = out.knR[2] = 0;
  out.anL[1] = out.anL[2] = out.anR[1] = out.anR[2] = 0;
  out.drop = -0.05 * st - 0.05 * r + 0.035 * r * Math.abs(cs) + Math.sin(t * 1.6) * 0.006 * st;
  // weight shift: the pelvis rolls over the planted leg
  out.hips[0] = 0; out.hips[1] = -sn * 0.16 * r - st * 0.3; out.hips[2] = cs * 0.05 * r;
  out.spine[0] = 0.06 * st + 0.12 * r; out.spine[1] = st * 0.12; out.spine[2] = -cs * 0.03 * r;
  out.chest[0] = 0.04 * r + Math.sin(t * 1.6) * 0.012 * st; out.chest[1] = sn * 0.18 * r + st * 0.16; out.chest[2] = 0;
  out.neck[0] = -0.05 * r; out.neck[1] = -out.chest[1] * 0.5 - out.spine[1] * 0.5 - out.hips[1] * 0.6; out.neck[2] = 0;
  out.head[0] = -0.06 * r; out.head[1] = 0; out.head[2] = 0;
  // free (left) arm: swings with the stride, raised in a guard at idle
  out.shL[0] = -sn * 0.55 * r * (1 - st) - st * 0.35; out.shL[1] = 0; out.shL[2] = 0.16 + st * 0.08;
  out.elL[0] = -0.4 - 0.6 * r - st * 0.85; out.elL[1] = 0; out.elL[2] = 0;
  out.haL[0] = 0; out.haL[1] = 0; out.haL[2] = 0;
  out.shR[0] = sn * 0.5 * r; out.shR[1] = 0; out.shR[2] = -0.15; out.elR[0] = -0.6; out.elR[1] = 0; out.elR[2] = 0;
  out.haR[0] = 0; out.haR[1] = 0; out.haR[2] = 0;
  out.shift = 0;
  return out;
}

// airborne: vy > 0 rising (legs tucked)
export function airPose(out, vy) {
  const up = clamp01(vy / 5);
  out.thL[0] = -0.9; out.knL[0] = 1.3; out.anL[0] = -0.3;
  out.thR[0] = lerp(0.35, -0.2, up); out.knR[0] = lerp(0.9, 0.5, up); out.anR[0] = 0.2;
  out.thL[2] = 0.1; out.thR[2] = -0.1;
  out.spine[0] = 0.15; out.chest[0] = 0.05; out.hips[1] = -0.1; out.chest[1] = 0.1;
  out.shL[0] = -0.5; out.shL[2] = 0.45; out.elL[0] = -1.0;
  out.drop = 0; out.neck[1] = 0; out.head[0] = 0;
  return out;
}

// deep crouch used for jump take-off and hard landings (k = 0..1)
export function crouchPose(out, k) {
  out.thL[0] = lerp(out.thL[0], -0.85, k); out.knL[0] = lerp(out.knL[0], 1.5, k); out.anL[0] = lerp(out.anL[0], -0.6, k);
  out.thR[0] = lerp(out.thR[0], -0.5, k); out.knR[0] = lerp(out.knR[0], 1.4, k); out.anR[0] = lerp(out.anR[0], -0.8, k);
  out.spine[0] = lerp(out.spine[0], 0.4, k);
  out.drop = lerp(out.drop, -0.3, k);
  return out;
}

// sword guard: wide low stance, blade held across the body (the hand target comes from guardHand)
export function guardPose(out, t) {
  locoPose(out, 0, 0, t);
  out.thL[0] = -0.35; out.knL[0] = 0.75; out.anL[0] = -0.35; out.thL[2] = 0.18;
  out.thR[0] = 0.25; out.knR[0] = 0.6; out.anR[0] = 0.1; out.thR[2] = -0.16;
  out.hips[1] = -0.45; out.spine[0] = 0.18; out.spine[1] = 0.2; out.chest[1] = 0.3; out.chest[0] = 0.08;
  out.neck[1] = 0.1; out.head[0] = -0.05;
  out.shL[0] = -0.9; out.shL[2] = 0.35; out.elL[0] = -1.35;     // free arm braces the flat of the blade
  out.drop = -0.2;
  return out;
}
export const GUARD_HAND = { p: [-0.05, 1.28, 0.42], d: [0.95, 0.28, 0.12], u: [0, 0.2, 1] };

// dash / step: lean hard into the move, trailing leg extended. lx, lz = dash direction in character space
export function dashPose(out, lx, lz, t) {
  locoPose(out, 0.6, 1, t);
  const fwd = lz, side = lx;
  out.spine[0] = 0.35 * fwd + 0.05; out.chest[0] = 0.15 * fwd;
  out.spine[2] = -0.25 * side; out.hips[2] = -0.2 * side;
  out.thL[0] = -0.75 * Math.max(0, fwd) + 0.5 * Math.max(0, -fwd); out.knL[0] = 1.1;
  out.thR[0] = 0.6 * Math.max(0, fwd) - 0.3 * Math.max(0, -fwd); out.knR[0] = 0.35; out.anR[0] = 0.45;
  out.thL[2] = 0.1 + 0.35 * Math.max(0, side); out.thR[2] = -0.1 - 0.35 * Math.max(0, -side);
  out.shL[0] = 0.6 * fwd; out.shL[2] = 0.55; out.elL[0] = -0.7;
  out.drop = -0.18;
  return out;
}

// struck: torso snaps away from the blow (the spring impulse does most of the work), legs buckle
export function flinchPose(out, k, t) {
  locoPose(out, 0, 0, t);
  out.spine[0] = -0.35 * k; out.chest[0] = -0.25 * k; out.neck[0] = 0.3 * k; out.head[0] = 0.2 * k;
  out.knL[0] = 0.7; out.knR[0] = 0.9; out.thR[0] = 0.2;
  out.shL[0] = -0.2; out.shL[2] = 0.7 * k + 0.2; out.elL[0] = -0.5;
  out.drop = -0.12 * k;
  return out;
}

// launched / knocked into the air: limbs flung out, back arched (the body tumbles via root pitch)
export function tumblePose(out, t) {
  out.hips[0] = 0; out.hips[1] = 0; out.hips[2] = 0;
  out.spine[0] = -0.45; out.chest[0] = -0.3; out.spine[1] = Math.sin(t * 7) * 0.1; out.chest[1] = 0;
  out.neck[0] = 0.35; out.head[0] = 0.25; out.neck[1] = 0;
  out.thL[0] = -0.5; out.knL[0] = 1.2; out.anL[0] = 0.3; out.thL[2] = 0.3;
  out.thR[0] = 0.25; out.knR[0] = 0.4; out.anR[0] = 0.4; out.thR[2] = -0.35;
  out.shL[0] = 0.3; out.shL[2] = 1.3; out.elL[0] = -0.4;
  out.shR[0] = 0.4; out.shR[2] = -1.2; out.elR[0] = -0.4;
  out.drop = 0; out.shift = 0;
  return out;
}

// flat on the back (the body is pitched back 90° about the feet), k = 1 down, 0 up
export function downPose(out, k, t) {
  tumblePose(out, t);
  out.spine[0] = lerp(-0.45, 0.05, k); out.chest[0] = lerp(-0.3, 0, k); out.neck[0] = lerp(0.35, -0.25, k);
  out.thL[0] = lerp(-0.5, -0.1, k); out.knL[0] = lerp(1.2, 0.45, k); out.thR[0] = lerp(0.25, -0.05, k); out.knR[0] = lerp(0.4, 0.1, k);
  out.shL[2] = 1.0; out.shR[2] = -1.0; out.shL[0] = 0.1; out.shR[0] = 0.1;
  return out;
}

// getting up: knee down, hand on the ground, k = 1 kneeling, 0 standing
export function getupPose(out, k, t) {
  locoPose(out, 0, 0, t);
  out.thL[0] = lerp(out.thL[0], -1.3, k); out.knL[0] = lerp(out.knL[0], 1.6, k); out.anL[0] = lerp(out.anL[0], -0.3, k);
  out.thR[0] = lerp(out.thR[0], 0.2, k); out.knR[0] = lerp(out.knR[0], 1.9, k); out.anR[0] = lerp(out.anR[0], 0.7, k);
  out.spine[0] = lerp(out.spine[0], 0.55, k); out.chest[0] = lerp(out.chest[0], 0.2, k);
  out.shL[0] = lerp(out.shL[0], -0.5, k); out.shL[2] = lerp(out.shL[2], 0.25, k); out.elL[0] = lerp(out.elL[0], -0.1, k);
  out.drop = lerp(out.drop, -0.52, k);
  return out;
}

// ---------- moves ----------
// path 'arc': hand = c + R (cos a U + sin a V), U = (-cos roll, sin roll, 0) (character right, tilted up by roll),
// V = forward. t = [windup, swing, recovery] seconds. dmg is also the ore yield (dmg / 4 tonnes) on deposits.
// pull = how far the windup draws the blade back along the arc (radians-ish fraction of the swing).
// Flags: launch (pops the target into the air), slam (drives an airborne target into the ground), heavy / finisher
// (big knockback), air (performed airborne), plunge (dives to the ground), unblockable (red telegraph: dodge it).
const C = [0, 1.3, 0.14];
const m = (o) => ({ path: 'arc', R: 0.52, c: C, cone: 1.3, range: 2.2, lunge: 2.4, hitstop: 0.06, dmg: 12, chain: 0.6, pull: 0.12, ...o });

export const MOVES = {
  k1: m({ roll: 0.18, a0: -0.7, a1: 3.7, t: [0.1, 0.13, 0.28], dmg: 14 }),
  k2: m({ roll: -0.55, a0: 3.6, a1: -0.5, t: [0.09, 0.13, 0.28], dmg: 14 }),
  k3: m({ roll: 1.05, a0: -0.4, a1: 3.4, t: [0.11, 0.14, 0.3], dmg: 17 }),
  k4: m({ roll: -1.3, a0: -0.2, a1: 3.0, t: [0.15, 0.15, 0.45], dmg: 24, hitstop: 0.1, cone: 1.0, finisher: true }),
  kH: m({ roll: 1.45, a0: -0.5, a1: 2.6, t: [0.28, 0.14, 0.45], dmg: 32, hitstop: 0.12, shock: 3.2, range: 2.5, cone: 0.9, heavy: true }),
  // launcher: rising slash from the ground up past the head; the target goes up, you can jump after it
  kL: m({ roll: 1.52, a0: 2.95, a1: -0.55, t: [0.12, 0.15, 0.34], dmg: 16, hitstop: 0.09, cone: 0.9, range: 2.3, lunge: 1.8, launch: true }),
  kA1: m({ roll: 0.1, a0: -0.6, a1: 3.6, t: [0.07, 0.12, 0.24], dmg: 12, air: true, lunge: 1.2 }),
  kA2: m({ roll: -0.4, a0: 3.6, a1: -0.4, t: [0.07, 0.12, 0.28], dmg: 14, air: true, lunge: 1.2 }),
  kA3: m({ roll: 1.4, a0: -0.6, a1: 2.7, t: [0.1, 0.13, 0.34], dmg: 20, air: true, lunge: 1.4, slam: true, hitstop: 0.1, heavy: true }),
  kP: m({ roll: 1.45, a0: -0.3, a1: 2.4, t: [0.14, 0.12, 0.38], dmg: 28, shock: 3.6, plunge: true, heavy: true, hitstop: 0.1 }),

  // enemy moves: same arcs with long, readable windups (the body glows during it). Orange = parry it, red = dodge.
  e1: m({ roll: 0.2, a0: -0.8, a1: 3.6, t: [0.46, 0.14, 0.42], dmg: 7, pull: 0.3, lunge: 2.6 }),
  e2: m({ roll: -0.6, a0: 3.6, a1: -0.4, t: [0.26, 0.14, 0.5], dmg: 7, pull: 0.25 }),
  eL: m({ roll: 1.52, a0: 2.95, a1: -0.5, t: [0.55, 0.15, 0.55], dmg: 8, pull: 0.35, launch: true, cone: 0.9 }),
  eH: m({ roll: 1.45, a0: -0.6, a1: 2.6, t: [0.8, 0.15, 0.7], dmg: 18, pull: 0.45, shock: 3.4, range: 2.6, cone: 0.9, heavy: true, unblockable: true }),
  eA: m({ roll: 1.3, a0: -0.5, a1: 2.7, t: [0.36, 0.13, 0.4], dmg: 9, air: true, slam: true, pull: 0.3, lunge: 1.6 }),
  eS: m({ roll: -1.2, a0: -0.3, a1: 3.0, t: [0.5, 0.15, 0.55], dmg: 11, pull: 0.3, heavy: true, finisher: true }),
};
export const COMBO = { ground: ['k1', 'k2', 'k3', 'k4'], heavy: 'kH', launch: 'kL', air: ['kA1', 'kA2', 'kA3'], plunge: 'kP' };

const _U = new THREE.Vector3();
// Evaluates a move at elapsed time e. Writes hand target / blade dir / blade up in CHARACTER space.
export function evalMove(mv, e, scale, out) {
  const [tw, ts] = mv.t;
  const phase = e < tw ? 'wind' : e < tw + ts ? 'swing' : 'recover';
  let u;
  if (phase === 'wind') u = -mv.pull * ease.outCubic(e / tw);
  else if (phase === 'swing') u = -mv.pull + (1 + mv.pull) * ease.outQuart((e - tw) / ts);
  else u = 1;
  const a = mv.a0 + (mv.a1 - mv.a0) * u;
  _U.set(-Math.cos(mv.roll), Math.sin(mv.roll), 0);
  const ca = Math.cos(a), sa = Math.sin(a);
  out.dir.set(_U.x * ca, _U.y * ca, sa);
  out.hand.set(mv.c[0], mv.c[1], mv.c[2]).addScaledVector(out.dir, mv.R).multiplyScalar(scale);
  const sgn = Math.sign(mv.a1 - mv.a0);
  out.up.set(-_U.x * sa * sgn, -_U.y * sa * sgn, ca * sgn);
  out.dir.addScaledVector(out.up, 0.15).normalize();   // the tip leads the cut
  out.angle = a;
  out.phase = phase;
  out.u = u;
  return out;
}

export function arcBasis(mv, U, V) {
  U.set(-Math.cos(mv.roll), Math.sin(mv.roll), 0);
  V.set(0, 0, 1);
}

// Torso pose that sells a swing: twist with the blade angle, lean into it, step the lead foot.
// k = how committed (0 wind .. 1 swing), air = airborne variant.
export function attackPose(out, mv, mvState, t) {
  locoPose(out, 0, 0, t);
  const k = THREE.MathUtils.clamp(-(mvState.angle - Math.PI / 2), -1.6, 1.6);
  const vert = Math.abs(Math.sin(mv.roll));                        // overhead / rising cuts twist less, bend more
  out.chest[1] = k * 0.38 * (1 - vert * 0.6); out.spine[1] = k * 0.3 * (1 - vert * 0.5); out.hips[1] = k * 0.16;
  const sw = mvState.phase === 'swing' ? 1 : mvState.phase === 'recover' ? 0.8 : 0.3;
  const wind = mvState.phase === 'wind' ? 1 : 0;
  const rise = mv.launch ? (mvState.phase === 'wind' ? -1 : mvState.u) : 0;
  out.spine[0] = 0.15 + sw * (mv.heavy ? 0.35 : 0.15) + vert * 0.2 * (mvState.u > 0.5 ? 1 : -0.4) - rise * 0.35;
  out.chest[0] = vert * 0.1 * sw - wind * 0.1;
  out.thR[0] = -0.75 * sw - 0.2 * wind; out.knR[0] = 0.7 + 0.3 * wind; out.thL[0] = 0.45 * sw; out.knL[0] = 0.35 + 0.2 * wind;
  out.anR[0] = -0.2 * sw; out.anL[0] = 0.25 * sw;
  out.drop = -0.1 - 0.08 * sw - 0.12 * wind * (mv.heavy || mv.launch ? 1 : 0.4) + (mv.launch ? 0.1 * Math.max(0, rise) : 0);
  out.shL[0] = -0.4 - 0.4 * sw; out.shL[2] = 0.35 + 0.5 * sw; out.elL[0] = -0.7;   // free arm counterbalances
  out.neck[1] = -out.chest[1] * 0.6 - out.spine[1] * 0.4;
  if (mv.air) airPose(out, 2);
  return out;
}
