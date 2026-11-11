import * as THREE from 'three';
import { Area, label } from './area.js';
import { worldBox, ladderTexture } from '../chars/simTextures.js';
import { portalGate } from './portal.js';

// SINGAPORE · MARINA BAY — a simulated area reached through the training sim's portal atrium.
//
// A half-scale model of downtown Singapore around Marina Bay. Landmarks are placed from their real coordinates
// (lat/lon -> metres, then halved), so the layout reads true: the Merlion spouting into the bay at the river mouth,
// the Fullerton behind it and Boat Quay's shophouses up the river, the Esplanade's two spiked domes, the Float,
// the Helix Bridge, the ArtScience lotus, Marina Bay Sands with its SkyPark 100 m up, the Singapore Flyer, the
// Supertree Grove with its walkable skyway, the Flower Dome and Cloud Forest, the Marina Barrage, the Padang and
// civic district, Suntec City and the Raffles Place / Marina Bay Financial Centre skyline. Ordinary city blocks,
// street trees and the rest of the island beyond the playable bounds are generated (seeded, so it's the same city
// every visit). The bay is wadeable: fall in and you can climb back out onto the quay.
//
// Collision is the parkour controller's axis-aligned boxes: the land is rasterised into strips around the water
// polygon, and every building is solid and climbable.

const SP = 0.5;                                   // world metres per real metre (distances and buildings)
const LAT0 = 1.2850, LON0 = 103.8580;             // origin: the middle of Marina Bay
export const ll = (lat, lon) => [(lon - LON0) * 111320 * SP, -(lat - LAT0) * 110600 * SP];
const B = { x0: -520, x1: 800, z0: -600, z1: 450 };   // playable bounds
const WATER_Y = -0.5, BED_Y = -1.2;

// Marina Bay, the Singapore River mouth and the reservoir channel out past Gardens by the Bay to the barrage
// (x east, z south, half-scale metres)
const WATER = [
  [-182, 150], [-182, -118], [-240, -124], [-760, -128], [-760, -154], [-240, -152], [-178, -168], [-125, -205],
  [0, -212], [160, -214], [280, -188], [420, -130], [560, 30], [900, 330], [900, 400], [740, 340], [540, 110],
  [400, -40], [260, -112], [130, -104], [95, -100], [52, -92], [44, -50], [92, -36], [92, 150],
];

// arrival points offered by the portal (also used before the area is built)
export const SG_SPOTS = [
  { name: 'Merlion Park', sub: 'the Merlion · river mouth', pos: [-192, 0, -70], yaw: Math.PI },
  { name: 'Marina Bay Sands SkyPark', sub: 'on the ship, 100 m up', pos: [168, 100, 70], yaw: -Math.PI / 2 },
  { name: 'Supertree Grove', sub: 'the OCBC Skyway', pos: [298, 15, 176], yaw: Math.PI / 2 },
  { name: 'Helix Bridge', sub: 'across the bay', pos: [140, 0, -208], yaw: 0 },
  { name: 'Esplanade', sub: 'theatres on the bay', pos: [-150, 0, -205], yaw: Math.PI },
  { name: 'Singapore Flyer', sub: 'the wheel', pos: [250, 0, -205], yaw: 2.34 },
  { name: 'Gardens by the Bay', sub: 'Flower Dome · Cloud Forest', pos: [380, 0, 150], yaw: 2.52 },
  { name: 'Boat Quay', sub: 'shophouses on the river', pos: [-440, 0, -119], yaw: Math.PI / 2 },
];

const ZONES = [
  ['MERLION PARK', -190, -95, 40], ['FULLERTON', -273, -72, 40], ['BOAT QUAY', -380, -115, 85], ['ESPLANADE', -140, -245, 70],
  ['THE FLOAT', 70, -205, 40], ['HELIX BRIDGE', 140, -160, 55], ['ARTSCIENCE MUSEUM', 72, -72, 40], ['MARINA BAY SANDS', 150, 70, 95],
  ['SINGAPORE FLYER', 284, -238, 70], ['SUPERTREE GROVE', 310, 190, 70], ['GARDENS BY THE BAY', 450, 160, 170], ['MARINA BARRAGE', 740, 260, 80],
  ['RAFFLES PLACE', -380, 40, 130], ['MARINA BAY FINANCIAL CENTRE', -190, 260, 100], ['PADANG', -295, -290, 60], ['CIVIC DISTRICT', -410, -320, 150],
  ['SUNTEC CITY', 56, -553, 90], ['MARINA CENTRE', 50, -380, 150], ['MARINA SOUTH', 40, 330, 150],
];

// ---------------- small helpers ----------------
const rngOf = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
function canvasTex(w, h, draw, { srgb = true } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
function speckle(g, w, h, amt, seed) {
  const r = rngOf(seed), im = g.getImageData(0, 0, w, h), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const k = 1 + (r() - 0.5) * amt; d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; }
  g.putImageData(im, 0, 0);
}
function waterSpans(z) {
  const xs = [];
  for (let i = 0, n = WATER.length; i < n; i++) {
    const [ax, az] = WATER[i], [bx, bz] = WATER[(i + 1) % n];
    if ((az > z) !== (bz > z)) xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
  }
  return xs.sort((a, b) => a - b);
}
export function inWater(x, z) { let c = 0; for (const v of waterSpans(z)) if (v < x) c++; return c % 2 === 1; }
const nearWater = (x, z, m) => inWater(x, z) || inWater(x + m, z) || inWater(x - m, z) || inWater(x, z + m) || inWater(x, z - m);
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}
const overlap = (a, b, pad = 0) => a[0] < b[2] + pad && a[2] > b[0] - pad && a[1] < b[3] + pad && a[3] > b[1] - pad;

// ---------------- textures ----------------
// glass curtain wall: one tile = 8 m = 4 half-scale storeys, 6 panels across, a few lit
function curtainWall(glass, frame, seed, lit = 0.06) {
  const r = rngOf(seed), on = [];
  const map = canvasTex(256, 256, (g, n) => {
    const rows = 4, cols = 6, ch = n / rows, cw = n / cols;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const k = 0.85 + r() * 0.3;
      const gr = g.createLinearGradient(x * cw, y * ch, x * cw + cw, y * ch + ch);
      gr.addColorStop(0, shade(glass, k * 1.3)); gr.addColorStop(1, shade(glass, k * 0.78));
      g.fillStyle = gr; g.fillRect(x * cw, y * ch, cw, ch);
      if (r() < lit) on.push([x, y]);
    }
    g.fillStyle = frame;
    for (let y = 0; y <= rows; y++) g.fillRect(0, y * ch - 4, n, 8);
    for (let x = 0; x <= cols; x++) g.fillRect(x * cw - 1, 0, 2, n);
  });
  const emissiveMap = canvasTex(256, 256, (g, n) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, n, n); g.fillStyle = '#d8c08a';
    for (const [x, y] of on) g.fillRect(x * n / 6 + 3, y * n / 4 + 6, n / 6 - 6, n / 4 - 12);
  });
  return new THREE.MeshStandardMaterial({ map, emissiveMap, emissive: 0xffffff, emissiveIntensity: 0.3, metalness: 0.55, roughness: 0.22 });
}
// punched-window wall (HDB flats, offices, hotels): 4 storeys a tile, a coloured accent band on the stair core
function windowWall(wall, accent, seed) {
  const r = rngOf(seed);
  const map = canvasTex(256, 256, (g, n) => {
    g.fillStyle = wall; g.fillRect(0, 0, n, n);
    g.fillStyle = accent; g.fillRect(0, 0, 34, n);
    for (let y = 0; y < 4; y++) {
      g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(34, y * 64 + 56, n, 6);                 // ledge
      for (let x = 0; x < 4; x++) {
        const wx = 46 + x * 52, wy = y * 64 + 16;
        g.fillStyle = r() < 0.2 ? '#d9c690' : '#3c4a58'; g.fillRect(wx, wy, 38, 32);
        g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(wx, wy, 38, 6);
      }
    }
    speckle(g, n, n, 0.08, seed + 3);
  });
  return new THREE.MeshStandardMaterial({ map, roughness: 0.85 });
}
// colonial: cream plaster, two storeys of tall arched windows between pilasters
function colonialWall(wall, seed) {
  const map = canvasTex(256, 256, (g, n) => {
    g.fillStyle = wall; g.fillRect(0, 0, n, n);
    for (let y = 0; y < 2; y++) {
      g.fillStyle = 'rgba(0,0,0,0.1)'; g.fillRect(0, y * 128 + 118, n, 10);
      for (let x = 0; x < 4; x++) {
        const cx = x * 64 + 32, top = y * 128 + 22;
        g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(x * 64, y * 128, 8, 128);       // pilaster
        g.fillStyle = '#4b5560';
        g.beginPath(); g.moveTo(cx - 14, top + 80); g.lineTo(cx - 14, top + 14); g.arc(cx, top + 14, 14, Math.PI, 0); g.lineTo(cx + 14, top + 80); g.fill();
        g.fillStyle = 'rgba(40,60,50,0.6)'; g.fillRect(cx - 14, top + 30, 28, 4);
      }
    }
    speckle(g, n, n, 0.06, seed);
  });
  return new THREE.MeshStandardMaterial({ map, roughness: 0.9 });
}
// a shophouse front: five-foot-way arches below, shuttered windows above, a cornice
function shophouseTex(color, shutter, seed) {
  return canvasTex(128, 192, (g) => {
    g.fillStyle = color; g.fillRect(0, 0, 128, 192);
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(0, 0, 128, 10); g.fillRect(0, 118, 128, 6);
    for (let i = 0; i < 3; i++) {
      const x = 14 + i * 38;
      g.fillStyle = shutter; g.fillRect(x, 26, 24, 42); g.fillRect(x, 76, 24, 34);
      g.fillStyle = 'rgba(0,0,0,0.25)'; for (let k = 0; k < 8; k++) g.fillRect(x, 28 + k * 5, 24, 1.5);
    }
    g.fillStyle = '#3a3330';
    g.beginPath(); g.moveTo(14, 192); g.lineTo(14, 150); g.arc(64, 150, 50, Math.PI, 0); g.lineTo(114, 192); g.fill();
    g.fillStyle = '#e9c98a'; g.fillRect(40, 160, 48, 32);
    speckle(g, 128, 192, 0.1, seed);
  });
}

// ---------------- the build ----------------
export function buildSingapore() {
  const A = new Area('singapore'), S = A.scene;
  const rng = rngOf(1965);
  const occ = [];        // reserved ground (no generated buildings)
  const foot = [];       // building footprints (no trees)
  const roads = [];
  const trees = [];      // [x, y, z, s, type] type 0 rain tree, 1 palm
  const labels = [];
  const anim = [];       // per-frame callbacks (t, dt)

  // ===== sky, light, fog =====
  S.background = new THREE.Color(0xd9e7ef);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1900, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color(0x3f86d8) }, hor: { value: new THREE.Color(0xe4eef4) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top, hor; varying vec3 vP; void main(){ float h = clamp(vP.y, 0.0, 1.0); gl_FragColor = vec4(mix(hor, top, pow(h, 0.5)), 1.0); }',
  }));
  sky.renderOrder = -1;
  S.add(sky);
  {
    const cc = document.createElement('canvas'); cc.width = cc.height = 128;
    const cg = cc.getContext('2d'), grd = cg.createRadialGradient(64, 64, 4, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    cg.fillStyle = grd; cg.fillRect(0, 0, 128, 128);
    const cloudMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cc), transparent: true, depthWrite: false, fog: false });
    const clouds = new THREE.Group();
    for (let i = 0; i < 70; i++) {
      const s = new THREE.Sprite(cloudMat);
      const a = rng() * Math.PI * 2, r = 900 + rng() * 800;
      s.position.set(Math.cos(a) * r, 220 + rng() * 260, Math.sin(a) * r);
      s.scale.set(240 + rng() * 260, 90 + rng() * 70, 1);
      clouds.add(s);
    }
    S.add(clouds);
    anim.push((t, dt, view) => clouds.position.set(view.camera.position.x, 0, view.camera.position.z));
  }
  S.fog = new THREE.Fog(0xd9e7ef, 520, 1950);
  S.add(new THREE.HemisphereLight(0xd8ecff, 0x6f6a5c, 0.7));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -75, right: 75, top: 75, bottom: -75, near: 1, far: 420 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  S.add(sun, sun.target);
  A.sun = sun; A.sunOff = [70, 170, -50];

  // ===== materials =====
  const M = (o) => new THREE.MeshStandardMaterial(o);
  const roofMat = M({ color: 0x55585e, roughness: 0.95 });
  const white = M({ color: 0xf1efe9, roughness: 0.55 });
  const steel = M({ color: 0xc9ced6, metalness: 0.85, roughness: 0.3 });
  const darkSteel = M({ color: 0x3a3f47, metalness: 0.7, roughness: 0.4 });
  const glassClear = M({ color: 0xbfe2ee, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.35, depthWrite: false });
  const decal = (o, f = -2) => M({ ...o, polygonOffset: true, polygonOffsetFactor: f, polygonOffsetUnits: f });
  const pavingTex = canvasTex(256, 256, (g, n) => {
    g.fillStyle = '#8f8a80'; g.fillRect(0, 0, n, n);
    const r = rngOf(4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = shade('#8f8a80', 0.88 + r() * 0.2); g.fillRect(x * 32 + 1, y * 32 + 1, 30, 30); }
    speckle(g, n, n, 0.1, 5);
  });
  pavingTex.repeat.set(1 / 8, 1 / 8);
  const grassTex = canvasTex(256, 256, (g, n) => {
    g.fillStyle = '#5e8f3e'; g.fillRect(0, 0, n, n);
    const r = rngOf(8);
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(${r() < 0.5 ? '40,80,30' : '120,160,70'},0.25)`; g.fillRect(r() * n, r() * n, 2 + r() * 5, 2 + r() * 5); }
  });
  grassTex.repeat.set(1 / 10, 1 / 10);
  const grass = decal({ map: grassTex, roughness: 0.95 }, -1);
  const roadTex = canvasTex(128, 256, (g) => {
    g.fillStyle = '#3b3d42'; g.fillRect(0, 0, 128, 256);
    speckle(g, 128, 256, 0.18, 9);
    g.fillStyle = '#e8e8e2'; g.fillRect(6, 0, 3, 256); g.fillRect(119, 0, 3, 256);
    for (let y = 0; y < 256; y += 64) g.fillRect(62, y, 4, 34);
  });
  const roadMat = decal({ map: roadTex, roughness: 0.9 }, -4);
  const glassMats = [['#5b7d99', '#c9d2da', 1], ['#3f6b6e', '#b8c4c0', 2], ['#7e8f9e', '#e2e6ea', 3], ['#4a5a78', '#9aa6b8', 4], ['#8aa7b0', '#f0f0ec', 5], ['#2f4a5e', '#7f8c99', 6], ['#6d8a7c', '#d6dcd2', 7]]
    .map(([a, b, s]) => curtainWall(a, b, s));
  const flatMats = [['#ece8de', '#7fb3c9', 11], ['#e9e2d2', '#d98c6a', 12], ['#dfe3e4', '#8fbf8a', 13], ['#efe9dc', '#c9a35a', 14], ['#e4ddd0', '#9a8fc9', 15]]
    .map(([a, b, s]) => windowWall(a, b, s));
  const colonialMats = [colonialWall('#efe6cf', 21), colonialWall('#f4f1ea', 22), colonialWall('#e8dabb', 23)];
  const faces = (mat, roof = roofMat) => [mat, mat, roof, roof, mat, mat];

  // ===== water, land and their collision =====
  {
    // the water: an animated normal map over a deep teal
    const nTex = canvasTex(256, 256, (g, n) => {
      const im = g.createImageData(n, n), d = im.data;
      const h = (x, y) => Math.sin((x / n) * Math.PI * 2 * 3 + Math.sin((y / n) * Math.PI * 2 * 2)) * 0.5 + Math.sin((y / n) * Math.PI * 2 * 5 + (x / n) * Math.PI * 2 * 2) * 0.35 + Math.sin(((x + y) / n) * Math.PI * 2 * 7) * 0.15;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const dx = (h(x + 1, y) - h(x - 1, y)) * 3, dy = (h(x, y + 1) - h(x, y - 1)) * 3;
        const l = Math.hypot(dx, dy, 1), i = (y * n + x) * 4;
        d[i] = (-dx / l * 0.5 + 0.5) * 255; d[i + 1] = (-dy / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
      }
      g.putImageData(im, 0, 0);
    }, { srgb: false });
    nTex.repeat.set(220, 220);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), M({ color: 0x24606b, roughness: 0.12, metalness: 0.15, normalMap: nTex, normalScale: new THREE.Vector2(0.35, 0.35) }));
    water.rotation.x = -Math.PI / 2; water.position.y = WATER_Y; water.receiveShadow = true;
    S.add(water);
    anim.push((t) => { nTex.offset.set(t * 0.004, t * 0.0025); });

    // the land: the island around the bay, quay walls down to the water
    const shape = new THREE.Shape([[-1800, -1800], [1000, -1800], [1000, 500], [-1800, 500]].map(([x, z]) => new THREE.Vector2(x, -z)));
    shape.holes.push(new THREE.Path(WATER.map(([x, z]) => new THREE.Vector2(x, -z))));
    const lg = new THREE.ExtrudeGeometry(shape, { depth: 1.6, bevelEnabled: false, steps: 1 });
    lg.rotateX(-Math.PI / 2); lg.translate(0, -1.6, 0);
    const land = new THREE.Mesh(lg, [M({ map: pavingTex, roughness: 0.9 }), M({ color: 0x6f6a62, roughness: 0.9 })]);
    land.receiveShadow = true;
    S.add(land); A.meshes.push(land);

    // collision: the bay floor everywhere, land as strips scanned row by row around the water and merged
    A.collider(B.x0, BED_Y - 1, B.z0, B.x1 - B.x0, 1, B.z1 - B.z0);
    const C = 2;
    let open = new Map();
    const emit = (k, z0, z1) => { const [a, b] = k.split('|').map(Number); A.collider(a, BED_Y, z0, b - a, -BED_Y, z1 - z0); };
    for (let z = B.z0; z < B.z1; z += C) {
      const xs = waterSpans(z + C / 2), strips = [];
      let cur = B.x0;
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const w0 = Math.max(B.x0, xs[i]), w1 = Math.min(B.x1, xs[i + 1]);
        if (w1 <= B.x0 || w0 >= B.x1) continue;
        if (w0 > cur) strips.push([cur, w0]);
        cur = Math.max(cur, w1);
      }
      if (cur < B.x1) strips.push([cur, B.x1]);
      const next = new Map();
      for (const [a, b] of strips) { const k = `${a.toFixed(2)}|${b.toFixed(2)}`; next.set(k, open.has(k) ? open.get(k) : z); open.delete(k); }
      for (const [k, z0] of open) emit(k, z0, z);
      open = next;
    }
    for (const [k, z0] of open) emit(k, z0, B.z1);
    // the edge of the simulation
    A.collider(B.x0 - 2, BED_Y, B.z0, 2, 600, B.z1 - B.z0); A.collider(B.x1, BED_Y, B.z0, 2, 600, B.z1 - B.z0);
    A.collider(B.x0, BED_Y, B.z0 - 2, B.x1 - B.x0, 600, 2); A.collider(B.x0, BED_Y, B.z1, B.x1 - B.x0, 600, 2);
    A.killY = -12;

    // a granite coping along the quays
    const cope = M({ color: 0x8a8580, roughness: 0.8 });
    for (let i = 0; i < WATER.length; i++) {
      const [ax, az] = WATER[i], [bx, bz] = WATER[(i + 1) % WATER.length];
      const len = Math.hypot(bx - ax, bz - az);
      if (Math.abs(ax) > 1000 || Math.abs(bx) > 1000) continue;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.12, len), cope);
      m.position.set((ax + bx) / 2, 0.06, (az + bz) / 2); m.rotation.y = Math.atan2(bx - ax, bz - az);
      S.add(m);
    }
  }

  // flat decals on the ground
  const flatPoly = (pts, mat, y = 0.03) => {
    const g = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z))));
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat); m.position.y = y; m.receiveShadow = true; S.add(m);
    return m;
  };
  const road = (x0, z0, x1, z1, w) => {
    roads.push([x0, z0, x1, z1, w]);
    const len = Math.hypot(x1 - x0, z1 - z0);
    const g = new THREE.PlaneGeometry(w, len); g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * len / 16);
    const m = new THREE.Mesh(g, roadMat);
    m.position.set((x0 + x1) / 2, 0.05, (z0 + z1) / 2); m.rotation.y = Math.atan2(x1 - x0, z1 - z0); m.receiveShadow = true;
    S.add(m);
  };
  const onRoad = (r, pad) => roads.some(([x0, z0, x1, z1, w]) => {
    if (x0 === x1 || z0 === z1) return overlap(r, [Math.min(x0, x1) - w / 2, Math.min(z0, z1) - w / 2, Math.max(x0, x1) + w / 2, Math.max(z0, z1) + w / 2], pad);
    return segDist((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, x0, z0, x1, z1) < w / 2 + Math.hypot(r[2] - r[0], r[3] - r[1]) / 2 + pad;
  });
  const reserve = (r) => occ.push(r);
  const lbl = (text, sub, x, y, z, s = 22, color = '#7fe6ff') => { const l = label(text, sub, color); l.position.set(x, y, z); l.scale.set(s, s / 4, 1); S.add(l); labels.push(l); };

  // ===== roads =====
  for (const r of [
    [-209, -600, -209, 180, 12], [-520, 180, 215, 180, 14], [144, -100, 144, 180, 9], [215, -105, 215, 450, 14],
    [-209, -300, 330, -300, 12], [330, -300, 560, -600, 14], [-209, -480, 200, -480, 12], [-352, -170, -352, -600, 10],
    [-244, -170, -244, -345, 10], [-440, -170, -440, -600, 10], [-520, -160, -244, -160, 10], [-270, -40, -270, 180, 10],
    [-360, -40, -360, 180, 10], [-450, -40, -450, 180, 10], [-520, -10, -209, -10, 10], [-520, 90, -209, 90, 10],
    [-520, 300, 215, 300, 12], [-100, 180, -100, 450, 10], [-60, -300, -60, -600, 10], [120, -300, 120, -480, 10],
  ]) road(...r);

  // ===== reserved landmark ground =====
  for (const r of [
    [-202, -112, -182, -40], [-300, -98, -246, -46], [-462, -116, -304, -102], [-195, -290, -85, -226], [36, -240, 104, -168],
    [44, -104, 130, -36], [95, -25, 138, 165], [148, -5, 183, 160], [240, -275, 330, -215], [215, -115, 900, 450],
    [-340, -335, -250, -245], [-425, -335, -360, -245], [-335, -225, -290, -175], [-234, -372, -218, -350], [-14, -623, 126, -483],
    [280, -600, 900, -150], [-485, -295, -455, -265], [-415, -428, -385, -405],
  ]) reserve(r);

  // generic tower: centre, footprint, height; crown = setback tier height, spire = mast height, round = sides
  const tower = (cx, cz, w, d, h, mat, { crown = 0, spire = 0, round = 0, collide = true } = {}) => {
    const x0 = cx - w / 2, z0 = cz - d / 2;
    if (round) {
      const g = new THREE.CylinderGeometry(w / 2, w / 2, h, round);
      const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * w / 8, uv.getY(i) * h / 8);
      const m = new THREE.Mesh(g, [mat, roofMat, roofMat]); m.position.set(cx, h / 2, cz); m.castShadow = m.receiveShadow = true;
      S.add(m); A.meshes.push(m);
      if (collide) A.collider(cx - w * 0.42, 0, cz - w * 0.42, w * 0.84, h, w * 0.84);
    } else A.box(x0, 0, z0, w, h, d, faces(mat), { tile: 8, collide });
    let top = h;
    if (crown) { const cw = w * 0.68, cd = d * 0.68; A.box(cx - cw / 2, h, cz - cd / 2, cw, crown, cd, faces(mat), { tile: 8, collide }); top += crown; }
    if (spire) { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.6, spire, 6), steel); m.position.set(cx, top + spire / 2, cz); S.add(m); }
    foot.push([x0, z0, x0 + w, z0 + d]); occ.push([x0, z0, x0 + w, z0 + d]);
  };

  // ===== THE MERLION (and its cub) =====
  const scalesTex = canvasTex(256, 256, (g, n) => {
    g.fillStyle = '#efece4'; g.fillRect(0, 0, n, n);
    g.strokeStyle = 'rgba(120,112,100,0.55)'; g.lineWidth = 3;
    for (let y = -1; y < 9; y++) for (let x = -1; x < 9; x++) { g.beginPath(); g.arc(x * 32 + (y % 2 ? 16 : 0), y * 32, 18, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke(); }
  });
  scalesTex.repeat.set(12, 4);
  const merlionWhite = M({ color: 0xf0ede6, roughness: 0.5 });
  const merlionScales = M({ color: 0xffffff, map: scalesTex, roughness: 0.55 });
  const sphereG = new THREE.SphereGeometry(1, 20, 14);
  function merlion(scale, jet) {
    const g = new THREE.Group();
    const add = (geo, mat, x, y, z, sx = 1, sy = sx, sz = sx) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
    const rock = M({ color: 0x6d6a66, roughness: 0.95, flatShading: true });
    add(new THREE.DodecahedronGeometry(1, 1), rock, -0.6, 0.25, 0, 2.9, 0.7, 2.3);
    // breaking waves around the base
    for (let i = 0; i < 11; i++) { const a = (i / 11) * Math.PI * 2; add(sphereG, merlionWhite, -0.8 + Math.cos(a) * 1.9, 0.8, Math.sin(a) * 1.7, 0.75, 0.38, 0.55).rotation.y = -a; }
    // the fish: a body rising out of the waves, the tail curled up behind
    const curve = new THREE.CatmullRomCurve3([[-2.6, 2.3, 0.5], [-2.35, 1.25, 0.4], [-1.5, 0.9, 0.15], [-0.5, 1.2, 0], [0.05, 2.2, 0], [0.22, 3.4, 0], [0.22, 4.4, 0], [0.12, 5.15, 0]].map((p) => new THREE.Vector3(...p)));
    const TS = 72, RS = 22, tube = new THREE.TubeGeometry(curve, TS, 1, RS, false);
    const p = tube.attributes.position, v = new THREE.Vector3(), c = new THREE.Vector3();
    for (let j = 0; j <= TS; j++) {
      const t = j / TS, r = 0.2 + 0.88 * THREE.MathUtils.smoothstep(t, 0, 0.62) - 0.08 * THREE.MathUtils.smoothstep(t, 0.85, 1);
      curve.getPointAt(t, c);
      for (let k = 0; k <= RS; k++) { const i = j * (RS + 1) + k; v.fromBufferAttribute(p, i).sub(c).multiplyScalar(r).add(c); p.setXYZ(i, v.x, v.y, v.z); }
    }
    tube.computeVertexNormals();
    add(tube, merlionScales, 0, 0, 0);
    // forked tail fin
    const fin = new THREE.Shape([[0, 0], [0.95, 1.45], [0.38, 1.0], [0, 1.3], [-0.38, 1.0], [-0.95, 1.45]].map(([x, y]) => new THREE.Vector2(x, y)));
    const finM = add(new THREE.ExtrudeGeometry(fin, { depth: 0.14, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 2 }), merlionWhite, -2.62, 2.2, 0.43);
    finM.rotation.set(0, 0, 0.25);
    // pectoral fins
    for (const s of [-1, 1]) add(sphereG, merlionWhite, 0.35, 3.0, s * 1.05, 0.7, 0.18, 0.4).rotation.set(s * 0.5, 0, -0.6);
    // the lion: skull, muzzle, open jaws, eyes, brows, ears
    add(sphereG, merlionWhite, 0.35, 6.0, 0, 1.1, 1.08, 1.0);
    add(sphereG, merlionWhite, 1.15, 5.78, 0, 0.72, 0.42, 0.55);
    add(sphereG, merlionWhite, 1.72, 5.95, 0, 0.26, 0.21, 0.32);
    add(sphereG, merlionWhite, 1.02, 5.1, 0, 0.58, 0.24, 0.42);
    add(sphereG, M({ color: 0x5a2a26, roughness: 0.6 }), 1.25, 5.42, 0, 0.45, 0.2, 0.32);
    for (const s of [-1, 1]) {
      add(sphereG, M({ color: 0x1b1a18, roughness: 0.3 }), 1.08, 6.3, s * 0.44, 0.13);
      add(sphereG, merlionWhite, 0.98, 6.5, s * 0.44, 0.3, 0.13, 0.28);
      add(new THREE.ConeGeometry(0.26, 0.55, 10), merlionWhite, 0.15, 7.05, s * 0.62).rotation.x = s * 0.3;
    }
    // mane: curls around the face, down the back of the neck
    const curls = [];
    for (let i = 0; i < 20; i++) { const a = (i / 20) * Math.PI * 2; curls.push([0.3, 6.0 + Math.cos(a) * 1.18, Math.sin(a) * 1.18, 0.42]); }
    for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; curls.push([-0.35, 6.0 + Math.cos(a) * 0.95, Math.sin(a) * 0.95, 0.46]); }
    for (let i = 0; i < 6; i++) curls.push([-0.55 + i * 0.03, 4.5 + i * 0.25, 0, 0.5]);
    const im = new THREE.InstancedMesh(sphereG, merlionWhite, curls.length);
    const q = new THREE.Quaternion(), mtx = new THREE.Matrix4();
    curls.forEach(([x, y, z, s], i) => im.setMatrixAt(i, mtx.compose(v.set(x, y, z), q, c.set(s, s, s))));
    im.castShadow = true; g.add(im);
    if (jet) {
      // the jet: a glassy core and spray particles on a ballistic arc into the bay, a splash where it lands
      const O = new THREE.Vector3(1.6, 5.38, 0), V = new THREE.Vector3(6.2, 1.0, 0), G = 4.9;
      const landY = WATER_Y / scale, T = (V.y + Math.sqrt(V.y * V.y + 4 * G * (O.y - landY))) / (2 * G);
      const pts = []; for (let i = 0; i <= 24; i++) { const t = (i / 24) * T; pts.push(new THREE.Vector3(O.x + V.x * t, O.y + V.y * t - G * t * t, 0)); }
      const jc = new THREE.CatmullRomCurve3(pts), jt = new THREE.TubeGeometry(jc, 48, 1, 10, false);
      const jp = jt.attributes.position;
      for (let j = 0; j <= 48; j++) { const t = j / 48, r = 0.11 + 0.22 * t; jc.getPointAt(t, c); for (let k = 0; k <= 10; k++) { const i = j * 11 + k; v.fromBufferAttribute(jp, i).sub(c).multiplyScalar(r).add(c); jp.setXYZ(i, v.x, v.y, v.z); } }
      g.add(new THREE.Mesh(jt, new THREE.MeshBasicMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0.45, depthWrite: false })));
      const N = 700, seeds = new Float32Array(N * 3), dummy = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) { seeds[i * 3] = Math.random(); seeds[i * 3 + 1] = Math.random() - 0.5; seeds[i * 3 + 2] = Math.random() - 0.5; }
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.BufferAttribute(dummy, 3)); pg.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));
      const LAND = new THREE.Vector3(O.x + V.x * T, landY, 0);
      const pm = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false,
        uniforms: { time: { value: 0 }, O: { value: O }, V: { value: V }, T: { value: T }, L: { value: LAND } },
        vertexShader: `uniform float time, T; uniform vec3 O, V, L; attribute vec3 seed; varying float vA;
          void main(){
            vec3 p; float sz;
            if (seed.x < 0.72) {           // spray along the jet
              float t = mod(time * 0.9 + seed.x / 0.72 * T, T);
              vec3 v = V + vec3(seed.y * 0.5, seed.z * 0.7, seed.y * 0.9) * (0.4 + t);
              p = O + v * t + vec3(0.0, -4.9 * t * t, 0.0); sz = 0.16 + t * 0.22; vA = 0.75 - t / T * 0.35;
            } else {                       // splash where it lands
              float t = mod(time + seed.x * 7.0, 0.85), a = seed.y * 6.2832;
              vec3 d = vec3(cos(a), 0.0, sin(a)) * (0.6 + seed.z + 0.5) * 2.2;
              p = L + d * t + vec3(0.0, (2.6 + seed.z * 2.0) * t - 4.9 * t * t, 0.0); sz = 0.3; vA = 0.7 * (1.0 - t / 0.85);
            }
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_PointSize = clamp(sz * 900.0 / -mv.z, 1.0, 64.0);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: 'varying float vA; void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25) discard; gl_FragColor = vec4(0.94, 0.98, 1.0, (1.0 - d * 4.0) * vA); }',
      });
      const pts3 = new THREE.Points(pg, pm); pts3.frustumCulled = false; g.add(pts3);
      anim.push((t) => { pm.uniforms.time.value = t; });
    }
    g.scale.setScalar(scale);
    return g;
  }
  {
    const mer = merlion(1.15, true); mer.position.set(-186, 0, -100); S.add(mer);
    A.collider(-189.9, 0, -102.7, 6.7, 1.0, 5.4); A.collider(-187.3, 0, -101.4, 3.3, 8.2, 2.8);
    foot.push([-190, -103, -182.5, -97]);
    // the Merlion cub, 2 m tall, a little way back on the promenade
    const cub = merlion(0.28, false); cub.position.set(-196, 0, -112); cub.rotation.y = -0.4; S.add(cub);
    A.collider(-197, 0, -113, 2, 2, 2); foot.push([-198, -114, -194, -110]);
    lbl('MERLION', 'half lion · half fish · 8.6 m', -186, 14, -100, 14, '#ffd27a');
    // Merlion Park: a lawn and a viewing platform out over the water
    flatPoly([[-202, -112], [-190, -112], [-190, -88], [-202, -88]], grass, 0.03);
  }

  // ===== Fullerton Hotel, One Fullerton, Customs House, Clifford Pier =====
  {
    const fm = colonialMats[2];
    A.box(-298, 0, -96, 50, 17, 48, faces(fm, M({ color: 0x8c7d68, roughness: 0.9 })), { tile: 8 });
    A.box(-299, 0, -97, 52, 2.4, 50, M({ color: 0xc9b896, roughness: 0.9 }), { tile: 4 });
    foot.push([-300, -98, -246, -46]);
    const col = new THREE.CylinderGeometry(0.55, 0.6, 11, 12);
    const cols = [];
    for (let z = -93; z <= -50; z += 3.6) cols.push([-246.9, z]);
    for (let x = -294; x <= -251; x += 3.6) cols.push([x, -97.1]);
    const ci = new THREE.InstancedMesh(col, M({ color: 0xe8dabb, roughness: 0.8 }), cols.length);
    const mt = new THREE.Matrix4();
    cols.forEach(([x, z], i) => ci.setMatrixAt(i, mt.makeTranslation(x, 2.4 + 5.5, z)));
    ci.castShadow = true; S.add(ci);
    A.box(-247.6, 13.4, -97.6, 1.2, 1.4, 50, M({ color: 0xe8dabb }), { collide: false });
    const bea = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.5, 5, 12), white); bea.position.set(-273, 19.5, -72); S.add(bea);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), M({ color: 0xffe2a0, emissive: 0xffc860, emissiveIntensity: 2 })); lamp.position.set(-273, 22.6, -72); S.add(lamp);
    lbl('THE FULLERTON', 'old General Post Office · 1928', -273, 26, -72, 16);
    tower(-196, 30, 10, 18, 6, colonialMats[1]);            // Customs House
    tower(-192, 70, 16, 30, 7, colonialMats[0]);            // Clifford Pier
  }

  // ===== Boat Quay: shophouses along the river's south bank =====
  {
    const cols = ['#e8b4a0', '#f2d27a', '#9fc7b8', '#c9a3c8', '#f0e6d2', '#8fb3d9', '#e59a7a', '#b8d08f'];
    const shut = ['#2f6b4f', '#2d4f7a', '#7a3a2d', '#3f5f5f'];
    const tiles = M({ color: 0xa4543a, roughness: 0.85 });
    const fronts = cols.map((c, i) => shophouseTex(c, shut[i % shut.length], 40 + i));
    let x = -460, i = 0;
    while (x < -306) {
      const w = 3.4 + rng() * 1.2, h = 5.5 + rng() * 2.6, d = 11, z0 = -114;
      if (x + w > -305) break;
      const fm = M({ map: fronts[i % fronts.length], roughness: 0.85 }), side = M({ color: cols[i % cols.length], roughness: 0.9 });
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, roofMat, roofMat, side, fm]);
      m.position.set(x + w / 2, h / 2, z0 + d / 2); m.castShadow = m.receiveShadow = true; S.add(m); A.meshes.push(m);
      A.collider(x, 0, z0, w, h, d);
      const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(d + 0.6, 0), new THREE.Vector2(d / 2 + 0.3, 1.8)]), { depth: w, bevelEnabled: false }), tiles);
      roof.rotation.y = Math.PI / 2; roof.position.set(x, h, z0 + d + 0.3); roof.castShadow = true; S.add(roof);
      foot.push([x, z0, x + w, z0 + d]);
      x += w; i++;
    }
    lbl('BOAT QUAY', 'shophouses on the Singapore River', -390, 16, -110, 16);
    // Cavenagh Bridge: a white suspension footbridge over the river
    A.box(-323, -0.5, -160, 6, 0.5, 44, white, { tile: 4 });
    for (const z of [-152, -124]) for (const xx of [-323.2, -317.2]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.7, 6, 0.7), white); p.position.set(xx + 0.35, 3, z); S.add(p); }
    for (const xx of [-322.8, -317.2]) {
      const cv = new THREE.QuadraticBezierCurve3(new THREE.Vector3(xx, 6, -152), new THREE.Vector3(xx, 1.5, -138), new THREE.Vector3(xx, 6, -124));
      S.add(new THREE.Mesh(new THREE.TubeGeometry(cv, 20, 0.12, 6), white));
    }
  }

  // ===== Esplanade Bridge, Jubilee Bridge, Esplanade Park =====
  A.box(-217, -0.8, -164, 16, 0.8, 47, M({ color: 0x9a948a, roughness: 0.9 }), { tile: 4 });
  for (const z of [-150, -138, -126]) { const a = new THREE.Mesh(new THREE.TorusGeometry(5, 0.6, 8, 24, Math.PI), M({ color: 0xd8d2c4 })); a.position.set(-209, -0.8, z + 6); a.rotation.set(0, Math.PI / 2, Math.PI); a.scale.set(1, 0.4, 1); S.add(a); }
  A.box(-192, -0.4, -168, 4, 0.4, 53, steel, { tile: 4 });
  flatPoly([[-200, -232], [-178, -168], [-200, -166], [-238, -166], [-238, -232]], grass);

  // ===== Esplanade: Theatres on the Bay, two spiked domes =====
  {
    const shell = M({ color: 0x4a5059, metalness: 0.6, roughness: 0.35 });
    const spikeMat = M({ color: 0xbcae92, metalness: 0.7, roughness: 0.35 });
    const spike = new THREE.ConeGeometry(0.85, 1.7, 3);
    const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Quaternion(), mt = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1);
    const dome = (cx, cz, rx, rz, h) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 20, 0, Math.PI * 2, 0, Math.PI / 2), shell);
      m.scale.set(rx, h, rz); m.position.set(cx, 0, cz); m.castShadow = m.receiveShadow = true; S.add(m); A.meshes.push(m);
      const list = [];
      for (let r = 0; r < 15; r++) {
        const phi = ((r + 0.5) / 15) * Math.PI / 2 * 0.96, ring = Math.cos(phi);
        const cnt = Math.max(6, Math.round(ring * 2 * Math.PI * Math.max(rx, rz) / 2.6));
        for (let k = 0; k < cnt; k++) {
          const th = ((k + (r % 2) * 0.5) / cnt) * Math.PI * 2;
          p.set(rx * ring * Math.cos(th), h * Math.sin(phi), rz * ring * Math.sin(th));
          n.set(p.x / (rx * rx), p.y / (h * h), p.z / (rz * rz)).normalize();
          q.setFromUnitVectors(up, n);
          list.push(mt.clone().compose(p.clone().addScaledVector(n, 0.5).add(new THREE.Vector3(cx, 0, cz)), q.clone(), one));
        }
      }
      const im = new THREE.InstancedMesh(spike, spikeMat, list.length);
      list.forEach((x, i) => im.setMatrixAt(i, x)); im.castShadow = true; S.add(im);
      // stepped collision inside the shell
      for (const [y0, y1, f] of [[0, 0.34, 0.92], [0.34, 0.67, 0.72], [0.67, 0.9, 0.45]]) A.collider(cx - rx * f * 0.82, y0 * h, cz - rz * f * 0.82, 2 * rx * f * 0.82, (y1 - y0) * h, 2 * rz * f * 0.82);
      foot.push([cx - rx, cz - rz, cx + rx, cz + rz]);
    };
    dome(-165, -250, 26, 16, 18);
    dome(-112, -268, 23, 16, 16);
    A.box(-150, 0, -262, 28, 6, 12, M({ color: 0x7c828a, roughness: 0.6 }), { tile: 4 });
    lbl('ESPLANADE', 'Theatres on the Bay · "the durians"', -140, 30, -258, 18);
  }

  // ===== The Float @ Marina Bay: a floating pitch with a stepped gallery =====
  {
    const pitch = canvasTex(256, 256, (g) => {
      g.fillStyle = '#3f7d52'; g.fillRect(0, 0, 256, 256);
      g.strokeStyle = '#f0f0f0'; g.lineWidth = 3; g.strokeRect(14, 14, 228, 228); g.beginPath(); g.moveTo(14, 128); g.lineTo(242, 128); g.stroke();
      g.beginPath(); g.arc(128, 128, 30, 0, 7); g.stroke();
    });
    const fm = new THREE.Mesh(worldBox(60, 0.6, 40, 1), [M({ color: 0x8a9096 }), M({ color: 0x8a9096 }), M({ map: pitch, roughness: 0.9 }), M({ color: 0x8a9096 }), M({ color: 0x8a9096 }), M({ color: 0x8a9096 })]);
    fm.position.set(70, -0.3, -192); fm.receiveShadow = true; S.add(fm); A.meshes.push(fm);
    const uv = fm.geometry.attributes.uv; for (let i = 8; i < 12; i++) uv.setXY(i, (i % 2), i < 10 ? 1 : 0);
    A.collider(40, -0.6, -212, 60, 0.6, 40);
    const seat = M({ color: 0xc9cfd6, roughness: 0.7 });
    for (let k = 0; k < 10; k++) A.box(44, 0, -214 - 2.6 * (k + 1), 52, 0.4 * (k + 1), 2.6, seat, { tile: 4 });
    foot.push([44, -240, 96, -214]);
    lbl('THE FLOAT', 'floating stage on the bay', 70, 10, -192, 12);
  }

  // ===== Helix Bridge =====
  {
    A.box(137, -0.6, -216, 6, 0.6, 114, M({ color: 0x8b9199, metalness: 0.4, roughness: 0.5 }), { tile: 4 });
    const helix = (r, ph, cy) => { const pts = []; for (let i = 0; i <= 400; i++) { const t = i / 400, a = t * 28 + ph; pts.push(new THREE.Vector3(140 + Math.cos(a) * r, cy + Math.sin(a) * r, -216 + 114 * t)); } return new THREE.CatmullRomCurve3(pts); };
    for (const [r, ph, rad] of [[3.1, 0, 0.12], [3.1, Math.PI, 0.12], [2.3, Math.PI / 2, 0.07], [2.3, -Math.PI / 2, 0.07]]) S.add(new THREE.Mesh(new THREE.TubeGeometry(helix(r, ph, 2.4), 800, rad, 6), steel));
    for (let z = -214; z < -102; z += 3.2) { const ring = new THREE.Mesh(new THREE.TorusGeometry(3.1, 0.04, 4, 24), steel); ring.position.set(140, 2.4, z); S.add(ring); }
    lbl('HELIX BRIDGE', 'a double helix across the bay', 140, 12, -160, 12);
  }

  // ===== ArtScience Museum: the lotus =====
  {
    const g = new THREE.Group(); g.position.set(72, 0, -72); S.add(g);
    const pond = new THREE.Mesh(new THREE.CircleGeometry(22, 48), decal({ color: 0x3f8a92, roughness: 0.1, metalness: 0.2 }, -1)); pond.rotation.x = -Math.PI / 2; pond.position.y = 0.04; g.add(pond);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(4, 5.5, 7, 24), white); stem.position.y = 3.5; g.add(stem);
    const bowl = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), white); bowl.scale.y = 0.45; bowl.position.y = 9.5; g.add(bowl);
    const tipMat = M({ color: 0xdff4ff, emissive: 0x9fdcff, emissiveIntensity: 0.8 });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2, L = 10 + 9 * (0.5 + 0.5 * Math.cos(a - Math.PI * 0.85)), tilt = 0.75 - 0.35 * (L - 10) / 9;
      const pivot = new THREE.Group(); pivot.position.set(Math.cos(a) * 6.5, 8.5, Math.sin(a) * 6.5); pivot.rotation.y = -a;
      const inner = new THREE.Group(); inner.rotation.z = -tilt; pivot.add(inner);
      const f = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 2.7, L, 16), white); f.position.y = L / 2; f.scale.set(0.65, 1, 1.45); f.castShadow = true; inner.add(f);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), tipMat); tip.position.y = L; tip.scale.set(0.65, 0.6, 1.45); inner.add(tip);
      g.add(pivot);
    }
    for (const m of [stem, bowl]) { m.castShadow = m.receiveShadow = true; }
    A.collider(64, 0, -80, 16, 9.5, 16); A.meshes.push(stem, bowl);
    foot.push([60, -84, 84, -60]);
    lbl('ARTSCIENCE MUSEUM', 'the lotus', 72, 32, -72, 14);
  }

  // ===== Marina Bay Sands: three towers, the SkyPark, the Shoppes =====
  {
    const X = 165, H = 97;
    const legMat = curtainWall('#8fa3ad', '#e4dccb', 31, 0.04);
    const sideMat = M({ color: 0xd9d2c3, roughness: 0.6 });
    for (const z0 of [40, 88, 136]) {
      A.box(X + 2, 0, z0 - 8, 12, H, 16, [sideMat, legMat, roofMat, roofMat, legMat, legMat], { tile: 8 });
      const g = worldBox(12, H, 16, 8), p = g.attributes.position;
      for (let i = 0; i < p.count; i++) { const f = (p.getY(i) + H / 2) / H; p.setX(i, p.getX(i) + 6 * Math.pow(f, 1.5)); }
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, [legMat, sideMat, roofMat, roofMat, legMat, legMat]); m.position.set(X - 10, H / 2, z0); m.castShadow = m.receiveShadow = true; S.add(m); A.meshes.push(m);
      for (let k = 0; k < 4; k++) { const s0 = 6 * Math.pow(k / 4, 1.5), s1 = 6 * Math.pow((k + 1) / 4, 1.5); A.collider(X - 16 + s0, (k * H) / 4, z0 - 8, 12 + s1 - s0, H / 4, 16); }
      A.box(X - 4, 0, z0 - 7, 6, 22, 14, glassClear, { collide: false, shadow: false });
    }
    // the SkyPark: a 170 m ship across the tops, cantilevered out to the north, an infinity pool on the bay side
    const hull = M({ color: 0xe9e9e4, metalness: 0.3, roughness: 0.4 });
    const deck = M({ color: 0x86684a, roughness: 0.85 });
    A.box(157, H, -1, 24, 3, 153, [hull, hull, deck, hull, hull, hull], { tile: 6 });
    const bow = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 3, 3, 1, false, Math.PI / 2, Math.PI), hull);
    bow.scale.set(1, 1, 0.6); bow.position.set(169, H + 1.5, -1); S.add(bow);
    const pool = new THREE.Mesh(new THREE.BoxGeometry(5, 0.1, 128), M({ color: 0x3aa6c8, roughness: 0.1, metalness: 0.1 }));
    pool.position.set(160.5, H + 3.04, 75); S.add(pool);
    for (const [x, z, w, d] of [[157, -1, 0.15, 153], [180.85, -1, 0.15, 153], [157, -1.15, 24, 0.15], [157, 151.85, 24, 0.15]]) A.box(x, H + 3, z, w, 1.2, d, glassClear, { shadow: false });
    for (let z = 4; z < 150; z += 9) { trees.push([178, H + 3, z, 0.55, 1]); trees.push([174, H + 3, z + 4.5, 0.5, 0]); }
    // the Shoppes and the Expo along the water, the glass sphere out on the bay
    A.box(95, 0, -25, 43, 12, 190, faces(curtainWall('#a9bcc4', '#f2efe8', 33, 0.02), white), { tile: 8 });
    const appleBase = new THREE.Mesh(new THREE.CylinderGeometry(9.5, 9.5, 0.6, 40), M({ color: 0xd8d8d4 })); appleBase.position.set(74, -0.3, 20); S.add(appleBase);
    A.collider(66, -0.6, 12, 16, 0.6, 16); A.box(82, -0.6, 17, 10, 0.6, 6, M({ color: 0xa69a88 }), { tile: 4 });
    const sph = new THREE.Mesh(new THREE.SphereGeometry(8, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), M({ color: 0xcfe8f2, metalness: 0.4, roughness: 0.05, transparent: true, opacity: 0.55 }));
    sph.position.set(74, 0, 20); S.add(sph);
    A.collider(69, 0, 15, 10, 5, 10);
    foot.push([95, -25, 183, 165]);
    lbl('MARINA BAY SANDS', 'three towers · the SkyPark 100 m up', 168, 116, 75, 34, '#ffd27a');
  }

  // ===== Singapore Flyer =====
  {
    const g = new THREE.Group(); g.position.set(284, 46, -239); g.rotation.y = -Math.PI / 4; S.add(g);
    const wheel = new THREE.Group(); g.add(wheel);
    const R = 37.5;
    for (const z of [-1.4, 1.4]) { const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.45, 8, 160), steel); rim.position.z = z; wheel.add(rim); }
    const spokeG = new THREE.CylinderGeometry(0.07, 0.07, R, 4); spokeG.translate(0, R / 2, 0);
    const caps = new THREE.CapsuleGeometry(1.5, 3.4, 4, 12); caps.rotateX(Math.PI / 2);
    const capMat = M({ color: 0xcfe9f5, metalness: 0.3, roughness: 0.08, transparent: true, opacity: 0.7 });
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      for (const z of [-1.4, 1.4]) { const s = new THREE.Mesh(spokeG, steel); s.rotation.z = a; s.position.z = z * 0.3; wheel.add(s); }
      const c = new THREE.Mesh(caps, capMat); c.position.set(Math.cos(a) * (R + 1.9), Math.sin(a) * (R + 1.9), 0); wheel.add(c);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 7, 20), darkSteel); hub.rotation.x = Math.PI / 2; g.add(hub);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.4, 50, 10), white);
      leg.position.set(sx * 9, -23, 5); leg.rotation.z = sx * 0.38; leg.rotation.x = -0.1; g.add(leg);
    }
    anim.push((t, dt) => { wheel.rotation.z -= dt * 0.012; });
    A.box(254, 0, -252, 60, 8, 26, faces(curtainWall('#9cc3d4', '#ffffff', 35, 0.02), white), { tile: 8 });
    foot.push([254, -252, 314, -226]);
    lbl('SINGAPORE FLYER', 'the observation wheel', 284, 96, -239, 26);
  }

  // ===== Gardens by the Bay =====
  {
    flatPoly([[222, -108], [260, -110], [400, -38], [538, 112], [736, 340], [736, 446], [222, 446]], grass, 0.02);
    flatPoly([[290, -195], [420, -138], [556, 18], [790, 225], [790, -380], [300, -380]], grass, 0.02);     // Bay East and the park north of the channel
    const plant = canvasTex(128, 256, (g) => {
      g.fillStyle = '#3f6e35'; g.fillRect(0, 0, 128, 256);
      const r = rngOf(51), cs = ['#a64ca6', '#e08ad0', '#e8c84a', '#7fbf4a', '#2f5a2a', '#c45a8a'];
      for (let i = 0; i < 420; i++) { g.fillStyle = cs[(r() * cs.length) | 0]; g.beginPath(); g.arc(r() * 128, r() * 256, 2 + r() * 5, 0, 7); g.fill(); }
      g.fillStyle = 'rgba(60,30,70,0.8)'; for (let x = 0; x < 128; x += 21) g.fillRect(x, 0, 4, 256);
    });
    plant.repeat.set(3, 3);
    const lattice = canvasTex(256, 256, (g, n) => {
      g.clearRect(0, 0, n, n); g.strokeStyle = '#6a3f78'; g.lineWidth = 7;
      for (let i = -n; i < n * 2; i += 42) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + n, n); g.stroke(); g.beginPath(); g.moveTo(i, n); g.lineTo(i + n, 0); g.stroke(); }
      for (let y = 0; y <= n; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(n, y); g.stroke(); }
    });
    lattice.repeat.set(5, 1);
    const trunkMat = M({ map: plant, roughness: 0.9 });
    const latMat = M({ map: lattice, alphaTest: 0.5, side: THREE.DoubleSide, color: 0xffffff, metalness: 0.5, roughness: 0.5 });
    const crownLights = M({ color: 0x40204a, emissive: 0xd060ff, emissiveIntensity: 0.6 });
    const supertree = (x, z, h, R, climb = false) => {
      const th = h * 0.8, ch = h * 0.2;
      const t = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 2.2, th, 14), trunkMat); t.position.set(x, th / 2, z); t.castShadow = true; S.add(t);
      const l = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 2.45, th, 14, 1, true), latMat); l.position.copy(t.position); S.add(l);
      const flare = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.4, 1.6, 14), latMat); flare.position.set(x, 0.8, z); S.add(flare);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(R, 1.0, ch, 28, 1, true), latMat); c.position.set(x, th + ch / 2, z); c.castShadow = true; S.add(c);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.18, 6, 48), crownLights); rim.rotation.x = Math.PI / 2; rim.position.set(x, h, z); S.add(rim);
      A.collider(x - 1.8, 0, z - 1.8, 3.6, th, 3.6, climb ? 'climb' : 'solid'); A.meshes.push(t);
      foot.push([x - 3, z - 3, x + 3, z + 3]);
    };
    for (const [x, z, h, R] of [[276, 170, 35, 13], [336, 222, 35, 13], [300, 170, 24, 10], [318, 182, 20, 9], [324, 200, 26, 10], [338, 195, 22, 9],
      [290, 190, 18, 8], [306, 205, 22, 9], [296, 150, 20, 8], [318, 158, 26, 10], [348, 170, 19, 8], [282, 208, 17, 7],
      [420, 250, 18, 8], [440, 266, 15, 7], [456, 244, 16, 7], [380, 330, 17, 7], [400, 346, 14, 6]]) supertree(x, z, h, R, h >= 26);
    // the OCBC Skyway: 15 m up through the crowns, reached by the climbing frame on its lift tower
    const sd = M({ color: 0x9aa0a8, metalness: 0.6, roughness: 0.4 });
    A.box(279.4, 14.6, 174.7, 52, 0.4, 2.6, sd, { tile: 4 }); A.box(328.7, 14.6, 177.3, 2.6, 0.4, 42, sd, { tile: 4 });
    for (const [x, z, w, d] of [[279.4, 174.55, 52, 0.15], [279.4, 177.3, 49.3, 0.15], [331.3, 174.55, 0.15, 44.75], [328.55, 177.3, 0.15, 42], [328.7, 219.3, 2.6, 0.15]])
      A.box(x, 15, z, w, 1.1, d, glassClear, { shadow: false });
    A.box(276, 0, 174.6, 3.4, 15, 2.8, M({ color: 0x5a3f68, metalness: 0.4, roughness: 0.5 }), { tile: 3 });
    A.box(275.75, 0, 174.8, 0.25, 15, 2.4, M({ map: ladderTexture(), roughness: 0.5, metalness: 0.6 }), { kind: 'climb', tile: 1.5 });
    foot.push([275, 174, 332, 220]);
    lbl('SUPERTREE GROVE', 'climb the frame to the OCBC Skyway', 306, 42, 190, 22);
    // the cooled conservatories
    const domeTex = canvasTex(256, 256, (g, n) => {
      g.fillStyle = '#cfe6ee'; g.fillRect(0, 0, n, n); g.strokeStyle = '#f8fbfc'; g.lineWidth = 4;
      for (let i = 0; i <= n; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, n); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(n, i); g.stroke(); }
    });
    domeTex.repeat.set(14, 5);
    const domeMat = M({ map: domeTex, transparent: true, opacity: 0.55, metalness: 0.3, roughness: 0.1, depthWrite: false, side: THREE.DoubleSide });
    const ribs = M({ color: 0xe6e9ea, metalness: 0.6, roughness: 0.4 });
    const glassDome = (cx, cz, rx, rz, h) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), domeMat); m.scale.set(rx, h, rz); m.position.set(cx, 0, cz); S.add(m);
      for (let i = 0; i < 9; i++) { const r = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 4, 40, Math.PI), ribs); r.scale.set(rx, h, rz); r.position.set(cx, 0, cz); r.rotation.y = (i / 9) * Math.PI; S.add(r); }
      for (const [y0, y1, f] of [[0, 0.4, 0.9], [0.4, 0.75, 0.68], [0.75, 0.95, 0.38]]) A.collider(cx - rx * f * 0.82, y0 * h, cz - rz * f * 0.82, 2 * rx * f * 0.82, (y1 - y0) * h, 2 * rz * f * 0.82);
      foot.push([cx - rx, cz - rz, cx + rx, cz + rz]);
    };
    glassDome(430, 80, 42, 25, 19);
    glassDome(520, 170, 24, 22, 28);
    const mount = new THREE.Mesh(new THREE.CylinderGeometry(5, 11, 22, 10), M({ color: 0x3f6e35, roughness: 0.95, flatShading: true })); mount.position.set(520, 11, 170); S.add(mount);
    const fall = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 20), M({ color: 0xe6f6ff, emissive: 0x9fd8ff, emissiveIntensity: 0.4, transparent: true, opacity: 0.8 })); fall.position.set(520, 10, 181.5); S.add(fall);
    lbl('FLOWER DOME', '', 430, 26, 80, 14); lbl('CLOUD FOREST', 'the indoor waterfall', 520, 36, 170, 14);
    for (let i = 0; i < 18; i++) trees.push([400 + rng() * 60, 0, 70 + rng() * 22, 0.7 + rng() * 0.4, rng() < 0.4 ? 1 : 0]);
  }

  // ===== Marina Barrage =====
  {
    A.box(715, BED_Y, 175, 50, 6 - BED_Y, 170, faces(M({ color: 0xb9bcbf, roughness: 0.8 }), M({ color: 0x5e8f3e, roughness: 0.95 })), { tile: 6 });
    const ramp = new THREE.Mesh(new THREE.TorusGeometry(16, 1.2, 8, 40, Math.PI * 1.5), white); ramp.rotation.x = Math.PI / 2; ramp.position.set(740, 6.6, 255); S.add(ramp);
    foot.push([715, 175, 765, 345]);
    lbl('MARINA BARRAGE', 'the dam across Marina Channel', 740, 20, 260, 18);
  }

  // ===== Civic district: Padang, the National Gallery, Victoria Theatre, St Andrew's, the War Memorial =====
  {
    flatPoly([[-340, -335], [-250, -335], [-250, -245], [-340, -245]], grass);
    const line = new THREE.Mesh(new THREE.RingGeometry(30, 30.6, 64), decal({ color: 0xf2f2f2 }, -3)); line.rotation.x = -Math.PI / 2; line.position.set(-295, 0.06, -290); S.add(line);
    A.box(-338, 0, -262, 14, 4, 12, faces(colonialMats[1], M({ color: 0x8a5a44 })), { tile: 8 });                      // cricket club
    A.box(-422, 0, -330, 60, 14, 80, faces(colonialMats[0], M({ color: 0x8c7d68 })), { tile: 8 });                     // National Gallery
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 4, 24), colonialMats[1]); drum.position.set(-392, 16, -270); S.add(drum);
    const domeG = new THREE.Mesh(new THREE.SphereGeometry(6, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), M({ color: 0x6f9a8a, metalness: 0.5, roughness: 0.4 })); domeG.position.set(-392, 18, -270); S.add(domeG);
    foot.push([-422, -330, -362, -250]);
    lbl('NATIONAL GALLERY', 'City Hall · old Supreme Court', -392, 34, -290, 16);
    tower(-470, -280, 26, 26, 28, curtainWall('#a8b8c0', '#e8e8e8', 37));                                                // Supreme Court
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(17, 17, 2.4, 40), M({ color: 0xd6d8d8, metalness: 0.5, roughness: 0.35 })); disc.position.set(-470, 30, -280); S.add(disc);
    A.box(-332, 0, -212, 40, 12, 24, faces(colonialMats[1], M({ color: 0x8a6a54 })), { tile: 8 });                     // Victoria Theatre & Concert Hall
    A.box(-315, 0, -203, 6, 30, 6, colonialMats[1], { tile: 8 });
    const pyr = new THREE.Mesh(new THREE.ConeGeometry(4.6, 6, 4), M({ color: 0x8a6a54 })); pyr.position.set(-312, 33, -200); pyr.rotation.y = Math.PI / 4; S.add(pyr);
    const clock = new THREE.Mesh(new THREE.CircleGeometry(1.6, 24), M({ color: 0xffffff, emissive: 0xfff2d0, emissiveIntensity: 0.3 })); clock.position.set(-312, 26, -196.9); S.add(clock);
    foot.push([-332, -212, -292, -188]);
    lbl('VICTORIA THEATRE', 'and Concert Hall', -312, 40, -200, 12);
    A.box(-414, 0, -426, 28, 12, 18, faces(colonialMats[1], M({ color: 0x5f6a74 })), { tile: 8 });                     // St Andrew's Cathedral
    const sp = new THREE.Mesh(new THREE.ConeGeometry(3, 26, 8), white); sp.position.set(-400, 18, -400); S.add(sp);
    A.box(-403, 0, -403, 6, 8, 6, colonialMats[1], { tile: 8 });
    foot.push([-414, -426, -386, -400]);
    for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) {                                 // Civilian War Memorial
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 1.0, 34, 4), white); m.position.set(-226 + dx, 17, -361 + dz); m.rotation.y = Math.PI / 4; m.castShadow = true; S.add(m);
    }
    A.collider(-228.5, 0, -363.5, 5, 34, 5);
    lbl('PADANG', '', -295, 10, -290, 12);
  }

  // ===== Suntec City: five towers round the Fountain of Wealth =====
  {
    const C = [56, -553];
    [[200, 88], [240, 88], [280, 88], [320, 88], [30, 40]].forEach(([deg, h], i) => {
      const a = (deg * Math.PI) / 180;
      tower(C[0] + Math.cos(a) * 42, C[1] + Math.sin(a) * 42, 22, 22, h, glassMats[(i + 2) % glassMats.length], { crown: 4 });
    });
    const bronze = M({ color: 0x8a6a3a, metalness: 0.85, roughness: 0.35 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(6, 0.7, 10, 48), bronze); ring.rotation.x = Math.PI / 2; ring.position.set(C[0], 7, C[1]); S.add(ring);
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.4, leg = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 8.4, 8), bronze); leg.position.set(C[0] + Math.cos(a) * 4.8, 3.5, C[1] + Math.sin(a) * 4.8); leg.rotation.set(Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25); S.add(leg); }
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 0.6, 40), decal({ color: 0x3f8a92, roughness: 0.1 })); basin.position.set(C[0], 0.3, C[1]); S.add(basin);
    lbl('SUNTEC CITY', 'Fountain of Wealth', C[0], 100, C[1], 22);
  }

  // ===== the skyline: named towers =====
  const G = glassMats;
  tower(-330, -30, 22, 22, 140, G[2], { crown: 6, spire: 6 });     // UOB Plaza One
  tower(-305, -30, 16, 16, 80, G[2]);                               // UOB Plaza Two
  tower(-400, 20, 24, 20, 140, G[5], { spire: 8 });                 // One Raffles Place
  tower(-480, 40, 24, 24, 140, G[3], { round: 8 });                 // Republic Plaza
  tower(-480, -60, 30, 14, 100, flatMats[3]);                       // OCBC Centre
  tower(-300, 40, 22, 22, 122, G[0], { crown: 8 });                 // Ocean Financial Centre
  tower(-240, 130, 18, 18, 122, G[1]); tower(-240, 155, 18, 18, 122, G[1]);   // One Raffles Quay
  tower(-240, 50, 20, 20, 110, G[4], { crown: 10 });                // Asia Square
  tower(-500, 130, 20, 20, 145, G[6], { spire: 10 });               // Guoco Tower
  tower(-180, 230, 20, 20, 122, G[0]); tower(-150, 260, 22, 22, 122, G[4]); tower(-200, 270, 20, 24, 122, G[1]);   // MBFC
  tower(-120, 215, 16, 22, 122, G[3], { crown: 6 });                // The Sail
  tower(-260, 240, 30, 18, 70, G[6]); tower(-260, 275, 30, 18, 70, G[6]);    // Marina One
  tower(-30, -360, 24, 18, 70, flatMats[0]);                        // Pan Pacific
  tower(40, -345, 30, 20, 50, flatMats[2]);                         // Mandarin Oriental
  tower(170, -380, 18, 30, 65, flatMats[4]);                        // Ritz-Carlton
  tower(170, -440, 22, 22, 95, G[5], { spire: 6 });                 // Millenia Tower
  tower(-300, -520, 28, 28, 113, G[0], { round: 24 });              // Swissôtel The Stamford
  tower(-260, -545, 16, 16, 70, G[2]); tower(-235, -520, 16, 16, 70, G[2]);  // Raffles City
  lbl('RAFFLES PLACE', 'the financial district', -380, 160, 30, 30);
  lbl('MARINA BAY FINANCIAL CENTRE', '', -175, 142, 255, 30);

  // ===== generated city blocks =====
  const free = (r, pad) => r[0] > B.x0 + 4 && r[2] < B.x1 - 4 && r[1] > B.z0 + 4 && r[3] < B.z1 - 4
    && !occ.some((o) => overlap(r, o, pad)) && !onRoad(r, pad)
    && ![[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]], [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]].some(([x, z]) => nearWater(x, z, 14));
  const district = (rect, hMin, hMax, mats, cell, skip, extra = {}) => {
    for (let x = rect[0]; x < rect[2]; x += cell) for (let z = rect[1]; z < rect[3]; z += cell) {
      if (rng() < skip) continue;
      const w = cell * (0.5 + rng() * 0.32), d = cell * (0.5 + rng() * 0.32);
      const cx = x + cell / 2 + (rng() - 0.5) * (cell - w) * 0.8, cz = z + cell / 2 + (rng() - 0.5) * (cell - d) * 0.8;
      const r = [cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2];
      if (!free(r, 3)) continue;
      const h = hMin + (hMax - hMin) * Math.pow(rng(), 1.5);
      const k = rng();
      tower(cx, cz, w, d, h, mats[(rng() * mats.length) | 0], { crown: h > 60 && k < 0.3 ? h * 0.08 : 0, spire: h > 90 && k > 0.85 ? 8 : 0, round: extra.round && k < 0.12 ? 10 : 0 });
    }
  };
  district([-515, -95, -220, 170], 40, 120, G, 30, 0.2, { round: true });
  district([-515, 190, -110, 445], 30, 110, [...G, flatMats[0], flatMats[2]], 32, 0.3);
  district([-90, 190, 205, 445], 8, 35, [...flatMats, G[4]], 36, 0.45);
  district([-515, -600, -360, -440], 30, 90, [...G, ...flatMats], 30, 0.35);
  district([-515, -440, -360, -175], 10, 30, [...colonialMats, flatMats[1]], 28, 0.35);
  district([-345, -600, -215, -360], 20, 80, [...G, flatMats[4]], 30, 0.35);
  district([-195, -600, 250, -310], 25, 80, [...G, ...flatMats], 32, 0.35);
  district([-80, -292, 236, -244], 12, 40, [...flatMats, G[4]], 28, 0.4);

  // ===== trees =====
  const treeOk = (x, z, pad = 2.5) => {
    if (x < B.x0 + 3 || x > B.x1 - 3 || z < B.z0 + 3 || z > B.z1 - 3) return false;
    if (nearWater(x, z, 2.5)) return false;
    const r = [x - pad, z - pad, x + pad, z + pad];
    if (foot.some((f) => overlap(r, f))) return false;
    if (onRoad(r, 0.5)) return false;
    if (overlap(r, [-340, -335, -250, -245]) && Math.hypot(x + 295, z + 290) < 40) return false;   // the Padang's field
    if (overlap(r, [-205, -112, -182, -40])) return false;                                         // Merlion Park and the arrival plaza
    return true;
  };
  // the promenade round the bay: rain trees 8 m in from the quay
  for (let i = 0; i < WATER.length; i++) {
    const [ax, az] = WATER[i], [bx, bz] = WATER[(i + 1) % WATER.length];
    const len = Math.hypot(bx - ax, bz - az), nx = -(bz - az) / len, nz = (bx - ax) / len;
    for (let s = 6; s < len - 6; s += 13) {
      const px = ax + ((bx - ax) * s) / len, pz = az + ((bz - az) * s) / len;
      for (const k of [1, -1]) { const x = px + nx * 8 * k, z = pz + nz * 8 * k; if (treeOk(x, z)) trees.push([x, 0, z, 0.8 + rng() * 0.35, 0]); }
    }
  }
  // street trees both sides of every road
  for (const [x0, z0, x1, z1, w] of roads) {
    const len = Math.hypot(x1 - x0, z1 - z0), nx = -(z1 - z0) / len, nz = (x1 - x0) / len;
    for (let s = 5; s < len; s += 14) for (const k of [1, -1]) {
      const x = x0 + ((x1 - x0) * s) / len + nx * (w / 2 + 2.2) * k, z = z0 + ((z1 - z0) * s) / len + nz * (w / 2 + 2.2) * k;
      if (treeOk(x, z, 1.5)) trees.push([x, 0, z, 0.7 + rng() * 0.3, 0]);
    }
  }
  // parks: Gardens by the Bay, Bay East, Esplanade Park, the Padang's edge, and scattered through the blocks
  const scatter = (rect, n, palm = 0.15, inside = null) => {
    for (let i = 0; i < n; i++) {
      const x = rect[0] + rng() * (rect[2] - rect[0]), z = rect[1] + rng() * (rect[3] - rect[1]);
      if (inside && !inside(x, z)) continue;
      if (treeOk(x, z)) trees.push([x, 0, z, 0.7 + rng() * 0.5, rng() < palm ? 1 : 0]);
    }
  };
  const alongBank = (pts, x) => { for (let i = 1; i < pts.length; i++) if (x <= pts[i][0] || i === pts.length - 1) { const [ax, az] = pts[i - 1], [bx, bz] = pts[i]; return az + ((bz - az) * (x - ax)) / (bx - ax); } return 0; };
  const SBANK = [[130, -104], [260, -112], [400, -40], [540, 110], [740, 340], [900, 400]], NBANK = [[0, -212], [160, -214], [280, -188], [420, -130], [560, 30], [900, 330]];
  scatter([222, -100, 736, 446], 1100, 0.25, (x, z) => x > 222 && z > alongBank(SBANK, x) + 4);
  scatter([290, -380, 790, 300], 650, 0.1, (x, z) => z < alongBank(NBANK, x) - 4);
  scatter([-238, -232, -178, -166], 60, 0.1);
  scatter([-345, -340, -245, -240], 70, 0);
  scatter([B.x0, B.z0, 215, B.z1], 1300, 0.08);

  // ===== beyond the bounds: the rest of the island, the strait, Sentosa =====
  {
    const hdb = flatMats.map((m) => m);
    const variants = [
      { geo: worldBox(30, 42, 8, 8), mat: faces(hdb[0]), list: [] }, { geo: worldBox(14, 50, 14, 8), mat: faces(hdb[2]), list: [] },
      { geo: worldBox(34, 18, 9, 8), mat: faces(hdb[1]), list: [] }, { geo: worldBox(20, 60, 20, 8), mat: faces(G[0]), list: [] },
      { geo: worldBox(24, 95, 24, 8), mat: faces(G[3]), list: [] }, { geo: worldBox(26, 32, 10, 8), mat: faces(hdb[4]), list: [] },
    ];
    const heights = [42, 50, 18, 60, 95, 32];
    const mt = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    for (let x = -1800; x < 1000; x += 48) for (let z = -1800; z < 500; z += 48) {
      const px = x + rng() * 26, pz = z + rng() * 26;
      if (px > B.x0 - 50 && px < B.x1 + 50 && pz > B.z0 - 50 && pz < B.z1 + 50) continue;
      if (nearWater(px, pz, 30) || Math.hypot(px + 929, pz - 465) < 70) continue;
      if (rng() < 0.3) { for (let k = 0; k < 4; k++) trees.push([px + rng() * 30, 0, pz + rng() * 30, 0.8 + rng() * 0.4, 0]); continue; }
      const dC = Math.hypot(px + 500, pz - 60);
      const v = dC < 650 ? (rng() < 0.55 ? 3 : 4) : [0, 1, 2, 5][(rng() * 4) | 0];
      q.setFromAxisAngle(up, ((rng() * 4) | 0) * Math.PI / 2 + (rng() - 0.5) * 0.3);
      variants[v].list.push(mt.clone().compose(new THREE.Vector3(px, heights[v] / 2, pz), q.clone(), one));
    }
    for (const V of variants) {
      if (!V.list.length) continue;
      const im = new THREE.InstancedMesh(V.geo, V.mat, V.list.length);
      V.list.forEach((m, i) => im.setMatrixAt(i, m)); im.receiveShadow = true; S.add(im);
    }
    // Pinnacle@Duxton: seven towers linked by sky gardens
    const pin = new THREE.Group(); pin.position.set(-929, 0, 465); S.add(pin);
    for (let i = 0; i < 7; i++) { const m = new THREE.Mesh(worldBox(12, 78, 16, 8), faces(hdb[0])); m.position.set((i - 3) * 13, 39, Math.abs(i - 3) * 4); pin.add(m); }
    for (const y of [26, 50]) { const b = new THREE.Mesh(new THREE.BoxGeometry(92, 2, 12), white); b.position.set(0, y, 6); pin.add(b); }
    // the strait: ships at anchor
    const hullG = new THREE.BoxGeometry(1, 1, 1), hulls = [], tops = [];
    for (let i = 0; i < 80; i++) {
      const L = 40 + rng() * 110, x = -1700 + rng() * 3400, z = 650 + rng() * 1150, a = rng() * Math.PI;
      q.setFromAxisAngle(up, a);
      hulls.push([mt.clone().compose(new THREE.Vector3(x, WATER_Y + 3, z), q.clone(), new THREE.Vector3(L * 0.16, 7, L)), rng()]);
      tops.push(mt.clone().compose(new THREE.Vector3(x - Math.sin(a) * L * 0.38, WATER_Y + 10, z - Math.cos(a) * L * 0.38), q.clone(), new THREE.Vector3(L * 0.14, 9, L * 0.1)));
    }
    const hi = new THREE.InstancedMesh(hullG, M({ color: 0xffffff, roughness: 0.7 }), hulls.length);
    const hc = [0x7a2a24, 0x2a3a5a, 0x2a4a3a, 0x3a3a3a, 0x8a5a2a].map((c) => new THREE.Color(c));
    hulls.forEach(([m, r], i) => { hi.setMatrixAt(i, m); hi.setColorAt(i, hc[(r * hc.length) | 0]); });
    const ti = new THREE.InstancedMesh(hullG, white, tops.length); tops.forEach((m, i) => ti.setMatrixAt(i, m));
    S.add(hi, ti);
    const sentosa = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 12), M({ color: 0x4f7a3a, roughness: 0.95 })); sentosa.scale.set(320, 30, 120); sentosa.position.set(-1200, -8, 980); S.add(sentosa);
  }

  // ===== instanced trees =====
  {
    const trunkG = new THREE.CylinderGeometry(0.6, 1, 1, 6); trunkG.translate(0, 0.5, 0);
    const rainG = new THREE.IcosahedronGeometry(1, 1), palmG = new THREE.IcosahedronGeometry(1, 0);
    const rain = trees.filter((t) => t[4] === 0), palm = trees.filter((t) => t[4] === 1);
    const trunks = new THREE.InstancedMesh(trunkG, M({ color: 0x5a4636, roughness: 0.95 }), trees.length);
    const crowns = new THREE.InstancedMesh(rainG, M({ color: 0xffffff, roughness: 0.9, flatShading: true }), rain.length);
    const fronds = new THREE.InstancedMesh(palmG, M({ color: 0xffffff, roughness: 0.9, flatShading: true }), palm.length);
    const mt = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    let ti = 0, ri = 0, pi = 0;
    for (const [x, y, z, s, type] of trees) {
      q.setFromAxisAngle(up, rng() * Math.PI * 2);
      if (type === 0) {
        trunks.setMatrixAt(ti++, mt.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(0.32 * s, 3.6 * s, 0.32 * s)));
        crowns.setMatrixAt(ri, mt.compose(new THREE.Vector3(x, y + 4.6 * s, z), q, new THREE.Vector3(4.2 * s, 2.3 * s, 4.2 * s)));
        crowns.setColorAt(ri++, col.setHSL(0.24 + rng() * 0.07, 0.45 + rng() * 0.2, 0.24 + rng() * 0.1));
      } else {
        trunks.setMatrixAt(ti++, mt.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(0.18 * s, 7 * s, 0.18 * s)));
        fronds.setMatrixAt(pi, mt.compose(new THREE.Vector3(x, y + 7.2 * s, z), q, new THREE.Vector3(2.8 * s, 0.9 * s, 2.8 * s)));
        fronds.setColorAt(pi++, col.setHSL(0.27 + rng() * 0.05, 0.5, 0.26 + rng() * 0.08));
      }
    }
    for (const im of [trunks, crowns, fronds]) { im.castShadow = true; im.receiveShadow = true; S.add(im); }
    A.treeCount = trees.length;
  }

  // ===== the way home: a portal gate on the Merlion Park promenade =====
  const gate = portalGate({ colA: 0xff3a4a, colB: 0xf2d6da, title: 'PORTAL', sub: 'back to the training sim · other areas', labelColor: '#ff9aa4' });
  gate.group.position.set(-196, 0, -48); gate.group.rotation.y = Math.PI; S.add(gate.group);
  A.collider(-199.2, 0, -49.1, 6.4, 0.5, 2.2); A.collider(-198.75, 0, -48.3, 0.5, 2, 0.6); A.collider(-193.75, 0, -48.3, 0.5, 2, 0.6);
  A.interact.push({ pos: new THREE.Vector3(-196, 0, -51.5), r: 2.8, text: 'Use the portal', act: 'portal' });
  anim.push((t) => gate.tick(t));

  // ===== spawn, titles, the per-frame tick =====
  const s0 = SG_SPOTS[0];
  A.spawn.pos.set(...s0.pos); A.spawn.yaw = s0.yaw;
  A.title = 'SINGAPORE';
  A.zoneTitle = (p) => {
    let best = 'MARINA BAY', bd = 1;
    for (const [name, x, z, r] of ZONES) { const d = Math.hypot(p.x - x, p.z - z) / r; if (d < bd) { bd = d; best = name; } }
    return `SINGAPORE · ${best}`;
  };
  let time = 0;
  A.tick = (dt, view) => {
    time += dt;
    sky.position.copy(view.camera.position);
    for (const f of anim) f(time, dt, view);
  };
  return A;
}
