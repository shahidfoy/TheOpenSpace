import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { NOISE } from './shaders.js';

// The real night sky: 25,700 catalogue stars (Hipparcos/BSC via d3-celestial, to mag 7.5)
// at their true RA/Dec, plus the Milky Way, Magellanic Clouds and Andromeda drawn in true
// galactic coordinates. Scene frame = ecliptic J2000 with +Y = ecliptic north (same as the map).
// Stars don't twinkle in space: twinkling is Earth's atmosphere. These are steady, round discs.

const R = Math.PI / 180, EPS = 23.4393 * R;
const SKY_R = 8000;
let DATA = null;

export function eqToScene(raDeg, decDeg, out = new THREE.Vector3()) {
  const a = raDeg * R, d = decDeg * R;
  const x = Math.cos(d) * Math.cos(a), y = Math.cos(d) * Math.sin(a), z = Math.sin(d);
  const ey = y * Math.cos(EPS) + z * Math.sin(EPS), ez = -y * Math.sin(EPS) + z * Math.cos(EPS);
  return out.set(x, ez, -ey);
}
// Galactic basis in scene coordinates (IAU 1958 frame).
export const GAL = {
  x: eqToScene(266.405, -28.936), // toward Sgr A*
  z: eqToScene(192.859, 27.128), // north galactic pole
};
GAL.y = new THREE.Vector3().crossVectors(GAL.z, GAL.x).normalize(); // l = 90°, direction of rotation
export function galToScene(lDeg, bDeg, out = new THREE.Vector3()) {
  const l = lDeg * R, b = bDeg * R;
  return out.set(0, 0, 0).addScaledVector(GAL.x, Math.cos(b) * Math.cos(l)).addScaledVector(GAL.y, Math.cos(b) * Math.sin(l)).addScaledVector(GAL.z, Math.sin(b));
}

export async function loadSky() {
  const base = `${import.meta.env.BASE_URL}sky/`;
  try {
    const [bin, lines, names] = await Promise.all([
      fetch(`${base}stars.bin`).then((r) => r.arrayBuffer()),
      fetch(`${base}lines.json`).then((r) => r.json()),
      fetch(`${base}names.json`).then((r) => r.json()),
    ]);
    DATA = { stars: new Int16Array(bin), lines, names };
  } catch (e) {
    console.warn('sky catalogue failed to load', e);
    DATA = { stars: new Int16Array(0), lines: [], names: [] };
  }
}

// B-V colour index → blackbody temperature (Ballesteros 2012) → RGB.
function bvColor(bv, out) {
  const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const t = T / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04; }
  else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255; }
  const c = (v) => Math.min(255, Math.max(0, v)) / 255;
  return out.setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
}

const STAR_VERT = /* glsl */ `
attribute float aSize; attribute float aAlpha;
uniform float uPR; uniform float uScale;
varying vec3 vC; varying float vA;
void main(){
  vC = color; vA = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPR * uScale;
}`;
const STAR_FRAG = /* glsl */ `
uniform float uGain;
varying vec3 vC; varying float vA;
void main(){
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = exp(-d * d * 9.0);
  float halo = (1.0 - d) * (1.0 - d) * 0.35;
  gl_FragColor = vec4(vC * (core * 1.5 + halo) * vA * uGain, 1.0);
}`;

const MW_FRAG = /* glsl */ `
uniform vec3 uGX; uniform vec3 uGY; uniform vec3 uGZ; uniform float uK;
uniform vec3 uLMC; uniform vec3 uSMC; uniform vec3 uM31;
varying vec3 vP;
${NOISE}
// x*x, never pow(x, 2.0): pow() of a negative base is NaN on Direct3D/ANGLE GPUs, and bloom smears NaN into black blocks
float sq(float x){ return x * x; }
float blob(vec3 d, vec3 c, float r){ float a = acos(clamp(dot(d, c), -1.0, 1.0)); return exp(-sq(a / r)); }
void main(){
  vec3 d = normalize(vP);
  float l = atan(dot(d, uGY), dot(d, uGX));
  float b = asin(clamp(dot(d, uGZ), -1.0, 1.0));
  float n = fbm(d * 7.0), n2 = fbm(d * 22.0 + 3.0), n3 = fbm(d * 3.0 + 9.0), n4 = fbm(d * 13.0 + 5.0), n5 = fbm(d * 48.0 + 1.0);
  float bulge = exp(-sq(l / 0.42));
  float width = 0.075 + 0.11 * bulge + 0.03 * n3;
  float disk = exp(-sq((b + 0.01 * sin(l * 3.0)) / width));
  float along = 0.32 + 0.38 * (0.5 + 0.5 * cos(l)) + 0.9 * bulge;
  float clump = 0.3 + 1.6 * n * n2 * (0.6 + 0.8 * n5);
  // Great Rift: dust lane from Cygnus (l ~ 80°) down through Aquila to Sagittarius
  float rift = exp(-sq((b - 0.02 - 0.05 * (n3 - 0.5) - 0.02 * (n4 - 0.5)) / (0.012 + 0.03 * n4))) * smoothstep(-0.45, -0.05, l) * smoothstep(1.55, 1.15, l);
  rift *= smoothstep(0.3, 0.6, n4 + 0.25 * n5);
  float dust = smoothstep(0.45, 0.75, fbm(d * 30.0 + 7.0)) * disk * 0.45;
  // Coalsack (l 301°, b -1°) and general dust mottling
  float coal = exp(-sq(length(vec2(l + 1.0297, b + 0.0175)) / 0.06));
  float I = disk * along * clump * (1.0 - 0.85 * rift) * (1.0 - 0.7 * coal) * (1.0 - dust) * (0.75 + 0.5 * n2);
  vec3 col = mix(vec3(0.55, 0.62, 0.8), vec3(1.0, 0.8, 0.58), bulge * 0.8 + 0.2 * n3) * I;
  col += vec3(0.72, 0.74, 0.85) * (blob(d, uLMC, 0.07) * (0.5 + 0.9 * n2) * 0.55 + blob(d, uSMC, 0.035) * 0.4);
  col += vec3(0.85, 0.82, 0.75) * blob(d, uM31, 0.018) * 0.5;
  col += vec3(0.003, 0.003, 0.006);
  gl_FragColor = vec4(max(col * uK, vec3(0.0)), 1.0);
}`;

export function makeSky({ lines = false, names = false, mw = 0.16, stars = 1 } = {}) {
  const g = new THREE.Group();
  const neb = new THREE.Mesh(
    new THREE.SphereGeometry(9000, 48, 24),
    new THREE.ShaderMaterial({
      uniforms: {
        uGX: { value: GAL.x }, uGY: { value: GAL.y }, uGZ: { value: GAL.z }, uK: { value: mw },
        uLMC: { value: galToScene(280.5, -32.9) }, uSMC: { value: galToScene(302.8, -44.3) }, uM31: { value: galToScene(121.2, -21.6) },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: MW_FRAG,
      side: THREE.BackSide, depthWrite: false, depthTest: false,
    }),
  );
  neb.renderOrder = -10;
  g.add(neb);

  const S = DATA?.stars || new Int16Array(0), n = S.length / 4;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), alpha = new Float32Array(n);
  const v = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const ra = S[i * 4] / 150, dec = S[i * 4 + 1] / 300, mag = S[i * 4 + 2] / 1000, bv = S[i * 4 + 3] / 1000;
    eqToScene(ra, dec, v).multiplyScalar(SKY_R);
    pos.set([v.x, v.y, v.z], i * 3);
    bvColor(bv, c);
    col.set([c.r, c.g, c.b], i * 3);
    // apparent brightness: flux ∝ 10^(-0.4 m); bright stars grow, faint ones fade rather than shrink below a pixel
    const flux = Math.pow(10, -0.4 * (mag - 1));
    size[i] = THREE.MathUtils.clamp(2.2 + Math.sqrt(flux) * 2.6, 2.2, 11);
    alpha[i] = THREE.MathUtils.clamp(Math.pow(flux, 0.42) * 1.4, 0.1, 1.6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPR: { value: 1 }, uScale: { value: 1 }, uGain: { value: stars * 1.3 } },
    vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, vertexColors: true,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.renderOrder = -9;
  pts.frustumCulled = false;
  pts.onBeforeRender = (r) => { mat.uniforms.uPR.value = r.getPixelRatio(); };
  g.add(pts);
  g.userData.stars = mat;

  if (lines && DATA?.lines.length) {
    const seg = [];
    for (const l of DATA.lines) for (let i = 1; i < l.length; i++) {
      seg.push(eqToScene(l[i - 1][0], l[i - 1][1]).multiplyScalar(SKY_R * 0.99), eqToScene(l[i][0], l[i][1]).multiplyScalar(SKY_R * 0.99));
    }
    const ls = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(seg), new THREE.LineBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.09, depthWrite: false, depthTest: false }));
    ls.renderOrder = -9;
    ls.frustumCulled = false;
    g.add(ls);
    g.userData.lines = ls;
  }
  if (names && DATA?.names.length) {
    const lab = new THREE.Group();
    for (const [name, ra, dec, mag] of DATA.names) {
      if (mag > 1.3) continue;
      const el = document.createElement('div');
      el.className = 'star-label';
      el.textContent = name;
      const o = new CSS2DObject(el);
      o.position.copy(eqToScene(ra, dec)).multiplyScalar(SKY_R * 0.98);
      lab.add(o);
    }
    g.add(lab);
    g.userData.names = lab;
  }
  return g;
}
