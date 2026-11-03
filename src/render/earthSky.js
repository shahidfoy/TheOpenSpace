import * as THREE from 'three';
import { NOISE } from './shaders.js';
import { weather } from './weather.js';

// Close-up Earth for the local (PILOT) view: a cloud shell lit by the real Sun and a physically
// based atmosphere (Rayleigh + Mie single scattering) drawn over the surface and the clouds.
// The surface itself is shaded in planets.js (uReal); the cloud shell and the ground's cloud
// shadows both read the live NASA GIBS cloud map (weather.texture), so they match today's weather.

export const CLOUD_H = 0.004; // cloud shell height above the surface, in planet radii (~25 km)

// Shared by the surface, the clouds and the sky. Distances in km, real sea-level coefficients;
// the haze (Mie) scale height is stretched a little so it reads at game scale.
export const SKY_GLSL = /* glsl */ `
const float PI = 3.14159265;
const vec3 BR = vec3(5.8e-3, 13.5e-3, 33.1e-3); // Rayleigh scattering (km^-1)
const float BM = 4e-3;                           // Mie scattering (km^-1)
const float BME = BM * 1.11;                     // Mie extinction
const float HR = 8.0, HM = 2.4;                  // scale heights (km)
const float RP = 6371.0, RA = 6451.0;            // ground and top-of-atmosphere radii (km)
// Sunlight left after crossing the air to a ground point whose sun elevation has cosine mu
// (Kasten-Young airmass): white at noon, orange-red at the terminator.
vec3 sunTrans(float mu){
  float z = min(acos(clamp(mu, -1.0, 1.0)) * 57.29578, 90.0);
  float m = 1.0 / (max(mu, 0.0) + 0.50572 * pow(96.07995 - z, -1.6364));
  return exp(-(BR * HR + BME * HM) * m);
}
// Schüler's Chapman approximation: relative optical depth from altitude h (in scale heights,
// planet radius X in scale heights) toward a direction at cosine coschi from the zenith.
float chapman(float X, float h, float coschi){
  float c = sqrt(X + h);
  if (coschi >= 0.0) return c / (c * coschi + 1.0) * exp(-h);
  float x0 = sqrt(1.0 - coschi * coschi) * (X + h);
  return 2.0 * sqrt(x0) * exp(min(X - x0, 40.0)) - c / (1.0 - c * coschi) * exp(-h);
}`;

const VERT = /* glsl */ `
uniform vec3 uSunDir;
varying vec2 vUv; varying vec3 vObj; varying vec3 vW; varying vec3 vLo;
void main(){
  vUv = uv;
  vObj = position;
  vLo = vec3(dot(uSunDir, modelMatrix[0].xyz), dot(uSunDir, modelMatrix[1].xyz), dot(uSunDir, modelMatrix[2].xyz)); // Sun in object space
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const CLOUD_FRAG = /* glsl */ `
uniform sampler2D uClouds; uniform sampler2D uNight; uniform vec3 uSunDir; uniform float uLight; uniform float uCloudK;
uniform float uQ; uniform vec2 uTexel;
varying vec2 vUv; varying vec3 vObj; varying vec3 vW; varying vec3 vLo;
${SKY_GLSL}
${NOISE}
void main(){
  float c = texture2D(uClouds, vUv).r * uCloudK;
  if (c < 0.004) discard;
  vec3 P = normalize(vObj), Lo = normalize(vLo);
  float pxl = length(fwidth(vObj)) / length(vObj); // screen pixel size in radians on the shell
  float cu = texture2D(uClouds, vUv + vec2(uTexel.x, 0.0)).r - texture2D(uClouds, vUv - vec2(uTexel.x, 0.0)).r;
  float cv = texture2D(uClouds, vUv + vec2(0.0, uTexel.y)).r - texture2D(uClouds, vUv - vec2(0.0, uTexel.y)).r;
  if (uQ > 0.5) {
    // crisp, wispy edges up close on the 26 km/texel map: mostly along the real cloud edges, so
    // the weather's own shapes stay in charge (fades out before it can alias)
    float k = smoothstep(2.5e-3, 6e-4, pxl) * (0.25 + 0.75 * clamp(length(vec2(cu, cv)) * 5.0, 0.0, 1.0));
    float n = noise(P * 300.0) * 0.6 + noise(P * 820.0) * 0.4;
    if (uQ > 1.5) n = n * 0.85 + noise(P * 2100.0) * 0.15;
    c = clamp(mix(c, (c - (n - 0.5) * 0.5 * (1.0 - c * 0.7)) * 1.05, k), 0.0, 1.0);
    if (c < 0.004) discard;
  }
  // cloud tops: thickness gradient bends the normal, so banks and towers catch the light
  vec3 east = normalize(vec3(P.z, 0.0, -P.x) + vec3(1e-5)), north = cross(P, east);
  vec3 Nc = normalize(P - 1.6 * (cu * east + cv * north));
  float ndlG = dot(P, Lo), ndl = dot(Nc, Lo);
  float thick = smoothstep(0.25, 1.0, c);
  vec3 V = normalize(cameraPosition - vW), L = normalize(uSunDir);
  // clouds sit higher than the ground, so they stay lit a little past the ground's terminator
  float day = smoothstep(-0.09, 0.04, ndlG + 0.03);
  vec3 Ts = sunTrans(ndlG + 0.03);
  float wrap = clamp((ndl + 0.4) / 1.4, 0.0, 1.0); // light diffusing through the cloud body
  vec3 lit = Ts * uLight * 0.72 * wrap * day * mix(1.0, 0.72, thick * (1.0 - clamp(ndl, 0.0, 1.0)));
  vec3 amb = vec3(0.05, 0.07, 0.11) * uLight * smoothstep(-0.2, 0.3, ndlG);
  float fwd = pow(max(dot(-V, L), 0.0), 6.0) * (1.0 - thick) * 0.8; // thin edges glow toward the Sun
  vec3 col = vec3(0.96) * (lit + amb) + Ts * fwd * uLight * day;
  // city light from below faintly lights cloud bases on the night side
  vec3 lights = texture2D(uNight, vUv).rgb;
  col += lights * lights * smoothstep(0.04, -0.16, ndlG) * 0.08 * vec3(1.6, 1.25, 0.8);
  // a cloud deck seen edge-on near the horizon looks denser
  float mu = max(dot(P, normalize((cameraPosition - vW))), 0.12);
  float a = 1.0 - pow(1.0 - min(c * 1.05, 0.98), 0.6 / mu + 0.4);
  gl_FragColor = vec4(col, a);
}`;

export function cloudShell(R, nightTex) {
  const img = weather.texture.image;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uClouds: { value: weather.texture }, uNight: { value: nightTex }, uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uLight: { value: 1.25 }, uCloudK: { value: 1 }, uQ: { value: 2 }, uTexel: { value: new THREE.Vector2(1 / img.width, 1 / img.height) },
    },
    vertexShader: VERT, fragmentShader: CLOUD_FRAG, transparent: true, depthWrite: false,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(R * (1 + CLOUD_H), 128, 64), mat);
  m.userData.sunDir = mat.uniforms.uSunDir.value;
  return m;
}

// Single scattering along the view ray through the air shell; the Sun's optical depth comes from
// the Chapman approximation, so the cost is one loop of uSteps samples. Output is the scattered
// light plus the view ray's mean transmittance in alpha, blended as dst * alpha + src, which
// dims (and hazes) the ground, clouds and stars behind it.
const ATMO_FRAG = /* glsl */ `
uniform vec3 uSunDir; uniform vec3 uCenter; uniform float uR; uniform float uSunI; uniform int uSteps;
varying vec2 vUv; varying vec3 vObj; varying vec3 vW; varying vec3 vLo;
${SKY_GLSL}
vec2 rsi(vec3 o, vec3 d, float r){
  float b = dot(o, d), c = dot(o, o) - r * r, h = b * b - c;
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
void main(){
  float km = RP / uR;
  vec3 o = (cameraPosition - uCenter) * km;
  vec3 d = normalize(vW - cameraPosition);
  vec2 a = rsi(o, d, RA);
  if (a.x > a.y || a.y < 0.0) discard;
  vec2 g = rsi(o, d, RP);
  float t0 = max(a.x, 0.0), t1 = a.y;
  if (g.x < g.y && g.x > 0.0) t1 = min(t1, g.x);
  vec3 L = normalize(uSunDir);
  float mu = dot(d, L);
  float phR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  const float G = 0.76;
  float phM = 3.0 / (8.0 * PI) * ((1.0 - G * G) * (1.0 + mu * mu)) / ((2.0 + G * G) * pow(1.0 + G * G - 2.0 * G * mu, 1.5));
  float n = float(uSteps), ds = (t1 - t0) / n;
  float odR = 0.0, odM = 0.0;
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (i >= uSteps) break;
    vec3 p = o + d * (t0 + (float(i) + 0.5) * ds);
    float r = length(p), h = max(r - RP, 0.0);
    float dR = exp(-h / HR) * ds, dM = exp(-h / HM) * ds;
    odR += dR * 0.5; odM += dM * 0.5; // optical depth up to the middle of this step
    float cs = dot(p, L) / r;
    float sR = HR * chapman(RP / HR, h / HR, cs), sM = HM * chapman(RP / HM, h / HM, cs);
    vec3 T = exp(-(BR * (odR + sR) + BME * (odM + sM)));
    sumR += dR * T; sumM += dM * T;
    odR += dR * 0.5; odM += dM * 0.5;
  }
  vec3 col = uSunI * (sumR * BR * phR + sumM * BM * phM);
  vec3 Tv = exp(-(BR * odR + BME * odM));
  gl_FragColor = vec4(col, dot(Tv, vec3(0.3333)));
}`;

export function scatteringShell(R) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: new THREE.Vector3(1, 0, 0) }, uCenter: { value: new THREE.Vector3() }, uR: { value: R },
      uSunI: { value: 7 }, uSteps: { value: 16 },
    },
    vertexShader: VERT, fragmentShader: ATMO_FRAG, transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(R * (6451 / 6371), 128, 64), mat);
  const s = new THREE.Vector3();
  m.onBeforeRender = () => {
    m.parent.getWorldPosition(mat.uniforms.uCenter.value);
    m.parent.getWorldScale(s);
    mat.uniforms.uR.value = R * s.x;
  };
  m.userData.sunDir = mat.uniforms.uSunDir.value;
  return m;
}

// ultra / high / low: scattering samples and the shaders' detail branches
export const EARTH_Q = { ultra: { q: 2, steps: 16 }, high: { q: 1, steps: 10 }, low: { q: 0, steps: 6 } };
