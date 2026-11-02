import * as THREE from 'three';
import { BODY } from '../sim/orbits.js';
import { RES } from '../data/economy.js';
import { deposit, emit } from '../sim/state.js';
import { atmosphereMaterial, glowSprite } from './shaders.js';
import { planetMaterial, ringMesh, bodyQuat } from './planets.js';
import { distKm } from '../sim/orbits.js';
import { simNow } from '../sim/state.js';
import { makeSky } from './sky.js';
import { makeMech, makeSeedShip, makeDrone, rockGeometry, MAT } from './models.js';
import { ROCK_NORMAL } from './materials.js';
import { haptic } from '../telegram.js';

// Walkable worlds. g in m/s² (real values); sky/fog only where there is an atmosphere.
export const SURFACES = {
  moon: { g: 1.62, ground: [0x6b6965, 0x9a968f, 0x34332f], parent: 'earth' },
  mercury: { g: 3.7, ground: [0x5f5953, 0x8a8178, 0x302c28] },
  mars: { g: 3.72, ground: [0x7a3418, 0xb8673a, 0x45190a], sky: 0xb98a62, fog: [0xc29268, 120, 1100] },
  ceres: { g: 0.28, ground: [0x45423f, 0x6e6a64, 0x262422] },
  europa: { g: 1.31, ground: [0xb8b2a6, 0xe8e2d6, 0x7a4a30], parent: 'jupiter' },
  titan: { g: 1.35, ground: [0x4a3014, 0x7a5228, 0x26180a], sky: 0xa86e2c, fog: [0xb07a38, 40, 520] },
  pluto: { g: 0.62, ground: [0xa8947a, 0xe0d4c0, 0x5a3c28] },
};

const SIZE = 1400, SEG = 220, PAD_R = 14, CAP = 60, BOUND = 560;
const SUN_DIR = new THREE.Vector3(0.62, 0.38, -0.69).normalize();
const DETAIL_GEO = rockGeometry(7, 2);
const CRYSTAL = new THREE.OctahedronGeometry(0.5, 0);

// ---------------- deterministic heightfield (shared by mesh + physics) ----------------
function hash2(x, y, s) {
  const h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm2(x, y, s, oct = 4) {
  let v = 0, a = 0.5;
  for (let i = 0; i < oct; i++) { v += a * vnoise(x, y, s + i * 13); x *= 2.03; y *= 2.03; a *= 0.5; }
  return v;
}

class Terrain {
  constructor(seed) {
    this.seed = seed;
    this.craters = [];
    let r = seed * 9.31;
    const rnd = () => { r = (r * 16807 + 11) % 2147483647; return r / 2147483647; };
    for (let i = 0; i < 46; i++) {
      const x = (rnd() - 0.5) * SIZE * 0.95, z = (rnd() - 0.5) * SIZE * 0.95;
      if (Math.hypot(x, z) < 90) continue;
      const rad = 14 + Math.pow(rnd(), 2.2) * 110;
      this.craters.push({ x, z, r: rad, d: rad * (0.12 + rnd() * 0.08) });
    }
  }
  // returns height and a 0..1 "crater floor" darkness term for colouring
  sample(x, z, out = {}) {
    let h = (fbm2(x * 0.005, z * 0.005, this.seed) - 0.5) * 34 + (fbm2(x * 0.03, z * 0.03, this.seed + 5, 3) - 0.5) * 4;
    let floor = 0;
    for (const c of this.craters) {
      const dx = x - c.x, dz = z - c.z, d2 = (dx * dx + dz * dz) / (c.r * c.r);
      if (d2 > 2.6) continue;
      const d = Math.sqrt(d2);
      if (d < 1) { h += c.d * (d2 - 1); floor = Math.max(floor, 1 - d); }
      h += c.d * 0.38 * Math.exp(-Math.pow((d - 1) * 3.2, 2));
    }
    const rr = Math.hypot(x, z);
    const flat = THREE.MathUtils.smoothstep(rr, 26, 70);
    h *= flat;
    h -= (rr * rr) / 5200; // exaggerated curvature drops the edges below the horizon
    out.h = h; out.floor = floor * flat;
    return out;
  }
  height(x, z) { return this.sample(x, z).h; }
}

export class SurfaceView {
  constructor(app) {
    this.app = app;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 30000);
    this.sky = makeSky();
    this.scene.add(this.sky);
    this.sun = new THREE.DirectionalLight(0xfff4e6, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 300 });
    this.sun.shadow.bias = -0.0008;
    this.hemi = new THREE.HemisphereLight(0x8090b0, 0x201814, 0.25);
    this.scene.add(this.sun, this.sun.target, this.hemi);

    this.mech = makeMech();
    this.mech.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.parts = this.mech.userData.parts || {};
    this.rest = {};
    for (const k in this.parts) if (this.parts[k]) this.rest[k] = this.parts[k].position.clone();
    this.jets = [-0.42, 0.42].map((x) => {
      const s = glowSprite(0xff4be0, 2.4, 2.5);
      s.position.set(x, 3.0, -1.05);
      this.mech.add(s);
      return s;
    });
    this.scene.add(this.mech);

    this.dust = glowSprite(0xffd2a0, 3, 1.2);
    this.dust.visible = false;
    this.scene.add(this.dust);

    this.vel = new THREE.Vector3();
    this.facing = 0;
    this.camYaw = Math.PI;
    this.camPitch = 0.28;
    this.phase = 0;
    this.fuel = 100;
    this.cargo = {};
    this.time = 0;
    this.info = { cargo: 0, cap: CAP, target: null, speed: 0, dock: 0, dockRange: PAD_R, fuel: 100, g: 1.62 };
    this.content = null;
    this.baseId = null;
  }

  setBase(id) {
    if (this.baseId === id && this.content) return;
    if (this.content) {
      this.scene.remove(this.content);
      this.content.traverse((o) => { if (o.isMesh && o.geometry !== DETAIL_GEO && o.geometry !== CRYSTAL) o.geometry.dispose(); });
    }
    this.baseId = id;
    const cfg = (this.cfg = SURFACES[id]);
    const body = BODY[id];
    this.content = new THREE.Group();
    this.scene.add(this.content);
    this.terrain = new Terrain(id.length * 3 + id.charCodeAt(0));

    // atmosphere vs vacuum
    const atmo = !!cfg.sky;
    this.sky.visible = !atmo;
    this.scene.background = atmo ? new THREE.Color(cfg.sky) : null;
    this.scene.fog = cfg.fog ? new THREE.Fog(cfg.fog[0], cfg.fog[1], cfg.fog[2]) : null;
    this.sun.intensity = atmo ? 1.8 : 3.2;
    this.hemi.intensity = atmo ? 0.8 : 0.18;
    this.hemi.color.set(atmo ? cfg.sky : 0x8090b0);

    this.buildGround(cfg);
    this.buildOutpost();
    this.buildNodes(body);

    if (!atmo) {
      const sunG = glowSprite(0xfff0d8, 900, 3);
      sunG.position.copy(SUN_DIR).multiplyScalar(8000);
      this.content.add(sunG);
    }
    if (cfg.parent && !atmo) {
      const p = BODY[cfg.parent];
      // true angular size from the real distance right now (Earth from the Moon: ~1.9°)
      const t = simNow(this.app.state);
      const R = 7000 * Math.tan(Math.atan(p.radiusKm / distKm(id, p.id, t)));
      const m = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 48), planetMaterial(p, { hi: true }));
      m.position.set(-0.45, 0.28, 0.85).normalize().multiplyScalar(7000);
      m.quaternion.copy(bodyQuat(p.id, t));
      m.material.userData.sunDir.copy(SUN_DIR);
      this.content.add(m);
      if (p.atmo) {
        const a = new THREE.Mesh(new THREE.SphereGeometry(R * 1.03, 48, 24), atmosphereMaterial(p.atmo));
        a.material.uniforms.uSunDir.value.copy(SUN_DIR);
        m.add(a);
      }
      if (p.rings) {
        const r = ringMesh(R);
        r.userData.sunDir.copy(SUN_DIR);
        m.add(r);
      }
      this.skyPlanet = m;
    } else this.skyPlanet = null;

    this.mech.position.set(0, 0, PAD_R + 4);
    this.vel.set(0, 0, 0);
    this.facing = 0;
    this.camYaw = Math.PI;
    this.info.g = cfg.g;
    this.applyQuality();
  }

  applyQuality() {
    this.sun.castShadow = this.app.quality !== 'low';
  }

  buildGround(cfg) {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, colors = new Float32Array(pos.count * 3);
    const [cA, cB, cC] = cfg.ground.map((h) => new THREE.Color(h));
    const c = new THREE.Color(), s = {};
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      this.terrain.sample(x, z, s);
      pos.setY(i, s.h);
      const n = fbm2(x * 0.02, z * 0.02, 99, 3);
      c.copy(cA).lerp(cB, THREE.MathUtils.clamp(n * 1.6 - 0.3, 0, 1)).lerp(cC, Math.min(1, s.floor * 1.4));
      c.multiplyScalar(0.85 + hash2(x, z, 3) * 0.25);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const detail = ROCK_NORMAL.clone();
    detail.repeat.set(160, 160);
    detail.needsUpdate = true;
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0, normalMap: detail, normalScale: new THREE.Vector2(0.9, 0.9) }));
    ground.receiveShadow = true;
    this.content.add(ground);

    // scattered boulders for scale
    const n = 420;
    const rocks = new THREE.InstancedMesh(DETAIL_GEO, new THREE.MeshStandardMaterial({ color: cfg.ground[0], roughness: 1, flatShading: true }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const x = (Math.random() - 0.5) * SIZE * 0.8, z = (Math.random() - 0.5) * SIZE * 0.8;
      if (Math.hypot(x, z) < 30) { i--; continue; }
      const k = 0.25 + Math.pow(Math.random(), 3) * 3.2;
      p.set(x, this.terrain.height(x, z) + k * 0.2, z);
      q.setFromEuler(e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3));
      m.compose(p, q, sc.set(k, k * 0.7, k));
      rocks.setMatrixAt(i, m);
    }
    rocks.castShadow = rocks.receiveShadow = true;
    this.content.add(rocks);
  }

  buildOutpost() {
    const g = new THREE.Group();
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(PAD_R, PAD_R + 1, 0.6, 48), MAT.hullDark);
    pad.position.y = 0.1;
    pad.receiveShadow = true;
    g.add(pad);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(PAD_R - 0.6, 0.12, 6, 64), MAT.amber);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.45;
    g.add(ring);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 2.2), i % 2 ? MAT.amber : MAT.hazard);
      l.position.set(Math.cos(a) * (PAD_R - 2.5), 0.45, Math.sin(a) * (PAD_R - 2.5));
      l.rotation.y = -a;
      g.add(l);
    }
    // the seed ship that founded this outpost, standing on its engine
    const seed = makeSeedShip();
    seed.rotation.x = -Math.PI / 2;
    seed.position.set(-PAD_R - 10, 5.4, -6);
    seed.userData.exhaust?.forEach((e) => (e.visible = false));
    seed.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.add(seed);
    // hab dome + antenna mast
    const dome = new THREE.Mesh(new THREE.SphereGeometry(6, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), MAT.glass);
    dome.position.set(PAD_R + 12, 0, -10);
    g.add(dome);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(6.3, 6.6, 1.2, 32), MAT.hull);
    base.position.copy(dome.position);
    g.add(base);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 22, 6), MAT.hullLight);
    mast.position.set(PAD_R + 4, 11, -22);
    mast.castShadow = true;
    g.add(mast);
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), MAT.red.clone());
    this.beacon.position.set(PAD_R + 4, 22.2, -22);
    g.add(this.beacon);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 4, 6), MAT.hullDark);
      pole.position.set(Math.cos(a) * (PAD_R + 3), 2, Math.sin(a) * (PAD_R + 3));
      g.add(pole);
      const lamp = glowSprite(0xffc070, 2.5, 2);
      lamp.position.set(pole.position.x, 4.2, pole.position.z);
      g.add(lamp);
    }
    this.padDrones = [0, 1].map((i) => {
      const d = makeDrone();
      d.scale.setScalar(1.4);
      g.add(d);
      return d;
    });
    this.content.add(g);
  }

  buildNodes(body) {
    const weights = Object.entries(body.drones).map(([r, v]) => [r, Math.sqrt(v) * (RES[r].value > 300 ? 2.5 : 1)]);
    if (!weights.length) weights.push(['ore', 1]);
    const total = weights.reduce((a, [, w]) => a + w, 0);
    const pick = () => {
      let x = Math.random() * total;
      for (const [r, w] of weights) if ((x -= w) <= 0) return r;
      return weights[0][0];
    };
    const rockMat = new THREE.MeshStandardMaterial({ color: this.cfg.ground[2], roughness: 0.9, flatShading: true });
    this.nodes = [];
    for (let i = 0; i < 34; i++) {
      const res = pick();
      const g = new THREE.Group();
      const rock = new THREE.Mesh(DETAIL_GEO, rockMat);
      rock.scale.set(2.2, 1.3, 2.2);
      rock.castShadow = true;
      g.add(rock);
      const cm = new THREE.MeshBasicMaterial({ color: new THREE.Color(RES[res].color).multiplyScalar(2.6) });
      for (let k = 0; k < 6; k++) {
        const c = new THREE.Mesh(CRYSTAL, cm);
        const a = (k / 6) * Math.PI * 2 + Math.random();
        c.position.set(Math.cos(a) * 1.1, 1 + Math.random() * 0.6, Math.sin(a) * 1.1);
        c.scale.set(0.6, 1.6 + Math.random() * 1.2, 0.6);
        c.rotation.set((Math.random() - 0.5) * 0.8, a, (Math.random() - 0.5) * 0.8);
        g.add(c);
      }
      g.add(glowSprite(RES[res].color, 7, 0.8));
      const node = { group: g, res, hp: 0, maxHp: 14, alive: true, respawnAt: 0 };
      this.placeNode(node);
      this.content.add(g);
      this.nodes.push(node);
    }
  }

  placeNode(node) {
    let x, z;
    do {
      const a = Math.random() * Math.PI * 2, r = 40 + Math.pow(Math.random(), 0.8) * 420;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    } while (Math.hypot(x, z) < 35);
    node.group.position.set(x, this.terrain.height(x, z) - 0.3, z);
    node.group.scale.setScalar(1);
    node.group.visible = true;
    node.hp = node.maxHp;
    node.alive = true;
  }

  cargoTotal() {
    return Object.values(this.cargo).reduce((a, b) => a + b, 0);
  }

  unload() {
    const n = this.cargoTotal();
    if (!n) return 0;
    const s = this.app.state;
    const got = deposit(s, this.baseId, this.cargo);
    s.stats.surface = (s.stats.surface || 0) + got;
    this.cargo = {};
    emit('toast', { text: `Mech unloaded ${Math.round(got)} t at ${BODY[this.baseId].base}`, kind: 'good' });
    emit('changed');
    haptic('medium');
    return got;
  }

  update(dt, input) {
    this.time += dt;
    const I = input.sample(dt);
    const m = this.mech, T = this.terrain, g = this.cfg.g;

    // orbit camera from drag
    this.camYaw -= I.lookX * 0.006;
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + I.lookY * 0.004, -0.15, 1.1);

    const fwd = new THREE.Vector3(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw));
    const right = new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
    const wish = new THREE.Vector3().addScaledVector(fwd, I.move.y).addScaledVector(right, I.move.x);
    if (wish.lengthSq() > 1) wish.normalize();
    const ground = T.height(m.position.x, m.position.z);
    const grounded = m.position.y <= ground + 0.05;
    const drilling = I.mine && this.target && grounded;
    const top = (I.boost ? 11 : 6) * (drilling ? 0.15 : 1);

    // horizontal: snappy on the ground, sluggish in the air (low-g momentum)
    const ctl = grounded ? 8 : 1.2;
    this.vel.x = THREE.MathUtils.lerp(this.vel.x, wish.x * top, 1 - Math.exp(-ctl * dt));
    this.vel.z = THREE.MathUtils.lerp(this.vel.z, wish.z * top, 1 - Math.exp(-ctl * dt));

    // gravity + jetpack
    const jet = I.lift > 0 && this.fuel > 0;
    if (jet) {
      this.vel.y += (g + 5.5) * dt;
      this.fuel = Math.max(0, this.fuel - 28 * dt);
    } else if (grounded) this.fuel = Math.min(100, this.fuel + 22 * dt);
    this.vel.y -= g * dt;
    this.vel.y = Math.min(this.vel.y, 14);
    m.position.addScaledVector(this.vel, dt);

    const h = T.height(m.position.x, m.position.z);
    if (m.position.y < h) {
      if (this.vel.y < -6) { haptic('heavy'); this.puff(m.position); }
      m.position.y = h;
      this.vel.y = Math.max(0, this.vel.y);
    }
    const r = Math.hypot(m.position.x, m.position.z);
    if (r > BOUND) { m.position.x *= BOUND / r; m.position.z *= BOUND / r; }

    // face movement direction (or the drill target)
    const hs = Math.hypot(this.vel.x, this.vel.z);
    let want = this.facing;
    if (drilling) want = Math.atan2(this.target.group.position.x - m.position.x, this.target.group.position.z - m.position.z);
    else if (hs > 0.6) want = Math.atan2(this.vel.x, this.vel.z);
    let d = want - this.facing;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.facing += d * (1 - Math.exp(-8 * dt));
    m.rotation.y = this.facing;

    this.animate(dt, hs, grounded, drilling, jet);
    for (const j of this.jets) {
      j.visible = jet;
      j.scale.setScalar(2 + Math.random() * 1.2);
    }

    this.updateDrill(dt, drilling, grounded);

    // nodes respawn, drones hover over the pad, beacon blinks
    for (const n of this.nodes) if (!n.alive && this.time > n.respawnAt) this.placeNode(n);
    this.padDrones.forEach((dr, i) => {
      const a = this.time * 0.4 + i * Math.PI;
      dr.position.set(Math.cos(a) * 9, 7 + Math.sin(this.time * 1.3 + i) * 0.8, Math.sin(a) * 9);
      dr.rotation.y = -a;
    });
    this.beacon.visible = Math.sin(this.time * 3) > 0;

    const dock = Math.hypot(m.position.x, m.position.z);
    if (dock < PAD_R && grounded && this.cargoTotal() > 0) this.unload();

    // chase camera, kept above the ground
    const cp = this.camPitch, dist = 17;
    const desired = new THREE.Vector3(
      m.position.x + Math.sin(this.camYaw) * Math.cos(cp) * dist,
      m.position.y + 3.5 + Math.sin(cp) * dist,
      m.position.z + Math.cos(this.camYaw) * Math.cos(cp) * dist,
    );
    desired.y = Math.max(desired.y, T.height(desired.x, desired.z) + 1.2);
    this.camera.position.lerp(desired, 1 - Math.exp(-10 * dt));
    this.camera.lookAt(m.position.x, m.position.y + 3.6, m.position.z);
    this.sky.position.copy(this.camera.position);

    this.sun.position.copy(m.position).addScaledVector(SUN_DIR, 120);
    this.sun.target.position.copy(m.position);

    Object.assign(this.info, {
      cargo: this.cargoTotal(), speed: hs, dock, fuel: this.fuel,
      alt: m.position.y - h, target: this.target ? { res: this.target.res, dist: this.targetDist, hp: this.target.hp / this.target.maxHp } : null,
    });
  }

  animate(dt, speed, grounded, drilling, jet) {
    const p = this.parts;
    if (!p.thigh_L) return;
    const stride = grounded ? THREE.MathUtils.clamp(speed / 6, 0, 1.4) : 0;
    this.phase += dt * (1.6 + speed * 0.75);
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    const k = 1 - Math.exp(-12 * dt);
    const set = (o, v) => { o.rotation.x += (v - o.rotation.x) * k; };
    if (grounded) {
      set(p.thigh_L, -s * 0.55 * stride);
      set(p.thigh_R, s * 0.55 * stride);
      set(p.shin_L, (0.15 + Math.max(0, c) * 0.7) * stride);
      set(p.shin_R, (0.15 + Math.max(0, -c) * 0.7) * stride);
    } else {
      // tuck legs while flying
      set(p.thigh_L, -0.5); set(p.thigh_R, -0.3);
      set(p.shin_L, 0.9); set(p.shin_R, 0.7);
    }
    set(p.arm_R, grounded ? s * 0.35 * stride : -0.3);
    set(p.arm_L, drilling ? -1.35 : grounded ? -s * 0.35 * stride : -0.3);
    set(p.torso, drilling ? 0.12 : 0.06 * stride);
    const bob = grounded ? Math.abs(s) * 0.18 * stride : 0;
    p.pelvis.position.y = this.rest.pelvis.y + bob - (drilling ? 0.15 : 0);
    p.head.rotation.y = Math.sin(this.time * 0.7) * 0.15;
    if (grounded && stride > 0.3 && Math.abs(s) < 0.08) this.puff(this.mech.position, 0.6);
  }

  puff(pos, scale = 1) {
    this.dust.visible = true;
    this.dust.position.set(pos.x, pos.y + 0.6, pos.z);
    this.dust.scale.setScalar(6 * scale);
    this.dustT = 0.6;
  }

  updateDrill(dt, drilling, grounded) {
    const m = this.mech;
    const f = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
    let best = null, bd = 9;
    for (const n of this.nodes) {
      if (!n.alive) continue;
      const v = n.group.position.clone().sub(m.position);
      v.y = 0;
      const d = v.length();
      if (d < bd && (d < 4 || v.normalize().dot(f) > 0.2)) { bd = d; best = n; }
    }
    this.target = grounded ? best : null;
    this.targetDist = bd;

    if (this.dustT > 0) {
      this.dustT -= dt;
      this.dust.material.opacity = Math.max(0, this.dustT / 0.6);
      if (this.dustT <= 0) this.dust.visible = false;
    }
    if (!drilling || !this.target) { this.drillT = 0; return; }
    const n = this.target;
    this.dust.visible = true;
    this.dust.position.copy(n.group.position).y += 1.4;
    this.dust.scale.setScalar(3 + Math.random() * 3);
    this.dust.material.opacity = 0.8;
    this.dustT = 0.15;
    this.drillT = (this.drillT || 0) + dt;
    if (this.drillT < 0.32) return;
    this.drillT = 0;
    if (this.cargoTotal() >= CAP) {
      if (this.time - (this.fullWarned || 0) > 4) {
        this.fullWarned = this.time;
        emit('toast', { text: 'Mech hopper full — walk back to the landing pad', kind: 'bad' });
      }
      return;
    }
    this.cargo[n.res] = (this.cargo[n.res] || 0) + 1;
    n.hp--;
    haptic('light');
    n.group.scale.setScalar(0.45 + 0.55 * (n.hp / n.maxHp));
    if (n.hp <= 0) { n.alive = false; n.group.visible = false; n.respawnAt = this.time + 60; }
  }
}
