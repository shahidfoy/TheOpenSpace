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

// ---------------- the training sim's city block ----------------
const noise = (g, n, amt, seed) => {
  rnd = seed;
  const im = g.getImageData(0, 0, n, n), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const k = 1 + (rand() - 0.5) * amt; d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; }
  g.putImageData(im, 0, 0);
};

// cast concrete: 1.5 m formwork panels with seams, tie holes and rain streaks (one tile = 3 m)
export function concreteTexture(base = '#9a9c9f') {
  const n = 512, c = canvas(n), g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, n, n);
  rnd = 21;
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    g.fillStyle = `rgba(${rand() < 0.5 ? '255,255,255' : '0,0,0'},${0.03 + rand() * 0.05})`;
    g.fillRect(x * 256, y * 256, 256, 256);
  }
  for (let i = 0; i < 26; i++) {
    const x = rand() * n, w = 6 + rand() * 22, h = 60 + rand() * 260, y = rand() * n;
    const gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, 'rgba(40,42,46,0.16)'); gr.addColorStop(1, 'rgba(40,42,46,0)');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
  }
  g.fillStyle = 'rgba(30,32,36,0.55)';
  for (let i = 0; i <= 2; i++) { g.fillRect(i * 256 - 1.5, 0, 3, n); g.fillRect(0, i * 256 - 1.5, n, 3); }
  g.fillStyle = 'rgba(25,27,30,0.6)';
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) for (const [a, b] of [[48, 48], [208, 48], [48, 208], [208, 208]]) { g.beginPath(); g.arc(x * 256 + a, y * 256 + b, 5, 0, 7); g.fill(); }
  noise(g, n, 0.12, 5);
  return tex(c);
}

// stone paving: staggered slabs with dark joints (one tile = 4 m)
export function pavingTexture() {
  const n = 512, c = canvas(n), g = c.getContext('2d');
  g.fillStyle = '#4c4f55'; g.fillRect(0, 0, n, n);
  rnd = 33;
  const rows = 4, h = n / rows;
  for (let r = 0; r < rows; r++) {
    const cols = 2, w = n / cols, off = r % 2 ? w / 2 : 0;
    for (let i = -1; i < cols + 1; i++) {
      const k = 0.86 + rand() * 0.24, warm = rand() * 10;
      g.fillStyle = `rgb(${Math.round((128 + warm) * k)},${Math.round(130 * k)},${Math.round(134 * k)})`;
      g.fillRect(i * w + off + 3, r * h + 3, w - 6, h - 6);
    }
  }
  noise(g, n, 0.16, 9);
  return tex(c);
}

// a building front: one storey per tile (4 m), two windows across, some lit
export function facadeTexture(wall = '#6f7480', lit = 0.3, seed = 41) {
  const n = 512, c = canvas(n), e = canvas(n), g = c.getContext('2d'), ge = e.getContext('2d');
  g.fillStyle = wall; g.fillRect(0, 0, n, n);
  ge.fillStyle = '#000'; ge.fillRect(0, 0, n, n);
  rnd = seed;
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, n - 26, n, 26);             // floor band
  g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, n - 34, n, 8);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const wx = x * 256 + 44, wy = y * 256 + 40, ww = 168, wh = 150;
    g.fillStyle = '#23262c'; g.fillRect(wx - 8, wy - 8, ww + 16, wh + 16);
    const on = rand() < lit;
    g.fillStyle = on ? '#e9c98a' : '#2f3f55'; g.fillRect(wx, wy, ww, wh);
    const gr = g.createLinearGradient(wx, wy, wx + ww, wy + wh);
    gr.addColorStop(0, 'rgba(255,255,255,0.22)'); gr.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(wx, wy, ww, wh);
    g.fillStyle = '#23262c'; g.fillRect(wx + ww / 2 - 3, wy, 6, wh); g.fillRect(wx, wy + wh * 0.45, ww, 5);
    if (on) { ge.fillStyle = '#b8935a'; ge.fillRect(wx, wy, ww, wh); }
  }
  noise(g, n, 0.1, seed + 1);
  return { map: tex(c), emissive: tex(e) };
}

// brick, for the walls you run along: courses of brick with a painted lane line at running height (one tile = 3 m)
export function brickTexture() {
  const n = 512, c = canvas(n), g = c.getContext('2d');
  g.fillStyle = '#3b3532'; g.fillRect(0, 0, n, n);
  rnd = 57;
  const rows = 16, h = n / rows, w = n / 6;
  for (let r = 0; r < rows; r++) for (let i = -1; i < 7; i++) {
    const k = 0.8 + rand() * 0.35;
    g.fillStyle = `rgb(${Math.round(126 * k)},${Math.round(70 * k)},${Math.round(56 * k)})`;
    g.fillRect(i * w + (r % 2 ? w / 2 : 0) + 2, r * h + 2, w - 4, h - 4);
  }
  noise(g, n, 0.14, 13);
  return tex(c);
}

// a steel ladder frame, for the walls you climb: rails, rungs every 30 cm, a hazard-yellow edge (one tile = 1.5 m)
export function ladderTexture() {
  const n = 256, c = canvas(n), g = c.getContext('2d');
  g.fillStyle = '#23272d'; g.fillRect(0, 0, n, n);
  g.fillStyle = '#14171b';
  for (let i = 0; i < 5; i++) g.fillRect(0, i * 51.2 + 8, n, 30);              // gaps between rungs
  g.fillStyle = '#8f98a3';
  for (let i = 0; i < 5; i++) { g.fillRect(0, i * 51.2, n, 9); g.fillStyle = '#c9d0d8'; g.fillRect(0, i * 51.2, n, 2); g.fillStyle = '#8f98a3'; }
  for (const x of [0, n / 2 - 7, n - 14]) { g.fillStyle = '#e0b020'; g.fillRect(x, 0, 14, n); g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x + 10, 0, 4, n); }
  return tex(c);
}
