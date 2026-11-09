// Strips the NEXORION player mech of its teal back/leg fins and its belt (front loincloth, hip skirt plates, back
// hip plates, the holstered hilt) by dropping whole mesh islands from the 'suit' geometry's index, once at load.
// Every body cloned from the asset (on-foot mech, sim mech, flight suit) shares this geometry, so they all lose them.
//
// Islands are connected components of the index. Each one is classified in bind space (y up 0..6, +z forward) by
// its bounds, the bone that carries most of its skin weight, and how much of its texture is the pale teal trim.

const TEAL_SAMPLE = 1024;

function islands(g) {
  const idx = g.index.array, N = g.attributes.position.count;
  const par = new Int32Array(N);
  for (let i = 0; i < N; i++) par[i] = i;
  const f = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let i = 0; i < idx.length; i += 3) {
    let a = f(idx[i]), b = f(idx[i + 1]);
    if (a !== b) par[a] = b;
    a = f(idx[i]); b = f(idx[i + 2]);
    if (a !== b) par[a] = b;
  }
  return f;
}

function texels(map) {
  const img = map?.image;
  if (!img || typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = TEAL_SAMPLE;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, TEAL_SAMPLE, TEAL_SAMPLE);
    return cx.getImageData(0, 0, TEAL_SAMPLE, TEAL_SAMPLE).data;
  } catch { return null; }
}

function stats(mesh, f) {
  const g = mesh.geometry, P = g.attributes.position, UV = g.attributes.uv, idx = g.index.array;
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const bones = mesh.skeleton?.bones.map((b) => b.name) || [];
  const D = UV ? texels(mesh.material.map) : null;
  const flipY = mesh.material.map?.flipY;
  const S = new Map();
  const get = (r) => {
    let s = S.get(r);
    if (!s) S.set(r, (s = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9], teal: 0, area: 0, w: {} }));
    return s;
  };
  for (let i = 0; i < P.count; i++) {
    const s = get(f(i));
    for (let k = 0; k < 3; k++) { const v = P.getComponent(i, k); if (v < s.min[k]) s.min[k] = v; if (v > s.max[k]) s.max[k] = v; }
  }
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2], s = get(f(a));
    const ax = P.getX(b) - P.getX(a), ay = P.getY(b) - P.getY(a), az = P.getZ(b) - P.getZ(a);
    const bx = P.getX(c) - P.getX(a), by = P.getY(c) - P.getY(a), bz = P.getZ(c) - P.getZ(a);
    const ar = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    s.area += ar;
    if (D) {
      let x = (UV.getX(a) + UV.getX(b) + UV.getX(c)) / 3, y = (UV.getY(a) + UV.getY(b) + UV.getY(c)) / 3;
      x = ((x % 1) + 1) % 1; y = ((y % 1) + 1) % 1;
      if (flipY) y = 1 - y;
      const o = (Math.min(TEAL_SAMPLE - 1, Math.floor(y * TEAL_SAMPLE)) * TEAL_SAMPLE + Math.min(TEAL_SAMPLE - 1, Math.floor(x * TEAL_SAMPLE))) * 4;
      const R = D[o] / 255, G = D[o + 1] / 255, B = D[o + 2] / 255;
      if (G > 0.45 && B > 0.45 && R < Math.min(G, B) * 0.85) s.teal += ar;
    }
    if (si && sw) {
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(a, k);
        if (w > 0) { const n = bones[si.getComponent(a, k)]; s.w[n] = (s.w[n] || 0) + w; }
      }
    }
  }
  for (const s of S.values()) {
    s.teal = s.area > 0 ? s.teal / s.area : 0;
    let best = null, bw = 0;
    for (const n in s.w) if (s.w[n] > bw) { bw = s.w[n]; best = n; }
    s.bone = best;
  }
  return S;
}

const fin = (s) => s.teal > 0.2 && s.area > 0.0003 && s.max[2] < -0.15;
const belt = (s) => {
  if (s.bone === 'Hips') return s.min[1] < 2.9 || s.max[0] > 0.95 || s.min[0] < -0.95 || s.min[2] < -0.2;
  if (/UpLeg$/.test(s.bone || '')) return Math.abs((s.min[0] + s.max[0]) / 2) > 0.55 && s.min[2] < -0.25 && s.max[1] > 2.2;
  return false;
};

export function trimMechPlayer(gltf) {
  let mesh = null;
  gltf.scene.traverse((o) => { if (!mesh && o.isSkinnedMesh && o.material?.name === 'suit' && o.geometry.index) mesh = o; });
  if (!mesh) return 0;
  const g = mesh.geometry, f = islands(g), S = stats(mesh, f), src = g.index.array, out = [];
  for (let t = 0; t < src.length; t += 3) {
    const s = S.get(f(src[t]));
    if (s && (fin(s) || belt(s))) continue;
    out.push(src[t], src[t + 1], src[t + 2]);
  }
  const removed = src.length / 3 - out.length / 3;
  g.setIndex(out);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return removed;
}
