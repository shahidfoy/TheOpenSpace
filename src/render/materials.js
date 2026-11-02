import * as THREE from 'three';

// Procedural PBR texture set, generated once at boot (no texture downloads).
// Blender exports box-projected UVs (metres / 4), so one tile covers ~4 m of hull.
const N = 512;

function rand(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Tileable value noise on an N x N grid with period p cells.
function tileNoise(r, p) {
  const g = new Float32Array(p * p).map(() => r());
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const fx = (x / N) * p, fy = (y / N) * p;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = g[(iy % p) * p + (ix % p)], b = g[(iy % p) * p + ((ix + 1) % p)];
    const c = g[((iy + 1) % p) * p + (ix % p)], d = g[((iy + 1) % p) * p + ((ix + 1) % p)];
    out[y * N + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  return out;
}
function fbm(r, base, oct = 4) {
  const out = new Float32Array(N * N);
  let amp = 0.5, tot = 0;
  for (let o = 0; o < oct; o++) {
    const n = tileNoise(r, base << o);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    tot += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

const idx = (x, y) => (((y % N) + N) % N) * N + (((x % N) + N) % N);

// Hull plating: recursive panel split, seams, rivets, vents, grime and scratches.
function hullLayers(seed, opts = {}) {
  const r = rand(seed);
  const H = new Float32Array(N * N).fill(0.5);
  const A = new Float32Array(N * N).fill(1); // albedo multiplier
  const R = new Float32Array(N * N).fill(0.5); // roughness
  const M = new Float32Array(N * N).fill(1); // metalness multiplier
  const leaves = [];
  (function split(x, y, w, h, d) {
    const can = w > 48 || h > 48;
    if (d > 6 || !can || (d > 2 && r() < 0.18)) return leaves.push([x, y, w, h]);
    if ((w > h && r() < 0.8) || h <= 48) {
      const s = Math.round((0.3 + r() * 0.4) * w / 8) * 8 || w / 2;
      split(x, y, s, h, d + 1); split(x + s, y, w - s, h, d + 1);
    } else {
      const s = Math.round((0.3 + r() * 0.4) * h / 8) * 8 || h / 2;
      split(x, y, w, s, d + 1); split(x, y + s, w, h - s, d + 1);
    }
  })(0, 0, N, N, 0);

  for (const [x, y, w, h] of leaves) {
    const dh = (r() - 0.5) * 0.08, ta = 0.9 + r() * 0.12, tr = (r() - 0.5) * 0.18;
    const vent = w * h < 6000 && r() < 0.25, plate = r() < 0.12;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = idx(x + i, y + j);
      H[k] += dh;
      A[k] *= ta;
      R[k] += tr;
      if (vent && i > 4 && i < w - 4 && j > 4 && j < h - 4 && (j % 6) < 3) { H[k] -= 0.12; A[k] *= 0.55; }
      if (plate && i > 3 && i < w - 3 && j > 3 && j < h - 3) H[k] += 0.05;
    }
    // seams (darker grooves along the leaf border)
    for (let i = 0; i < w; i++) for (const yy of [y, y + 1]) { const k = idx(x + i, yy); H[k] = 0.3; A[k] *= 0.6; R[k] += 0.1; }
    for (let j = 0; j < h; j++) for (const xx of [x, x + 1]) { const k = idx(xx, y + j); H[k] = 0.3; A[k] *= 0.6; R[k] += 0.1; }
    // rivets
    if (r() < 0.45) {
      for (let i = 6; i < w - 4; i += 10) for (const yy of [y + 5, y + h - 5]) {
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) H[idx(x + i + a, yy + b)] += a * a + b * b > 1 ? 0.08 : 0.16;
      }
    }
  }
  const grime = fbm(r, 4, 5), streak = fbm(r, 2, 3);
  for (let i = 0; i < N * N; i++) {
    const gm = Math.max(0, grime[i] - 0.45) * 2.2;
    const y = (i / N) | 0;
    const st = Math.max(0, streak[(i % N) + ((y >> 3) % 8) * N] - 0.55) * 1.2;
    A[i] *= 1 - (gm * 0.35 + st * 0.2) * (opts.dirt ?? 1);
    R[i] += gm * 0.25;
  }
  // scratches / chips
  const chips = opts.chips ? fbm(r, 16, 3) : null;
  for (let s = 0; s < 160; s++) {
    let x = r() * N, y = r() * N;
    const a = r() * Math.PI * 2, len = 6 + r() * 30;
    for (let t = 0; t < len; t++) {
      const k = idx(Math.round(x), Math.round(y));
      R[k] -= 0.25; A[k] *= 1.15;
      x += Math.cos(a); y += Math.sin(a);
    }
  }
  if (chips) {
    for (let i = 0; i < N * N; i++) {
      // worn paint: chips appear along panel seams and in noisy patches
      const c = chips[i] > 0.66 + (opts.chips === 'light' ? 0.06 : 0) ? 1 : 0;
      if (c) { A[i] = 0.45; M[i] = 1; R[i] = 0.35; H[i] -= 0.03; } else M[i] = 0.15;
    }
  }
  return { H, A, R, M };
}

function normalFrom(H, strength) {
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (H[idx(x + 1, y)] - H[idx(x - 1, y)]) * strength;
    const dy = (H[idx(x, y + 1)] - H[idx(x, y - 1)]) * strength;
    const l = Math.hypot(dx, dy, 1), k = (y * N + x) * 4;
    d[k] = (-dx / l * 0.5 + 0.5) * 255;
    d[k + 1] = (-dy / l * 0.5 + 0.5) * 255;
    d[k + 2] = (1 / l * 0.5 + 0.5) * 255;
    d[k + 3] = 255;
  }
  return tex(d, false);
}

function tex(data, srgb) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  ALL.push(t);
  return t;
}
const ALL = [];

function pack(L, rough0, rough1) {
  const albedo = new Uint8Array(N * N * 4), orm = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const a = Math.min(1, Math.max(0, L.A[i])) * 255;
    albedo.set([a, a, a, 255], i * 4);
    const ro = Math.min(1, Math.max(0, rough0 + (L.R[i] - 0.5) * (rough1 - rough0) * 2));
    orm.set([255, ro * 255, Math.min(1, L.M[i]) * 255, 255], i * 4);
  }
  return { map: tex(albedo, true), orm: tex(orm, false) };
}

function solarTex() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#0b1530';
  g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const gr = g.createLinearGradient(x * 32, y * 32, x * 32 + 32, y * 32 + 32);
    gr.addColorStop(0, '#1a3a7a'); gr.addColorStop(1, '#0d1d48');
    g.fillStyle = gr;
    g.fillRect(x * 32 + 2, y * 32 + 2, 28, 28);
    g.fillStyle = 'rgba(180,200,255,0.35)';
    for (let k = 1; k < 4; k++) g.fillRect(x * 32 + 2, y * 32 + k * 7 + 2, 28, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(2, 2);
  ALL.push(t);
  return t;
}

function windowTex() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 512, 64);
  const r = rand(77);
  for (let x = 0; x < 512; x += 16) {
    const on = r();
    if (on < 0.18) continue;
    const warm = on > 0.85 ? '#9fe6ff' : on > 0.4 ? '#ffd9a0' : '#ffb766';
    g.fillStyle = warm;
    g.globalAlpha = 0.55 + r() * 0.45;
    g.fillRect(x + 3, 0, 10, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(4, 1);
  ALL.push(t);
  return t;
}

// ---------------------------------------------------------------- build
const hull = hullLayers(1);
const hullTex = pack(hull, 0.38, 0.75);
const hullN = normalFrom(hull.H, 3.2);
const paint = hullLayers(2, { chips: true, dirt: 0.8 });
const paintTex = pack(paint, 0.48, 0.78);
const paintN = normalFrom(paint.H, 2.6);
const light = hullLayers(3, { chips: 'light', dirt: 0.6 });
const lightTex = pack(light, 0.42, 0.7);
const lightN = normalFrom(light.H, 2.6);
const foilH = fbm(rand(4), 32, 3);
const foilN = normalFrom(foilH, 14);
const rockH = fbm(rand(5), 8, 6);
export const ROCK_NORMAL = normalFrom(rockH, 10);

const std = (o) => new THREE.MeshStandardMaterial({ roughness: 1, metalness: 1, ...o });
const metalMat = (color, metal, maps, n, nScale = 0.7) => std({
  color, metalness: metal, map: maps.map, roughnessMap: maps.orm, metalnessMap: maps.orm,
  normalMap: n, normalScale: new THREE.Vector2(nScale, nScale),
});
const emissive = (hex, k) => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: hex, emissiveIntensity: k, roughness: 0.6, metalness: 0 });

export const PBR = {
  hull: metalMat(0x6a6e76, 0.85, hullTex, hullN),
  hullLight: metalMat(0xc4c4bf, 1, lightTex, lightN, 0.5),
  hullDark: metalMat(0x2c2e33, 0.9, hullTex, hullN, 0.5),
  accent: metalMat(0xd9611a, 1, paintTex, paintN, 0.5),
  yellow: metalMat(0xd9a01c, 1, paintTex, paintN, 0.5),
  paintRed: metalMat(0x8a2416, 1, paintTex, paintN, 0.5),
  paintBlue: metalMat(0x1f4a82, 1, paintTex, paintN, 0.5),
  paintOlive: metalMat(0x5d6328, 1, paintTex, paintN, 0.5),
  paintTeal: metalMat(0x18706c, 1, paintTex, paintN, 0.5),
  paintWhite: metalMat(0xc9c9c2, 1, paintTex, paintN, 0.5),
  foil: std({ color: 0xd9a54a, metalness: 1, roughness: 0.32, normalMap: foilN, normalScale: new THREE.Vector2(1, 1) }),
  solar: std({ color: 0xffffff, map: solarTex(), metalness: 0.6, roughness: 0.28 }),
  glass: std({ color: 0x0a1016, metalness: 1, roughness: 0.04, emissive: 0xff9a40, emissiveIntensity: 0.12 }),
  window: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: windowTex(), emissiveIntensity: 2.2 }),
  cyan: emissive(0x00e5ff, 2.2),
  magenta: emissive(0xff1aa8, 2.2),
  amber: emissive(0xff8a10, 2.4),
  red: emissive(0xff1020, 4),
  green: emissive(0x10ff60, 4),
  engine: emissive(0x2f7dff, 0.75),
  engineHot: emissive(0x6fc4ff, 1.4),
};
for (const k in PBR) PBR[k].name = k;
PBR.hull.envMapIntensity = PBR.hullDark.envMapIntensity = 1.4;

// Swap glTF materials (matched by name) for the shared textured set.
export function upgrade(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const swap = (m) => PBR[m.name.replace(/\.\d+$/, '')] || m;
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
  return root;
}

export function setAnisotropy(n) {
  for (const t of ALL) { t.anisotropy = n; t.needsUpdate = true; }
}
