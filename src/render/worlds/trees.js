import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Trees for the simulated cities: real branching trees with leaves, not lollipops.
//
// Three species, two variants each, grown procedurally once: the rain tree (a short trunk splitting into long
// spreading limbs under a wide umbrella canopy, the classic Singapore shade tree), the coconut palm (a leaning ringed
// trunk and a crown of drooping fronds) and a street tree (upright, rounded, the second variant in yellow flame
// bloom). Bark is tapered cylinders; leaves are cards painted with clusters of individual leaves, alpha-cut, lit with
// normals pointing out of the canopy (so the crown shades as a volume) and swaying in the wind.
//
// Thousands of trees are drawn with instancing at three levels of detail chosen by distance from the camera: the
// full tree up close, a pruned one in the middle distance and crossed billboards far away. Every few frames each
// tree is sorted into its level and the instance buffers are rewritten, so the whole forest is a few dozen draws.

const UP = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();
export const wind = { value: 0 };

const rngOf = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// ---------------- painted foliage ----------------
function leaf(g, x, y, len, wid, ang, h, s, l, rib = true) {
  g.save(); g.translate(x, y); g.rotate(ang);
  const gr = g.createLinearGradient(0, -wid, 0, wid);
  gr.addColorStop(0, hsl(h, s, l + 9)); gr.addColorStop(0.5, hsl(h, s, l + 2)); gr.addColorStop(1, hsl(h, s + 4, l - 7));
  g.fillStyle = gr;
  g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(len * 0.25, -wid, len * 0.7, -wid * 0.9, len, 0); g.bezierCurveTo(len * 0.7, wid * 0.9, len * 0.25, wid, 0, 0); g.fill();
  if (rib) { g.strokeStyle = hsl(h, s - 10, l + 14, 0.55); g.lineWidth = Math.max(0.8, wid * 0.1); g.beginPath(); g.moveTo(0, 0); g.lineTo(len * 0.9, 0); g.stroke(); }
  g.restore();
}
// rain tree: twice-compound leaves, rows of small leaflets along fine stems, with twigs showing through
function rainLeaves() {
  return canvasTex(512, 512, (g, n) => {
    const r = rngOf(7), C = n / 2;
    g.clearRect(0, 0, n, n);
    for (let i = 0; i < 9; i++) { const a = r() * Math.PI * 2; g.strokeStyle = hsl(28, 25, 22); g.lineWidth = 3 + r() * 3; g.beginPath(); g.moveTo(C, C); g.lineTo(C + Math.cos(a) * 200, C + Math.sin(a) * 200); g.stroke(); }
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 46; i++) {
      const a = r() * Math.PI * 2, d0 = r() * 120, sx = C + Math.cos(a) * d0, sy = C + Math.sin(a) * d0;
      const ang = a + (r() - 0.5) * 1.2, L = 110 + r() * 110, h = 88 + r() * 22, s = 42 + r() * 18, l = (pass ? 30 : 21) + r() * 9;
      g.strokeStyle = hsl(h, 30, 24); g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + Math.cos(ang) * L, sy + Math.sin(ang) * L); g.stroke();
      for (let t = 0.12; t < 1; t += 0.085) {
        const px = sx + Math.cos(ang) * L * t, py = sy + Math.sin(ang) * L * t;
        if (Math.hypot(px - C, py - C) > 238) continue;
        const ll = 17 + r() * 8 - t * 5, ww = 6 + r() * 2.5;
        leaf(g, px, py, ll, ww, ang - 1.15 - r() * 0.3, h, s, l + r() * 6, false);
        leaf(g, px, py, ll, ww, ang + 1.15 + r() * 0.3, h, s, l + r() * 6, false);
      }
    }
  });
}
// broadleaf: ovate leaves alternating along twigs; optionally yellow flame-tree blossom
function broadLeaves(bloom) {
  return canvasTex(512, 512, (g, n) => {
    const r = rngOf(bloom ? 31 : 13), C = n / 2;
    g.clearRect(0, 0, n, n);
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 11; i++) {
      const a = r() * Math.PI * 2, L = 150 + r() * 80;
      const sx = C + Math.cos(a) * r() * 60, sy = C + Math.sin(a) * r() * 60;
      g.strokeStyle = hsl(25, 28, 25); g.lineWidth = 3;
      g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + Math.cos(a) * L, sy + Math.sin(a) * L); g.stroke();
      for (let t = 0.15, k = 0; t < 1.02; t += 0.11, k++) {
        const px = sx + Math.cos(a) * L * t, py = sy + Math.sin(a) * L * t;
        const side = k % 2 ? 1 : -1, h = 95 + r() * 25, l = (pass ? 32 : 22) + r() * 10;
        leaf(g, px, py, 46 + r() * 26, 15 + r() * 7, a + side * (0.7 + r() * 0.5), h, 45 + r() * 15, l);
      }
      leaf(g, sx + Math.cos(a) * L, sy + Math.sin(a) * L, 50, 17, a, 100, 50, 30 + r() * 8);
    }
    if (bloom) for (let i = 0; i < 26; i++) {
      const a = r() * Math.PI * 2, d = 40 + r() * 180, x = C + Math.cos(a) * d, y = C + Math.sin(a) * d;
      for (let k = 0; k < 14; k++) { g.fillStyle = hsl(46 + r() * 8, 95, 52 + r() * 14); g.beginPath(); g.arc(x + (r() - 0.5) * 30, y + (r() - 0.5) * 30, 3 + r() * 3, 0, 7); g.fill(); }
    }
  });
}
// a coconut frond: a central rachis, leaflets angled toward the tip (tip at the top of the canvas)
function frondTex() {
  return canvasTex(128, 512, (g, w, h) => {
    const r = rngOf(17);
    g.clearRect(0, 0, w, h);
    for (let y = h - 8; y > 6; y -= 5) {
      const t = 1 - y / h, len = 60 * Math.sin(Math.PI * (0.06 + 0.94 * t)) * (1 - 0.25 * t) + 6;
      for (const s of [-1, 1]) {
        if (r() < 0.06) continue;                                   // a torn leaflet here and there
        const l = 24 + r() * 10 + (r() < 0.12 ? -8 : 0);
        g.strokeStyle = hsl(78 + r() * 18, 50 + r() * 15, l); g.lineWidth = 3.2;
        g.beginPath(); g.moveTo(w / 2, y); g.quadraticCurveTo(w / 2 + s * len * 0.6, y - 10, w / 2 + s * len, y - 22 - r() * 6); g.stroke();
      }
    }
    g.strokeStyle = hsl(55, 40, 38); g.lineWidth = 4; g.beginPath(); g.moveTo(w / 2, h); g.lineTo(w / 2, 0); g.stroke();
  });
}
function barkTex(palm) {
  return canvasTex(256, 256, (g, n) => {
    const r = rngOf(palm ? 5 : 3);
    g.fillStyle = palm ? '#9a8c78' : '#8a7a68'; g.fillRect(0, 0, n, n);
    if (palm) {
      for (let y = 0; y < n; y += 12 + r() * 6) { g.fillStyle = `rgba(40,32,25,${0.35 + r() * 0.3})`; g.fillRect(0, y, n, 3 + r() * 3); g.fillStyle = 'rgba(200,190,170,0.12)'; g.fillRect(0, y + 4, n, 2); }
    } else {
      for (let i = 0; i < 160; i++) { const x = r() * n; g.fillStyle = `rgba(${r() < 0.5 ? '25,20,15' : '150,135,115'},${0.12 + r() * 0.2})`; g.fillRect(x, 0, 1 + r() * 4, n); }
      for (let i = 0; i < 40; i++) { g.fillStyle = 'rgba(110,120,80,0.18)'; g.fillRect(r() * n, r() * n, 6 + r() * 20, 4 + r() * 10); }   // lichen
    }
  });
}
// far-away silhouettes for the billboards
function silhouette(kind) {
  return canvasTex(256, 256, (g, n) => {
    const r = rngOf(kind.length * 11);
    g.clearRect(0, 0, n, n);
    g.strokeStyle = kind === 'palm' ? '#6f6352' : '#4a3c30';
    if (kind === 'palm') {
      g.lineWidth = 6; g.beginPath(); g.moveTo(128, 256); g.quadraticCurveTo(122, 150, 132, 70); g.stroke();
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2, dx = Math.cos(a) * (60 + r() * 30), dy = Math.sin(a) * 18 - 8;
        g.strokeStyle = hsl(85 + r() * 15, 45, 26 + r() * 10); g.lineWidth = 9;
        g.beginPath(); g.moveTo(132, 70); g.quadraticCurveTo(132 + dx * 0.6, 58 + dy - 16, 132 + dx, 70 + dy + 30); g.stroke();
      }
      return;
    }
    const rain = kind === 'rain';
    g.lineWidth = rain ? 14 : 10; g.beginPath(); g.moveTo(128, 256); g.lineTo(128, rain ? 160 : 150); g.stroke();
    g.lineWidth = 6; for (const dx of [-60, -25, 25, 60]) { g.beginPath(); g.moveTo(128, rain ? 165 : 160); g.lineTo(128 + dx, rain ? 110 : 90); g.stroke(); }
    const cx = 128, cy = rain ? 92 : 92, rx = rain ? 122 : 84, ry = rain ? 58 : 84;
    for (let i = 0; i < 420; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r());
      const x = cx + Math.cos(a) * d * rx, y = cy + Math.sin(a) * d * ry * (Math.sin(a) > 0 && rain ? 0.7 : 1);
      g.fillStyle = hsl(kind === 'flame' && r() < 0.25 ? 48 : 95 + r() * 20, 45, 18 + (cy - y) / ry * 8 + r() * 12);
      g.beginPath(); g.arc(x, y, 5 + r() * 7, 0, 7); g.fill();
    }
  });
}

// ---------------- materials ----------------
function foliageMaterial(map, sway = true) {
  const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.78, metalness: 0, emissive: 0x0b1606, emissiveIntensity: 0.6 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWind = wind;
    if (sway) {
      sh.vertexShader = 'uniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3][0] * 0.37 + instanceMatrix[3][2] * 0.23;
        #else
          float ph = 0.0;
        #endif
        float sway = max(position.y - 1.2, 0.0);
        transformed.x += sin(uWind * 1.7 + ph + position.y * 0.7) * 0.03 * sway;
        transformed.z += cos(uWind * 1.3 + ph * 1.3 + position.x * 0.8) * 0.025 * sway;
        transformed.y += sin(uWind * 3.3 + ph + (position.x + position.z) * 2.1) * 0.02 * sway;`);
    }
    // both faces of a leaf card take the canopy normal (no flip on the back face)
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'));
  };
  return m;
}

// ---------------- geometry ----------------
function limb(p0, p1, r0, r1, radial) {
  const d = _v.subVectors(p1, p0), len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, 1, true);
  g.translate(0, len / 2, 0);
  const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, (uv.getY(i) * len) / 2);
  g.applyQuaternion(_q.setFromUnitVectors(UP, d.normalize()));
  g.translate(p0.x, p0.y, p0.z);
  return g;
}
// a leaf card at c, facing out of the canopy (and a little up), normals bent to point away from the crown's centre
function card(c, size, r, center) {
  const g = new THREE.PlaneGeometry(size, size);
  const out = _w.subVectors(c, center).normalize();
  const n = out.clone().add(new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(1.1)).addScaledVector(UP, 0.5).normalize();
  g.rotateZ(r() * Math.PI * 2);
  g.applyQuaternion(_q.setFromUnitVectors(Z, n));
  g.translate(c.x, c.y, c.z);
  const p = g.attributes.position, nn = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    _v.fromBufferAttribute(p, i).sub(center); _v.y *= 1.4; _v.normalize().multiplyScalar(0.8).addScaledVector(n, 0.2).normalize();
    nn.setXYZ(i, _v.x, _v.y, _v.z);
  }
  return g;
}
const merge = (list) => { const g = mergeGeometries(list, false); list.forEach((x) => x.dispose()); return g; };

// a broadleaf tree: trunk, limbs, sub-branches, leaf cards at the ends. lod 0 full, 1 pruned
function broadleaf(P, seed, lod) {
  const r = rngOf(seed), R = (a, b) => a + r() * (b - a);
  const bark = [], leaves = [];
  const rad = lod ? 5 : 7;
  const top = new THREE.Vector3(R(-0.25, 0.25), P.trunkH, R(-0.25, 0.25));
  bark.push(limb(new THREE.Vector3(0, -0.2, 0), top, P.trunkR * 1.25, P.trunkR * 0.85, rad));
  if (!lod) bark.push(limb(new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(0, 0.6, 0), P.trunkR * 1.7, P.trunkR * 1.05, rad));   // root flare
  const center = new THREE.Vector3(0, P.trunkH + P.crownLift, 0);
  for (let i = 0; i < P.limbs; i++) {
    const az = (i / P.limbs) * Math.PI * 2 + R(-0.4, 0.4), el = R(P.el[0], P.el[1]), L = R(P.limb[0], P.limb[1]);
    const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    const end = top.clone().addScaledVector(dir, L);
    bark.push(limb(top.clone().addScaledVector(dir, -0.2), end, P.trunkR * 0.5, P.trunkR * 0.24, rad));
    for (let k = 0; k < P.subs; k++) {
      const az2 = az + R(-0.9, 0.9), el2 = R(P.subEl[0], P.subEl[1]), L2 = R(P.sub[0], P.sub[1]);
      const d2 = new THREE.Vector3(Math.cos(el2) * Math.cos(az2), Math.sin(el2), Math.cos(el2) * Math.sin(az2));
      const start = top.clone().lerp(end, R(0.55, 1)), tip = start.clone().addScaledVector(d2, L2);
      if (!lod) bark.push(limb(start, tip, P.trunkR * 0.22, P.trunkR * 0.07, 5));
      const n = lod ? 2 : P.cards;
      for (let c = 0; c < n; c++) {
        const at = start.clone().lerp(tip, lod ? 0.75 : R(0.35, 1.05)).add(new THREE.Vector3(R(-0.7, 0.7), R(-0.3, 0.6), R(-0.7, 0.7)));
        leaves.push(card(at, R(P.card[0], P.card[1]) * (lod ? 1.75 : 1), r, center));
      }
    }
  }
  return { bark: merge(bark), leaves: merge(leaves) };
}
const SPECIES = {
  rain: { trunkH: 2.5, trunkR: 0.36, crownLift: 1.4, limbs: 5, el: [0.42, 0.75], limb: [2.6, 3.5], subs: 3, subEl: [0.08, 0.45], sub: [1.6, 2.4], cards: 7, card: [1.6, 2.3] },
  street: { trunkH: 2.1, trunkR: 0.22, crownLift: 2.2, limbs: 4, el: [0.9, 1.2], limb: [1.9, 2.6], subs: 3, subEl: [0.35, 0.95], sub: [1.2, 1.8], cards: 7, card: [1.3, 1.8] },
};

// a coconut palm: a leaning ringed trunk and a crown of arching, drooping fronds
function palm(seed, lod) {
  const r = rngOf(seed), R = (a, b) => a + r() * (b - a);
  const H = R(6.4, 7.8), lean = R(0.4, 1.6), la = r() * Math.PI * 2;
  const segs = lod ? 3 : 8, bark = [], leaves = [];
  const pts = [];
  for (let i = 0; i <= segs; i++) { const t = i / segs; pts.push(new THREE.Vector3(Math.cos(la) * lean * t * t, H * t, Math.sin(la) * lean * t * t)); }
  for (let i = 0; i < segs; i++) bark.push(limb(pts[i], pts[i + 1], 0.25 - 0.08 * (i / segs), 0.25 - 0.08 * ((i + 1) / segs), lod ? 5 : 8));
  const top = pts[segs], center = top.clone().add(new THREE.Vector3(0, -0.6, 0));
  const F = lod ? 9 : 16, S = lod ? 3 : 8;
  for (let f = 0; f < F; f++) {
    const az = (f / F) * Math.PI * 2 + R(-0.2, 0.2), el = R(0.15, 1.0), L = R(3.3, 4.6);
    const hz = new THREE.Vector3(Math.cos(az), 0, Math.sin(az)), side = new THREE.Vector3().crossVectors(UP, hz).normalize();
    const pos = [], nor = [], uv = [], idx = [];
    for (let j = 0; j <= S; j++) {
      const t = j / S, along = L * t * Math.cos(el * 0.4), h = L * (Math.sin(el) * t - 0.62 * t * t);
      const c = top.clone().addScaledVector(hz, along).addScaledVector(UP, h);
      const wd = 0.85 * Math.sin(Math.PI * (0.06 + 0.94 * t)) * (1 - 0.3 * t) + 0.04;
      for (const s of [1, -1]) {
        const p = c.clone().addScaledVector(side, s * wd).addScaledVector(UP, -0.18 * wd);   // fronds fold down along the rachis
        pos.push(p.x, p.y, p.z);
        _v.subVectors(p, center).normalize().multiplyScalar(0.5).addScaledVector(UP, 0.7).normalize();
        nor.push(_v.x, _v.y, _v.z);
        uv.push(s > 0 ? 1 : 0, t);
      }
      if (j < S) { const a = j * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    leaves.push(g);
  }
  if (!lod) for (let i = 0; i < 5; i++) {                 // coconuts under the crown
    const a = r() * Math.PI * 2, g = new THREE.SphereGeometry(0.17, 8, 6);
    g.deleteAttribute('uv'); g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.translate(top.x + Math.cos(a) * 0.28, top.y - 0.35, top.z + Math.sin(a) * 0.28);
    bark.push(g);
  }
  return { bark: merge(bark), leaves: merge(leaves) };
}
// three crossed vertical quads, base on the ground
function billboard(w, h) {
  const list = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.PlaneGeometry(w, h); g.translate(0, h / 2, 0); g.rotateY((i / 3) * Math.PI);
    const p = g.attributes.position, nn = g.attributes.normal;
    for (let k = 0; k < p.count; k++) { _v.fromBufferAttribute(p, k); _v.y -= h * 0.55; _v.normalize().multiplyScalar(0.6).addScaledVector(UP, 0.6).normalize(); nn.setXYZ(k, _v.x, _v.y, _v.z); }
    list.push(g);
  }
  return merge(list);
}

// ---------------- the forest ----------------
// list: [x, y, z, scale, type] with type 0 rain tree, 1 palm, 2 street tree
export class Forest {
  constructor(list, { near = 140, mid = 460 } = {}) {
    this.group = new THREE.Group();
    this.group.userData.noReflect = true;
    this.near2 = near * near; this.mid2 = mid * mid;
    const bark = new THREE.MeshStandardMaterial({ map: barkTex(false), roughness: 0.95 });
    const palmBark = new THREE.MeshStandardMaterial({ map: barkTex(true), roughness: 0.9 });
    const rainLeaf = foliageMaterial(rainLeaves()), greenLeaf = foliageMaterial(broadLeaves(false)), flameLeaf = foliageMaterial(broadLeaves(true)), frond = foliageMaterial(frondTex());
    const bill = { rain: foliageMaterial(silhouette('rain'), false), palm: foliageMaterial(silhouette('palm'), false), street: foliageMaterial(silhouette('street'), false), flame: foliageMaterial(silhouette('flame'), false) };
    const bbRain = billboard(11, 7), bbPalm = billboard(7, 9), bbStreet = billboard(7.5, 8);
    // kinds: [type][variant]
    const kinds = [
      [0, 101, rainLeaf, bark, bill.rain, bbRain], [0, 202, rainLeaf, bark, bill.rain, bbRain],
      [1, 303, frond, palmBark, bill.palm, bbPalm], [1, 404, frond, palmBark, bill.palm, bbPalm],
      [2, 505, greenLeaf, bark, bill.street, bbStreet], [2, 606, flameLeaf, bark, bill.flame, bbStreet],
    ].map(([type, seed, leafMat, barkMat, billMat, bbGeo]) => ({
      type, items: [],
      lods: [0, 1].map((lod) => (type === 1 ? palm(seed, lod) : broadleaf(type === 0 ? SPECIES.rain : SPECIES.street, seed, lod))),
      leafMat, barkMat, billMat, bbGeo,
    }));
    // sort the trees into kinds, with a fixed transform and a leaf tint each
    const r = rngOf(99), col = new THREE.Color();
    for (const [x, y, z, s, type] of list) {
      const k = kinds[(type === 1 ? 2 : type === 2 ? 4 : 0) + (r() < 0.5 ? 0 : 1)];
      _q.setFromAxisAngle(UP, r() * Math.PI * 2);
      const m = new Float32Array(16);
      _m.compose(_v.set(x, y, z), _q, _s.set(s, s * (0.9 + r() * 0.2), s)).toArray(m);
      col.setHSL(0, 0, 1).offsetHSL((r() - 0.5) * 0.05, (r() - 0.5) * 0.15, (r() - 0.5) * 0.18);
      k.items.push({ x, y, z, m, c: [col.r, col.g, col.b] });
    }
    // per kind, per level: [bark?, leaves]
    const make = (geo, mat, n, shadow, tint) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
      im.count = 0; im.frustumCulled = false; im.castShadow = shadow; im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (tint) im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3);
      this.group.add(im);
      return im;
    };
    this.kinds = kinds.filter((k) => k.items.length).map((k) => {
      const n = k.items.length;
      k.levels = [
        [make(k.lods[0].bark, k.barkMat, n, true, false), make(k.lods[0].leaves, k.leafMat, n, true, true)],
        [make(k.lods[1].bark, k.barkMat, n, false, false), make(k.lods[1].leaves, k.leafMat, n, false, true)],
        [null, make(k.bbGeo, k.billMat, n, false, true)],
      ];
      return k;
    });
    this.count = list.length;
    this.last = new THREE.Vector3(1e9, 0, 0);
    this.cool = 0;
  }
  // re-sort trees into levels when the camera has moved (or every half second)
  update(dt, cam) {
    wind.value += dt;
    this.cool -= dt;
    if (this.cool > 0 && cam.distanceToSquared(this.last) < 64) return;
    this.cool = 0.5; this.last.copy(cam);
    for (const k of this.kinds) {
      const n = [0, 0, 0];
      for (const it of k.items) {
        const dx = it.x - cam.x, dz = it.z - cam.z, dy = (it.y - cam.y) * 0.5, d2 = dx * dx + dz * dz + dy * dy;
        const l = d2 < this.near2 ? 0 : d2 < this.mid2 ? 1 : 2, i = n[l]++;
        const [b, f] = k.levels[l];
        if (b) b.instanceMatrix.array.set(it.m, i * 16);
        f.instanceMatrix.array.set(it.m, i * 16);
        f.instanceColor.array.set(it.c, i * 3);
      }
      k.levels.forEach(([b, f], l) => {
        for (const im of [b, f]) { if (!im) continue; im.count = n[l]; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
      });
    }
  }
}
