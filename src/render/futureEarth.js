import * as THREE from 'three';
import { glowSprite } from './shaders.js';

// Earth, 2087: the real planet underneath (terrain + satellite imagery), with an imagined
// cyberpunk future built on top: neon megacities on real land, holographic billboards, sky
// traffic, a space elevator rising from the sea off Singapore (1.3° from the equator) to an
// equatorial orbital ring that arcs across the sky.

const R = 6371000, D2R = Math.PI / 180;

// radius (m), tower count, tallest megatower (m), city-grid angle, palette bias
export const FUTURE_CITIES = {
  singapore: { r: 11000, n: 1700, mega: 2400, grid: 0.35, hue: 0, title: 'Neo-Singapore · Equator Skyport' },
  tokyo: { r: 22000, n: 2200, mega: 2000, grid: 0.12, hue: 1, title: 'Tokyo Megaplex' },
  dubai: { r: 12000, n: 1300, mega: 2800, grid: 0.6, hue: 2, title: 'Dubai Solar Arcology' },
  nyc: { r: 13000, n: 1700, mega: 1900, grid: 0.5, hue: 1, title: 'New York Vertical City' },
  paris: { r: 9000, n: 1000, mega: 900, grid: 0.2, hue: 3, title: 'Paris Lumière District' },
  rio: { r: 11000, n: 1100, mega: 1200, grid: 0.8, hue: 0, title: 'Rio Neon Bay' },
  sydney: { r: 11000, n: 1100, mega: 1300, grid: 0.25, hue: 2, title: 'Sydney Harbour Spires' },
  capetown: { r: 7000, n: 700, mega: 900, grid: 0.4, hue: 3, title: 'Cape Town Tablehaven' },
  reykjavik: { r: 4500, n: 450, mega: 600, grid: 0.1, hue: 1, title: 'Reykjavík Geothermal Hub' },
  canaveral: { r: 6000, n: 500, mega: 1100, grid: 0.0, hue: 0, title: 'Canaveral Launch Metroplex' },
};
const ELEVATOR = { lat: 1.17, lon: 103.98, height: 160000 }; // off Singapore, in the strait

const PALETTES = [
  [0x00e5ff, 0xff2bd6, 0xffb347, 0xffffff], // cyan / magenta
  [0xff2bd6, 0x7a5cff, 0x00e5ff, 0xffd6f6], // magenta / violet
  [0xffb347, 0x00e5ff, 0xff6a2b, 0xfff2d8], // amber / cyan
  [0x9dff6a, 0x00e5ff, 0xff2bd6, 0xffffff], // acid green
].map((p) => p.map((h) => new THREE.Color(h)));

// ---------------------------------------------------------------- shaders
const CURVE = /* glsl */ `
  vec2 cd = w.xz - uCam.xz;
  w.y -= dot(cd, cd) / (2.0 * 6371000.0);`;

const TOWER_VERT = /* glsl */ `
uniform vec3 uCam;
attribute vec3 aColor; attribute float aSeed;
varying vec3 vLocal; varying vec3 vScale; varying vec3 vW; varying vec3 vN; varying float vSeed; varying vec3 vCol; varying float vDist;
void main(){
  vec3 scale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  ${CURVE}
  vLocal = position; vScale = scale; vW = w.xyz; vSeed = aSeed; vCol = aColor;
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vDist = distance(w.xyz, uCam);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const TOWER_FRAG = /* glsl */ `
uniform vec3 uSun; uniform float uDay; uniform float uTime; uniform vec3 uFog; uniform float uFogK; uniform vec3 uCam;
varying vec3 vLocal; varying vec3 vScale; varying vec3 vW; varying vec3 vN; varying float vSeed; varying vec3 vCol; varying float vDist;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec3 p = vLocal * vScale;
  vec3 N = normalize(vN);
  bool roof = N.y > 0.5;
  float u = abs(N.x) > 0.5 ? p.z : p.x;
  vec2 cell = floor(vec2(u / 3.2, p.y / 3.8));
  vec2 fr = fract(vec2(u / 3.2, p.y / 3.8));
  float win = step(0.12, fr.x) * step(fr.x, 0.88) * step(0.22, fr.y) * step(fr.y, 0.86);
  float lit = step(0.72 - 0.2 * vSeed, hash(cell + vSeed * 91.0)) * win;
  // facade: dark glass by day reflecting the sky, with sun shading
  vec3 L = normalize(uSun);
  vec3 glass = mix(vec3(0.05, 0.07, 0.1), vec3(0.18, 0.24, 0.32), hash(cell * 0.37 + vSeed));
  vec3 V = normalize(uCam - vW);
  float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 4.0);
  vec3 col = glass * (0.3 + 1.1 * max(dot(N, L), 0.0)) * uDay + vec3(0.45, 0.6, 0.85) * fres * 0.35 * uDay + glass * 0.04;
  if (roof) col = vec3(0.06, 0.065, 0.075) * (0.2 + uDay);
  // neon: window light, vertical edge tubes, a glowing crown band, scrolling LED strips
  float night = 1.0 - uDay;
  vec3 warm = mix(vec3(1.0, 0.82, 0.55), vCol, 0.55 * step(0.5, vSeed));
  col += warm * lit * (0.04 + 0.55 * night) * (roof ? 0.0 : 1.0);
  // distance (m) from this face's vertical corners: neon tubes ~1 m wide run up the corners
  float across = abs(N.x) > 0.5 ? abs(vLocal.z) : abs(vLocal.x);
  float faceW = abs(N.x) > 0.5 ? vScale.z : vScale.x;
  float edge = 1.0 - smoothstep(0.5, 1.3, (0.5 - across) * faceW);
  float tubes = step(0.35, vSeed) * edge * (roof ? 0.0 : 1.0);
  float crown = smoothstep(vScale.y - 14.0, vScale.y - 4.0, p.y) * (roof ? 0.0 : 1.0);
  float strip = step(0.7, vSeed) * step(0.9, fract(p.y / 40.0 - uTime * 0.3 * (vSeed - 0.5))) * (roof ? 0.0 : 1.0);
  col += vCol * (tubes * 2.6 + crown * 3.0 + strip * 1.8) * (0.06 + 0.94 * night);
  col *= 1.0 - 0.6 * smoothstep(3000.0, 20000.0, vDist) * night; // distant towers melt into the haze
  float f = 1.0 - exp(-vDist * uFogK);
  gl_FragColor = vec4(mix(col, uFog, clamp(f, 0.0, 1.0)), 1.0);
}`;

const HOLO_VERT = /* glsl */ `
uniform vec3 uCam;
attribute vec3 aColor; attribute float aSeed;
varying vec2 vUv; varying vec3 vCol; varying float vSeed; varying float vDist;
void main(){
  vUv = uv; vCol = aColor; vSeed = aSeed;
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  ${CURVE}
  vDist = distance(w.xyz, uCam);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const HOLO_FRAG = /* glsl */ `
uniform float uTime; uniform float uFogK; uniform float uDay;
varying vec2 vUv; varying vec3 vCol; varying float vSeed; varying float vDist;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  float t = uTime + vSeed * 20.0;
  vec2 uv = vUv;
  // abstract ad glyphs: blocky bars that re-scramble every couple of seconds
  vec2 g = floor(vec2(uv.x * 9.0, uv.y * 5.0));
  float glyph = step(0.45, hash(g + floor(t * 0.5) * 7.0)) * step(0.2, fract(uv.x * 9.0)) * step(0.2, fract(uv.y * 5.0));
  float frame = 1.0 - step(0.04, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  float scan = 0.65 + 0.35 * sin(uv.y * 160.0 - t * 12.0);
  float flick = 0.85 + 0.15 * step(0.93, hash(vec2(floor(t * 12.0), vSeed)));
  vec3 c = mix(vCol, vec3(1.0), 0.15) * (glyph * 0.9 + frame * 1.5 + 0.12) * scan * flick;
  float fade = exp(-vDist * uFogK * 0.6);
  gl_FragColor = vec4(c * 2.0 * fade * (0.25 + 0.75 * (1.0 - uDay)), 1.0);
}`;

const TRAFFIC_VERT = /* glsl */ `
uniform float uTime; uniform vec3 uCam; uniform float uPR; uniform float uDay;
attribute vec4 aOrbit; attribute float aSpeed; attribute vec3 aColor;
varying vec3 vCol; varying float vA;
void main(){
  float a = aOrbit.w + uTime * aSpeed;
  vec3 local = vec3(cos(a) * aOrbit.x, aOrbit.z + sin(a * 3.0 + aOrbit.w) * 30.0, sin(a) * aOrbit.y);
  vec4 w = modelMatrix * vec4(local, 1.0);
  ${CURVE}
  vec4 mv = viewMatrix * w;
  float d = -mv.z;
  gl_PointSize = clamp(1400.0 / d, 1.5, 7.0) * uPR;
  vA = clamp(3500.0 / d, 0.15, 1.0) * (0.3 + 0.7 * (1.0 - uDay));
  vCol = aColor;
  gl_Position = projectionMatrix * mv;
}`;
const TRAFFIC_FRAG = /* glsl */ `
varying vec3 vCol; varying float vA;
void main(){
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(vCol * (exp(-d * d * 6.0) * 2.5) * vA, 1.0);
}`;

const TETHER_FRAG = /* glsl */ `
uniform float uTime; varying vec2 vUv;
void main(){
  float pulse = 0.6 + 0.4 * sin(vUv.y * 900.0 - uTime * 4.0);
  float core = pow(1.0 - abs(vUv.x - 0.5) * 2.0, 2.0);
  vec3 c = mix(vec3(0.0, 0.9, 1.0), vec3(1.0, 0.2, 0.85), smoothstep(0.0, 1.0, vUv.y)) * core * pulse * 3.0;
  gl_FragColor = vec4(c, 1.0);
}`;

function hashRand(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export class FutureEarth {
  constructor(view) {
    this.view = view;
    this.group = new THREE.Group();
    view.scene.add(this.group);
    this.cities = {};
    this.uniforms = {
      uCam: { value: new THREE.Vector3() }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uDay: { value: 1 }, uTime: { value: 0 },
      uFog: { value: new THREE.Color() }, uFogK: { value: 0 }, uPR: { value: 1 },
    };
    this.buildElevator();
    this.buildRing();
  }

  // ---------------- cities
  buildCity(place, cfg) {
    const v = this.view, rnd = hashRand(place.lat * 1000 + place.lon * 7);
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const towers = [], holos = [];
    const pal = PALETTES[cfg.hue];
    const ca = Math.cos(cfg.grid), sa = Math.sin(cfg.grid);
    const spot = (r) => {
      // blocks on a rotated street grid, denser and taller toward the core
      const a = rnd() * Math.PI * 2, d = cfg.r * Math.pow(rnd(), 0.75) * r;
      let x = Math.cos(a) * d, z = Math.sin(a) * d;
      const gx = Math.round((x * ca + z * sa) / 140) * 140, gz = Math.round((-x * sa + z * ca) / 140) * 140;
      x = gx * ca - gz * sa; z = gx * sa + gz * ca;
      return { x, z, d };
    };
    const ground = (x, z) => {
      const lat = place.lat + (-z / R) / D2R, lon = place.lon + (x / (R * Math.cos(place.lat * D2R))) / D2R;
      return v.groundHeight(lat, lon);
    };
    const used = new Set();
    for (let i = 0; i < cfg.n * 2.2 && towers.length < cfg.n; i++) {
      const s = spot(1);
      const key = `${Math.round(s.x / 70)},${Math.round(s.z / 70)}`;
      if (used.has(key)) continue;
      const g = ground(s.x, s.z);
      if (g === null || g < 1.5 || g > 900) continue; // land only (no sea), not up mountainsides
      used.add(key);
      const core = Math.exp(-((s.d / (cfg.r * 0.28)) ** 2));
      const megaChance = core > 0.6 && rnd() < 0.04;
      const h = megaChance ? cfg.mega * (0.6 + rnd() * 0.4) : 25 + rnd() * 90 + core * rnd() ** 2 * cfg.mega * 0.55;
      const w = megaChance ? 90 + rnd() * 70 : 22 + rnd() * 40 + core * 25;
      const dpt = megaChance ? w : 22 + rnd() * 40 + core * 25;
      towers.push({ x: s.x, z: s.z, y: g, w, h, d: dpt, rot: cfg.grid, seed: rnd(), col: pal[(rnd() * 3) | 0] });
      if (h > 260 && rnd() < 0.55) {
        const side = (rnd() * 4) | 0, ang = cfg.grid + side * Math.PI / 2;
        const hw = side % 2 ? dpt : w;
        holos.push({ x: s.x, z: s.z, y: g + h * (0.55 + rnd() * 0.3), w: hw * 0.9, h: Math.min(120, h * 0.18), ang, off: (side % 2 ? w : dpt) / 2 + 2, seed: rnd(), col: pal[(rnd() * 3) | 0] });
      }
    }
    if (!towers.length) return null;
    const g = new THREE.Group();
    // towers
    const tm = new THREE.InstancedMesh(box, new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: TOWER_VERT, fragmentShader: TOWER_FRAG }), towers.length);
    const colA = new Float32Array(towers.length * 3), seedA = new Float32Array(towers.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    towers.forEach((t, i) => {
      m.compose(pos.set(t.x, t.y - 2, t.z), q.setFromAxisAngle(Y, -t.rot), sc.set(t.w, t.h + 2, t.d));
      tm.setMatrixAt(i, m);
      colA.set([t.col.r, t.col.g, t.col.b], i * 3);
      seedA[i] = t.seed;
    });
    tm.geometry = box.clone();
    tm.geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colA, 3));
    tm.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seedA, 1));
    tm.frustumCulled = false;
    g.add(tm);
    // holographic billboards on the tall towers
    if (holos.length) {
      const plane = new THREE.PlaneGeometry(1, 1);
      const hm = new THREE.InstancedMesh(plane, new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG, side: THREE.DoubleSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), holos.length);
      const hc = new Float32Array(holos.length * 3), hs = new Float32Array(holos.length);
      holos.forEach((b, i) => {
        const dir = new THREE.Vector3(Math.sin(b.ang), 0, Math.cos(b.ang));
        m.compose(pos.set(b.x, b.y, b.z).addScaledVector(dir, b.off), q.setFromAxisAngle(Y, b.ang), sc.set(b.w, b.h, 1));
        hm.setMatrixAt(i, m);
        hc.set([b.col.r, b.col.g, b.col.b], i * 3);
        hs[i] = b.seed;
      });
      hm.geometry = plane.clone();
      hm.geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(hc, 3));
      hm.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(hs, 1));
      hm.frustumCulled = false;
      g.add(hm);
    }
    // sky traffic: lanes of flying vehicles circling the towers
    const n = Math.round(cfg.n * 1.4), orbit = new Float32Array(n * 4), speed = new Float32Array(n), tc = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const rr = cfg.r * (0.08 + Math.pow(rnd(), 0.8) * 0.75);
      orbit.set([rr, rr * (0.7 + rnd() * 0.6), 120 + rnd() * 700 * (1 - rr / cfg.r), rnd() * Math.PI * 2], i * 4);
      speed[i] = (rnd() < 0.5 ? -1 : 1) * (60 + rnd() * 120) / rr;
      const c = rnd() < 0.45 ? new THREE.Color(1, 0.25, 0.3) : rnd() < 0.6 ? new THREE.Color(1, 1, 1) : pal[(rnd() * 2) | 0];
      tc.set([c.r, c.g, c.b], i * 3);
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    tg.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 4));
    tg.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    tg.setAttribute('aColor', new THREE.BufferAttribute(tc, 3));
    const pts = new THREE.Points(tg, new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: TRAFFIC_VERT, fragmentShader: TRAFFIC_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    pts.frustumCulled = false;
    g.add(pts);
    this.group.add(g);
    return { g, place, towers: towers.length };
  }

  // ---------------- space elevator + orbital ring
  buildElevator() {
    const g = new THREE.Group();
    const H = ELEVATOR.height;
    const tether = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: TETHER_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    tether.scale.set(60, H, 1);
    tether.position.y = H / 2;
    tether.frustumCulled = false;
    this.tether = tether;
    g.add(tether);
    // anchor platform: a neon ring city on the water
    const base = new THREE.Mesh(new THREE.CylinderGeometry(650, 720, 60, 64), new THREE.MeshStandardMaterial({ color: 0x14171d, metalness: 0.8, roughness: 0.35 }));
    base.position.y = 30;
    g.add(base);
    for (const [r, c] of [[700, 0x00e5ff], [520, 0xff2bd6], [300, 0x00e5ff]]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 6, 6, 96), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(4) }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 62;
      g.add(ring);
    }
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(40, 160, 1400, 24), new THREE.MeshStandardMaterial({ color: 0x1c2029, metalness: 0.9, roughness: 0.3, emissive: 0x062a3a }));
    spire.position.y = 700;
    g.add(spire);
    // cargo climbers riding the tether
    this.climbers = Array.from({ length: 6 }, (_, i) => {
      const s = glowSprite(i % 2 ? 0xff2bd6 : 0x7fe9ff, 900, 3);
      s.userData.phase = i / 6;
      g.add(s);
      return s;
    });
    this.elevator = g;
    this.group.add(g);
  }

  buildRing() {
    // equatorial orbital ring at 600 km, drawn by direction (it lives beyond the far plane)
    const n = 9000; // dense: only the arc above your horizon is visible
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.ringPts = new THREE.Points(geo, new THREE.PointsMaterial({ color: new THREE.Color(0x9ff4ff).multiplyScalar(2.2), size: 3.5, sizeAttenuation: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.ringPts.frustumCulled = false;
    this.ringPts.renderOrder = -7;
    this.group.add(this.ringPts);
    this.ringN = n;
  }

  updateRing() {
    const v = this.view, la = v.info.lat * D2R, lo = v.info.lon * D2R;
    // Earth-fixed basis: x = lon 0, y = north, -z = lon 90°E
    const U = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
    const E = new THREE.Vector3(-Math.sin(lo), 0, -Math.cos(lo));
    const N = new THREE.Vector3().crossVectors(U, E);
    const obs = U.clone().multiplyScalar(R + v.pos.y);
    const p = new THREE.Vector3(), out = this.ringPts.geometry.attributes.position, dist = v.camera.far * 0.8;
    for (let i = 0; i < this.ringN; i++) {
      const a = (i / this.ringN) * Math.PI * 2;
      p.set(Math.cos(a), 0, -Math.sin(a)).multiplyScalar(R + 600000).sub(obs);
      // hidden if the line of sight passes through the planet first
      const len = p.length();
      p.normalize();
      const b = obs.dot(p), c = obs.lengthSq() - R * R, disc = b * b - c;
      const below = disc > 0 && -b - Math.sqrt(disc) > 0 && -b - Math.sqrt(disc) < len;
      const x = p.dot(E), y = p.dot(U), z = -p.dot(N);
      out.setXYZ(i, below ? 0 : x * dist, below ? -1e7 : y * dist, below ? 0 : z * dist);
    }
    out.needsUpdate = true;
  }

  // ---------------- per frame
  update(dt, ctx) {
    const v = this.view, u = this.uniforms;
    u.uTime.value += dt;
    u.uCam.value.copy(v.camera.position);
    u.uSun.value.copy(ctx.sun);
    u.uDay.value = ctx.day;
    u.uFog.value.copy(ctx.fog);
    u.uFogK.value = ctx.fogK;
    u.uPR.value = v.app.renderer.getPixelRatio();

    // build cities near the player (needs terrain heights to keep towers on land)
    if ((this.cityAcc = (this.cityAcc ?? 99) + dt) > 1) {
      this.cityAcc = 0;
      for (const p of ctx.places) {
        const cfg = FUTURE_CITIES[p.id];
        if (!cfg) continue;
        const near = ctx.dist(p) < 150000;
        const c = this.cities[p.id];
        if (near && !c && v.groundHeight(p.lat, p.lon) !== null) {
          const built = this.buildCity(p, cfg);
          if (built) this.cities[p.id] = built;
        } else if (!near && c) {
          this.group.remove(c.g);
          c.g.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
          delete this.cities[p.id];
        }
      }
      this.updateRing();
    }
    for (const id in this.cities) {
      const c = this.cities[id];
      ctx.project(c.place.lat, c.place.lon, c.g.position);
    }
    // elevator anchor + climbers
    ctx.project(ELEVATOR.lat, ELEVATOR.lon, this.elevator.position);
    this.elevator.position.y = 0;
    const d = Math.hypot(this.elevator.position.x - v.camera.position.x, this.elevator.position.z - v.camera.position.z);
    this.elevator.visible = d < v.camera.far * 1.5;
    this.elevator.position.y = -(d * d) / (2 * R);
    this.tether.rotation.set(0, Math.atan2(v.camera.position.x - this.elevator.position.x, v.camera.position.z - this.elevator.position.z), 0);
    for (const s of this.climbers) {
      const k = (s.userData.phase + u.uTime.value * 0.004) % 1;
      s.position.y = 2000 + k * (ELEVATOR.height - 4000);
      s.scale.setScalar(600 + d * 0.01);
    }
    this.ringPts.position.copy(v.camera.position);
    this.ringPts.material.opacity = 0.35 + 0.65 * (1 - ctx.day * 0.6);
  }

  citiesGlow() {
    return Object.values(this.cities).map((c) => c.g.position);
  }
}
