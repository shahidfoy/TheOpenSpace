import * as THREE from 'three';
import { buildMechRig, applyPose, solveArm, S } from './mechRig.js';
import { newPose, mixPose, locoPose, airPose, crouchPose, evalMove, arcBasis, MOVES, COMBO, ease } from './swordAnim.js';
import { SwordFx } from './swordFx.js';

// Surface mech controller: run / sprint, jump + double jump (thruster burst), rocket flight (hold jump in the air
// to climb on the foot / calf / back thrusters, Shift in the air to boost along the stick on the back and wing
// thrusters, leaning into it), and laser-sword combat driven by the Noir move set (4-hit ground combo, heavy shockwave, aerial combo, plunge,
// and a 360° arc slash). Physics use the world's real gravity; jump heights are set in metres so they feel the
// same everywhere and hang time reflects the gravity.

const RUN = 8, SPRINT = 15;
const JUMP_H = [6, 5];            // metres gained by the first and second jump
const SPIN_COST = 30, SPIN_T = 0.6;
const FLY_TOP = 34, CLIMB = 11;   // m/s: rocket boost top speed, climb rate
const BURN_BOOST = 9, BURN_CLIMB = 8, RECHARGE = 22;   // thruster charge %/s
const PIVOT = 3.0;                // metres above the feet the flight lean pivots around
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _C = new THREE.Vector3(), _U = new THREE.Vector3(), _V = new THREE.Vector3();
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const lerp = THREE.MathUtils.lerp;

export class MechPilot {
  constructor(scene) {
    this.rig = buildMechRig();
    this.root = this.rig.root;
    this.fx = new SwordFx(scene);
    this.pos = new THREE.Vector3();   // feet; the rig root is offset from it when leaning
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pose = newPose(); this.target = newPose();
    this.hand = { p: V3(-0.27, 1.04, 0.32).multiplyScalar(S), d: V3(0, 0, 1), u: V3(0, 1, 0), w: 1 };
    this.mv = { hand: new THREE.Vector3(), dir: new THREE.Vector3(), up: new THREE.Vector3(), phase: '', u: 0, angle: 0 };
    this.reset();
  }

  reset() {
    this.vel.set(0, 0, 0);
    this.yaw = 0;
    this.state = 'idle';       // idle | attack | spin
    this.grounded = true;
    this.jumps = 0;
    this.jumpHeld = false;
    this.burstT = 0;
    this.climb = 0; this.boostK = 0; this.flying = false;
    this.pitch = 0; this.roll = 0;
    this.thr = { back: 0, wing: 0, sh: 0, calf: 0, foot: 0 };
    this.landT = 0;
    this.move = null; this.moveE = 0; this.moveHit = new Set();
    this.combo = 0; this.comboGap = 9;
    this.buf = null; this.bufT = 0;
    this.hitstop = 0;
    this.shake = 0;
    this.phase = 0;
    this.speedNorm = 0;
    this.fuel = 100;
    this.ignite = 0;
    this.swordHold = 0;
    this.time = 0;
    this.slashHoldT = 0;
  }

  forward(out = _v) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  // rig space -> world, including the flight lean (root matrix is refreshed each frame in animate)
  toWorld(local, out) { return out.copy(local).applyMatrix4(this.root.matrixWorld); }
  toWorldDir(local, out) { return out.copy(local).transformDirection(this.root.matrixWorld); }
  flatWorld(local, out) { return out.copy(local).applyAxisAngle(UP, this.yaw).add(this.pos); }
  flatDir(local, out) { return out.copy(local).applyAxisAngle(UP, this.yaw); }

  // ctx: { g, height(x,z), bound, camYaw, targets: [{pos, radius, alive}], onHit(target, mv, point), onSpend(),
  //        puff(pos, scale), haptic(kind) }
  update(rawDt, I, ctx) {
    this.time += rawDt;
    this.shake = Math.max(0, this.shake - rawDt * 2.5);
    if (this.hitstop > 0) this.hitstop -= rawDt;
    const dt = this.hitstop > 0 ? rawDt * 0.06 : rawDt;
    // the blade only exists while fighting: it ignites on an attack, stays lit briefly so combos chain, then retracts
    const fighting = this.state === 'attack' || this.state === 'spin';
    if (fighting) this.swordHold = 1.4; else this.swordHold = Math.max(0, (this.swordHold || 0) - rawDt);
    const lit = fighting || this.swordHold > 0;
    this.ignite = lit ? Math.min(1, this.ignite + rawDt * 14) : Math.max(0, this.ignite - rawDt * 3.5);

    // ---- input: buffered attacks ----
    const heldSlash = I.slashHold && !this.slashHeldPrev;
    this.slashHeldPrev = I.slashHold;
    if (I.slashHold) this.slashHoldT += rawDt; else this.slashHoldT = 0;
    if (I.attack || heldSlash || (this.slashHoldT > 0.3 && !this.buf)) { this.buf = 'attack'; this.bufT = 0.35; }
    if (I.heavy) { this.buf = 'heavy'; this.bufT = 0.35; }
    if (I.spin) { this.buf = 'spin'; this.bufT = 0.35; }
    if (this.bufT > 0) this.bufT -= rawDt; else this.buf = null;

    const g = (this.g = ctx.g);
    const jumpEdge = I.jump && !this.jumpHeld;
    this.jumpHeld = I.jump;

    // ---- desired move direction (camera relative) ----
    const fwd = _v2.set(-Math.sin(ctx.camYaw), 0, -Math.cos(ctx.camYaw));
    const right = _v3.set(Math.cos(ctx.camYaw), 0, -Math.sin(ctx.camYaw));
    const wish = _v4.set(0, 0, 0).addScaledVector(fwd, I.move.y).addScaledVector(right, I.move.x);
    if (wish.lengthSq() > 1) wish.normalize();

    // ---- start actions ----
    const canAct = this.state === 'idle' || (this.state === 'attack' && this.mv.phase === 'recover' && this.moveE > this.move.t[0] + this.move.t[1] + 0.05);
    if (this.buf && canAct) {
      const b = this.buf;
      if (b === 'spin') {
        if (this.fuel >= SPIN_COST) { this.fuel -= SPIN_COST; this.startSpin(); }
        else ctx.onSpend?.();
      } else this.startAttack(b === 'heavy', wish, ctx);
      this.buf = null;
    }

    // ---- jumping ----
    if (jumpEdge && this.state !== 'spin' && !(this.move?.plunge)) {
      if (this.grounded) this.jump(0, wish);
      else if (this.jumps < 2) this.jump(1, wish);
    }

    // ---- horizontal motion ----
    if (this.state === 'attack') this.updateAttack(dt, ctx);
    else if (this.state === 'spin') this.updateSpin(dt, ctx);
    else {
      if (this.state === 'idle' && this.comboGap < 9) this.comboGap += dt;
      const boosting = !this.grounded && I.boost && this.fuel > 0;
      let top, ctl, dir = wish;
      if (boosting) {
        // rocket boost: along the stick, or straight ahead with no stick input
        if (wish.lengthSq() < 0.01) dir = this.forward(_v);
        top = FLY_TOP; ctl = 2.6;
        this.fuel = Math.max(0, this.fuel - BURN_BOOST * dt);
      } else if (this.grounded) {
        top = I.boost ? SPRINT : RUN; ctl = this.landT > 0 ? 3 : 9;
      } else {
        // free fall keeps momentum; climbing on thrusters gives some steering
        top = Math.max(RUN, Math.hypot(this.vel.x, this.vel.z)); ctl = this.climb > 0.1 ? 2.4 : 0.9;
      }
      this.boostK += ((boosting ? 1 : 0) - this.boostK) * Math.min(1, dt * 6);
      const k = 1 - Math.exp(-ctl * dt);
      const prevX = this.vel.x, prevZ = this.vel.z;
      this.vel.x = lerp(this.vel.x, dir.x * top, k);
      this.vel.z = lerp(this.vel.z, dir.z * top, k);
      this.accelX = (this.vel.x - prevX) / Math.max(dt, 1e-4); this.accelZ = (this.vel.z - prevZ) / Math.max(dt, 1e-4);
      const hs = Math.hypot(this.vel.x, this.vel.z);
      if (hs > 0.6 && (wish.lengthSq() > 0.01 || boosting)) this.yaw += angDiff(this.yaw, Math.atan2(this.vel.x, this.vel.z)) * (1 - Math.exp(-(this.grounded ? 10 : boosting ? 5 : 3) * dt));
    }

    // ---- vertical: gravity, thrusters ----
    // hold jump in the air (after the take-off press) to climb on the thrusters
    const climbing = !this.grounded && I.jump && !jumpEdge && this.fuel > 0 && this.state !== 'attack' && this.burstT <= 0;
    this.climb += ((climbing ? 1 : 0) - this.climb) * Math.min(1, dt * 8);
    const hang = this.state === 'attack' && this.move.air && !this.move.plunge;
    if (climbing) {
      this.vel.y = lerp(this.vel.y, CLIMB, 1 - Math.exp(-2.5 * dt));
      this.fuel = Math.max(0, this.fuel - BURN_CLIMB * dt);
    } else if (hang) this.vel.y *= Math.exp(-7 * dt);
    else if (this.boostK > 0.5 && this.state === 'idle') this.vel.y = lerp(this.vel.y - g * dt, 0, 1 - Math.exp(-1.8 * dt));   // boost holds altitude
    else this.vel.y -= g * dt;
    this.vel.y = Math.min(this.vel.y, 16);
    this.flying = climbing || this.boostK > 0.5;
    if (this.grounded) this.fuel = Math.min(100, this.fuel + RECHARGE * dt);

    this.pos.addScaledVector(this.vel, dt);
    const h = ctx.height(this.pos.x, this.pos.z);
    const was = this.grounded;
    if (this.pos.y <= h + 0.02) {
      if (!was) this.land(this.vel.y, ctx);
      this.pos.y = h;
      this.vel.y = Math.max(0, this.vel.y);
      this.grounded = this.vel.y <= 0.01;
    } else if (this.grounded && this.pos.y - h < 0.6 && this.vel.y <= 0) {
      this.pos.y = h;                // stick to the ground walking downhill
    } else this.grounded = false;
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > ctx.bound) { this.pos.x *= ctx.bound / r; this.pos.z *= ctx.bound / r; }
    this.alt = this.pos.y - h;

    if (this.landT > 0) this.landT -= dt;
    if (this.burstT > 0) this.burstT -= dt;

    // footsteps
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.speed = sp;
    if (this.grounded && sp > 1 && this.state === 'idle') {
      const prev = this.phase;
      this.phase += dt * (sp * 1.45 / S + 1.6);
      if (Math.floor(prev / Math.PI) !== Math.floor(this.phase / Math.PI)) {
        const side = Math.floor(this.phase / Math.PI) % 2 ? 1 : -1;
        ctx.puff?.(this.flatWorld(_v.set(side * 0.12 * S, 0, 0.3 * S), new THREE.Vector3()), 0.35 + sp / SPRINT * 0.5);
        if (sp > 10) this.shake = Math.max(this.shake, 0.08);
      }
    }

    this.animate(dt);
    this.updateSword(rawDt);
    this.fx.update(rawDt);
  }

  jump(n, wish) {
    this.vel.y = Math.sqrt(2 * this.g * JUMP_H[n]);
    if (n === 1) {
      this.jumps = 2;
      this.burstT = 0.4;      // thruster kick on the second jump
      if (wish.lengthSq() > 0.01) {
        // redirect momentum toward the stick on the second jump
        const hs = Math.max(RUN * 0.8, Math.hypot(this.vel.x, this.vel.z));
        this.vel.x = wish.x * hs; this.vel.z = wish.z * hs;
        this.yaw = Math.atan2(wish.x, wish.z);
      }
      this.fx.ring(_v.copy(this.pos).setY(this.pos.y + 0.6 * S), 2.2 * S, { life: 0.4 });
      if (this.state === 'attack' && this.move?.air) { this.state = 'idle'; this.move = null; }
    } else {
      this.jumps = 1;
      this.burstT = 0.15;
      this.landT = 0;
    }
    this.grounded = false;
    this.pos.y += 0.05;
  }

  land(vy, ctx) {
    this.jumps = 0;
    if (vy < -5) {
      this.landT = Math.min(0.35, -vy * 0.03);
      ctx.puff?.(this.pos, 1.2);
      ctx.haptic?.('heavy');
      this.shake = Math.max(this.shake, Math.min(0.5, -vy * 0.03));
    }
    if (this.state === 'attack' && this.move) {
      if (this.move.plunge) {
        // plunge impact: shockwave
        this.moveE = Math.max(this.moveE, this.move.t[0] + this.move.t[1]);
        this.shockwave(ctx, this.pos, this.move.shock * S, this.move);
        this.shake = 0.7;
      } else if (this.move.air) { this.state = 'idle'; this.move = null; }
    }
  }

  // ---------------- attacks ----------------
  pickTarget(ctx, range = 9 * S) {
    let best = null, bs = Infinity;
    const f = this.forward(_v);
    for (const t of ctx.targets) {
      if (!t.alive) continue;
      const dx = t.pos.x - this.pos.x, dz = t.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > range || Math.abs(t.pos.y - this.pos.y) > 4 * S) continue;
      const dot = d > 0.01 ? (dx * f.x + dz * f.z) / d : 1;
      if (dot < 0.15 && d > 2.5 * S) continue;
      const score = d * (1.6 - dot);
      if (score < bs) { bs = score; best = t; }
    }
    return best;
  }

  startAttack(heavy, wish, ctx) {
    // aim with the stick before choosing a target
    if (wish.lengthSq() > 0.05) this.yaw = Math.atan2(wish.x, wish.z);
    let id;
    if (!this.grounded) {
      if (heavy) { id = COMBO.plunge; this.vel.y = 3; }
      else {
        const n = this.state === 'attack' && this.move?.air ? this.combo : 0;
        id = COMBO.air[n % COMBO.air.length];
        this.combo = n + 1;
      }
    } else if (heavy) { id = COMBO.heavy; this.combo = 0; }
    else {
      const chain = this.state === 'attack' || this.comboGap < 0.45;
      if (!chain || this.combo >= COMBO.ground.length) this.combo = 0;
      id = COMBO.ground[this.combo];
      this.combo++;
    }
    this.attackTarget = this.pickTarget(ctx);
    this.move = MOVES[id];
    this.moveE = 0;
    this.moveHit.clear();
    this.slashed = false;
    this.shocked = false;
    this.state = 'attack';
    this.comboGap = 0;
  }

  arcFrame(center, U, V) {
    const mv = this.move;
    arcBasis(mv, U, V);
    this.flatDir(U, U); this.flatDir(V, V);
    this.flatWorld(_v.set(mv.c[0], mv.c[1], mv.c[2]).multiplyScalar(S), center);
  }

  updateAttack(dt, ctx) {
    const mv = this.move;
    this.moveE += dt;
    const s = evalMove(mv, this.moveE, S, this.mv);
    const [tw, ts] = mv.t;
    if (mv.plunge) {
      if (this.moveE > tw && !this.grounded) this.vel.y = -32;
      this.vel.x *= Math.exp(-dt * 6); this.vel.z *= Math.exp(-dt * 6);
    } else if (this.moveE < tw + ts * 0.6) {
      let want = mv.lunge * 9;
      const t = this.attackTarget;
      if (t && t.alive) {
        const d = Math.hypot(t.pos.x - this.pos.x, t.pos.z - this.pos.z) - t.radius;
        const stop = mv.range * S * 0.55;
        want = THREE.MathUtils.clamp((d - stop) * 10, 0, 40);
        this.yaw += angDiff(this.yaw, Math.atan2(t.pos.x - this.pos.x, t.pos.z - this.pos.z)) * Math.min(1, dt * 20);
      }
      const f = this.forward(_v);
      this.vel.x = f.x * want; this.vel.z = f.z * want;
    } else {
      this.vel.x *= Math.exp(-dt * 12); this.vel.z *= Math.exp(-dt * 12);
    }
    if (s.phase === 'swing' && !this.slashed) {
      this.slashed = true;
      this.arcFrame(_C, _U, _V);
      const big = mv.heavy || mv.finisher;
      this.fx.crescent(_C, _U, _V, mv.a0, mv.a1, ts * 1.1, { radius: 1.75 * S * (big ? 1.2 : 1), innerFrac: 0.42, life: big ? 0.32 : 0.22 });
    }
    if (s.phase === 'swing' || (s.phase === 'recover' && this.moveE < tw + ts + 0.04)) this.sweep(ctx);
    if (s.phase === 'recover' && mv.shock && !mv.plunge && !this.shocked) {
      this.shocked = true;
      const p = this.forward(_v).multiplyScalar(1.6 * S).add(this.pos);
      p.y = ctx.height(p.x, p.z) + 0.2;
      this.shockwave(ctx, p, mv.shock * S, mv);
    }
    if (this.moveE >= tw + ts + mv.t[2]) { this.state = 'idle'; this.move = null; this.comboGap = 0; }
  }

  shockwave(ctx, p, r, mv) {
    this.fx.ring(_v.copy(p).setY(p.y + 0.3), r, { life: 0.5 });
    this.fx.sparksAt(_v.copy(p).setY(p.y + 0.5), 30, { speed: 16, dir: UP, spread: 1.6, floor: p.y });
    ctx.puff?.(p, 1.6);
    this.shake = Math.max(this.shake, 0.5);
    ctx.haptic?.('heavy');
    for (const t of ctx.targets) {
      if (!t.alive || this.moveHit.has(t)) continue;
      if (Math.hypot(t.pos.x - p.x, t.pos.z - p.z) > r + t.radius) continue;
      this.moveHit.add(t);
      this.hit(t, mv, ctx);
    }
  }

  // targets struck by the current swing (horizontal cone + range + height overlap)
  sweep(ctx) {
    const mv = this.move;
    const f = this.forward(_v3);
    for (const t of ctx.targets) {
      if (!t.alive || this.moveHit.has(t)) continue;
      const dx = t.pos.x - this.pos.x, dz = t.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > mv.range * S + t.radius) continue;
      if (t.pos.y - this.pos.y > 2.2 * S || this.pos.y - t.pos.y > 3 * S) continue;
      const cosA = d > 0.01 ? (dx * f.x + dz * f.z) / d : 1;
      if (Math.acos(THREE.MathUtils.clamp(cosA, -1, 1)) > mv.cone && d > 1.5 * S) continue;
      this.moveHit.add(t);
      this.hit(t, mv, ctx);
    }
  }

  hit(t, mv, ctx) {
    const p = _v.copy(t.pos); p.y += t.radius * 0.6;
    const color = ctx.onHit(t, mv, p) ?? 0xbff4ff;
    this.fx.sparksAt(p, mv.heavy || mv.finisher ? 40 : 22, { color, speed: 18, life: 0.6, floor: t.pos.y - 0.5 });
    this.fx.sparksAt(p, 10, { color: 0xeaffff, speed: 26, life: 0.25, width: 0.05 });
    this.hitstop = Math.max(this.hitstop, mv.hitstop);
    this.shake = Math.max(this.shake, mv.heavy || mv.finisher ? 0.45 : 0.22);
    ctx.haptic?.(mv.heavy ? 'heavy' : 'medium');
  }

  // ---------------- arc slash: two spins, hits everything in reach ----------------
  startSpin() {
    this.state = 'spin';
    this.moveE = 0;
    this.moveHit.clear();
    this.spinHits = 0;
    this.move = null;
    this.vel.x *= 0.3; this.vel.z *= 0.3;
    if (!this.grounded) this.vel.y = Math.max(this.vel.y, 1.5);
  }

  updateSpin(dt, ctx) {
    this.moveE += dt;
    this.vel.x *= Math.exp(-dt * 6); this.vel.z *= Math.exp(-dt * 6);
    const hitsAt = [0.12, 0.34];
    if (this.spinHits < hitsAt.length && this.moveE >= hitsAt[this.spinHits]) {
      this.spinHits++;
      this.moveHit.clear();
      const r = 2.7 * S;
      _C.copy(this.pos); _C.y += 1.2 * S;
      _U.set(1, 0, 0); _V.set(0, 0, -1);
      this.fx.crescent(_C, _U, _V, 0, Math.PI * 2 - 0.01, 0.2, { radius: r, innerFrac: 0.62, life: 0.3, tail: 3 });
      this.fx.crescent(_C, _U, _V, 0, Math.PI * 2 - 0.01, 0.18, { radius: r * 0.75, innerFrac: 0.5, life: 0.25, tail: 3, color: 0xe8fbff });
      this.shake = Math.max(this.shake, 0.35);
      const mv = { dmg: 18, hitstop: 0.05, heavy: this.spinHits === 2 };
      for (const t of ctx.targets) {
        if (!t.alive) continue;
        if (Math.hypot(t.pos.x - this.pos.x, t.pos.z - this.pos.z) > r + t.radius) continue;
        if (Math.abs(t.pos.y - this.pos.y) > 3 * S) continue;
        this.hit(t, mv, ctx);
      }
    }
    if (this.moveE >= SPIN_T) { this.state = 'idle'; this.combo = 0; }
  }

  // ---------------- animation ----------------
  animate(dt) {
    const T = this.target;
    const sp = this.speed;
    this.speedNorm += (Math.min(1.6, sp / RUN) - this.speedNorm) * Math.min(1, dt * 10);
    const run = Math.min(1, this.speedNorm);
    let rate = 16;
    let H = null;
    const sc = (x, y, z) => V3(x, y, z).multiplyScalar(S);

    if (this.state === 'attack') {
      const mv = this.move;
      locoPose(T, 0, 0, this.time);
      const k = THREE.MathUtils.clamp(-(this.mv.angle - Math.PI / 2), -1.6, 1.6);
      T.chest[1] = k * 0.35; T.spine[1] = k * 0.3; T.hips[1] = k * 0.15;
      const sw = this.mv.phase === 'swing' ? 1 : this.mv.phase === 'recover' ? 0.8 : 0.3;
      T.spine[0] = 0.15 + sw * (mv.heavy ? 0.35 : 0.15);
      T.thR[0] = -0.75 * sw; T.knR[0] = 0.7; T.thL[0] = 0.45 * sw; T.knL[0] = 0.35;
      T.drop = -0.1 - 0.08 * sw;
      if (mv.air) airPose(T, 2);
      H = { p: this.mv.hand, d: this.mv.dir, u: this.mv.up, snap: this.mv.phase !== 'wind', rate: 30 };
      rate = this.mv.phase === 'wind' ? 30 : 20;
    } else if (this.state === 'spin') {
      locoPose(T, 0, 0, this.time);
      T.spine[0] = 0.25; T.drop = -0.15; T.thR[0] = -0.6; T.knR[0] = 0.8; T.knL[0] = 0.6;
      T.shL[0] = -0.2; T.shL[2] = 1.2; T.elL[0] = -0.3;
      H = { p: sc(-0.62, 1.3, 0.25), d: V3(-1, 0.05, 0.35).normalize(), u: V3(0, 0, 1), snap: true };
      rate = 24;
    } else if (this.flying) {
      // rocket flight: legs trail and straighten, free arm tucked, sword held back along the body;
      // climbing straight up keeps the legs together under the body
      airPose(T, 0);
      const b = this.boostK;
      T.thL[0] = lerp(-0.1, 0.32, b); T.thR[0] = lerp(0.05, 0.12, b);
      T.knL[0] = lerp(0.25, 0.55, b); T.knR[0] = lerp(0.15, 0.85, b);
      T.anL[0] = 0.45; T.anR[0] = 0.5;
      T.thL[2] = 0.04; T.thR[2] = -0.04;
      T.spine[0] = lerp(0.05, -0.12, b); T.chest[0] = lerp(0, -0.1, b);
      T.neck[0] = -this.pitch * 0.55; T.head[0] = -this.pitch * 0.25;
      T.hips[1] = 0; T.chest[1] = 0; T.spine[1] = 0;
      T.shL[0] = lerp(-0.3, 0.45, b); T.shL[2] = lerp(0.5, 0.25, b); T.elL[0] = lerp(-0.9, -1.3, b);
      T.drop = 0;
      H = { p: sc(-0.33, 1.0, lerp(0.1, -0.22, b)), d: V3(-0.15, -0.45, lerp(0.5, -1, b)).normalize(), u: V3(0, 1, 0), rate: 10, w: this.swordHold > 0 ? 1 : 0 };
      if (H.w === 0) { T.shR[0] = lerp(-0.3, 0.45, b); T.shR[2] = -lerp(0.5, 0.25, b); T.elR[0] = lerp(-0.9, -1.3, b); }
      rate = 8;
    } else {
      if (!this.grounded) airPose(T, this.vel.y);
      else locoPose(T, this.phase, this.speedNorm, this.time);
      if (this.landT > 0) crouchPose(T, Math.min(1, this.landT / 0.2));
      // sword low and forward at idle, trailing behind while running
      H = {
        p: sc(-0.27, lerp(1.04, 0.96, run), lerp(0.32, -0.3, run)),
        d: V3(lerp(-0.15, 0.15, run), lerp(-0.2, -0.3, run), lerp(1, -1, run)).normalize(),
        u: V3(0, 1, 0),
        w: this.swordHold > 0 ? 1 : 0,      // sword put away: the right arm swings freely on FK
      };
    }
    mixPose(this.pose, this.pose, T, 1 - Math.exp(-dt * rate));

    const rig = this.rig;
    // flight lean: pitch into the boost (Iron Man style), bank with sideways acceleration; pivot near the chest
    const fl = this.state === 'idle' && this.flying;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const f = this.forward(_v);
    const side = (this.accelX || 0) * f.z - (this.accelZ || 0) * f.x;      // lateral accel (+ = to the left)
    const wantPitch = fl ? THREE.MathUtils.clamp(hs / FLY_TOP, 0, 1) * this.boostK * 1.05 + this.climb * (1 - this.boostK) * 0.05 : 0;
    const wantRoll = fl ? THREE.MathUtils.clamp(-side * 0.025, -0.6, 0.6) : 0;
    this.pitch += (wantPitch - this.pitch) * Math.min(1, dt * 4);
    this.roll += (wantRoll - this.roll) * Math.min(1, dt * 3);
    if (!fl) this.boostK += (0 - this.boostK) * Math.min(1, dt * 6);
    rig.root.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    const pv = _v2.set(0, PIVOT, 0);
    rig.root.position.copy(this.pos).add(pv).sub(pv.clone().applyEuler(rig.root.rotation));
    applyPose(rig, this.pose);
    if (this.state === 'spin') rig.J.hips.rotation.y += -Math.PI * 4 * ease.outCubic(Math.min(1, this.moveE / (SPIN_T * 0.8)));
    rig.root.updateMatrixWorld(true);

    const h = this.hand;
    const k = H.snap ? 1 : 1 - Math.exp(-dt * (H.rate ?? 18));
    h.p.lerp(H.p, k);
    h.d.lerp(H.d, k).normalize();
    h.u.lerp(H.u, k).normalize();
    h.w += ((H.w ?? 1) - h.w) * Math.min(1, k * 1.5 + dt * 4);
    if (this.state === 'spin') h.w = 1;
    if (h.w > 0.01) {
      const tgt = this.toWorld(h.p, new THREE.Vector3());
      const dirW = this.toWorldDir(h.d, new THREE.Vector3());
      const upW = this.toWorldDir(h.u, new THREE.Vector3());
      const poleL = V3(-0.45, 0.75, -0.5).multiplyScalar(S);
      if (h.p.y > 1.5 * S) poleL.y += 0.9 * S;
      const poleW = this.toWorld(poleL, new THREE.Vector3());
      if (this.state === 'spin') {
        // the hand target is in the un-spun frame; rotate it with the hips
        const a = -Math.PI * 4 * ease.outCubic(Math.min(1, this.moveE / (SPIN_T * 0.8)));
        for (const v of [tgt, poleW]) v.sub(rig.root.position).applyAxisAngle(UP, a).add(rig.root.position);
        dirW.applyAxisAngle(UP, a); upW.applyAxisAngle(UP, a);
      }
      solveArm(rig, 'R', tgt, poleW, dirW, upW, h.w);
    }

    this.updateThrusters(dt);
  }

  // per-group throttle: back + wings drive the boost, feet + calves lift, shoulder verniers trim attitude
  updateThrusters(dt) {
    const burst = this.burstT > 0 ? 1.4 : 0;
    const c = this.climb, b = this.boostK;
    const steer = Math.min(1, Math.abs(this.roll) * 2 + Math.abs(this.pitch - (this.prevPitch ?? this.pitch)) * 40);
    this.prevPitch = this.pitch;
    const want = {
      back: Math.max(b * 1.1, c * 0.55, burst),
      wing: Math.max(b, c * 0.7, burst * 0.9),
      sh: Math.max(b * 0.35 + steer * 0.6, burst * 0.5, c * 0.25),
      calf: Math.max(c * 0.9, b * 0.4, burst),
      foot: Math.max(c, burst * 1.1),
    };
    for (const k in want) this.thr[k] += (want[k] - this.thr[k]) * Math.min(1, dt * 12);
    const t = this.time;
    for (const th of this.rig.thrusters) {
      const v = this.thr[th.group] ?? 0;
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

  updateSword(dt) {
    const sw = this.rig.sword, u = sw.userData;
    const swinging = (this.state === 'attack' && this.mv.phase === 'swing') || this.state === 'spin';
    const flick = 0.92 + Math.sin(this.time * 61) * 0.04 + Math.sin(this.time * 37) * 0.04;
    const ig = ease.outCubic(this.ignite);
    sw.visible = this.ignite > 0.01;
    u.core.scale.set(1, 1, Math.max(0.001, ig));
    u.sheath.scale.set(1 + (swinging ? 0.35 : 0), 1 + (swinging ? 0.25 : 0), Math.max(0.001, ig * 1.03));
    u.sheathMat.opacity = (swinging ? 0.8 : 0.5) * flick;
    u.light.intensity = (swinging ? 22 : 7) * flick * ig;
    sw.updateWorldMatrix(true, false);
    this.fx.pushTrail(_v.copy(u.base).applyMatrix4(sw.matrixWorld), _v2.copy(u.tip).applyMatrix4(sw.matrixWorld), swinging);
  }

  setVisible(v) {
    this.root.visible = v;
    this.fx.setVisible(v);
  }
}
