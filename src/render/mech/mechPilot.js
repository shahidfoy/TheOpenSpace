import * as THREE from 'three';
import { S } from './mechRig.js';
import { MechBody, thrustFor } from './mechBody.js';
import {
  locoPose, airPose, crouchPose, guardPose, dashPose, flinchPose, tumblePose, downPose, getupPose, attackPose,
  evalMove, arcBasis, MOVES, COMBO, ease, GUARD_HAND,
} from './swordAnim.js';
import { SwordFx } from './swordFx.js';
import { SkinnedMechBody, buildSkinCombos, makeWarp, clipTime, clipRate } from './mechSkin.js';
import { rmAt } from '../chars/katanaPack.js';
import { BladeKit, KIT, RAGE_COLOR, shotgun, wound, woundMul, slow, makeLane, setLane, distToLane } from '../chars/bladeKit.js';
// the Rush clip's phases: its dash carries the Daywalker Dash and the Thousand-Fold Slash's entry
const RUSH = { crouch: 0.6, holdA: 0.85, holdB: 2.2, dash0: 2.45, dash1: 4.15, end: 4.9 };
const GUN_RANGE = 75, PELLET_DMG = 4.4;       // metres; damage per pellet (nine to a shell)
const ULT_LEN = 50, ULT_W = 12;               // metres: the Thousand-Fold Slash's path
const distSeg = (p, a, b) => {
  const abx = b.x - a.x, abz = b.z - a.z, l2 = abx * abx + abz * abz;
  const t = l2 > 1e-6 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2)) : 0;
  return Math.hypot(p.x - (a.x + abx * t), p.z - (a.z + abz * t));
};
import { skinned } from '../assets.js';
import { loadFrame } from './frames.js';

// Surface mech controller: run / sprint, jump + double jump (thruster burst), rocket flight (hold jump in the air
// to climb on the foot / calf / back thrusters, Shift in the air to boost along the stick on the back and wing
// thrusters, leaning into it), and the Daywalker kit (chars/bladeKit.js, Blade's kit from Marvel Rivals): a saber slash
// chain or shotgun blasts as the primary (swap between them), the Daywalker Dash, the Scarlet Shroud block, Bloodline
// Awakening and the Thousand-Fold Slash, plus a launcher and a 3-hit aerial combo.
// Defence for the arena: hold GUARD to block (press it just before a hit lands to PARRY: the attacker staggers and
// time slows), DODGE for a thruster step with invulnerability frames. Enemies can hurt, launch and knock you down.
// Physics use the world's real gravity (or the arena's grav plating); jump heights are set in metres so they feel
// the same everywhere and hang time reflects the gravity.

const RUN = 8, SPRINT = 15, GUARD_WALK = 3.2;
const JUMP_H = [6, 5];            // metres gained by the first and second jump
const SPIN_COST = 30, SPIN_T = 0.6;
const FLY_TOP = 34, CLIMB = 11;   // m/s: rocket boost top speed, climb rate
const BURN_BOOST = 9, BURN_CLIMB = 8, RECHARGE = 22;   // thruster charge %/s
const PIVOT = 3.0;                // metres above the feet the flight lean pivots around
const DODGE_T = 0.34, DODGE_V = 58, DODGE_IFRAME = [0.02, 0.3], AIR_DODGE_COST = 14;      // the Daywalker Dash
const PARRY_WIN = 0.24;           // seconds after pressing guard that a hit is parried instead of blocked
export const MAX_HP = 100;
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _C = new THREE.Vector3(), _U = new THREE.Vector3(), _V = new THREE.Vector3();
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const REACT = new Set(['hit', 'launched', 'down', 'getup', 'dead']);

export class MechPilot {
  // opts.clone: give this pilot its own copy of the skinned model (a second mech in another scene)
  constructor(scene, opts = {}) {
    this.fx = new SwordFx(scene);
    this.scene = scene; this.cloneBody = !!opts.clone;
    // root: a stable handle for the scene; the frame's own body hangs in the same scene and can be swapped
    this.setFrame(opts.frame || loadFrame(), true);
    this.pos = new THREE.Vector3();   // feet; the rig root is offset from it when leaning
    this.vel = new THREE.Vector3();
    this.mv = { hand: new THREE.Vector3(), dir: new THREE.Vector3(), up: new THREE.Vector3(), phase: '', u: 0, angle: 0 };
    // reusable hand-target spec handed to the body every frame
    this.H = { p: new THREE.Vector3(), d: new THREE.Vector3(), u: new THREE.Vector3(), w: 1, snap: false, rate: 18, force: false };
    this.thrWant = { back: 0, wing: 0, sh: 0, calf: 0, foot: 0 };
    this.dodgeDir = new THREE.Vector3();
    this.kit = new BladeKit();
    this.aimDir = new THREE.Vector3(0, 0, 1);
    // the Thousand-Fold Slash's path on the ground
    this.lane = makeLane();
    scene.add(this.lane);
    this.reset();
  }

  // the chosen frame (mech/frames.js: X-12, Omega), else the NEXORION, else the procedural knight
  setFrame(id, first = false) {
    const asset = skinned('mech_' + id) || skinned('mech_player');
    if (!first && this.frameId === id) return;
    this.frameId = id;
    const vis = this.body ? this.body.root.visible : true;
    if (this.body) { this.body.root.removeFromParent(); this.body.trail.on = false; this.body.trail.mesh.visible = false; }
    this.body = asset ? new SkinnedMechBody(this.scene, this.fx, asset, { saber: true, clone: this.cloneBody || !!this.bodyMade }) : new MechBody(this.scene, this.fx, { scheme: 'player' });
    this.bodyMade = true;
    this.skin = asset ? this.body : null;
    this.C = asset ? buildSkinCombos(this.body) : COMBO;
    // once the clip packs are on the body, rebuild the moves on its clips (root motion, true grip, new launcher)
    if (asset) this.body.onPack = () => { this.C = buildSkinCombos(this.body); };
    this.rig = this.body.rig;
    this.root = this.body.root;
    if (!first) { this.body.setVisible(vis); this.state = 'idle'; this.move = null; this.skin?.setWeapon(this.kit.weapon); }
  }

  reset() {
    this.vel.set(0, 0, 0);
    this.yaw = 0;
    this.state = 'idle';       // idle | attack | spin | dodge | hit | launched | down | getup | dead
    this.grounded = true;
    this.jumps = 0;
    this.jumpHeld = false;
    this.burstT = 0;
    this.climb = 0; this.boostK = 0; this.flying = false;
    this.pitch = 0; this.roll = 0; this.tumble = 0;
    this.landT = 0;
    this.move = null; this.moveE = 0; this.moveHit = new Set();
    this.combo = 0; this.comboGap = 9;
    this.buf = null; this.bufT = 0;
    this.hitstop = 0; this.slowmo = 0;
    this.shake = 0;
    this.phase = 0;
    this.speedNorm = 0;
    this.fuel = 100;
    this.swordHold = 0;
    this.time = 0;
    this.slashHoldT = 0;
    this.hp = MAX_HP;
    this.guarding = false; this.guardT = 9; this.guardK = 0;
    this.reactT = 0; this.iframe = 0;
    this.lock = null;
    this.hurtT = 0;
    this.lean = 0;
    this.kit.reset();
    this.aimK = 0; this.recoil = 0; this.dash = null;
    this.zone = null; this.lane.visible = false;
    this.skin?.setWeapon('sword');
  }

  forward(out = _v) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  // rig space -> world, including the flight lean (root matrix is refreshed each frame in animate)
  toWorld(local, out) { return out.copy(local).applyMatrix4(this.root.matrixWorld); }
  flatWorld(local, out) { return out.copy(local).applyAxisAngle(UP, this.yaw).add(this.pos); }
  flatDir(local, out) { return out.copy(local).applyAxisAngle(UP, this.yaw); }
  get alive() { return this.state !== 'dead'; }
  get radius() { return 1.5; }
  get invulnerable() { return this.iframe > 0 || this.state === 'getup' || this.state === 'dead'; }

  // ctx: { g, height(x,z), bound, center?, camYaw, targets: [{pos, radius, alive}], enemies?, onHit(target, mv, point),
  //        onSpend(), puff(pos, scale), haptic(kind), onDeath() }
  update(rawDt, I, ctx) {
    this.time += rawDt;
    this.shake = Math.max(0, this.shake - rawDt * 2.5);
    if (this.hitstop > 0) this.hitstop -= rawDt;
    if (this.slowmo > 0) this.slowmo -= rawDt;
    const dt = rawDt * this.timeScale;
    this.hurtT = Math.max(0, this.hurtT - rawDt);
    if (this.iframe > 0) this.iframe -= dt;
    // the blade only exists while fighting: it ignites on an attack or guard and stays lit just long enough for the
    // next press of a combo, then retracts (the saber suit keeps it out for less time than the procedural frame)
    this.kit.update(dt);
    this.recoil = Math.max(0, this.recoil - rawDt * 7);
    const fighting = this.state === 'attack' || this.state === 'aim' || this.state === 'rush' || this.state === 'rushEnd' || this.guarding || !!this.zone || (this.state === 'dodge' && this.dash && !this.dash.gun);
    if (fighting) this.swordHold = this.skin ? 0.55 : 1.4; else this.swordHold = Math.max(0, this.swordHold - rawDt);

    const g = (this.g = ctx.g);
    const jumpEdge = I.jump && !this.jumpHeld;
    this.jumpHeld = I.jump;

    // ---- desired move direction (camera relative) ----
    const fwd = _v2.set(-Math.sin(ctx.camYaw), 0, -Math.cos(ctx.camYaw));
    const right = _v3.set(Math.cos(ctx.camYaw), 0, -Math.sin(ctx.camYaw));
    const wish = _v4.set(0, 0, 0).addScaledVector(fwd, I.move.y).addScaledVector(right, I.move.x);
    if (wish.lengthSq() > 1) wish.normalize();

    this.updateLock(ctx, I);

    if (REACT.has(this.state)) {
      this.updateReaction(dt, I, ctx, jumpEdge, wish);
    } else {
      this.updateControl(dt, rawDt, I, ctx, jumpEdge, wish, g);
    }

    // ---- vertical: gravity, thrusters ----
    // hold jump in the air (after the take-off press) to climb on the thrusters
    const ctl = !REACT.has(this.state) && this.state !== 'dodge';
    const climbing = ctl && !this.grounded && I.jump && !jumpEdge && this.fuel > 0 && this.state !== 'attack' && this.burstT <= 0;
    this.climb += ((climbing ? 1 : 0) - this.climb) * Math.min(1, dt * 8);
    const hang = this.state === 'attack' && this.move.air && !this.move.plunge;
    if (climbing) {
      this.vel.y = lerp(this.vel.y, CLIMB, 1 - Math.exp(-2.5 * dt));
      this.fuel = Math.max(0, this.fuel - BURN_CLIMB * dt);
    } else if (hang) this.vel.y *= Math.exp(-7 * dt);
    else if (this.state === 'dodge' && !this.grounded) this.vel.y *= Math.exp(-10 * dt);   // air dash holds altitude
    else if (this.boostK > 0.5 && this.state === 'idle') this.vel.y = lerp(this.vel.y - g * dt, 0, 1 - Math.exp(-1.8 * dt));   // boost holds altitude
    else this.vel.y -= g * dt;
    this.vel.y = Math.min(this.vel.y, 20);
    this.flying = climbing || (this.boostK > 0.5 && this.state === 'idle');
    if (this.grounded && this.state !== 'dead') this.fuel = Math.min(100, this.fuel + RECHARGE * dt);

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
    const cx = ctx.center ? ctx.center.x : 0, cz = ctx.center ? ctx.center.z : 0;
    const dx = this.pos.x - cx, dz = this.pos.z - cz, r = Math.hypot(dx, dz);
    if (r > ctx.bound) { this.pos.x = cx + dx * ctx.bound / r; this.pos.z = cz + dz * ctx.bound / r; }
    this.alt = this.pos.y - h;

    if (this.landT > 0) this.landT -= dt;
    if (this.burstT > 0) this.burstT -= dt;

    // footsteps
    const sp = Math.hypot(this.vel.x, this.vel.z);
    this.speed = sp;
    if (this.grounded && sp > 1 && (this.state === 'idle' || this.state === 'dodge')) {
      const prev = this.phase;
      this.phase += dt * (sp * 1.45 / S + 1.6);
      if (Math.floor(prev / Math.PI) !== Math.floor(this.phase / Math.PI)) {
        const side = Math.floor(this.phase / Math.PI) % 2 ? 1 : -1;
        ctx.puff?.(this.flatWorld(_v.set(side * 0.12 * S, 0, 0.3 * S), _C), 0.35 + sp / SPRINT * 0.5);
        if (sp > 10) this.shake = Math.max(this.shake, 0.08);
      }
    }

    this.updateZone(dt, ctx);
    this.skin?.setRage(this.kit.raging && this.alive);
    if (this.kit.raging && Math.random() < rawDt * 16) {
      const a = Math.random() * Math.PI * 2;
      this.fx.sparksAt(_v.set(this.pos.x + Math.cos(a) * 1.2, this.pos.y + Math.random() * 1.5 * S, this.pos.z + Math.sin(a) * 1.2), 1, { speed: 6, dir: UP, spread: 0.3, life: 0.5, width: 0.05, grav: -3, color: RAGE_COLOR });
    }
    this.animate(dt);
    this.fx.update(rawDt);
  }

  get timeScale() { return this.hitstop > 0 ? 0.06 : this.slowmo > 0 ? 0.4 : 1; }

  updateControl(dt, rawDt, I, ctx, jumpEdge, wish, g) {
    // ---- input: buffered attacks ----
    const heldSlash = I.slashHold && !this.slashHeldPrev;
    this.slashHeldPrev = I.slashHold;
    if (I.slashHold) this.slashHoldT += rawDt; else this.slashHoldT = 0;
    const K = this.kit;
    if (K.gun) { if ((I.attack || I.attackHold || I.slashHold) && K.canFire() && this.state === 'idle' && !this.guarding) this.fireGun(ctx); }
    else if (I.attack || heldSlash || ((I.attackHold || this.slashHoldT > 0.3) && !this.buf)) { this.buf = 'attack'; this.bufT = 0.35; }
    if (I.swap && this.state === 'idle') this.swapWeapon();
    if ((I.heavy || I.rage) && K.canRage() && (this.state === 'idle' || this.state === 'attack')) this.toggleRage();
    // laying the ultimate's path: attack (or the ultimate again) confirms, dash or block calls it off
    if (this.state === 'aim') {
      if (I.dodge || I.guard) { this.state = 'idle'; K.aiming = false; this.lane.visible = false; this.buf = null; }
      else if ((I.attack || I.spin || heldSlash) && this.moveE > 0.15) { this.buf = null; this.startUlt(ctx); }
    }
    if (I.launch) { this.buf = 'launch'; this.bufT = 0.35; }
    if (I.spin) { this.buf = 'ult'; this.bufT = 0.35; }
    if (I.dodge) { this.buf = 'dodge'; this.bufT = 0.3; }
    if (this.bufT > 0) this.bufT -= rawDt; else this.buf = null;

    // ---- guard (held) ----
    const wantGuard = !!I.guard && this.grounded && this.state !== 'attack' && this.state !== 'spin' && this.state !== 'dodge';
    if (wantGuard && !this.guarding) { this.guardT = 0; K.mark('block'); if (K.gun) this.swapWeapon('sword'); }
    this.guarding = wantGuard;
    this.guardT += rawDt;
    this.guardK += ((this.guarding ? 1 : 0) - this.guardK) * Math.min(1, dt * 18);

    // ---- start actions ----
    const recovering = this.state === 'attack' && this.mv.phase === 'recover' && this.moveE > this.move.t[0] + this.move.t[1] + 0.05;
    const canAct = this.state === 'idle' || recovering || (this.state === 'dodge' && this.moveE > DODGE_T * 0.6);
    if (this.buf && canAct && !this.guarding) {
      const b = this.buf;
      if (b === 'ult') {
        if (K.canUlt() && this.C.rush && this.grounded) this.startAim();
        this.buf = null;
      } else if (b === 'dodge') {
        if (this.state !== 'dodge' && K.canDash() && (this.grounded || this.fuel >= AIR_DODGE_COST)) { this.startDodge(wish, ctx); this.buf = null; }
      } else { if (K.gun) this.swapWeapon('sword'); this.startAttack(b, wish, ctx); this.buf = null; }
    } else if (this.buf === 'dodge' && this.guarding && K.canDash()) { this.guarding = false; this.startDodge(wish, ctx); this.buf = null; }
    // ---- jumping (jump-cancels the launcher and attack recovery, so you can chase a launched target) ----
    if (jumpEdge && this.state !== 'rush' && this.state !== 'aim' && !(this.move?.plunge)) {
      if (this.grounded) { if (this.state === 'attack' && recovering) this.endMove(); if (this.state !== 'attack') this.jump(0, wish); }
      else if (this.jumps < 2) this.jump(1, wish);
    }

    // ---- horizontal motion ----
    if (this.state === 'attack') this.updateAttack(dt, ctx);
    else if (this.state === 'aim') this.updateAim(dt, ctx);
    else if (this.state === 'rush' || this.state === 'rushEnd') this.updateRush(dt, ctx);
    else if (this.state === 'dodge') this.updateDodge(dt, ctx);
    else {
      if (this.comboGap < 9) this.comboGap += dt;
      const boosting = !this.grounded && I.boost && this.fuel > 0;
      let top, ctl, dir = wish;
      if (boosting) {
        // rocket boost: along the stick, or straight ahead with no stick input
        if (wish.lengthSq() < 0.01) dir = this.forward(_v);
        top = FLY_TOP; ctl = 2.6;
        this.fuel = Math.max(0, this.fuel - BURN_BOOST * dt);
      } else if (this.grounded) {
        top = this.guarding ? GUARD_WALK : I.boost ? SPRINT : RUN; ctl = this.landT > 0 ? 3 : 9;
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
      if (K.gun && K.aimT > 0.3) this.yaw += angDiff(this.yaw, Math.atan2(this.aimDir.x, this.aimDir.z)) * (1 - Math.exp(-18 * dt));   // onto the aim
      else if (this.guarding && this.lock) this.faceTarget(this.lock, dt, 12);
      else if (hs > 0.6 && (wish.lengthSq() > 0.01 || boosting)) this.yaw += angDiff(this.yaw, Math.atan2(this.vel.x, this.vel.z)) * (1 - Math.exp(-(this.grounded ? 10 : boosting ? 5 : 3) * dt));
    }
  }

  faceTarget(t, dt, rate) {
    this.yaw += angDiff(this.yaw, Math.atan2(t.pos.x - this.pos.x, t.pos.z - this.pos.z)) * Math.min(1, dt * rate);
  }

  // soft lock-on: the nearest live enemy in view stays locked until it dies, goes far, or you switch (Tab)
  updateLock(ctx, I) {
    const list = ctx.enemies;
    if (!list || !list.length) { this.lock = null; return; }
    const ok = (e) => e && e.alive && e.pos.distanceTo(this.pos) < 60;
    if (I.lockSwitch || !ok(this.lock)) {
      let best = null, bs = Infinity;
      const camF = _v.set(-Math.sin(ctx.camYaw), 0, -Math.cos(ctx.camYaw));
      for (const e of list) {
        if (!ok(e) || (I.lockSwitch && e === this.lock && list.length > 1)) continue;
        const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z, d = Math.hypot(dx, dz);
        const dot = d > 0.1 ? (dx * camF.x + dz * camF.z) / d : 1;
        const s = d * (1.8 - dot);
        if (s < bs) { bs = s; best = e; }
      }
      this.lock = best;
    }
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
      if (this.state === 'attack' && this.move?.air) this.endMove();
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
    this.landEdge = vy < -9;
    if (vy < -5 && this.state !== 'launched') {
      this.landT = Math.min(0.35, -vy * 0.03);
      ctx.puff?.(this.pos, 1.2);
      ctx.haptic?.('heavy');
      this.shake = Math.max(this.shake, Math.min(0.5, -vy * 0.03));
    }
    if (this.state === 'launched') {
      // slammed into the ground: knocked flat
      this.state = 'down'; this.reactT = 0.85; this.vel.x *= 0.3; this.vel.z *= 0.3;
      ctx.puff?.(this.pos, 1.6);
      this.shake = Math.max(this.shake, 0.45);
      ctx.haptic?.('heavy');
    }
    if (this.state === 'attack' && this.move) {
      if (this.move.plunge) {
        // plunge impact: shockwave
        this.moveE = Math.max(this.moveE, this.move.t[0] + this.move.t[1]);
        this.shockwave(ctx, this.pos, this.move.shock * S, this.move);
        this.shake = 0.7;
      } else if (this.move.air) this.endMove();
    }
    if (this.state === 'dodge') this.vel.y = 0;
  }

  endMove() { this.state = 'idle'; this.move = null; this.comboGap = 0; }

  // ---------------- defence ----------------
  // Daywalker Dash: a thruster dash with invulnerability frames, along the stick or straight ahead. With the saber
  // it cuts everything on the way and leaves it wounded; with the shotgun it ends in a wide blast.
  startDodge(wish, ctx) {
    if (!this.grounded) this.fuel -= AIR_DODGE_COST;
    const K = this.kit, d = this.dodgeDir;
    K.useDash();
    if (wish.lengthSq() > 0.05) d.copy(wish).normalize();
    else this.forward(d);
    this.state = 'dodge';
    this.move = null;
    this.moveE = 0;
    this.moveHit.clear();
    this.dash = { from: this.pos.clone(), gun: K.gun, up: !!this.jumpHeld };
    if (this.dash.up) { this.grounded = false; this.pos.y += 0.1; this.jumps = Math.max(this.jumps, 1); K.mark('dashUp'); }
    this.iframe = DODGE_IFRAME[1];
    this.vel.x = d.x * DODGE_V; this.vel.z = d.z * DODGE_V;
    this.burstT = 0.3;
    this.yaw = Math.atan2(d.x, d.z);
    ctx.puff?.(this.pos, 0.9);
    const col = K.raging ? RAGE_COLOR : 0x8fd4ff;
    this.fx.ring(_v.copy(this.pos).setY(this.pos.y + 0.3), 2.4 * S, { life: 0.35, color: col });
    this.fx.sparksAt(_v.copy(this.pos).setY(this.pos.y + 1.2 * S), 18, { color: col, speed: 12, dir: _v2.copy(d).negate(), spread: 0.6, life: 0.35, width: 0.05 });
    ctx.haptic?.('light');
  }

  updateDodge(dt, ctx) {
    this.moveE += dt;
    const k = Math.max(0, 1 - this.moveE / DODGE_T), D = this.dash;
    const v = DODGE_V * (0.2 + 0.8 * ease.outCubic(k));
    this.vel.x = this.dodgeDir.x * v * (D?.up ? 0.6 : 1); this.vel.z = this.dodgeDir.z * v * (D?.up ? 0.6 : 1);
    if (D?.up) this.vel.y = v * 0.62;                // jump held: the dash carries you upward
    if (D && !D.gun) {
      for (const t of ctx.targets) {
        if (!t.alive || this.moveHit.has(t)) continue;
        if (distSeg(t.pos, D.from, this.pos) < t.radius + 1.2 * S && Math.abs(t.pos.y - this.pos.y) < 3 * S) {
          this.moveHit.add(t);
          slow(t, this.time);                        // the cleaving strike slows
          this.hit(t, { dmg: 24, heavy: true, hitstop: 0.09, wound: true, cone: Math.PI, range: 3 }, ctx);
        }
      }
    }
    if (this.moveE >= DODGE_T) {
      this.state = 'idle'; this.vel.multiplyScalar(0.3); this.comboGap = 0;
      if (D?.gun) this.fireGun(ctx, { free: true, wide: true });
      else if (D) {
        const fw = this.forward(_v), right = _v2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        this.fx.crescent(_C.copy(this.pos).setY(this.pos.y + 1.2 * S), right, fw, -1.2, 1.2, 0.08, { radius: 2.4 * S, innerFrac: 0.6, life: 0.3, color: this.skin?.slashColor ?? 0xd8f0ff });
      }
      this.dash = null;
    }
  }

  // An attack reaches the player. hit: { dmg, mv, from (Vector3), attacker, kind: light|heavy|launch|slam|beam, unblockable }
  // Returns 'dodge' | 'parry' | 'block' | 'hit'. The attacker reacts to parry itself.
  takeHit(hit, ctx) {
    if (this.state === 'dead') return 'dodge';
    if (this.invulnerable) {
      if (this.state === 'dodge' && this.moveE < 0.14) { this.slowmo = Math.max(this.slowmo, 0.5); ctx.onPerfect?.('dodge'); }
      return 'dodge';
    }
    const dx = hit.from.x - this.pos.x, dz = hit.from.z - this.pos.z, d = Math.hypot(dx, dz) || 1;
    const f = this.forward(_v);
    const facing = (dx * f.x + dz * f.z) / d;
    const p = _C.copy(this.pos); p.y += 1.3 * S;
    if (this.guarding && facing > 0.1 && !hit.unblockable) {
      if (this.guardT < PARRY_WIN) {
        // parry: bright spark burst, both freeze, then the world slows while the attacker reels
        this.fx.sparksAt(p.addScaledVector(_v2.set(dx / d, 0, dz / d), 1.6), 46, { color: 0xffe08a, speed: 24, life: 0.6, width: 0.06 });
        this.fx.ring(_v.copy(this.pos).setY(this.pos.y + 1.3 * S), 3.2, { color: 0xffd36a, life: 0.35 });
        this.hitstop = Math.max(this.hitstop, 0.14);
        this.slowmo = Math.max(this.slowmo, 0.55);
        this.shake = Math.max(this.shake, 0.35);
        this.body.recoil(dx / d * 0.2, 0.25, 0.4);
        ctx.haptic?.('heavy');
        this.kit.blocked(); this.kit.blocked();
        return 'parry';
      }
      // Scarlet Shroud: the blade takes most of the blow, and each one brings the dash back sooner
      this.hp -= hit.dmg * 0.15;
      this.kit.blocked();
      this.fuel = Math.max(0, this.fuel - (hit.mv?.heavy ? 14 : 6));
      this.vel.x -= dx / d * 7; this.vel.z -= dz / d * 7;
      this.fx.sparksAt(p.addScaledVector(_v2.set(dx / d, 0, dz / d), 1.4), 18, { color: 0xbfe8ff, speed: 16, life: 0.4 });
      this.body.recoil(0, 0.6, 0.5);
      this.skin?.play('block_hit', { time: 0.05, fade: 0.04, speed: 1.6, restart: true });
      this.hitstop = Math.max(this.hitstop, 0.05);
      this.shake = Math.max(this.shake, 0.15);
      ctx.haptic?.('medium');
      if (this.hp <= 0) this.die(ctx);
      return 'block';
    }
    // clean hit
    this.hp -= hit.dmg;
    this.hurtT = 0.5;
    this.guarding = false;
    this.move = null;
    const lx = -(dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw)) / d;     // character-space direction of the blow
    const lz = facing;
    this.body.recoil(lx, lz, hit.mv?.heavy ? 1.4 : 1);
    this.body.hitFlash(0.9);
    this.fx.sparksAt(p, 26, { color: 0xff6a3a, speed: 18, life: 0.6, floor: this.pos.y });
    this.hitstop = Math.max(this.hitstop, hit.mv?.heavy ? 0.1 : 0.06);
    this.shake = Math.max(this.shake, hit.mv?.heavy ? 0.5 : 0.3);
    ctx.haptic?.('heavy');
    const away = _v2.set(-dx / d, 0, -dz / d);
    if (this.hp <= 0) { this.die(ctx); this.vel.addScaledVector(away, 8); return 'hit'; }
    if (hit.kind === 'launch') {
      this.state = 'launched'; this.grounded = false; this.pos.y += 0.1;
      this.vel.set(away.x * 3, Math.sqrt(2 * this.g * 5.5), away.z * 3);
      this.tumble = 0;
    } else if (hit.kind === 'slam' || (!this.grounded && hit.mv?.heavy)) {
      this.state = 'launched'; this.vel.set(away.x * 6, this.grounded ? 4 : -22, away.z * 6); this.grounded = false; this.pos.y += 0.1;
    } else if (!this.grounded) {
      this.state = 'launched'; this.vel.set(away.x * 5, Math.max(this.vel.y, 3), away.z * 5);
    } else {
      const heavy = hit.mv?.heavy || hit.mv?.finisher || hit.kind === 'beam';
      this.state = 'hit'; this.reactT = heavy ? 0.6 : 0.36;
      this.vel.x = away.x * (heavy ? 16 : 6); this.vel.z = away.z * (heavy ? 16 : 6);
    }
    return 'hit';
  }

  die(ctx) {
    this.hp = 0;
    this.state = 'dead';
    this.reactT = 2.6;
    this.move = null;
    this.guarding = false;
    this.fx.sparksAt(_v.copy(this.pos).setY(this.pos.y + 1.4 * S), 60, { color: 0xff8a3a, speed: 22, life: 0.9, floor: this.pos.y });
    this.fx.ring(_v.copy(this.pos).setY(this.pos.y + 0.4), 9, { color: 0xff7a3a, life: 0.6 });
    this.slowmo = 1.2;
    ctx.puff?.(this.pos, 1.8);
  }

  revive() {
    this.hp = MAX_HP; this.fuel = 100;
    this.state = 'idle'; this.reactT = 0; this.iframe = 1.5;
    this.vel.set(0, 0, 0); this.pitch = 0; this.roll = 0; this.tumble = 0;
  }

  updateReaction(dt, I, ctx, jumpEdge, wish) {
    this.reactT -= dt;
    this.guarding = false; this.guardK = Math.max(0, this.guardK - dt * 8);
    const fr = Math.exp(-dt * (this.grounded ? 7 : 0.6));
    if (this.state === 'hit') {
      this.vel.x *= fr; this.vel.z *= fr;
      if (this.reactT <= 0) { this.state = 'idle'; this.iframe = 0.22; }    // a breath to guard or dodge out of a gang-up
    } else if (this.state === 'launched') {
      this.tumble += dt;
      // air recovery: tap jump once the worst is over to flip upright on the thrusters
      if (jumpEdge && this.tumble > 0.35 && this.fuel >= 10) {
        this.fuel -= 10; this.state = 'idle'; this.jumps = 1; this.burstT = 0.35; this.vel.y = Math.max(this.vel.y, 4);
        this.fx.ring(_v.copy(this.pos).setY(this.pos.y + 0.6 * S), 2.2 * S, { life: 0.35 });
        this.iframe = 0.3;
      }
    } else if (this.state === 'down') {
      this.vel.x *= fr; this.vel.z *= fr;
      // tech roll: dodge while on the ground springs you up sooner
      if ((I.dodge || jumpEdge) && this.reactT < 0.6) this.reactT = Math.min(this.reactT, 0.05);
      if (this.reactT <= 0) { this.state = 'getup'; this.reactT = 0.5; }
    } else if (this.state === 'getup') {
      this.vel.x *= fr; this.vel.z *= fr;
      if (this.reactT <= 0) { this.state = 'idle'; this.iframe = 0.35; }
    } else if (this.state === 'dead') {
      this.vel.x *= fr; this.vel.z *= fr;
      if (this.reactT <= 0 && !this.deathReported) { this.deathReported = true; ctx.onDeath?.(); }
      return;
    }
    this.deathReported = false;
  }

  // ---------------- attacks ----------------
  pickTarget(ctx, range = 9 * S) {
    if (this.lock && this.lock.alive && this.lock.pos.distanceTo(this.pos) < range * 1.4) return this.lock;
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

  startAttack(kind, wish, ctx) {
    // aim with the stick before choosing a target
    if (wish.lengthSq() > 0.05) this.yaw = Math.atan2(wish.x, wish.z);
    let id;
    if (!this.grounded) {
      if (kind === 'heavy') { id = this.C.plunge; this.vel.y = 3; }
      else {
        const n = this.state === 'attack' && this.move?.air ? this.combo : 0;
        id = this.C.air[n % this.C.air.length];
        this.combo = n + 1;
      }
    } else if (kind === 'launch') { id = this.C.launch; this.combo = 0; }
    else if (kind === 'heavy') { id = this.C.heavy; this.combo = 0; }
    else if (this.kit.whirl && this.C.whirl && (this.move?.whirl || this.combo >= this.C.ground.length)) { id = this.C.whirl; this.kit.mark('whirlCut'); }
    else {
      const chain = this.state === 'attack' || this.comboGap < 0.45;
      if (!chain || this.combo >= this.C.ground.length) this.combo = 0;
      id = this.C.ground[this.combo];
      this.combo++;
    }
    if (kind === 'launch') this.kit.mark('launch');
    const fromDodge = this.state === 'dodge';
    this.attackTarget = this.pickTarget(ctx, fromDodge ? 12 * S : 9 * S);
    const prev = this.state === 'attack' ? this.move : null, prevE = this.moveE;
    // each attack gets its own copy: a chained clip move re-times its windup from where the last one left off
    this.move = { ...MOVES[id], t: MOVES[id].t.slice() };
    const sp = this.kit.speed;
    if (sp !== 1) {                      // Bloodline Awakening: every cut is faster
      const m = this.move;
      if (m.path === 'clip') { m.speed *= sp; m.arcs = m.arcs.map((a) => ({ ...a, dt: a.dt / sp, dur: a.dur / sp })); }
      else m.t = m.t.map((x) => x / sp);
    }
    this.moveE = 0;
    this.moveHit.clear();
    this.slashed = false;
    this.shocked = false;
    this.rehitT = 0;
    this.state = 'attack';
    this.comboGap = 0;
    this.playMoveClip(prev, prevE);
    // root-motion warp toward the target: stretch / shorten the clip's travel so the cut lands at reach
    this.rmWarp = 1;
    const mvr = this.move, tg = this.attackTarget;
    if (mvr.rm && mvr.warp && tg && !mvr.air && this.skin) {
      const need = Math.hypot(tg.pos.x - this.pos.x, tg.pos.z - this.pos.z) - tg.radius - mvr.range * S * 0.55;
      const avail = (rmAt(mvr.rm, 'fwd', mvr.seg[2]) - rmAt(mvr.rm, 'fwd', mvr.warp.C[0])) * this.skin.k;
      this.rmWarp = avail > 0.5 ? clamp(need / avail, 0, 2.2) : 1;
    }
  }

  // skinned body: start the move's clip, or flow straight into it. Combo hits are consecutive slices of one clip, so
  // a hit chained from the last one's follow-through just keeps scrubbing the same clip from where it is, at the
  // speed it was moving: no crossfade, no snap back to the segment start. Anything else blends in over ~0.1 s.
  playMoveClip(prev, prevE) {
    const mv = this.move, B = this.skin;
    this.arcI = 0;
    if (!B || mv?.path !== 'clip') return;
    if (prev?.warp && prev.clip === mv.clip && B.currentName === mv.clip) {
      const c = clipTime(prev, prevE);
      if (c > mv.seg[0] - 0.45 && c < mv.seg[1] - 0.04) {
        makeWarp(mv, c, clipRate(prev, prevE));
        return;
      }
    }
    makeWarp(mv, mv.seg[0]);
    B.play(mv.clip, { time: mv.seg[0], fade: prev ? 0.09 : 0.12, speed: 0, restart: true });
  }

  // slash crescents along the clip's detected swing arcs (model space -> world)
  clipSlashes() {
    const mv = this.move, B = this.skin, tw = mv.t[0];
    const m = this.root.matrixWorld;
    while (this.arcI < mv.arcs.length && this.moveE >= tw + mv.arcs[this.arcI].dt) {
      const a = mv.arcs[this.arcI++];
      _C.set(a.c[0], a.c[1], a.c[2]).multiplyScalar(B.k).add(B.model.position).applyMatrix4(m);
      _U.set(a.u[0], a.u[1], a.u[2]).transformDirection(m);
      _V.set(a.v[0], a.v[1], a.v[2]).transformDirection(m);
      const big = mv.heavy || mv.finisher || mv.launch;
      const ang = clamp(a.a1, -Math.PI * 2 + 0.01, Math.PI * 2 - 0.01);
      this.fx.crescent(_C, _U, _V, 0, ang, Math.max(0.05, a.dur), { radius: (a.r * B.k + 0.6) * (big ? 1.2 : 1.05), innerFrac: 0.5, life: big ? 0.32 : 0.22, color: this.skin.slashColor });
    }
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
    } else if (mv.rm && !mv.air) {
      // the clip's own footwork (root motion, model units -> metres), warped so the cut lands at reach
      const tc = clipTime(mv, this.moveE), rate = clipRate(mv, this.moveE), k = this.skin.k;
      const f = (rmAt(mv.rm, 'fwd', tc + 0.01) - rmAt(mv.rm, 'fwd', tc - 0.01)) / 0.02 * rate * k * this.rmWarp;
      const l = (rmAt(mv.rm, 'left', tc + 0.01) - rmAt(mv.rm, 'left', tc - 0.01)) / 0.02 * rate * k * Math.min(1, this.rmWarp);
      const t = this.attackTarget;
      if (t && t.alive && this.moveE < tw + ts * 0.6) this.faceTarget(t, dt, 20);
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw), kk = 1 - Math.exp(-30 * dt);
      this.vel.x += (sy * f + cy * l - this.vel.x) * kk; this.vel.z += (cy * f - sy * l - this.vel.z) * kk;
    } else if (this.moveE < tw + ts * 0.6) {
      let want = mv.lunge * 9;
      const t = this.attackTarget;
      if (t && t.alive) {
        const d = Math.hypot(t.pos.x - this.pos.x, t.pos.z - this.pos.z) - t.radius;
        const stop = mv.range * S * 0.55;
        want = clamp((d - stop) * 10, 0, 40);
        this.faceTarget(t, dt, 20);
        // aerial attacks home in vertically too, so juggles connect
        if (mv.air && !mv.plunge) this.vel.y = clamp((t.pos.y - this.pos.y) * 3, -8, 8);
      }
      // step in like a kendo fumikomi: the push builds through the windup and peaks as the cut lands
      const f = this.forward(_v), k = 1 - Math.exp(-(this.moveE < tw ? 14 : 24) * dt);
      this.vel.x = lerp(this.vel.x, f.x * want, k); this.vel.z = lerp(this.vel.z, f.z * want, k);
    } else {
      this.vel.x *= Math.exp(-dt * 9); this.vel.z *= Math.exp(-dt * 9);
    }
    if (mv.path === 'clip') { if (s.phase !== 'wind') this.clipSlashes(); }
    else if (s.phase === 'swing' && !this.slashed) {
      this.slashed = true;
      this.arcFrame(_C, _U, _V);
      const big = mv.heavy || mv.finisher || mv.launch;
      this.fx.crescent(_C, _U, _V, mv.a0, mv.a1, ts * 1.1, { radius: 1.75 * S * (big ? 1.2 : 1), innerFrac: 0.42, life: big ? 0.32 : 0.22 });
      if (mv.launch) this.fx.sparksAt(_v.copy(this.pos).setY(this.pos.y + 0.3), 16, { color: 0x9fe8ff, speed: 12, dir: UP, spread: 0.5, life: 0.4, floor: this.pos.y });
    }
    // the whirlwind cuts again and again as it turns
    if (mv.whirl && s.phase === 'swing' && (this.rehitT += dt) > 0.2 / this.kit.speed) { this.rehitT = 0; this.moveHit.clear(); }
    if (s.phase === 'swing' || (s.phase === 'recover' && this.moveE < tw + ts + 0.04)) this.sweep(ctx);
    if (s.phase === 'recover' && mv.shock && !mv.plunge && !this.shocked) {
      this.shocked = true;
      const p = this.forward(_v).multiplyScalar(1.6 * S).add(this.pos);
      p.y = ctx.height(p.x, p.z) + 0.2;
      this.shockwave(ctx, p, mv.shock * S, mv);
    }
    if (this.moveE >= tw + ts + mv.t[2]) this.endMove();
  }

  // ---------------- weapons ----------------
  swapWeapon(to = null) {
    const w = this.kit.swap(to);
    this.skin?.setWeapon(w);
    this.combo = 0;
    this.fx.sparksAt(_v.copy(this.pos).setY(this.pos.y + 1.1 * S), 8, { speed: 8, life: 0.25, width: 0.05, grav: 0, color: w === 'gun' ? 0xffb080 : 0xcfe9ff });
  }

  // one blast: at the locked target, else the nearest one in front of the camera, else straight along the camera
  fireGun(ctx, { free = false, wide = false } = {}) {
    const K = this.kit, d = this.aimDir;
    if (free) this.forward(d); else d.set(-Math.sin(ctx.camYaw), 0, -Math.cos(ctx.camYaw));
    const o = _C.copy(this.pos); o.y += 1.42 * S;
    let t = this.lock && this.lock.alive && !free ? this.lock : null, best = wide ? 0.3 : 0.86;
    if (!t) for (const c of ctx.targets) {
      if (!c.alive) continue;
      _v.copy(c.pos); _v.y += (c.height || 1.9 * S) * 0.55; _v.sub(o);
      const L = _v.length(); if (L > GUN_RANGE) continue;
      const dot = _v.dot(d) / Math.max(L, 1e-3);
      if (dot > best) { best = dot; t = c; }
    }
    if (t) { d.copy(t.pos); d.y += (t.height || 1.9 * S) * 0.55; d.sub(o).normalize(); }
    const origin = o.clone().addScaledVector(d, 1.6 * S);
    const res = shotgun(origin, d, ctx.targets, wide ? { range: 11 * S, spread: 0.3, pellets: 14, tall: 1.9 * S } : { range: GUN_RANGE, tall: 1.9 * S });
    for (const [tg, n] of res.hits) {
      const dist = Math.hypot(tg.pos.x - this.pos.x, tg.pos.z - this.pos.z);
      const fall = wide ? 1 : clamp(1.25 - dist / GUN_RANGE * 1.1, 0.4, 1);
      if (wide) wound(tg, this.time);              // the dash's blast leaves them wounded
      this.hit(tg, { dmg: n * PELLET_DMG * fall * (wide ? 1.3 : 1), gun: true, heavy: wide || n >= 7, hitstop: wide ? 0.07 : 0.03, cone: Math.PI, range: 3 }, ctx);
    }
    for (const e of res.ends) {
      _v.copy(e).sub(origin); const L = _v.length(); _v.multiplyScalar(1 / Math.max(L, 1e-3));
      this.fx.sparksAt(origin, 1, { dir: _v, spread: 0, speed: Math.min(600, L / 0.07), life: 0.09, width: 0.07, grav: 0, color: K.raging ? 0xff8a7a : 0xffd9a0, intensity: 5 });
      if (L < (wide ? 11 * S : GUN_RANGE) - 0.2) this.fx.sparksAt(e, 2, { speed: 10, life: 0.2, width: 0.05, color: 0xffe2a8 });
    }
    this.fx.sparksAt(origin, wide ? 18 : 10, { dir: d, spread: 0.5, speed: 26, life: 0.14, width: 0.08, grav: 0, color: 0xffc080 });
    this.skin?.gun?.userData.fire();
    this.recoil = 1; this.aimK = Math.max(this.aimK || 0, 0.55);
    this.body.recoil(0, 0.4, wide ? 0.7 : 0.4);
    this.shake = Math.max(this.shake, wide ? 0.45 : 0.25);
    ctx.haptic?.(wide ? 'heavy' : 'medium');
    K.fire(free);
    if (free) K.aimT = 0.5;
  }

  // ---------------- Bloodline Awakening ----------------
  toggleRage() {
    const K = this.kit, on = K.toggleStance();
    if (on) this.skin?.setWeapon('sword');
    this.fx.ring(_v.copy(this.pos).setY(this.pos.y + 0.3), (on ? 3.4 : 1.8) * S, { life: on ? 0.5 : 0.35, color: RAGE_COLOR });
    if (!on) return;
    this.fx.sparksAt(_v.copy(this.pos).setY(this.pos.y + 1.2 * S), 40, { speed: 18, dir: UP, spread: 1.6, life: 0.7, width: 0.07, grav: -4, color: RAGE_COLOR });
    this.shake = Math.max(this.shake, 0.3);
  }

  // ---------------- Thousand-Fold Slash: dash into a zone that is then cut to ribbons ----------------
  // lay the path: an iai crouch, the strip on the ground following the camera
  startAim() {
    const K = this.kit;
    if (K.gun) this.swapWeapon('sword');
    K.aiming = true;
    this.state = 'aim'; this.moveE = 0; this.move = null;
    this.skin.play('rush', { fade: 0.12, time: 0, speed: 0, restart: true });
  }
  updateAim(dt, ctx) {
    this.moveE += dt;
    this.yaw += angDiff(this.yaw, Math.atan2(-Math.sin(ctx.camYaw), -Math.cos(ctx.camYaw))) * Math.min(1, dt * 12);
    this.vel.x *= Math.exp(-dt * 12); this.vel.z *= Math.exp(-dt * 12);
    const tc = this.moveE < RUSH.crouch ? this.moveE : RUSH.holdA + (Math.sin((this.moveE - RUSH.crouch) * 1.4) * 0.5 + 0.5) * (RUSH.holdB - RUSH.holdA) * 0.6;
    this.skin.pose('rush', tc, 0.12);
    setLane(this.lane, this.pos, this.yaw, ULT_LEN, ULT_W);
  }
  // confirmed: dash down the path
  startUlt(ctx) {
    const K = this.kit, fw = this.forward(_v);
    const to = this.pos.clone().addScaledVector(fw, ULT_LEN);
    K.useUlt();
    const rm = this.skin.rm.rush;
    const span = (rmAt(rm, 'fwd', RUSH.dash1) - rmAt(rm, 'fwd', RUSH.dash0)) * this.skin.k;
    this.state = 'rush'; this.moveE = 0; this.moveHit.clear(); this.move = null;
    this.rush = { from: this.pos.clone(), warp: ULT_LEN / Math.max(1, span), dur: 0.5 };
    this.iframe = this.rush.dur + 0.3;
    this.skin.play('rush', { fade: 0.05, time: RUSH.dash0, speed: 0, restart: true });
    this.fx.ring(_v.copy(this.pos).setY(this.pos.y + 0.3), 3.4 * S, { life: 0.35, color: RAGE_COLOR });
    this.fx.sparksAt(_v.copy(this.pos).setY(this.pos.y + 1), 40, { speed: 16, dir: UP, spread: 1.6, floor: this.pos.y, color: RAGE_COLOR });
    this.shake = Math.max(this.shake, 0.45);
    ctx.haptic?.('heavy');
  }
  openZone(from, to) {
    this.zone = { a: from.clone(), b: to.clone(), t: 0, tick: 0 };
    setLane(this.lane, from, Math.atan2(to.x - from.x, to.z - from.z), Math.hypot(to.x - from.x, to.z - from.z), ULT_W);
  }
  // the path cuts everything on it, over and over, then bursts
  updateZone(dt, ctx) {
    const Z = this.zone;
    if (!Z) return;
    Z.t += dt; Z.tick -= dt;
    const done = Z.t >= KIT.ultT;
    if (Z.tick <= 0 || done) {
      Z.tick = KIT.ultTick;
      for (let i = 0; i < (done ? 8 : 3); i++) {
        _C.copy(Z.a).lerp(Z.b, Math.random());
        _C.x += (Math.random() - 0.5) * ULT_W * 0.5; _C.z += (Math.random() - 0.5) * ULT_W * 0.5; _C.y += (0.5 + Math.random() * 1.4) * S;
        const b = Math.random() * Math.PI * 2, tilt = (Math.random() - 0.5) * 2.2;
        _U.set(Math.cos(b), 0, Math.sin(b));
        _V.set(-Math.sin(b) * Math.sin(tilt), Math.cos(tilt), Math.cos(b) * Math.sin(tilt));
        const a0 = Math.random() * 6.28, sw = (1.6 + Math.random() * 1.6) * (Math.random() < 0.5 ? -1 : 1);
        this.fx.crescent(_C, _U, _V, a0, a0 + sw, 0.07, { radius: ((done ? 2.4 : 1.4) + Math.random() * 1.2) * S, innerFrac: 0.62, life: 0.2, color: i % 2 ? 0xffffff : 0xff4a55 });
      }
      for (const t of ctx.targets) {
        if (!t.alive || distToLane(t.pos, Z.a, Z.b) > ULT_W * 0.5 + t.radius || Math.abs(t.pos.y - Z.a.y) > 4 * S) continue;
        wound(t, this.time);
        this.hit(t, done ? { dmg: 42, heavy: true, finisher: true, hitstop: 0.12, zone: true, cone: Math.PI, range: 3 } : { dmg: 9, hitstop: 0.012, zone: true, light: true, cone: Math.PI, range: 3 }, ctx);
      }
    }
    if (done) {
      this.fx.sparksAt(_v.copy(Z.a).lerp(Z.b, 0.5).setY(Z.a.y + S), 50, { speed: 26, dir: UP, spread: 1.6, color: RAGE_COLOR, width: 0.08, floor: Z.a.y });
      this.shake = Math.max(this.shake, 0.6);
      this.zone = null; this.lane.visible = false;
    }
  }
  updateRush(dt, ctx) {
    const R = this.rush;
    this.moveE += dt;
    if (this.state === 'rushEnd') {
      this.vel.x *= Math.exp(-dt * 10); this.vel.z *= Math.exp(-dt * 10);
      this.skin.pose('rush', RUSH.dash1 + Math.min(1, this.moveE / 0.5) * (RUSH.end - RUSH.dash1), 0.05);
      if (this.moveE > 0.5) { this.state = 'idle'; this.comboGap = 0; }
      return;
    }
    const k = Math.min(1, this.moveE / R.dur);
    const tc = RUSH.dash0 + (RUSH.dash1 - RUSH.dash0) * k;
    this.skin.pose('rush', tc, 0.04);
    const rate = (RUSH.dash1 - RUSH.dash0) / R.dur, rm = this.skin.rm.rush;
    const f = (rmAt(rm, 'fwd', tc + 0.01) - rmAt(rm, 'fwd', tc - 0.01)) / 0.02 * rate * this.skin.k * R.warp;
    const fw = this.forward(_v);
    this.vel.x = fw.x * f; this.vel.z = fw.z * f;
    for (const t of ctx.targets) {
      if (!t.alive || this.moveHit.has(t)) continue;
      if (distSeg(t.pos, R.from, this.pos) < t.radius + 1.1 * S && Math.abs(t.pos.y - this.pos.y) < 3 * S) {
        this.moveHit.add(t);
        this.hit(t, { dmg: 30, heavy: true, hitstop: 0.1, wound: true, cone: Math.PI, range: 3 }, ctx);
      }
    }
    if (k >= 1) {
      const right = _v2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      this.fx.crescent(_C.copy(this.pos).setY(this.pos.y + 1.2 * S), right, fw, -1.2, 1.2, 0.08, { radius: 3 * S, innerFrac: 0.6, life: 0.3, color: 0xff9a8a });
      this.openZone(R.from, this.pos);
      this.state = 'rushEnd'; this.moveE = 0;
    }
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
      if (t.pos.y - p.y > 3 * S) continue;
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
      if (t.pos.y - this.pos.y > 2.4 * S || this.pos.y - t.pos.y > 3 * S) continue;
      const cosA = d > 0.01 ? (dx * f.x + dz * f.z) / d : 1;
      if (Math.acos(clamp(cosA, -1, 1)) > mv.cone && d > 1.5 * S) continue;
      this.moveHit.add(t);
      this.hit(t, mv, ctx);
    }
  }

  // every hit goes through here: the frenzy and a wound scale it, the frenzy steals life, and it charges the ultimate
  hit(t, mv0, ctx) {
    const K = this.kit, dmg = mv0.dmg * K.dmg * woundMul(t, this.time);
    const mv = { ...mv0, dmg };
    const p = _v.copy(t.pos); p.y += t.height ? t.height * 0.6 : t.radius * 0.6;
    let color = ctx.onHit(t, mv, p, this) ?? 0xbff4ff;
    if (K.raging) { this.hp = Math.min(MAX_HP, this.hp + dmg * KIT.lifesteal * 0.25); color = 0xff6a5a; }
    if (!mv.zone) K.dealt(dmg);
    if (!mv.zone && !mv.gun) K.swordHit();
    if (mv.gun) K.mark('gunHit');
    if (mv.finisher && !mv.zone) K.mark('finisher');
    if (mv.light) this.fx.sparksAt(p, 8, { color: 0xff6a5a, speed: 14, life: 0.35, floor: t.pos.y - 0.5 });
    else {
      this.fx.sparksAt(p, mv.heavy || mv.finisher ? 40 : 22, { color, speed: 18, life: 0.6, floor: t.pos.y - 0.5 });
      this.fx.sparksAt(p, 10, { color: 0xeaffff, speed: 26, life: 0.25, width: 0.05 });
    }
    this.hitstop = Math.max(this.hitstop, mv.hitstop ?? 0.06);
    this.shake = Math.max(this.shake, mv.heavy || mv.finisher ? 0.45 : mv.light ? 0.1 : 0.22);
    if (!mv.light) ctx.haptic?.(mv.heavy ? 'heavy' : 'medium');
  }

  // ---------------- animation ----------------
  animate(dt) {
    if (this.skin) return this.animateSkin(dt);
    const B = this.body, T = B.target, H = this.H;
    const sp = this.speed;
    this.speedNorm += (Math.min(1.6, sp / RUN) - this.speedNorm) * Math.min(1, dt * 10);
    const run = Math.min(1, this.speedNorm);
    let omega = 18, zeta = 0.8, pivot = PIVOT, wantPitch = 0, wantRoll = 0, spin = 0, lift = 0;
    H.snap = false; H.rate = 18; H.force = false; H.w = 1;
    const st = this.state;

    if (st === 'attack') {
      const mv = this.move;
      attackPose(T, mv, this.mv, this.time);
      H.p.copy(this.mv.hand); H.d.copy(this.mv.dir); H.u.copy(this.mv.up);
      H.snap = this.mv.phase !== 'wind'; H.rate = 30;
      omega = this.mv.phase === 'wind' ? 26 : 22; zeta = 0.7;   // snappy with a little follow-through
    } else if (st === 'spin') {
      locoPose(T, 0, 0, this.time);
      T.spine[0] = 0.25; T.drop = -0.15; T.thR[0] = -0.6; T.knR[0] = 0.8; T.knL[0] = 0.6;
      T.shL[0] = -0.2; T.shL[2] = 1.2; T.elL[0] = -0.3;
      H.p.set(-0.62, 1.3, 0.25).multiplyScalar(S); H.d.set(-1, 0.05, 0.35).normalize(); H.u.set(0, 0, 1); H.snap = true; H.force = true;
      omega = 26;
      spin = -Math.PI * 4 * ease.outCubic(Math.min(1, this.moveE / (SPIN_T * 0.8)));
    } else if (st === 'dodge') {
      // dash direction in character space
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw), d = this.dodgeDir;
      dashPose(T, d.x * c - d.z * s, d.x * s + d.z * c, this.time);
      this.swordIdle(H, 1, 1);
      omega = 30; zeta = 0.75;
    } else if (st === 'hit') {
      flinchPose(T, Math.min(1, this.reactT * 3), this.time);
      this.swordIdle(H, 0, 0.6);
      omega = 20; zeta = 0.6;
    } else if (st === 'launched') {
      tumblePose(T, this.time);
      this.swordIdle(H, 0, 0.3);
      wantPitch = -clamp(0.4 + this.tumble * 1.6, 0, 1.25);
      pivot = 1.1 * S; omega = 14; zeta = 0.7;
    } else if (st === 'down' || st === 'dead') {
      const k = st === 'dead' ? 1 : clamp(this.reactT / 0.3, 0, 1);
      downPose(T, Math.max(k, 0.6), this.time);
      this.swordIdle(H, 0, 0);
      wantPitch = -Math.PI / 2 * (st === 'dead' ? 1 : Math.max(0.15, k));
      pivot = 0; lift = 0.28 * S; omega = 12; zeta = 0.85;
    } else if (st === 'getup') {
      getupPose(T, clamp(this.reactT / 0.5, 0, 1), this.time);
      this.swordIdle(H, 0, 0);
      omega = 16;
    } else if (this.guardK > 0.05) {
      guardPose(T, this.time);
      H.p.set(GUARD_HAND.p[0], GUARD_HAND.p[1], GUARD_HAND.p[2]).multiplyScalar(S);
      H.d.set(GUARD_HAND.d[0], GUARD_HAND.d[1], GUARD_HAND.d[2]).normalize();
      H.u.set(GUARD_HAND.u[0], GUARD_HAND.u[1], GUARD_HAND.u[2]);
      H.rate = 30; omega = 26;
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
      H.p.set(-0.33, 1.0, lerp(0.1, -0.22, b)).multiplyScalar(S); H.d.set(-0.15, -0.45, lerp(0.5, -1, b)).normalize(); H.u.set(0, 1, 0);
      H.rate = 10; H.w = this.swordHold > 0 ? 1 : 0;
      if (H.w === 0) { T.shR[0] = lerp(-0.3, 0.45, b); T.shR[2] = -lerp(0.5, 0.25, b); T.elR[0] = lerp(-0.9, -1.3, b); }
      omega = 10; zeta = 0.9;
      // flight lean: pitch into the boost (Iron Man style), bank with sideways acceleration
      const hs = Math.hypot(this.vel.x, this.vel.z);
      const f = this.forward(_v);
      const side = (this.accelX || 0) * f.z - (this.accelZ || 0) * f.x;      // lateral accel (+ = to the left)
      wantPitch = clamp(hs / FLY_TOP, 0, 1) * this.boostK * 1.05 + this.climb * (1 - this.boostK) * 0.05;
      wantRoll = clamp(-side * 0.025, -0.6, 0.6);
    } else {
      if (!this.grounded) airPose(T, this.vel.y);
      else locoPose(T, this.phase, this.speedNorm, this.time);
      if (this.landT > 0) crouchPose(T, Math.min(1, this.landT / 0.2));
      // sword low and forward at idle, trailing behind while running
      this.swordIdle(H, run, this.swordHold > 0 ? 1 : 0);
      // lean into acceleration on foot: forward when speeding up, back when braking, into turns
      if (this.grounded) {
        const f = this.forward(_v);
        const along = (this.accelX || 0) * f.x + (this.accelZ || 0) * f.z;
        const side = (this.accelX || 0) * f.z - (this.accelZ || 0) * f.x;
        this.lean += (clamp(along * 0.012, -0.25, 0.3) - this.lean) * Math.min(1, dt * 8);
        T.spine[0] += this.lean; T.spine[2] += clamp(-side * 0.01, -0.2, 0.2);
      }
      omega = this.grounded ? 18 : 12;
      if (this.landT > 0) { omega = 24; zeta = 0.6; }
    }
    // look at the locked target
    if (this.lock && !REACT.has(st)) {
      const a = angDiff(this.yaw, Math.atan2(this.lock.pos.x - this.pos.x, this.lock.pos.z - this.pos.z));
      T.neck[1] += clamp(a, -0.9, 0.9) * 0.5; T.head[1] += clamp(a, -0.9, 0.9) * 0.3;
    }

    const rate = st === 'launched' ? 6 : st === 'down' || st === 'dead' ? 7 : this.flying ? 4 : 6;
    this.pitch += (wantPitch - this.pitch) * Math.min(1, dt * rate);
    this.roll += (wantRoll - this.roll) * Math.min(1, dt * 3);
    if (!this.flying) this.boostK += (0 - this.boostK) * Math.min(1, dt * 6);

    const burst = this.burstT > 0 ? 1.4 : 0;
    const steer = Math.min(1, Math.abs(this.roll) * 2 + Math.abs(this.pitch - (this.prevPitch ?? this.pitch)) * 40);
    this.prevPitch = this.pitch;
    const want = thrustFor({ boost: this.boostK, climb: this.climb, burst, steer });
    if (st === 'dodge') { want.back = Math.max(want.back, 1.2); want.sh = Math.max(want.sh, 0.9); }
    const lit = this.state === 'attack' || this.state === 'spin' || this.swordHold > 0 || this.guardK > 0.3;
    const swinging = (st === 'attack' && this.mv.phase === 'swing') || st === 'spin';
    B.solve(dt, { pos: this.pos, yaw: this.yaw, pitch: this.pitch, roll: this.roll, pivot, lift: lift * Math.min(1, -this.pitch / 1.2), omega, zeta, H, spin, thr: want, lit, swinging });
  }

  // ---------------- clip-driven animation (skinned frame) ----------------
  animateSkin(dt) {
    const B = this.skin, st = this.state, sp = this.speed;
    const enter = st !== this.prevState;
    this.prevState = st;
    let wantPitch = 0, wantRoll = 0, pivot = PIVOT;
    const cur = B.currentName;
    const done = !B.current || (B.current.loop === THREE.LoopOnce && B.current.time >= B.current.getClip().duration - 1e-3);
    // the gun arm: up on the aim line while a shot is fresh
    const K = this.kit, aiming = K.gun && K.aimT > 0 && st === 'idle' && this.guardK < 0.05;
    this.aimK = (this.aimK || 0) + ((aiming ? 1 : 0) - (this.aimK || 0)) * Math.min(1, dt * (aiming ? 22 : 7));
    if (st === 'rush' || st === 'rushEnd' || st === 'aim') {
      // posed by the rush (updateAim / updateRush)
    } else if (st === 'attack') {
      // the move's clip was started in startAttack; its time follows the move's warp curve
      if (this.move?.warp && cur === this.move.clip) B.scrub(clipTime(this.move, this.moveE));
    } else if (st === 'dodge') {
      // the saber's dash rides the rush clip's lunge; the shotgun's a plain thruster dash
      if (this.dash && !this.dash.gun && B.rm?.rush) B.pose('rush', RUSH.dash0 + (RUSH.dash1 - RUSH.dash0) * Math.min(1, this.moveE / DODGE_T) * 0.8, 0.05);
      else if (enter) B.play('dash', { time: 0.0, fade: 0.05, speed: 2.2, restart: true });
    } else if (st === 'hit') {
      if (enter) B.play(Math.random() < 0.5 ? 'hit' : 'hit2', { time: 0, fade: 0.05, speed: 1.4, restart: true });
    } else if (st === 'launched') {
      if (enter) B.play('big_hit', { time: 0.1, fade: 0.05, speed: 1.3, restart: true });
      else if (cur === 'big_hit' && done) B.play('fall', { fade: 0.25 });
      wantPitch = -clamp(0.2 + this.tumble * 1.2, 0, 0.9);
      pivot = 1.1 * S;
    } else if (st === 'down') {
      if (enter) B.play('knockdown', { time: 0.9, fade: 0.08, speed: 1.6, restart: true });
    } else if (st === 'dead') {
      if (enter) B.play('death', { time: 0.4, fade: 0.1, speed: 1.1, restart: true });
    } else if (st === 'getup') {
      if (enter) B.play('getup', { time: 1.1, fade: 0.1, speed: 3.2, restart: true });
    } else if (this.guardK > 0.05) {
      // behind the Shroud the legs keep walking under the held block
      if (cur === 'block_hit' && !done) { /* the blow plays out */ }
      else if (sp > 0.6 && B.has('block_walk')) B.play('block_walk', { fade: 0.18, speed: clamp(sp / (B.pace('block_walk') || 4.5), 0.5, 1.3) });
      else if (cur !== 'block') B.play('block', { time: 0.7, fade: cur === 'block_walk' ? 0.18 : 0.08, speed: 0, restart: true });
    } else if (this.flying) {
      B.play('fall', { fade: 0.3, speed: 0.8 });
      const hs = Math.hypot(this.vel.x, this.vel.z);
      const f = this.forward(_v);
      const side = (this.accelX || 0) * f.z - (this.accelZ || 0) * f.x;
      wantPitch = clamp(hs / FLY_TOP, 0, 1) * this.boostK * 1.05 + this.climb * (1 - this.boostK) * 0.05;
      wantRoll = clamp(-side * 0.025, -0.6, 0.6);
    } else if (!this.grounded) {
      if (this.vel.y > 1) { if (cur !== 'jump') B.play('jump', { time: 0.35, fade: 0.1, speed: 0.7, restart: true }); }
      else if (cur !== 'fall') B.play('fall', { fade: 0.35, speed: 0.8 });
    } else if (this.landT > 0.12 && (this.landEdge || cur === 'land')) {
      if (this.landEdge) B.play('land', { time: 0.4, fade: 0.06, speed: 2.4, restart: true });
    } else if (sp < 0.6) {
      B.play('idle', { fade: 0.3 });
    } else if (sp < 5) {
      // a heavy walk whose feet keep pace with the ground
      B.play('walk', { fade: 0.25, speed: clamp(sp / (B.pace('walk') || 4.5), 0.5, 1.3) });
    } else if (sp < 12.5) {
      B.play('run', { fade: 0.22, speed: clamp(sp / 14, 0.6, 1.1) });
    } else {
      B.play('sprint', { fade: 0.22, speed: clamp(sp / (B.pace('sprint') || 17), 0.7, 1.2) });
    }
    this.landEdge = false;
    // lean into acceleration on foot
    if (this.grounded && st === 'idle' && this.guardK < 0.05) {
      const f = this.forward(_v);
      const along = (this.accelX || 0) * f.x + (this.accelZ || 0) * f.z;
      this.lean += (clamp(along * 0.01, -0.2, 0.25) - this.lean) * Math.min(1, dt * 8);
    } else this.lean *= Math.max(0, 1 - dt * 8);

    const rate = st === 'launched' ? 6 : this.flying ? 4 : 6;
    this.pitch += (wantPitch - this.pitch) * Math.min(1, dt * rate);
    this.roll += (wantRoll - this.roll) * Math.min(1, dt * 3);
    if (!this.flying) this.boostK += (0 - this.boostK) * Math.min(1, dt * 6);
    const burst = this.burstT > 0 ? 1.4 : 0;
    const steer = Math.min(1, Math.abs(this.roll) * 2 + Math.abs(this.pitch - (this.prevPitch ?? this.pitch)) * 40);
    this.prevPitch = this.pitch;
    const want = thrustFor({ boost: this.boostK, climb: this.climb, burst, steer });
    if (st === 'dodge') { want.back = Math.max(want.back, 1.2); want.sh = Math.max(want.sh, 0.9); }
    const cutDash = st === 'dodge' && this.dash && !this.dash.gun;
    const swinging = (st === 'attack' && this.mv.phase === 'swing') || st === 'rush' || cutDash;
    const lit = (st === 'attack' || st === 'aim' || st === 'rush' || st === 'rushEnd' || cutDash || this.swordHold > 0 || this.guardK > 0.3) && !REACT.has(st) && !K.gun;
    const grounded = this.grounded && !this.flying && (st === 'idle' || st === 'attack' || st === 'aim' || st === 'rushEnd') && !this.move?.air;
    B.solve(dt, { pos: this.pos, yaw: this.yaw, pitch: this.pitch, roll: this.roll, pivot, thr: want, swinging, lit, lean: this.lean, grounded,
      afterPose: this.aimK > 0.01 ? (b) => b.aimGun(this.aimDir, this.aimK, this.recoil) : null });
  }

  // sword low and forward at idle (run = 0), trailing behind while running (run = 1); w = arm IK weight
  swordIdle(H, run, w) {
    H.p.set(-0.27, lerp(1.04, 0.96, run), lerp(0.32, -0.3, run)).multiplyScalar(S);
    H.d.set(lerp(-0.15, 0.15, run), lerp(-0.2, -0.3, run), lerp(1, -1, run)).normalize();
    H.u.set(0, 1, 0);
    H.w = w;
  }

  setVisible(v) {
    this.body.setVisible(v);
    this.fx.setVisible(v);
  }
}
