import * as THREE from 'three';

// Sparring bots: the foes of the training sim's battle areas, for the characters on foot. Each area (a rectangle on
// the ground) keeps a squad that wakes when you step in: the bots close in, wind up (their visor and baton turn red)
// and strike. Block the blow, dash through it, or take it. Cut them all down and a bigger wave follows.
// A bot is a sword target like the practice dummies: { pos, radius, height, alive, hit(dmg, dir, mv) }, and it reads
// the kit's slow (slowUntil) against the fighter's clock.

const _v = new THREE.Vector3(), _d = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const AMBER = new THREE.Color(0xffa030), RED = new THREE.Color(0xff2a20);
const SPEED = 3.3, REACH = 1.75, WIND = 0.55, HP = 70;

function makeBot() {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a4048, metalness: 0.8, roughness: 0.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1e23, metalness: 0.5, roughness: 0.6 });
  const glow = new THREE.MeshStandardMaterial({ color: 0x140a02, emissive: AMBER.clone(), emissiveIntensity: 2.2 });
  const add = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
  for (const s of [-1, 1]) { add(new THREE.CapsuleGeometry(0.09, 0.62, 4, 8), dark, s * 0.14, 0.42, 0); add(new THREE.BoxGeometry(0.16, 0.08, 0.3), steel, s * 0.14, 0.04, 0.05); }
  add(new THREE.CapsuleGeometry(0.2, 0.42, 6, 12), steel, 0, 1.18, 0);                       // torso
  add(new THREE.BoxGeometry(0.5, 0.16, 0.26), dark, 0, 1.47, 0);                              // shoulders
  add(new THREE.SphereGeometry(0.15, 14, 10), steel, 0, 1.72, 0);                             // head
  add(new THREE.BoxGeometry(0.22, 0.05, 0.06), glow, 0, 1.74, 0.13);                          // visor
  add(new THREE.BoxGeometry(0.1, 0.1, 0.03), glow, 0, 1.22, 0.2);                             // chest lamp
  add(new THREE.CapsuleGeometry(0.06, 0.5, 4, 8), dark, 0.31, 1.15, 0);                       // off arm
  // the baton arm swings from the shoulder
  const arm = new THREE.Group(); arm.position.set(-0.31, 1.45, 0); g.add(arm);
  add(new THREE.CapsuleGeometry(0.06, 0.5, 4, 8), dark, 0, -0.3, 0, arm);
  add(new THREE.CylinderGeometry(0.025, 0.03, 0.8, 8), glow, 0, -0.62, 0.36, arm).rotation.x = Math.PI / 2;
  g.userData = { arm, glow };
  return g;
}

export class SparBots {
  // zones: [{ name, rect: [x0, x1, z0, z1], count, max }]; onWave(zone, n) announces a wave
  constructor(scene, fx, zones, onWave) {
    this.fx = fx; this.onWave = onWave;
    this.zones = zones.map((z) => ({ ...z, wave: 1, restT: 0, bots: [], active: false }));
    this.targets = [];
    for (const Z of this.zones) {
      for (let i = 0; i < Z.max; i++) {
        const group = makeBot(); scene.add(group);
        const b = { zone: Z, group, pos: group.position, radius: 0.4, height: 1.9, alive: false, hp: HP, state: 'chase', t: 0, cd: 0, yaw: 0, vel: new THREE.Vector3(), grow: 1 };
        b.hit = (dmg, dir, mv) => this.damage(b, dmg, dir, mv);
        group.visible = false;
        Z.bots.push(b); this.targets.push(b);
      }
      this.spawn(Z, null);
    }
  }

  // stand a wave up, spread over the area and away from the player
  spawn(Z, P) {
    const [x0, x1, z0, z1] = Z.rect, n = Math.min(Z.max, Z.count + Z.wave - 1);
    Z.bots.forEach((b, i) => {
      b.alive = i < n; b.group.visible = b.alive;
      if (!b.alive) return;
      let x = 0, z = 0;
      for (let k = 0; k < 12; k++) {
        x = x0 + 1 + Math.random() * (x1 - x0 - 2); z = z0 + 1 + Math.random() * (z1 - z0 - 2);
        if (!P || Math.hypot(x - P.pos.x, z - P.pos.z) > 6) break;
      }
      // the first squad waits in a tidy rank along the far end
      if (!P) { const long = z1 - z0 > x1 - x0, k = (i + 0.5) / n; x = long ? (x0 + x1) / 2 + (i % 2 ? 1 : -1) : x0 + (x1 - x0) * k; z = long ? z0 + 3 + (z1 - z0 - 8) * k : z0 + 3; }
      b.pos.set(x, 0, z); b.hp = HP; b.state = 'chase'; b.t = 0; b.cd = 0.6 + Math.random(); b.vel.set(0, 0, 0); b.grow = P ? 0 : 1;
      b.slowUntil = 0; b.woundUntil = 0;
      b.yaw = Math.PI;
    });
  }

  damage(b, dmg, dir, mv) {
    if (!b.alive) return;
    b.hp -= dmg;
    b.state = 'stagger'; b.t = 0;
    b.vel.copy(dir).setY(0).multiplyScalar(mv?.heavy || mv?.finisher ? 7 : mv?.light ? 1.2 : 3.5);
    if (b.hp > 0) return;
    b.alive = false; b.group.visible = false;
    _v.copy(b.pos).setY(1.1);
    this.fx.sparksAt(_v, 40, { color: 0xffa030, speed: 9, life: 0.7, width: 0.035, floor: 0 });
    this.fx.ring(_v.copy(b.pos).setY(0.1), 2, { color: 0xffa030, life: 0.4 });
  }

  // P: the Parkour controller; sword: the HumanSword (its clock times the slow, its takeHit answers a blow)
  update(dt, P, sword, enabled) {
    for (const Z of this.zones) {
      const [x0, x1, z0, z1] = Z.rect;
      const inside = enabled && P.pos.x > x0 - 0.5 && P.pos.x < x1 + 0.5 && P.pos.z > z0 - 0.5 && P.pos.z < z1 + 0.5 && P.pos.y < 3;
      if (inside && !Z.active) this.onWave?.(Z, Z.wave);
      Z.active = inside;
      let alive = 0;
      for (const b of Z.bots) {
        if (!b.alive) continue;
        alive++;
        if (b.grow < 1) { b.grow = Math.min(1, b.grow + dt * 2.5); b.group.scale.setScalar(Math.max(0.01, b.grow)); }
        const ud = b.group.userData;
        const dx = P.pos.x - b.pos.x, dz = P.pos.z - b.pos.z, d = Math.hypot(dx, dz) || 1;
        b.t += dt; b.cd -= dt;
        let wind = 0;
        if (b.state === 'stagger') {
          b.pos.addScaledVector(b.vel, dt); b.vel.multiplyScalar(Math.exp(-dt * 7));
          if (b.t > 0.4) { b.state = 'chase'; b.t = 0; b.cd = Math.max(b.cd, 0.5); }
        } else if (!inside) {
          b.state = 'chase';                                   // stand down
        } else if (b.state === 'chase') {
          const slow = b.slowUntil > sword.now ? 0.45 : 1;
          if (d > REACH - 0.25) { b.pos.x += dx / d * SPEED * slow * dt; b.pos.z += dz / d * SPEED * slow * dt; }
          else if (b.cd <= 0) { b.state = 'wind'; b.t = 0; }
        } else if (b.state === 'wind') {
          wind = Math.min(1, b.t / WIND);
          if (b.t >= WIND) {
            b.state = 'recover'; b.t = 0; b.cd = 1.3 + Math.random() * 0.9;
            if (d < REACH + 0.6 && Math.abs(P.pos.y - b.pos.y) < 1.6) {
              const res = sword.takeHit(b.pos, P);
              _v.copy(P.pos).setY(P.pos.y + 1.1).addScaledVector(_d.set(-dx / d, 0, -dz / d), 0.4);
              this.fx.sparksAt(_v, res === 'hit' ? 16 : 22, { color: res === 'hit' ? 0xff4a3a : 0xbfe8ff, speed: 8, life: 0.35, width: 0.03 });
            }
          }
        } else if (b.state === 'recover') {
          wind = Math.max(0, 1 - b.t / 0.25) * -0.6;           // the swing follows through
          if (b.t > 0.5) { b.state = 'chase'; b.t = 0; }
        }
        // keep apart from each other, and inside the area
        for (const o of Z.bots) {
          if (o === b || !o.alive) continue;
          const ox = b.pos.x - o.pos.x, oz = b.pos.z - o.pos.z, od = Math.hypot(ox, oz);
          if (od < 0.95 && od > 1e-3) { b.pos.x += ox / od * (0.95 - od) * 0.5; b.pos.z += oz / od * (0.95 - od) * 0.5; }
        }
        b.pos.x = Math.max(x0 + 0.5, Math.min(x1 - 0.5, b.pos.x)); b.pos.z = Math.max(z0 + 0.5, Math.min(z1 - 0.5, b.pos.z));
        // face the player; the baton comes up through the windup and down on the strike
        if (inside) { const want = Math.atan2(dx, dz); b.yaw += Math.atan2(Math.sin(want - b.yaw), Math.cos(want - b.yaw)) * Math.min(1, dt * 9); }
        b.group.rotation.y = b.yaw;
        ud.arm.rotation.x = wind > 0 ? -2.4 * wind : wind < 0 ? 1.1 * -wind / 0.6 : Math.sin(b.t * 6) * 0.08 * (b.state === 'chase' ? 1 : 0);
        ud.glow.emissive.copy(AMBER).lerp(RED, Math.max(0, wind));
        ud.glow.emissiveIntensity = 2.2 + Math.max(0, wind) * 3 + (b.slowUntil > sword.now ? -1.2 : 0);
        b.group.rotation.z = b.state === 'stagger' ? Math.sin(b.t * 30) * 0.12 : 0;
      }
      // the squad is down: a bigger one after a breath
      if (alive === 0) {
        Z.restT += dt;
        if (Z.restT > 2.5) { Z.restT = 0; Z.wave++; this.spawn(Z, P); if (Z.active) this.onWave?.(Z, Z.wave); }
      } else Z.restT = 0;
    }
  }
}
