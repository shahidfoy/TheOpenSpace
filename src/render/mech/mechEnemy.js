import * as THREE from 'three';
import { MechBody, thrustFor } from './mechBody.js';
import { S } from './mechRig.js';
import {
  locoPose, airPose, crouchPose, dashPose, flinchPose, tumblePose, downPose, getupPose, attackPose, evalMove, arcBasis, MOVES, ease,
} from './swordAnim.js';
import { Beam } from './swordFx.js';

// Hostile frames for the lunar arena. They share the player's body, poses and sword arcs (MechBody + swordAnim),
// driven by a small state machine:
//   spawn (drop in on thrusters) → think → approach / strafe / attack (windup glows: orange = parry it, red = dodge)
//   → recover. Struck: hitstun, launched (juggle in the air), slammed, knocked down, getting up, staggered (parried),
//   dead (sparks, collapse, sink).
// Only a couple of enemies attack at once (attack tokens handed out by the arena) so a crowd reads, circles and
// takes turns instead of piling in, but they do gang up on a player stuck in the air.
//
// Types: lancer (sword combos, launcher, aerial follow-up), gunner (keeps its distance, paints you with a red aim
// line then fires a beam; parry the beam to throw it back), brute (bigger, super armour, unblockable overhead and a
// ground shockwave sweep).

export const TYPES = {
  lancer: { hp: 110, speed: 9.5, size: 1, poise: 0, reach: 7, moves: [['e1', 3], ['eL', 1.4], ['eS', 1]], cd: [1.2, 2.4], score: 100 },
  gunner: { hp: 80, speed: 8, size: 0.95, poise: 0, reach: 6, moves: [['e1', 1]], cd: [2.6, 3.6], score: 140, gun: true },
  brute: { hp: 300, speed: 6.5, size: 1.28, poise: 45, reach: 8.5, moves: [['eH', 1.6], ['eS', 1]], cd: [1.6, 2.8], score: 300 },
};
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _C = new THREE.Vector3(), _U = new THREE.Vector3(), _V = new THREE.Vector3();
const _from = new THREE.Vector3(), _to = new THREE.Vector3();
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const clamp = THREE.MathUtils.clamp;
const REACT = new Set(['hit', 'launched', 'down', 'getup', 'stagger', 'dead']);
const TELE_PARRY = 0xff8a1a, TELE_RED = 0xff1a10;

function pickWeighted(list) {
  let t = 0;
  for (const [, w] of list) t += w;
  let x = Math.random() * t;
  for (const [id, w] of list) if ((x -= w) <= 0) return id;
  return list[0][0];
}

export class MechEnemy {
  constructor(scene, fx, type) {
    this.type = type;
    this.cfg = TYPES[type];
    this.fx = fx;
    this.body = new MechBody(scene, fx, { scheme: type, lod: true, size: this.cfg.size });
    this.k = this.body.k;
    this.isEnemy = true;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.mv = { hand: new THREE.Vector3(), dir: new THREE.Vector3(), up: new THREE.Vector3(), phase: '', u: 0, angle: 0 };
    this.H = { p: new THREE.Vector3(), d: new THREE.Vector3(), u: new THREE.Vector3(), w: 1, snap: false, rate: 18, force: false };
    this.aim = new THREE.Vector3();
    this.beam = this.cfg.gun ? new Beam(scene, 0xff2a14) : null;
    this.radius = 1.6 * this.cfg.size;
    this.height = 3.4 * this.cfg.size;
    this.body.setVisible(false);
    this.active = false;
    this.alive = false;
  }

  spawn(x, z, yaw, h, wave = 1) {
    this.active = true; this.alive = true;
    this.maxHp = this.hp = Math.round(this.cfg.hp * (1 + (wave - 1) * 0.12));
    this.pos.set(x, h + 46, z);
    this.vel.set(0, -26, 0);
    this.yaw = yaw;
    this.state = 'spawn';
    this.grounded = false;
    this.t = 0; this.reactT = 0; this.cd = 1 + Math.random() * 1.5;
    this.move = null; this.moveE = 0; this.hitDone = false;
    this.pitch = 0; this.tumble = 0;
    this.phase = 0; this.speedNorm = 0; this.speed = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1; this.strafeT = 0;
    this.poise = this.cfg.poise;
    this.token = false;
    this.deadT = 0;
    this.juggleT = 0;
    this.gunPhase = null;
    this.comboLeft = 0;
    this.body.setVisible(true);
    this.body.snapPose();
    this.burst = 1;
    this.lastHitBy = 0;
  }

  despawn() {
    this.active = false; this.alive = false;
    this.body.setVisible(false);
    this.beam?.hide();
    this.token = false;
  }

  get telegraph() {
    if (this.state === 'attack' && this.mv.phase === 'wind') return this.move.unblockable ? 'red' : 'parry';
    if (this.gunPhase === 'aim' || this.gunPhase === 'lock') return 'parry';
    return null;
  }

  forward(out = _v) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  flatWorld(local, out) { return out.copy(local).applyAxisAngle(UP, this.yaw).add(this.pos); }
  flatDir(local, out) { return out.copy(local).applyAxisAngle(UP, this.yaw); }
  face(p, dt, rate) { this.yaw += angDiff(this.yaw, Math.atan2(p.x - this.pos.x, p.z - this.pos.z)) * Math.min(1, dt * rate); }

  // ctx: { player, g, height, center, R, fx, tokens: { free, take(e), give(e) }, others, onHitPlayer(e, mv, kind), puff, time }
  update(dt, ctx) {
    if (!this.active) return;
    this.t += dt;
    const P = ctx.player;
    const g = ctx.g;
    const dx = P.pos.x - this.pos.x, dz = P.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    this.dist = dist;
    let wantVX = 0, wantVZ = 0, ctl = 8;

    if (this.state === 'dead') {
      this.deadT += dt;
      this.vel.x *= Math.exp(-dt * 3); this.vel.z *= Math.exp(-dt * 3);
      if (this.deadT > 2.2) this.pos.y -= dt * 2.5;            // sink into the regolith
      if (this.deadT > 4) this.despawn();
    } else if (this.state === 'spawn') {
      this.face(P.pos, dt, 4);
      this.vel.y = Math.max(this.vel.y, -26);
    } else if (REACT.has(this.state)) {
      this.updateReaction(dt, ctx);
    } else if (this.state === 'attack') {
      this.updateAttack(dt, ctx, dist);
    } else if (this.state === 'gun') {
      this.updateGun(dt, ctx, dist);
    } else if (this.state === 'dash') {
      this.moveE += dt;
      if (this.moveE > 0.3) this.state = 'idle';
    } else {
      // ---- think ----
      this.cd -= dt;
      this.strafeT -= dt;
      if (this.strafeT <= 0) { this.strafeT = 1.5 + Math.random() * 2.5; if (Math.random() < 0.5) this.strafeDir *= -1; }
      const cfg = this.cfg;
      const pAir = P.alt > 3 && P.alive;
      const want = cfg.gun ? 22 : cfg.reach + 3;
      const canAttack = this.cd <= 0 && P.alive && (this.token || ctx.tokens.take(this));
      if (cfg.gun) {
        if (dist < 7 && canAttack) this.startAttack('e1', ctx);
        else if (dist < 9 && this.cd < 1 && this.grounded && Math.random() < dt * 1.5) this.dashAway(P);
        else if (canAttack && dist < 48) this.startGun(ctx);
      } else if (pAir && this.type === 'lancer' && dist < 13 && canAttack) {
        this.startAttack('eA', ctx);                 // jump after a player stuck in the air
      } else if (dist < cfg.reach && canAttack) {
        const id = pickWeighted(cfg.moves);
        this.comboLeft = id === 'e1' && Math.random() < 0.6 ? 1 : 0;
        this.startAttack(id, ctx);
      }
      if (this.state === 'idle' || this.state === undefined) {
        this.state = 'idle';
        // approach to a ring around the player, then circle it; the attacker closes in, the rest hang back
        const ring = this.token ? cfg.reach * 0.7 : want + (cfg.gun ? 0 : 4);
        const toward = (dist - ring);
        const nx = dist > 0.01 ? dx / dist : 0, nz = dist > 0.01 ? dz / dist : 1;
        const sp = cfg.speed * (dist > 25 && !cfg.gun ? 1.4 : 1);
        const radial = clamp(toward * 0.6, -1, 1);
        const tang = Math.abs(toward) < 6 ? this.strafeDir * 0.55 : 0;
        wantVX = (nx * radial + -nz * tang) * sp;
        wantVZ = (nz * radial + nx * tang) * sp;
        // keep out of each other's way
        for (const o of ctx.others) {
          if (o === this || !o.active || o.state === 'dead') continue;
          const ox = this.pos.x - o.pos.x, oz = this.pos.z - o.pos.z, od = Math.hypot(ox, oz);
          if (od < 7 && od > 0.01) { wantVX += ox / od * (7 - od) * 1.2; wantVZ += oz / od * (7 - od) * 1.2; }
        }
        this.face(P.pos, dt, 6);
        ctl = this.grounded ? 6 : 1;
      }
      if (!canAttack && this.token && this.cd > 0.5) ctx.tokens.give(this);
    }

    if (this.state === 'idle') {
      const k = 1 - Math.exp(-ctl * dt);
      this.vel.x += (wantVX - this.vel.x) * k;
      this.vel.z += (wantVZ - this.vel.z) * k;
    }

    // ---- vertical ----
    const hang = (this.state === 'attack' && this.move?.air && !this.move.slamDive) || (this.juggleT > 0 && this.state === 'launched');
    if (this.juggleT > 0) this.juggleT -= dt;
    if (hang) { this.vel.y -= g * 0.25 * dt; this.vel.y *= Math.exp(-3 * dt); }
    else if (this.state === 'spawn') this.vel.y -= g * 0.2 * dt;
    else if (this.state === 'dead' && this.deadT > 2.2) this.vel.y = 0;
    else this.vel.y -= g * dt;
    this.pos.addScaledVector(this.vel, dt);
    const h = ctx.height(this.pos.x, this.pos.z);
    if (this.state === 'dead' && this.deadT > 2.2) { /* sinking: ignore the ground */ }
    else if (this.pos.y <= h) {
      if (!this.grounded) this.land(this.vel.y, ctx);
      this.pos.y = h; this.vel.y = Math.max(0, this.vel.y); this.grounded = this.vel.y <= 0.01;
    } else if (this.grounded && this.pos.y - h < 0.6 && this.vel.y <= 0) this.pos.y = h;
    else this.grounded = false;
    // arena wall
    const cx = this.pos.x - ctx.center.x, cz = this.pos.z - ctx.center.z, r = Math.hypot(cx, cz), R = ctx.R - 2;
    if (r > R) { this.pos.x = ctx.center.x + cx * R / r; this.pos.z = ctx.center.z + cz * R / r; }
    // body separation from the player (no walking through each other)
    if (this.state !== 'dead' && P.alive) {
      const ox = this.pos.x - P.pos.x, oz = this.pos.z - P.pos.z, od = Math.hypot(ox, oz), min = this.radius + P.radius;
      if (od < min && od > 0.01 && Math.abs(this.pos.y - P.pos.y) < 4) {
        const push = (min - od) * 0.5;
        this.pos.x += ox / od * push; this.pos.z += oz / od * push;
        P.pos.x -= ox / od * push; P.pos.z -= oz / od * push;
      }
    }
    this.alt = this.pos.y - h;
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    if (this.grounded && this.speed > 1 && this.state === 'idle') this.phase += dt * (this.speed * 1.45 / this.k + 1.6);
    this.animate(dt, ctx);
  }

  land(vy, ctx) {
    if (this.state === 'spawn') {
      this.state = 'idle';
      ctx.puff?.(this.pos, 1.6);
      this.fx.ring(_v.copy(this.pos).setY(this.pos.y + 0.3), 8, { color: this.body.slashColor, life: 0.5 });
      this.fx.sparksAt(_v.copy(this.pos).setY(this.pos.y + 0.4), 20, { color: 0xffa060, speed: 14, dir: UP, spread: 1.6, floor: this.pos.y });
      this.landT = 0.35;
      return;
    }
    if (this.state === 'launched') {
      this.state = 'down'; this.reactT = 1.1;
      ctx.puff?.(this.pos, 1.3);
      this.fx.sparksAt(_v.copy(this.pos).setY(this.pos.y + 0.5), 14, { color: 0xffa060, speed: 10, dir: UP, spread: 1.4, floor: this.pos.y });
    }
    if (this.state === 'attack' && this.move?.air) {
      if (this.move.slam) this.shock(ctx, this.pos, 3 * this.k, this.move);
      this.endAttack(ctx);
    }
    if (vy < -8) this.landT = 0.3;
  }

  // ---------------- attacking ----------------
  startAttack(id, ctx) {
    this.move = MOVES[id];
    this.moveE = 0;
    this.hitDone = false;
    this.slashed = false;
    this.shocked = false;
    this.state = 'attack';
    if (this.move.air) {
      // leap up to the player first (aerial follow-up)
      const P = ctx.player;
      const up = clamp(P.pos.y - this.pos.y + 2, 4, 14);
      this.vel.y = Math.sqrt(2 * ctx.g * up);
      this.grounded = false;
      this.burst = 1;
    }
  }

  endAttack(ctx) {
    this.state = 'idle';
    this.move = null;
    if (this.comboLeft > 0 && this.dist < this.cfg.reach + 1 && ctx.player.alive) {
      this.comboLeft--;
      this.startAttack('e2', ctx);
      return;
    }
    const [a, b] = this.cfg.cd;
    this.cd = a + Math.random() * (b - a);
    ctx.tokens.give(this);
  }

  updateAttack(dt, ctx, dist) {
    const mv = this.move, P = ctx.player;
    this.moveE += dt;
    const s = evalMove(mv, this.moveE, this.k, this.mv);
    const [tw, ts] = mv.t;
    if (this.moveE < tw * 0.85) this.face(P.pos, dt, 10);          // tracks you until the very end of the windup
    if (mv.air) {
      const dx = P.pos.x - this.pos.x, dz = P.pos.z - this.pos.z;
      this.vel.x = dx * 2.2; this.vel.z = dz * 2.2;
      if (s.phase === 'swing') this.vel.y = Math.min(this.vel.y, 2);
    } else if (this.moveE > tw * 0.6 && this.moveE < tw + ts * 0.5) {
      const stop = mv.range * this.k * 0.5 + P.radius;
      const want = clamp((dist - stop) * 9, 0, 34) * (mv.lunge / 2.4);
      const f = this.forward(_v);
      this.vel.x = f.x * want; this.vel.z = f.z * want;
    } else { this.vel.x *= Math.exp(-dt * 10); this.vel.z *= Math.exp(-dt * 10); }
    if (s.phase === 'swing' && !this.slashed) {
      this.slashed = true;
      arcBasis(mv, _U, _V); this.flatDir(_U, _U); this.flatDir(_V, _V);
      this.flatWorld(_v.set(mv.c[0], mv.c[1], mv.c[2]).multiplyScalar(this.k), _C);
      this.fx.crescent(_C, _U, _V, mv.a0, mv.a1, ts * 1.1, { radius: 1.75 * this.k * (mv.heavy ? 1.2 : 1), innerFrac: 0.42, life: 0.26, color: this.body.slashColor });
    }
    if (!this.hitDone && (s.phase === 'swing' || (s.phase === 'recover' && this.moveE < tw + ts + 0.04)) && P.alive) {
      const dx = P.pos.x - this.pos.x, dz = P.pos.z - this.pos.z, d = Math.hypot(dx, dz);
      const f = this.forward(_v);
      const cosA = d > 0.01 ? (dx * f.x + dz * f.z) / d : 1;
      const dy = P.pos.y - this.pos.y;
      if (d < mv.range * this.k + P.radius && Math.acos(clamp(cosA, -1, 1)) < mv.cone + 0.2 && dy < 2.6 * this.k && dy > -3 * this.k) {
        this.hitDone = true;
        ctx.onHitPlayer(this, mv, mv.launch ? 'launch' : mv.slam ? 'slam' : mv.heavy ? 'heavy' : 'light');
      }
    }
    if (s.phase === 'recover' && mv.shock && !this.shocked) {
      this.shocked = true;
      const p = this.forward(_v).multiplyScalar(1.8 * this.k).add(this.pos);
      p.y = ctx.height(p.x, p.z);
      this.shock(ctx, p, mv.shock * this.k, mv);
    }
    if (this.state === 'attack' && this.moveE >= tw + ts + mv.t[2] && (this.grounded || !mv.air)) this.endAttack(ctx);
  }

  // ground shockwave: hits a grounded player inside the ring (jump or dodge it)
  shock(ctx, p, r, mv) {
    this.fx.ring(_v.copy(p).setY(p.y + 0.3), r, { color: this.body.slashColor, life: 0.5 });
    this.fx.sparksAt(_v.copy(p).setY(p.y + 0.5), 26, { color: 0xffa060, speed: 16, dir: UP, spread: 1.6, floor: p.y });
    ctx.puff?.(p, 1.5);
    const P = ctx.player;
    if (!this.hitDone && P.alive && P.alt < 1.5 && Math.hypot(P.pos.x - p.x, P.pos.z - p.z) < r + P.radius) {
      this.hitDone = true;
      ctx.onHitPlayer(this, { ...mv, dmg: mv.dmg * 0.7, unblockable: true }, 'heavy');
    }
  }

  // ---------------- gunner beam ----------------
  startGun() {
    this.state = 'gun';
    this.gunPhase = 'aim';
    this.moveE = 0;
    this.hitDone = false;
    this.aim.copy(this.pos);
  }

  muzzle(out) {
    // the left forearm is the cannon: fire from in front of the chest
    return this.flatWorld(out.set(0.25 * this.k, 1.45 * this.k, 0.6 * this.k), out);
  }

  updateGun(dt, ctx, dist) {
    const P = ctx.player;
    this.moveE += dt;
    this.vel.x *= Math.exp(-dt * 8); this.vel.z *= Math.exp(-dt * 8);
    const AIM = 1.05, LOCK = 0.28, FIRE = 0.32;
    const target = _to.copy(P.pos); target.y += 1.4 * S;
    if (this.gunPhase === 'aim') {
      // the aim line trails the player: keep moving and it misses
      this.aim.lerp(target, 1 - Math.exp(-dt * 5));
      this.face(this.aim, dt, 12);
      if (this.moveE > AIM) { this.gunPhase = 'lock'; this.moveE = 0; }
    } else if (this.gunPhase === 'lock') {
      if (this.moveE > LOCK) { this.gunPhase = 'fire'; this.moveE = 0; ctx.shake?.(0.15); }
    } else if (this.gunPhase === 'fire') {
      if (!this.hitDone && P.alive) {
        // beam: a long segment from the muzzle through the aim point
        this.muzzle(_from);
        const dir = _v.subVectors(this.aim, _from).normalize();
        const rel = _v2.subVectors(target, _from);
        const t = rel.dot(dir);
        const miss = rel.addScaledVector(dir, -t).length();
        if (t > 0 && t < 90 && miss < 1.3 + P.radius * 0.6) {
          this.hitDone = true;
          const res = ctx.onHitPlayer(this, { dmg: 13, hitstop: 0.06, heavy: true, beam: true }, 'beam');
          if (res === 'parry') {
            // thrown back down the line
            this.reflected = true;
            ctx.hitEnemy?.(this, { dmg: 40, hitstop: 0.12, heavy: true }, this.pos.clone().setY(this.pos.y + 2 * this.k));
          }
        }
      }
      if (this.moveE > FIRE) { this.gunPhase = null; this.beam.hide(); this.endAttack(ctx); }
    }
    this.drawBeam(ctx.time);
  }

  drawBeam(t) {
    if (!this.beam) return;
    if (this.state !== 'gun' || !this.gunPhase) { this.beam.hide(); return; }
    this.muzzle(_from);
    const dir = _v.subVectors(this.aim, _from);
    const len = dir.length();
    _to.copy(_from).addScaledVector(dir, 95 / Math.max(1, len));
    // aim line: thick enough to read across the arena (like a sniper's laser), flashing hot just before it fires
    if (this.gunPhase === 'aim') this.beam.set(_from, _to, 0.22, 0.6 + 0.25 * Math.sin(t * 30), 0.2, t);
    else if (this.gunPhase === 'lock') this.beam.set(_from, _to, 0.34, 1, 0.6 + 0.4 * Math.sin(t * 60), t);
    else this.beam.set(_from, _to, 1.6 * (1 - this.moveE / 0.4) + 0.4, 1, 1, t);
  }

  dashAway(P) {
    this.state = 'dash';
    this.moveE = 0;
    const dx = this.pos.x - P.pos.x, dz = this.pos.z - P.pos.z, d = Math.hypot(dx, dz) || 1;
    const side = Math.random() < 0.5 ? -1 : 1;
    this.vel.x = (dx / d * 0.8 + -dz / d * 0.6 * side) * 24; this.vel.z = (dz / d * 0.8 + dx / d * 0.6 * side) * 24;
    this.burst = 1;
  }

  // ---------------- getting hit ----------------
  // mv from the player's move; returns the spark colour
  receiveHit(mv, attacker, ctx) {
    if (!this.alive) return 0xffa060;
    this.hp -= mv.dmg;
    this.lastHitBy = ctx.time;
    this.body.hitFlash(1);
    const dx = this.pos.x - attacker.pos.x, dz = this.pos.z - attacker.pos.z, d = Math.hypot(dx, dz) || 1;
    const nx = dx / d, nz = dz / d;
    const lz = -(nx * Math.sin(this.yaw) + nz * Math.cos(this.yaw));
    const lx = -(nx * Math.cos(this.yaw) - nz * Math.sin(this.yaw));
    this.body.recoil(lx, lz, mv.heavy || mv.finisher ? 1.4 : 0.9);
    if (this.gunPhase) { this.gunPhase = null; this.beam?.hide(); }
    if (this.hp <= 0) { this.die(nx, nz, mv, ctx); return 0xffa060; }
    const airborne = !this.grounded && this.alt > 0.8;
    // super armour: a brute shrugs off light hits until its poise breaks (heavy hits and parries break it fast)
    if (this.cfg.poise > 0 && this.state !== 'stagger' && !airborne) {
      this.poise -= mv.dmg * (mv.heavy || mv.launch ? 1.6 : 1);
      if (this.poise > 0) { this.vel.x += nx * 1.5; this.vel.z += nz * 1.5; return 0xffd060; }
      this.poise = this.cfg.poise;
      this.stagger(1.4);
      return 0xffd060;
    }
    if (this.token) { ctx.tokens.give(this); this.cd = Math.max(this.cd, 0.8); }
    this.move = null;
    if (mv.launch) {
      this.state = 'launched'; this.grounded = false; this.pos.y += 0.1;
      this.vel.set(nx * 1.5, Math.sqrt(2 * ctx.g * 6.2), nz * 1.5);
      this.tumble = 0; this.juggleT = 0;
    } else if (airborne && (mv.slam || mv.plunge)) {
      this.state = 'launched'; this.vel.set(nx * 5, -30, nz * 5); this.juggleT = 0;
    } else if (airborne) {
      // juggle: each hit keeps it afloat a little longer
      this.state = 'launched';
      this.vel.set(nx * 2, Math.max(this.vel.y, 2.6), nz * 2);
      this.juggleT = 0.45;
    } else if (mv.heavy || mv.finisher || mv.spin) {
      this.state = 'hit'; this.reactT = 0.65;
      this.vel.x = nx * 15; this.vel.z = nz * 15;
    } else {
      this.state = 'hit'; this.reactT = 0.38;
      this.vel.x = nx * 4; this.vel.z = nz * 4;
    }
    return mv.heavy ? 0xffc070 : 0xff9a5a;
  }

  stagger(t = 1.3) {
    this.state = 'stagger'; this.reactT = t;
    this.move = null; this.gunPhase = null; this.beam?.hide();
    this.vel.x *= 0.2; this.vel.z *= 0.2;
    this.body.hitFlash(0.6);
  }

  parried(ctx) {
    if (this.token) ctx.tokens.give(this);
    this.cd = 1.5;
    this.poise = 0;
    this.stagger(1.5);
  }

  die(nx, nz, mv, ctx) {
    this.alive = false;
    this.state = 'dead';
    this.deadT = 0;
    this.move = null;
    if (this.token) ctx.tokens.give(this);
    this.vel.set(nx * (mv.heavy ? 14 : 7), this.grounded ? 5 : Math.max(this.vel.y, 2), nz * (mv.heavy ? 14 : 7));
    this.grounded = false;
    const p = _v.copy(this.pos); p.y += 1.6 * this.k;
    this.fx.sparksAt(p, 70, { color: 0xff8a3a, speed: 24, life: 1.0, floor: this.pos.y });
    this.fx.sparksAt(p, 20, { color: 0xfff0c0, speed: 34, life: 0.35, width: 0.05 });
    this.fx.ring(_v2.copy(this.pos).setY(this.pos.y + 0.5), 10 * this.cfg.size, { color: 0xff6a2a, life: 0.6 });
    ctx.puff?.(this.pos, 2);
    ctx.onKill?.(this);
  }

  updateReaction(dt, ctx) {
    this.reactT -= dt;
    const fr = Math.exp(-dt * (this.grounded ? 7 : 0.5));
    this.vel.x *= fr; this.vel.z *= fr;
    if (this.state === 'hit') { if (this.reactT <= 0) this.state = 'idle'; }
    else if (this.state === 'stagger') { if (this.reactT <= 0) this.state = 'idle'; }
    else if (this.state === 'launched') { this.tumble += dt; }
    else if (this.state === 'down') { if (this.reactT <= 0) { this.state = 'getup'; this.reactT = 0.55; } }
    else if (this.state === 'getup') { if (this.reactT <= 0) { this.state = 'idle'; this.cd = Math.min(this.cd, 0.6); } }
  }

  // ---------------- animation ----------------
  animate(dt, ctx) {
    const B = this.body, T = B.target, H = this.H, k = this.k, st = this.state;
    this.speedNorm += (Math.min(1.6, this.speed / 8) - this.speedNorm) * Math.min(1, dt * 10);
    let omega = 18, zeta = 0.8, pivot = 0, wantPitch = 0, lift = 0;
    H.snap = false; H.rate = 18; H.w = 1; H.force = false;
    let tint = 0, tintHex = TELE_PARRY;
    const idleHand = (w) => { H.p.set(-0.27, 1.04, 0.32).multiplyScalar(k); H.d.set(-0.15, -0.2, 1).normalize(); H.u.set(0, 1, 0); H.w = w; };
    if (st === 'attack') {
      attackPose(T, this.move, this.mv, this.t);
      H.p.copy(this.mv.hand); H.d.copy(this.mv.dir); H.u.copy(this.mv.up);
      H.snap = this.mv.phase !== 'wind'; H.rate = this.mv.phase === 'wind' ? 12 : 30;
      omega = this.mv.phase === 'wind' ? 14 : 22; zeta = 0.7;
      if (this.mv.phase === 'wind') {
        const e = this.moveE / this.move.t[0];
        tint = 0.25 + 0.75 * e * e; tintHex = this.move.unblockable ? TELE_RED : TELE_PARRY;
      }
    } else if (st === 'gun') {
      locoPose(T, 0, 0, this.t);
      // cannon arm up and level, braced stance
      T.shL[0] = -1.45; T.shL[2] = 0.05; T.elL[0] = -0.1; T.chest[1] = 0.35; T.spine[1] = 0.2; T.hips[1] = 0.1;
      T.thR[0] = 0.3; T.knR[0] = 0.5; T.thL[0] = -0.3; T.knL[0] = 0.5; T.drop = -0.12;
      idleHand(0.6);
      omega = 20;
      if (this.gunPhase === 'aim') { tint = 0.3 + 0.4 * (this.moveE / 1.05); tintHex = TELE_PARRY; }
      else if (this.gunPhase === 'lock') { tint = 1; tintHex = TELE_PARRY; }
    } else if (st === 'dash') {
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw), vx = this.vel.x, vz = this.vel.z, l = Math.hypot(vx, vz) || 1;
      dashPose(T, (vx * c - vz * s) / l, (vx * s + vz * c) / l, this.t);
      idleHand(1); omega = 28;
    } else if (st === 'hit' || st === 'stagger') {
      flinchPose(T, st === 'stagger' ? 1 : Math.min(1, this.reactT * 3), this.t);
      if (st === 'stagger') { T.spine[0] = -0.5 + Math.sin(this.t * 9) * 0.08; T.shR[2] = -0.9; T.shL[2] = 0.9; T.drop = -0.2; }
      idleHand(st === 'stagger' ? 0 : 0.5);
      omega = 18; zeta = 0.55;
    } else if (st === 'launched') {
      tumblePose(T, this.t);
      idleHand(0);
      wantPitch = -clamp(0.4 + this.tumble * 1.5, 0, 1.2);
      pivot = 1.1 * k; omega = 14; zeta = 0.65;
    } else if (st === 'down' || st === 'dead') {
      downPose(T, 1, this.t);
      idleHand(0);
      wantPitch = -Math.PI / 2;
      lift = 0.28 * k; omega = 12;
      if (st === 'dead') { T.spine[0] = 0.1; T.neck[0] = -0.4; }
    } else if (st === 'getup') {
      getupPose(T, clamp(this.reactT / 0.55, 0, 1), this.t);
      idleHand(0);
    } else if (st === 'spawn') {
      airPose(T, -2); T.thL[0] = -0.3; T.knL[0] = 0.6; T.thR[0] = 0.1; T.knR[0] = 0.4;
      idleHand(0);
    } else {
      if (!this.grounded) airPose(T, this.vel.y);
      else locoPose(T, this.phase, this.speedNorm, this.t);
      if (this.landT > 0) { this.landT -= dt; crouchPose(T, Math.min(1, this.landT / 0.2)); }
      idleHand(1);
      // guard up while circling
      if (this.dist < 14 && this.grounded) { T.shL[0] -= 0.3; T.elL[0] -= 0.3; }
    }
    const rate = st === 'down' || st === 'dead' ? 7 : 6;
    this.pitch += (wantPitch - this.pitch) * Math.min(1, dt * rate);
    B.setTint(tintHex, tint);
    this.burst = Math.max(0, this.burst - dt * 2.5);
    const climb = st === 'spawn' ? 1 : 0;
    const want = thrustFor({ boost: st === 'dash' ? 1 : 0, climb, burst: this.burst * 1.3 });
    const lit = st === 'attack' || st === 'idle' && this.dist < 18 || st === 'dash' || st === 'gun';
    const swinging = st === 'attack' && this.mv.phase === 'swing';
    B.solve(dt, { pos: this.pos, yaw: this.yaw, pitch: this.pitch, roll: 0, pivot, lift: lift * Math.min(1, -this.pitch / 1.2), omega, zeta, H, thr: want, lit, swinging });
  }
}
