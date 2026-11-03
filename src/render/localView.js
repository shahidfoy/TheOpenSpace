import * as THREE from 'three';
import { BODY, sunDistAU, helioAU, transitAU } from '../sim/orbits.js';
import { AU_KM, FIELDS, ZONES, DEEP } from '../data/bodies.js';
import { RES } from '../data/economy.js';
import { SKIFF_CAP, fleetCap, deposit, emit, simNow } from '../sim/state.js';
import { atmosphereMaterial, glowSprite } from './shaders.js';
import { planetMaterial, ringMesh, bodyQuat, bodyFrame } from './planets.js';
import { cloudShell, scatteringShell, EARTH_Q } from './earthSky.js';
import { makeSky } from './sky.js';
import { makeCraft, poseFrame, makeStation, makeDrone, makeHauler, makeSeedShip, makeJunk, makeCanister, rockGeometry, FIELD_MATS, setThrust } from './models.js';
import { haptic } from '../telegram.js';

const SUN_DIR = new THREE.Vector3(0.85, 0.5, 0.15).normalize();
const ROCK_GEOS = [1, 2, 3, 4, 5, 6].map((s) => rockGeometry(s, 4));
const GAS = ['jupiter', 'saturn', 'uranus', 'neptune'];
const DOCK_RANGE = 18;
const BERTH = new THREE.Vector3(32, -4, 24); // where your ship waits beside the station while you are on EVA
const BERTH_YAW = Math.atan2(32, 24); // nose pointing away from the station
const BOARD_RANGE = 9;
const TETHER = 460;
const ROCK_TINT = { mars: 0x6a3a28, moon: 0x55524e, mercury: 0x4e4a46, ceres: 0x3f3b37, jupiter: 0x5a4636, belt: 0x403a34, trojan: 0x3a2e2a, nea: 0x4a443c, deep: 0x46403a };
const v3 = () => new THREE.Vector3();
const tmp = v3(), tmp2 = v3();
const Y_UP = new THREE.Vector3(0, 1, 0);

// Where the body sits in the local frame: its centre lies along `nadir`, at a distance
// that gives the station a believable altitude (Earth: ~1,000 km). R is the render radius.
function layout(id) {
  if (id === 'sun') return { R: 348, pos: new THREE.Vector3(0, -0.8, 0.6).multiplyScalar(6000) }; // true 3.3° disc at 0.08 AU
  if (GAS.includes(id)) return { R: 3000, pos: new THREE.Vector3(0, -2600, -3200) };
  const R = { earth: 1000, venus: 900, mars: 800, moon: 600, mercury: 600, europa: 450, titan: 520, ceres: 350, pluto: 300 }[id] || 500;
  return { R, pos: new THREE.Vector3(0, -0.8, 0.6).multiplyScalar(R + 160) };
}
// Standard gravitational parameters (km³/s²) for real orbital periods.
const GM = { sun: 1.32712e11, mercury: 22032, venus: 324859, earth: 398600, moon: 4902.8, mars: 42828, ceres: 62.6, jupiter: 1.26687e8, europa: 3202.7, saturn: 3.7931e7, titan: 8978, uranus: 5.794e6, neptune: 6.8365e6, pluto: 869.6 };
// Heliocentric position in scene (map/ecliptic) coordinates, AU.
function helioScene(id, t, out = new THREE.Vector3()) {
  const p = helioAU(BODY[id], t);
  return out.set(p[0], p[2], -p[1]);
}

function disposeTree(o) {
  o.traverse((c) => {
    if (c.isMesh && c.geometry && !ROCK_GEOS.includes(c.geometry) && !c.geometry.userData.shared) c.geometry.dispose();
    if (c.isCSS2DObject) c.element.remove();
  });
}

export class LocalView {
  constructor(app) {
    this.app = app;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 30000);
    this.sky = makeSky();
    this.scene.add(this.sky);
    this.sun = new THREE.DirectionalLight(0xfff1dd, 2.6);
    this.sun.position.copy(SUN_DIR).multiplyScalar(100);
    this.fill = new THREE.HemisphereLight(0x3a4a6a, 0x120818, 0.3);
    this.scene.add(this.sun, this.fill);
    this.sunDir = SUN_DIR.clone();

    this.setCraft(app.state.craft);
    this.vel = v3();
    this.prevVel = v3(); this.accel = v3(); // for the suit's motion-driven pose
    this.yaw = 0; this.pitch = 0; this.roll = 0;
    this.cargo = {};
    this.info = { cargo: 0, cap: SKIFF_CAP, target: null, speed: 0, dock: 0, markers: [], sun: { x: 0, y: 0, vis: 0 }, zone: '', voyage: false };

    const beamMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff6a20).multiplyScalar(5), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 6, 1, true), beamMat);
    this.beam.geometry.userData.shared = true;
    this.beam.visible = false;
    this.spark = glowSprite(0xffa060, 3, 3);
    this.spark.visible = false;
    this.scene.add(this.beam, this.spark);
    this.content = null;
    this.mineTimer = 0;
    this.fullWarned = 0;
    this.time = 0;
    this.mode = 'base';
    this.buildDust();
  }

  clear() {
    if (this.content) { this.scene.remove(this.content); disposeTree(this.content); }
    this.content = new THREE.Group();
    this.scene.add(this.content);
    this.rocks = [];
    this.drones = [];
    this.escorts = [];
    this.station = null;
    this.planet = null;
    this.fieldGroup = null;
    this.parked = null;
  }

  // Swap the piloted craft (frame mech or skiff) in place, keeping where it is and where it faces.
  setCraft(type) {
    const old = this.craft;
    this.craft = makeCraft(type);
    if (old) {
      this.craft.position.copy(old.position);
      this.craft.quaternion.copy(old.quaternion);
      this.scene.remove(old);
    }
    this.isFrame = !!this.craft.userData.parts;
    this.scene.add(this.craft);
  }

  // Craft changes happen at the station: while you are in the exosuit your ship waits at a berth
  // beside the station; fly up to it to board, or bring the ship into docking range to step out.
  canSwap() {
    if (this.mode !== 'base' || !this.craft) return false;
    return this.isFrame ? this.craft.position.distanceTo(BERTH) < BOARD_RANGE : this.craft.position.length() < BERTH.length() + 12;
  }

  switchCraft(type) {
    this.setCraft(type);
    this.yaw = BERTH_YAW; this.pitch = 0; this.roll = 0;
    // board: take the ship off its berth; EVA: the ship parks there and you step out beside it
    this.craft.position.copy(BERTH);
    if (type === 'frame') this.craft.position.add(tmp.set(-4, 1.2, -1).applyAxisAngle(Y_UP, BERTH_YAW));
    this.craft.quaternion.setFromEuler(new THREE.Euler(0, this.yaw, 0, 'YXZ'));
    this.vel.set(0, 0, 0);
    this.updateParked();
  }

  updateParked() {
    if (this.parked) { this.content?.remove(this.parked); disposeTree(this.parked); this.parked = null; }
    if (this.mode !== 'base' || !this.isFrame || !this.content) return;
    this.parked = makeCraft('skiff');
    this.parked.position.copy(BERTH);
    this.parked.rotation.y = BERTH_YAW;
    setThrust(this.parked, 0, 0);
    this.content.add(this.parked);
  }

  resetCraft(z = 24) {
    this.craft.position.set(0, -1, z);
    this.vel.set(0, 0, 0);
    this.yaw = 0; this.pitch = 0;
    this.camera.position.set(0, 3, z - 12);
  }

  // ---------------- station orbit around a base ----------------
  // The station flies a real-time circular orbit (Earth: ~105 min, 51.6° like the ISS). The view
  // is station-fixed (LVLH): the world below turns, day and night sweep past, and the Sun, the
  // sky and any parent world sit where they really are right now.
  setBase(id) {
    this.clear();
    this.mode = 'base';
    this.baseId = id;
    const body = BODY[id];
    const t = simNow(this.app.state);
    const au = sunDistAU(id, t);
    this.sun.intensity = THREE.MathUtils.clamp(2.6 * Math.pow(1 / (au * au), 0.22), 0.9, 4);
    this.sunGlow = id === 'sun' ? null : glowSprite(0xffd9a0, THREE.MathUtils.clamp(900 / au, 80, 2400), 2.5);
    if (this.sunGlow) this.content.add(this.sunGlow);

    const { R, pos } = layout(id);
    this.orbit = { nadir: pos.clone().normalize(), dist: pos.length(), R, frame: bodyFrame(id), inc: (id === 'earth' ? 51.6 : 28) * Math.PI / 180 };
    this.orbit.aKm = (body.kind === 'star' ? body.radiusKm : body.radiusKm) * (pos.length() / R);
    this.orbit.period = 2 * Math.PI * Math.sqrt(this.orbit.aKm ** 3 / GM[id]) * 1000;
    this.planet = this.addPlanet(body, R, pos);
    if (id === 'sun') {
      const gl = glowSprite(0xffb060, R * 7, 1.6);
      gl.position.copy(pos);
      this.content.add(gl);
    }
    // other worlds hanging in this sky at their true size and direction
    const others = body.parent ? [body.parent] : id === 'earth' ? ['moon'] : [];
    this.skyBodies = others.map((oid) => {
      const m = this.addPlanet(BODY[oid], 1, new THREE.Vector3(0, 0, -6000));
      return { id: oid, m };
    });
    this.orbitAcc = 99;
    this.updateOrbit(0);

    this.station = this.makeStation();
    this.content.add(this.station);
    const f = FIELDS[id];
    this.zone = { ...f, id, density: f.kind === 'none' ? 0 : 40 };
    this.buildField(this.zone, 40, 300);
    this.buildDrones();
    this.resetCraft(24);
    this.updateParked();
    this.updateInfoCaps();
  }

  updateOrbit(dt) {
    if ((this.orbitAcc += dt) < 0.1) return;
    this.orbitAcc = 0;
    const o = this.orbit, id = this.baseId, t = simNow(this.app.state);
    const { P, Q, E } = o.frame;
    const u = 2 * Math.PI * ((t / o.period) % 1);
    const k = tmp.copy(E).multiplyScalar(Math.cos(o.inc)).addScaledVector(P, Math.sin(o.inc));
    const r = v3().copy(Q).multiplyScalar(Math.cos(u)).addScaledVector(k, Math.sin(u));
    const v = v3().copy(Q).multiplyScalar(-Math.sin(u)).addScaledVector(k, Math.cos(u));
    o.r = r; // station's radial direction (scene frame): its ground point is where a descent begins
    // world → local: radial out = +Y, along-track = +Z, then tilt so the world sits below and ahead
    const qL2W = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(v3().crossVectors(r, v), r, v));
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), o.nadir).multiply(qL2W.invert());
    this.frameQ = q;
    this.sky.quaternion.copy(q);
    this.planet.quaternion.copy(q).multiply(bodyQuat(id, t));
    const here = helioScene(id, t);
    const sunLocal = id === 'sun' ? o.nadir.clone() : here.clone().negate().normalize().applyQuaternion(q);
    this.setSunDir(sunLocal);
    if (this.sunGlow) this.sunGlow.position.copy(sunLocal).multiplyScalar(8500);
    this.planet.userData.setSun(sunLocal);
    for (const b of this.skyBodies) {
      const d = helioScene(b.id, t).sub(here);
      const km = d.length() * AU_KM;
      d.normalize().applyQuaternion(q);
      b.m.position.copy(d).multiplyScalar(6000);
      b.m.scale.setScalar(6000 * Math.tan(Math.atan(BODY[b.id].radiusKm / km)));
      b.m.quaternion.copy(q).multiply(bodyQuat(b.id, t));
      b.m.userData.setSun(sunLocal);
    }
  }

  setSunDir(d) {
    this.sunDir.copy(d);
    this.sun.position.copy(d).multiplyScalar(100);
  }

  addPlanet(body, R, pos, parent = this.content) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 64), planetMaterial(body, { hi: true }));
    m.position.copy(pos);
    parent.add(m);
    const suns = [m.material.userData.sunDir];
    if (body.id === 'earth') {
      // close-up Earth: live clouds on their own shell, then the scattering atmosphere over both
      // (child order = draw order: same centre, so the transparent sort falls back to creation order)
      const u = m.material.uniforms;
      u.uReal.value = 1;
      const clouds = cloudShell(R, u.uNight.value), air = scatteringShell(R);
      suns.push(clouds.userData.sunDir, air.userData.sunDir);
      m.add(clouds, air);
      m.onBeforeRender = () => {
        const q = EARTH_Q[this.app.quality] || EARTH_Q.high;
        u.uQ.value = clouds.material.uniforms.uQ.value = q.q;
        air.material.uniforms.uSteps.value = q.steps;
      };
    } else if (body.atmo) {
      const a = new THREE.Mesh(new THREE.SphereGeometry(R * 1.035, 64, 32), atmosphereMaterial(body.atmo));
      suns.push(a.material.uniforms.uSunDir.value);
      m.add(a);
    }
    if (body.rings) {
      const ring = ringMesh(R);
      suns.push(ring.userData.sunDir);
      m.add(ring);
    }
    m.userData.setSun = (d) => suns.forEach((x) => x.copy(d));
    m.userData.setSun(this.sunDir);
    return m;
  }

  rebuildStation() {
    if (!this.content || this.mode !== 'base') return;
    this.content.remove(this.station);
    disposeTree(this.station);
    this.station = this.makeStation();
    this.content.add(this.station);
    this.buildDrones();
  }

  makeStation() {
    const s = this.app.state;
    const docked = s.ships.filter((x) => x.status === 'docked' && (x.at || 'earth') === this.baseId).map((x) => x.type);
    return makeStation(s.bases[this.baseId]?.buildings || {}, this.baseId, docked);
  }

  // ---------------- fleet voyage: deep space around your convoy ----------------
  setVoyage() {
    const v = this.app.state.voyage;
    if (!v) return;
    this.clear();
    this.mode = 'voyage';
    this.baseId = null;
    this.sun.intensity = 2.6;

    // celestial anchors updated from real geometry every second
    this.celest = { sun: glowSprite(0xffd9a0, 200, 2.5), dest: null, origin: null };
    this.content.add(this.celest.sun);
    const mk = (id) => {
      const b = BODY[id];
      const g = new THREE.Group();
      const m = this.addPlanet(b, 1, new THREE.Vector3(), g);
      const dot = glowSprite(b.atmo || b.look.a, 60, 1.6);
      g.add(dot);
      this.content.add(g);
      return { id, g, m, dot };
    };
    this.celest.dest = mk(v.to);
    this.celest.origin = mk(v.from);

    // the convoy in formation, all heading +Z
    const slots = [[-26, -5, -14], [24, 4, -22], [-18, 9, -44], [30, -8, -50], [0, -12, -36], [-38, 2, -70]];
    v.escorts.forEach((id, i) => {
      const sh = this.app.state.ships.find((x) => x.id === id);
      if (!sh) return;
      const m = sh.type === 'seed' ? makeSeedShip() : makeHauler();
      const [x, y, z] = slots[i % slots.length];
      m.position.set(x, y, z - Math.floor(i / slots.length) * 40);
      this.content.add(m);
      this.escorts.push({ mesh: m, base: m.position.clone(), phase: Math.random() * 6 });
    });

    this.zone = null;
    this.zoneAcc = 99;
    this.contactAt = this.time + 25;
    this.skyAcc = 99;
    this.resetCraft(6);
    this.updateInfoCaps();
  }

  // Which region of the solar system the fleet is crossing right now.
  zoneAt(P) {
    let best = null;
    for (const id in FIELDS) {
      const q = helioAU(BODY[id], simNow(this.app.state));
      const d = Math.hypot(P[0] - q[0], P[1] - q[1], P[2] - q[2]) * AU_KM;
      const reach = id === 'earth' ? 45000 : id === 'sun' ? 0 : GAS.includes(id) ? 2e6 : 250000;
      if (d < reach && (!best || d < best.d)) best = { id, d };
    }
    if (best && FIELDS[best.id].kind !== 'none') return { ...FIELDS[best.id], id: best.id, density: 34 };
    const r = Math.hypot(P[0], P[1], P[2]);
    return ZONES.find((z) => r >= z.from && r <= z.to) || DEEP;
  }

  updateVoyage(dt) {
    const s = this.app.state, v = s.voyage;
    if (!v) return;
    const t = simNow(s);
    const P = transitAU(v.from, v.to, v.depart, v.arrive, t);

    if ((this.skyAcc += dt) > 1) {
      this.skyAcc = 0;
      const D = transitAU(v.from, v.to, v.depart, v.arrive, v.arrive);
      // basis: +Z toward the destination, +Y toward ecliptic north
      const f = new THREE.Vector3(D[0] - P[0], D[1] - P[1], D[2] - P[2]);
      if (f.lengthSq() < 1e-18) f.set(1, 0, 0);
      f.normalize();
      const up = new THREE.Vector3(0, 0, 1);
      const right = new THREE.Vector3().crossVectors(up, f).normalize();
      if (right.lengthSq() < 0.5) right.set(1, 0, 0);
      up.crossVectors(f, right).normalize();
      // (right is really the left-hand side here: facing +Z with +Y up, +X is on your left)
      const toScene = (x, y, z, out) => out.set(x * right.x + y * right.y + z * right.z, x * up.x + y * up.y + z * up.z, x * f.x + y * f.y + z * f.z);
      // turn the real sky (built in map/ecliptic frame: x, ecl-north, -y) into this frame
      this.sky.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
        new THREE.Vector3(right.x, up.x, f.x), new THREE.Vector3(right.z, up.z, f.z), new THREE.Vector3(-right.y, -up.y, -f.y)));
      const sunV = toScene(-P[0], -P[1], -P[2], v3());
      const au = Math.max(0.05, sunV.length());
      sunV.normalize();
      this.setSunDir(sunV);
      this.celest.sun.position.copy(sunV).multiplyScalar(8500);
      this.celest.sun.scale.setScalar(THREE.MathUtils.clamp(900 / au, 60, 2600));
      this.sun.intensity = THREE.MathUtils.clamp(2.6 * Math.pow(1 / (au * au), 0.22), 0.7, 4.5);
      for (const c of [this.celest.dest, this.celest.origin]) {
        const q = helioAU(BODY[c.id], t), b = BODY[c.id];
        const d = toScene(q[0] - P[0], q[1] - P[1], q[2] - P[2], v3());
        const km = Math.max(1, d.length() * AU_KM);
        d.normalize();
        // true angular size, drawn on a 7000 m sky shell
        const R = 7000 * Math.tan(Math.atan((b.radiusKm || 1) / km));
        c.g.position.copy(d).multiplyScalar(7000);
        c.m.scale.setScalar(Math.max(0.001, R));
        c.m.visible = R > 2;
        c.dot.visible = R < 30;
        c.dot.scale.setScalar(c.id === 'sun' ? 0 : 40);
        c.m.userData.setSun(sunV);
        c.m.quaternion.copy(this.sky.quaternion).multiply(bodyQuat(c.id, t));
        c.km = km;
        c.dir = d;
      }
      this.info.progress = (t - v.depart) / (v.arrive - v.depart);
    }

    if ((this.zoneAcc += dt) > 2) {
      this.zoneAcc = 0;
      const z = this.zoneAt(P);
      if (!this.zone || z.id !== this.zone.id) {
        const first = !this.zone;
        this.zone = z;
        this.buildField(z, z.density, 320, !first);
        if (!first) emit('toast', { text: `Entering ${z.name}`, kind: '' });
      }
    }
    // rare drifting contacts in open space
    if (this.zone && this.zone.density === 0 && this.time > this.contactAt) {
      this.contactAt = this.time + 70 + Math.random() * 90;
      const n = 1 + ((Math.random() * 3) | 0);
      const c = new THREE.Vector3((Math.random() - 0.5) * 160, (Math.random() - 0.5) * 60, 380);
      for (let i = 0; i < n; i++) this.spawnContact(c.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(18)));
      emit('toast', { text: n > 1 ? `Survey contact · ${n} objects closing ahead` : 'Survey contact · object closing ahead', kind: '' });
    }
    for (const r of this.rocks) {
      if (!r.drift || !r.alive) continue;
      r.mesh.position.z -= dt * 3.5;
      if (r.mesh.position.z < -380) { r.alive = false; r.mesh.visible = false; r.gone = true; }
    }

    for (const e of this.escorts) {
      e.mesh.position.copy(e.base);
      e.mesh.position.y += Math.sin(this.time * 0.4 + e.phase) * 0.6;
      e.mesh.rotation.z = Math.sin(this.time * 0.3 + e.phase) * 0.03;
      setThrust(e.mesh, 0.55, this.time + e.phase);
    }
    this.dust.visible = true;
  }

  // ---------------- dust streaks: sense of cruise speed ----------------
  buildDust() {
    const n = 360, pos = new Float32Array(n * 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dustSeeds = Array.from({ length: n }, () => new THREE.Vector3((Math.random() - 0.5) * 240, (Math.random() - 0.5) * 140, (Math.random() - 0.5) * 240));
    this.dust = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(0x9fd4ff).multiplyScalar(0.8), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.dust.frustumCulled = false;
    this.dust.visible = false;
    this.scene.add(this.dust);
  }

  updateDust(dt) {
    if (!this.dust.visible) return;
    const tier = Math.log10(Math.max(15, this.app.state.voyage?.kms || 15));
    const speed = 30 + tier * 28, len = 1 + tier * 2.2;
    const p = this.dust.geometry.attributes.position, c = this.camera.position;
    this.dustSeeds.forEach((s, i) => {
      s.z -= speed * dt;
      if (s.z < -120) s.z += 240;
      const x = c.x + s.x, y = c.y + s.y, z = c.z + s.z;
      p.setXYZ(i * 2, x, y, z);
      p.setXYZ(i * 2 + 1, x, y, z - len);
    });
    p.needsUpdate = true;
  }

  // ---------------- salvage / mining field ----------------
  buildField(zone, count, spread, fade = false) {
    if (this.fieldGroup) { this.content.remove(this.fieldGroup); disposeTree(this.fieldGroup); }
    this.fieldGroup = new THREE.Group();
    this.content.add(this.fieldGroup);
    this.rocks = [];
    this.zoneRes = zone.res;
    if (!count || zone.kind === 'none') return;
    const mat = zone.kind === 'ice' ? FIELD_MATS.ice : FIELD_MATS.rock.clone();
    if (zone.kind === 'rocks') mat.color.set(ROCK_TINT[zone.id] || 0x46403a);
    this.fieldMat = mat;
    for (let i = 0; i < count; i++) this.addFieldObject(zone, i, mat, spread, fade);
  }

  pickRes(res) {
    const w = Object.entries(res).map(([r, v]) => [r, Math.sqrt(v)]);
    if (!w.length) return 'ore';
    let x = Math.random() * w.reduce((a, [, k]) => a + k, 0);
    for (const [r, k] of w) if ((x -= k) <= 0) return r;
    return w[0][0];
  }

  addFieldObject(zone, i, mat, spread, fade, at) {
    const res = this.pickRes(zone.res);
    let m, radius;
    if (zone.kind === 'junk') {
      m = makeJunk(i);
      const sc = 0.9 + Math.random() * 0.8;
      m.scale.setScalar(sc);
      radius = new THREE.Box3().setFromObject(m).getBoundingSphere(new THREE.Sphere()).radius * 0.75;
    } else if (zone.kind === 'canister') {
      m = makeCanister();
      radius = 1.6;
    } else {
      const sc = (zone.kind === 'ice' ? 0.8 : 1.2) + Math.random() * (zone.kind === 'ice' ? 2.4 : 3.6);
      m = new THREE.Mesh(ROCK_GEOS[i % ROCK_GEOS.length], mat);
      m.scale.set(sc, sc * (0.65 + Math.random() * 0.35), sc * (0.75 + Math.random() * 0.3));
      radius = sc;
      if (RES[res].value >= 400) {
        // rare matter shows as faint glowing veins
        const vein = glowSprite(RES[res].color, sc * 2.2, 0.7);
        m.add(vein);
      }
    }
    m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    const rock = { mesh: m, res, scale: m.scale.clone(), radius, alive: true, respawnAt: 0, spin: new THREE.Vector3().randomDirection().multiplyScalar(zone.kind === 'junk' ? 0.12 : 0.2), spread, kind: zone.kind };
    if (at) m.position.copy(at);
    else this.placeRock(rock);
    if (fade) m.scale.multiplyScalar(0.01), (rock.grow = 0);
    this.fieldGroup.add(m);
    this.rocks.push(rock);
    return rock;
  }

  spawnContact(at) {
    const rock = this.addFieldObject(this.zone, (Math.random() * 6) | 0, this.fieldMat || FIELD_MATS.rock, 0, false, at);
    rock.drift = true;
  }

  placeRock(rock) {
    const p = v3(), S = rock.spread || 300;
    do {
      p.set((Math.random() - 0.5) * S, (Math.random() - 0.5) * 70 + 5, (Math.random() - 0.5) * S);
    } while (p.length() < 36);
    rock.mesh.position.copy(p);
    rock.maxHp = Math.round(4 + rock.radius * 3);
    rock.hp = rock.maxHp;
    rock.mesh.scale.copy(rock.scale);
    rock.mesh.visible = true;
    rock.alive = true;
  }

  buildDrones() {
    if (this.drones) this.drones.forEach((d) => this.content.remove(d.mesh, d.beam));
    this.drones = [];
    if (this.mode !== 'base') return;
    const lvl = this.app.state.bases[this.baseId]?.buildings.drones || 0;
    const bay = this.station.userData.anim.bay;
    for (let i = 0; i < Math.min(12, lvl * 3); i++) {
      const mesh = makeDrone();
      mesh.position.copy(bay);
      const beam = new THREE.Mesh(this.beam.geometry, new THREE.MeshBasicMaterial({ color: new THREE.Color(0x5ab4ff).multiplyScalar(4), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
      beam.visible = false;
      this.content.add(mesh, beam);
      this.drones.push({ mesh, beam, phase: 'out', t: Math.random() * 3, rock: null, from: bay.clone(), to: v3() });
    }
  }

  updateDrones(dt) {
    if (!this.station) return;
    const bay = this.station.userData.anim.bay;
    for (const d of this.drones) {
      d.t += dt;
      if (!d.rock || !d.rock.alive) {
        const live = this.rocks.filter((r) => r.alive);
        d.rock = live[(Math.random() * live.length) | 0];
        d.phase = 'out'; d.t = 0;
        d.from.copy(d.mesh.position);
        if (!d.rock) continue;
      }
      const hover = d.to.copy(d.rock.mesh.position).addScaledVector(tmp.copy(d.from).sub(d.rock.mesh.position).normalize(), d.rock.radius + 2.5);
      const travel = Math.max(2, d.from.distanceTo(hover) / 14);
      if (d.phase === 'out') {
        const k = Math.min(1, d.t / travel);
        d.mesh.position.lerpVectors(d.from, hover, k * k * (3 - 2 * k));
        d.mesh.lookAt(hover);
        if (k >= 1) { d.phase = 'mine'; d.t = 0; }
        d.beam.visible = false;
      } else if (d.phase === 'mine') {
        d.mesh.position.copy(hover).y += Math.sin(this.time * 3 + d.from.x) * 0.2;
        d.mesh.lookAt(d.rock.mesh.position);
        this.setBeam(d.beam, d.mesh.position, d.rock.mesh.position);
        d.beam.visible = Math.sin(this.time * 30) > -0.6;
        if (d.t > 4) { d.phase = 'back'; d.t = 0; d.from.copy(d.mesh.position); }
      } else {
        const k = Math.min(1, d.t / travel);
        d.mesh.position.lerpVectors(d.from, bay, k * k * (3 - 2 * k));
        d.mesh.lookAt(bay);
        d.beam.visible = false;
        if (k >= 1) { d.rock = null; d.from.copy(bay); }
      }
    }
  }

  setBeam(beam, a, b) {
    const d = tmp2.subVectors(b, a);
    beam.position.copy(a).addScaledVector(d, 0.5);
    beam.scale.set(1, d.length(), 1);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  }

  // In transit the hold is the fleet's (skiff + escort haulers) and persists in the save.
  hold() {
    return this.mode === 'voyage' && this.app.state.voyage ? this.app.state.voyage.cargo : this.cargo;
  }
  capacity() {
    const v = this.app.state.voyage;
    return this.mode === 'voyage' && v ? fleetCap(this.app.state, v.escorts) : SKIFF_CAP;
  }
  updateInfoCaps() {
    this.info.cap = this.capacity();
    this.info.voyage = this.mode === 'voyage';
  }

  cargoTotal() {
    return Object.values(this.hold()).reduce((a, b) => a + b, 0);
  }

  unload() {
    if (this.mode !== 'base') return 0;
    const n = this.cargoTotal();
    if (!n) return 0;
    const got = deposit(this.app.state, this.baseId, this.cargo);
    this.cargo = {};
    emit('toast', { text: `Unloaded ${Math.round(got)} t at ${BODY[this.baseId].base}`, kind: 'good' });
    haptic('medium');
    return got;
  }

  update(dt, input) {
    this.time += dt;
    const I = input.sample(dt);
    const s = this.craft;

    const yaw0 = this.yaw, spd = this.vel.length();
    this.yaw -= I.lookX * 0.005;
    // The suit flies like Iron Man: hovering, A/D strafes; at speed A/D banks into a turn and the
    // heading swings round (the body roll comes from the pose springs, not the craft frame).
    const cruise = this.isFrame ? THREE.MathUtils.smoothstep(spd, 5, 20) : 0;
    if (this.isFrame) this.yaw -= I.move.x * 1.6 * cruise * dt;
    this.pitch = THREE.MathUtils.clamp(this.pitch + I.lookY * 0.004, -1.3, 1.3);
    const roll = this.isFrame ? 0 : THREE.MathUtils.clamp(I.lookX * 0.03 - I.move.x * 0.35, -0.7, 0.7);
    this.roll = THREE.MathUtils.lerp(this.roll, roll, 1 - Math.exp(-5 * dt));
    s.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, this.roll, 'YXZ'));
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(s.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(s.quaternion);
    const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(s.quaternion);

    const thrust = I.boost ? 70 : 30;
    const acc = v3().addScaledVector(fwd, I.move.y).addScaledVector(right, I.move.x * (1 - cruise)).addScaledVector(up, I.lift);
    if (acc.lengthSq() > 1) acc.normalize();
    if (this.isFrame) {
      // carve: momentum follows most of the heading change instead of sliding sideways
      this.vel.applyAxisAngle(Y_UP, (this.yaw - yaw0) * 0.8 * THREE.MathUtils.smoothstep(spd, 3, 12));
      // hyper-velocity: boost kicks in with a lunge along the heading
      if (I.boost && !this.boosting && I.move.y > 0) this.vel.addScaledVector(fwd, 22);
    }
    this.boosting = I.boost;
    this.vel.addScaledVector(acc, thrust * dt);
    this.vel.multiplyScalar(Math.exp(-(I.boost ? 0.6 : 1.1) * dt));
    s.position.addScaledVector(this.vel, dt);

    for (const r of this.rocks) {
      if (!r.alive) continue;
      const d = tmp.copy(s.position).sub(r.mesh.position), min = r.radius + (this.isFrame ? 0.9 : 2.6);
      if (d.lengthSq() < min * min) {
        d.setLength(min);
        s.position.copy(r.mesh.position).add(d);
        this.vel.multiplyScalar(0.4);
      }
    }
    if (this.mode === 'base') {
      if (s.position.length() < 3.5) s.position.setLength(3.5);
      if (this.planet && this.baseId !== 'sun') {
        const R = this.planet.geometry.parameters.radius + 40;
        const d = tmp.copy(s.position).sub(this.planet.position);
        if (d.length() < R) s.position.copy(this.planet.position).add(d.setLength(R));
      }
      if (s.position.length() > 420) this.vel.addScaledVector(tmp.copy(s.position).normalize(), -40 * dt);
    } else {
      for (const e of this.escorts) {
        const d = tmp.copy(s.position).sub(e.mesh.position), min = 9;
        if (d.lengthSq() < min * min) { d.setLength(min); s.position.copy(e.mesh.position).add(d); this.vel.multiplyScalar(0.5); }
      }
      // autopilot tether keeps you with the convoy
      if (s.position.length() > TETHER) this.vel.addScaledVector(tmp.copy(s.position).normalize(), -45 * dt);
      this.info.tether = s.position.length() / TETHER;
    }

    const thr = Math.max(0, I.move.y) + (I.boost ? 0.6 : 0);
    if (this.isFrame) {
      // the pose reads motion in the suit's own frame (x left, y up, z forward)
      const inv = s.quaternion.clone().invert();
      const a = this.accel.lerp(tmp.copy(this.vel).sub(this.prevVel).divideScalar(Math.max(dt, 1e-3)), 1 - Math.exp(-12 * dt));
      this.prevVel.copy(this.vel);
      poseFrame(s, {
        vel: this.vel.clone().applyQuaternion(inv), acc: a.clone().applyQuaternion(inv),
        turn: -(this.yaw - yaw0) / Math.max(dt, 1e-3), input: I.move, lift: I.lift, boost: I.boost, aim: I.mine && !!this.targetRock,
      }, dt, this.time);
    } else setThrust(s, 0.08 + thr * 0.7, this.time);
    s.updateMatrixWorld(true);

    this.updateMining(dt, I.mine, fwd);
    if (this.mode === 'base') { this.updateDrones(dt); this.updateOrbit(dt); }
    else this.updateVoyage(dt);
    this.dust.visible = this.mode === 'voyage';

    for (const r of this.rocks) {
      if (r.grow !== undefined) {
        r.grow = Math.min(1, r.grow + dt * 0.6);
        r.mesh.scale.copy(r.scale).multiplyScalar(Math.max(0.01, r.grow));
        if (r.grow >= 1) delete r.grow;
      }
      if (r.alive) {
        r.mesh.rotation.x += r.spin.x * dt; r.mesh.rotation.y += r.spin.y * dt;
        if (r.mesh.userData.blink) r.mesh.userData.blink.visible = Math.sin(this.time * 4 + r.spin.x * 50) > 0.3;
      } else if (!r.gone && this.time > r.respawnAt && !r.drift) this.placeRock(r);
    }

    if (this.station) {
      const a = this.station.userData.anim;
      for (const sp of a.spin) sp.obj.rotation.y += sp.speed * dt;
      for (const b of a.blink) b.visible = Math.sin(this.time * 3) > 0;
      if (a.mech) {
        const p = a.mech.userData.parts, t = this.time;
        if (p?.torso) {
          p.torso.rotation.y = Math.sin(t * 0.35) * 0.3;
          p.head.rotation.y = Math.sin(t * 0.5 + 1) * 0.45;
          p.arm_R.rotation.x = Math.sin(t * 0.6) * 0.12 - 0.1;
          p.arm_L.rotation.x = Math.sin(t * 0.45 + 2) * 0.1;
        }
      }
    }

    const dockDist = this.mode === 'base' ? s.position.length() : Infinity;
    if (dockDist < DOCK_RANGE && this.cargoTotal() > 0) this.unload();

    // chase camera: carry most of the craft's velocity so it holds station at cruise speed, and
    // ease the rest (a little lag still sells acceleration)
    const desired = tmp.copy(s.position).addScaledVector(fwd, this.isFrame ? -5.5 : -17).addScaledVector(up, this.isFrame ? 1.7 : 4.8);
    this.camera.position.addScaledVector(this.vel, dt * 0.92).lerp(desired, 1 - Math.exp(-7 * dt));
    this.camera.up.lerp(up, 1 - Math.exp(-4 * dt)).normalize();
    this.camera.lookAt(tmp.copy(s.position).addScaledVector(fwd, this.isFrame ? 3 : 8));
    // speed reads through a wider lens: FOV opens with velocity and kicks on boost
    const fov = 62 + (this.isFrame ? THREE.MathUtils.clamp((this.vel.length() - 15) / 90, 0, 1) * 12 + (I.boost ? 4 : 0) : 0);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-4 * dt));
      this.camera.updateProjectionMatrix();
    }
    this.sky.position.copy(this.camera.position);
    this.camera.updateMatrixWorld();
    this.updateDust(dt);


    this.info.cargo = Math.round(this.cargoTotal());
    this.info.speed = this.vel.length();
    this.info.dock = dockDist;
    this.info.zone = this.zone?.name || '';
    this.updateScreenInfo();
  }

  // Screen-space data for the HUD: target bracket, nav markers, sun flare.
  project(p, out) {
    tmp.copy(p).project(this.camera);
    const behind = tmp.z > 1;
    out.x = (tmp.x * 0.5 + 0.5) * innerWidth;
    out.y = (-tmp.y * 0.5 + 0.5) * innerHeight;
    out.on = !behind && tmp.x > -1 && tmp.x < 1 && tmp.y > -1 && tmp.y < 1;
    out.behind = behind;
    return out;
  }

  updateScreenInfo() {
    const t = this.info.target;
    if (t && this.targetRock) {
      this.project(this.targetRock.mesh.position, t);
      const d = this.camera.position.distanceTo(this.targetRock.mesh.position);
      t.size = THREE.MathUtils.clamp((this.targetRock.radius / Math.max(1, d)) * innerHeight * 0.9, 34, 220);
    }
    const markers = [];
    if (this.mode === 'base' && this.station) {
      const m = this.project(new THREE.Vector3(0, 0, 0), { label: BODY[this.baseId].base, dist: this.craft.position.length(), kind: 'home' });
      if (m.dist > 40) markers.push(m);
      if (this.parked) {
        const b = this.project(BERTH, { label: 'YOUR SHIP', dist: this.craft.position.distanceTo(BERTH), kind: 'home' });
        if (b.dist > BOARD_RANGE) markers.push(b);
      }
    }
    if (this.mode === 'voyage' && this.celest?.dest?.dir) {
      for (const [c, kind] of [[this.celest.dest, 'dest'], [this.celest.origin, 'origin']]) {
        const m = this.project(tmp2.copy(c.dir).multiplyScalar(7000).add(this.camera.position), { label: BODY[c.id].name, km: c.km, kind });
        markers.push(m);
      }
      const conv = this.project(new THREE.Vector3(0, 0, 0), { label: 'CONVOY', dist: this.craft.position.length(), kind: 'home' });
      if (conv.dist > 60) markers.push(conv);
    }
    this.info.markers = markers;
    // sun flare: on-screen position and whether a planet blocks it
    const sp = this.project(tmp2.copy(this.sunDir).multiplyScalar(5000).add(this.camera.position), this.info.sun);
    let vis = sp.on ? 1 : 0;
    if (vis && this.planet && this.baseId !== 'sun') {
      const R = this.planet.geometry.parameters.radius;
      const oc = tmp.copy(this.camera.position).sub(this.planet.position);
      const b = oc.dot(this.sunDir), c = oc.lengthSq() - R * R;
      if (b * b - c > 0 && -b > 0) vis = 0;
    }
    if (this.baseId === 'sun') vis = 0;
    this.info.sun.vis = THREE.MathUtils.lerp(this.info.sun.vis0 || 0, vis, 0.15);
    this.info.sun.vis0 = this.info.sun.vis;
  }

  updateMining(dt, mining, fwd) {
    const s = this.craft;
    let target = null, best = 46;
    for (const r of this.rocks) {
      if (!r.alive || r.grow !== undefined) continue;
      const d = tmp.copy(r.mesh.position).sub(s.position);
      const dist = d.length() - r.radius;
      if (dist < best && d.normalize().dot(fwd) > 0.72) { best = dist; target = r; }
    }
    this.targetRock = target;
    this.info.target = target ? { res: target.res, dist: best, hp: target.hp / target.maxHp, kind: target.kind } : null;
    const active = mining && target;
    this.beam.visible = this.spark.visible = !!active;
    if (!active) return;
    const nose = s.userData.muzzle.getWorldPosition(v3());
    const hit = target.mesh.position.clone().addScaledVector(nose.clone().sub(target.mesh.position).normalize(), target.radius * 0.85);
    this.setBeam(this.beam, nose, hit);
    this.beam.material.opacity = 0.6 + Math.random() * 0.4;
    this.spark.position.copy(hit);
    this.spark.scale.setScalar(2 + Math.random() * 2);
    this.mineTimer += dt;
    if (this.mineTimer < 0.35) return;
    this.mineTimer = 0;
    if (this.cargoTotal() >= this.capacity()) {
      if (this.time - this.fullWarned > 4) {
        this.fullWarned = this.time;
        emit('toast', { text: this.mode === 'voyage' ? 'Fleet hold full · it unloads on arrival' : 'Cargo hold full · fly back to the station to unload', kind: 'bad' });
      }
      return;
    }
    const h = this.hold();
    h[target.res] = (h[target.res] || 0) + 1;
    target.hp--;
    haptic('light');
    const k = 0.45 + 0.55 * (target.hp / target.maxHp);
    target.mesh.scale.copy(target.scale).multiplyScalar(k);
    if (target.hp <= 0) {
      target.alive = false;
      target.mesh.visible = false;
      target.respawnAt = this.time + 40;
      if (target.drift) target.gone = true;
    }
  }
}
