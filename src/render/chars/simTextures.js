import * as THREE from 'three';

// Procedural textures for the training sim and the ship's deck, drawn once into canvases.
// The look follows a game-dev gray-box test level: orange prototype grid on the blocks, a pale grid floor, and
// glowing blue hex-stone panels marking the surfaces you can run along or climb.

const canvas = (n) => { const c = document.createElement('canvas'); c.width = c.height = n; return c; };
const tex = (c, srgb = true, rep = true) => {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (rep) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
};
let rnd = 1;
const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };

// one texture tile = 1 m: a 4 x 4 grid of 25 cm squares with a heavier line on the metre
export function gridTexture(base = '#d9772f', line = '#7a3410', major = '#5a2408') {
  const n = 256, c = canvas(n), g = c.getContext('2d');
  rnd = 7;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const k = 0.9 + rand() * 0.14;
    const col = new THREE.Color(base).multiplyScalar(k);
    g.fillStyle = `#${col.getHexString()}`;
    g.fillRect(x * 64, y * 64, 64, 64);
  }
  g.fillStyle = line;
  for (let i = 0; i <= 4; i++) { g.fillRect(i * 64 - 1, 0, 2, n); g.fillRect(0, i * 64 - 1, n, 2); }
  g.fillStyle = major;
  g.fillRect(0, 0, 4, n); g.fillRect(0, 0, n, 4);
  return tex(c);
}

export function floorTexture() { return gridTexture('#a9adb3', '#7b8088', '#5e636b'); }

// metal deck plating for the ship interior: big panels, seams, rivets, hazard stripe at the edge
export function deckTexture() {
  const n = 512, c = canvas(n), g = c.getContext('2d');
  rnd = 3;
  g.fillStyle = '#2b3038'; g.fillRect(0, 0, n, n);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const k = 0.85 + rand() * 0.3;
    g.fillStyle = `rgb(${Math.round(52 * k)},${Math.round(58 * k)},${Math.round(68 * k)})`;
    g.fillRect(x * 256 + 4, y * 256 + 4, 248, 248);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 6; i++) g.fillRect(x * 256 + 20, y * 256 + 30 + i * 36, 216, 2);
    g.fillStyle = '#1a1d22';
    for (const [rx, ry] of [[14, 14], [242, 14], [14, 242], [242, 242]]) { g.beginPath(); g.arc(x * 256 + rx, y * 256 + ry, 4, 0, 7); g.fill(); }
  }
  return tex(c);
}

export function wallTexture() {
  const n = 512, c = canvas(n), g = c.getContext('2d');
  g.fillStyle = '#3a404a'; g.fillRect(0, 0, n, n);
  g.fillStyle = '#4a515d'; g.fillRect(16, 16, n - 32, n * 0.55);
  g.fillStyle = '#2a2f37'; g.fillRect(16, n * 0.62, n - 32, n * 0.34);
  g.fillStyle = '#1b1f25'; g.fillRect(0, n * 0.585, n, 6);
  return tex(c);
}

// Hex-stone panels: jittered-grid Voronoi cells (tileable), each stone its own shade of blue, darker grout, a
// brighter rim of light inside each stone. Returns { map, emissive, bump }.
export function hexStoneTextures() {
  const n = 256, G = 8, cell = n / G;
  rnd = 11;
  const pts = [], cols = [];
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    pts.push([(x + 0.2 + rand() * 0.6) * cell, (y + 0.2 + rand() * 0.6) * cell]);
    const h = 0.55 + rand() * 0.08, s = 0.55 + rand() * 0.35, l = 0.45 + rand() * 0.25;
    cols.push(new THREE.Color().setHSL(h, s, l));
  }
  const cm = canvas(n), ce = canvas(n), cb = canvas(n);
  const im = cm.getContext('2d').createImageData(n, n), ie = ce.getContext('2d').createImageData(n, n), ib = cb.getContext('2d').createImageData(n, n);
  for (let py = 0; py < n; py++) for (let px = 0; px < n; px++) {
    const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
    let d1 = 1e9, d2 = 1e9, best = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const cx = (gx + ox + G) % G, cy = (gy + oy + G) % G, i = cy * G + cx;
      const qx = pts[i][0] + (gx + ox - cx) * cell, qy = pts[i][1] + (gy + oy - cy) * cell;
      const d = Math.hypot(px - qx, py - qy);
      if (d < d1) { d2 = d1; d1 = d; best = i; } else if (d < d2) d2 = d;
    }
    const edge = Math.min(1, (d2 - d1) / 5);            // 0 on the grout line
    const rim = Math.max(0, 1 - Math.abs((d2 - d1) - 7) / 5);   // a lit band just inside the stone edge
    const centre = Math.max(0, 1 - d1 / (cell * 0.8));
    const c = cols[best], o = (py * n + px) * 4;
    const k = edge < 1 ? 0.25 + 0.75 * edge : 1;
    im.data[o] = c.r * 255 * k; im.data[o + 1] = c.g * 255 * k; im.data[o + 2] = c.b * 255 * k; im.data[o + 3] = 255;
    const e = edge * (0.25 + 0.45 * rim + 0.3 * centre);
    ie.data[o] = c.r * 255 * e * 0.7; ie.data[o + 1] = c.g * 255 * e; ie.data[o + 2] = Math.min(255, c.b * 255 * e * 1.3); ie.data[o + 3] = 255;
    const b = Math.round(255 * Math.pow(edge, 0.5) * (0.75 + 0.25 * centre));
    ib.data[o] = ib.data[o + 1] = ib.data[o + 2] = b; ib.data[o + 3] = 255;
  }
  cm.getContext('2d').putImageData(im, 0, 0); ce.getContext('2d').putImageData(ie, 0, 0); cb.getContext('2d').putImageData(ib, 0, 0);
  return { map: tex(cm), emissive: tex(ce), bump: tex(cb, false) };
}

export function starTexture() {
  const n = 1024, c = canvas(n), g = c.getContext('2d');
  rnd = 5;
  g.fillStyle = '#02040a'; g.fillRect(0, 0, n, n);
  for (let i = 0; i < 900; i++) {
    const r = rand() < 0.95 ? 0.6 : 1.4;
    g.fillStyle = `rgba(255,255,255,${0.3 + rand() * 0.7})`;
    g.beginPath(); g.arc(rand() * n, rand() * n, r, 0, 7); g.fill();
  }
  // Earth below the window: a lit limb with an atmosphere glow
  const grd = g.createRadialGradient(n * 0.5, n * 1.9, n * 0.9, n * 0.5, n * 1.9, n * 1.25);
  grd.addColorStop(0, '#1d4f9a'); grd.addColorStop(0.78, '#2f78c8'); grd.addColorStop(0.86, '#9fd4ff'); grd.addColorStop(1, 'rgba(120,190,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, n, n);
  return tex(c, true, false);
}

// BoxGeometry whose UVs are in world metres (texture repeats once per `tile` metres on every face)
export function worldBox(w, h, d, tile = 1) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];   // +x -x +y -y +z -z
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) {
    const k = f * 4 + i;
    uv.setXY(k, uv.getX(k) * dims[f][0] / tile, uv.getY(k) * dims[f][1] / tile);
  }
  return geo;
}
