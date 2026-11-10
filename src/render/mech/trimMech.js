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

// The suit is a shell of hundreds of loose plates. Around the hips each plate was skinned on its own, so in a run
// neighbouring plates follow different bones: some swing out with the thigh, others shear into long shards behind
// the pelvis. Here the hips are re-skinned by position instead, so neighbours always agree: what sits within reach
// of a thigh's axis follows that thigh (easing in from the hip joint down), what stands off it (the pelvis and the
// armour around it) stays on the pelvis, and the few triangles that bridge the two are dropped. Returns the index.
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const REACH = 0.62, HIP_BAND = 0.6;      // model units off the thigh axis; fraction of the thigh the rule covers
function reskinHips(mesh, index) {
  const g = mesh.geometry, P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, sk = mesh.skeleton;
  const bi = (n) => sk.bones.findIndex((b) => b.name === n);
  const H = bi('Hips'), L = bi('LeftUpLeg'), R = bi('RightUpLeg'), KL = bi('LeftLeg'), KR = bi('RightLeg');
  if (!SI || !SW || [H, L, R, KL, KR].some((i) => i < 0)) return index;
  // joints in the geometry's bind space
  const joint = (i) => { const e = sk.boneInverses[i].clone().invert().premultiply(mesh.bindMatrixInverse).elements; return [e[12], e[13], e[14]]; };
  const legs = [[joint(L), joint(KL), L], [joint(R), joint(KR), R]].map(([a, b, bone]) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(d[0], d[1], d[2]);
    return { a, d: d.map((x) => x / len), len, bone };
  });
  const left = legs[0].a[0] > 0 ? 0 : 1;
  const N = P.count, T = new Float32Array(N), cls = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const w = new Map();
    for (let k = 0; k < 4; k++) { const ww = SW.getComponent(i, k); if (ww > 0) { const b = SI.getComponent(i, k); w.set(b, (w.get(b) || 0) + ww); } }
    const wl = (w.get(L) || 0) + (w.get(R) || 0), tot = (w.get(H) || 0) + wl;
    if (tot < 0.02) continue;
    const x = P.getX(i), leg = legs[x >= 0 ? left : 1 - left];
    const rx = x - leg.a[0], ry = P.getY(i) - leg.a[1], rz = P.getZ(i) - leg.a[2];
    const al = rx * leg.d[0] + ry * leg.d[1] + rz * leg.d[2], u = al / leg.len;
    const r = u < 0 ? Math.hypot(rx, ry, rz) : Math.hypot(rx - leg.d[0] * al, ry - leg.d[1] * al, rz - leg.d[2] * al);
    let t;
    if (r > REACH && u < HIP_BAND) { t = 0; cls[i] = 1; }
    else { t = smooth(-0.15, 0.45, u); t += (wl / tot - t) * smooth(0.5, 0.8, u); cls[i] = 2; }
    T[i] = t;
    w.delete(H); w.delete(L); w.delete(R);
    if (t < 0.999) w.set(H, tot * (1 - t));
    if (t > 0.001) w.set(leg.bone, tot * t);
    const e = [...w.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4), sum = e.reduce((p, q) => p + q[1], 0);
    for (let k = 0; k < 4; k++) { SI.setComponent(i, k, e[k] ? e[k][0] : 0); SW.setComponent(i, k, e[k] ? e[k][1] / sum : 0); }
  }
  SI.needsUpdate = SW.needsUpdate = true;
  const out = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const bridge = (cls[a] === 1 || cls[b] === 1 || cls[c] === 1) && (cls[a] === 2 || cls[b] === 2 || cls[c] === 2);
    if (bridge && Math.max(T[a], T[b], T[c]) > 0.25) continue;
    out.push(a, b, c);
  }
  return out;
}

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
  g.setIndex(reskinHips(mesh, out));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return removed;
}
