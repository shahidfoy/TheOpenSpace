import * as THREE from 'three';

// Final lens pass (after tone mapping): radial chromatic aberration, sun flare with
// anamorphic streak and ghosts, vignette and film grain.
export const LensShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSun: { value: new THREE.Vector3(0.5, 0.5, 0) },
    uAspect: { value: 1 },
    uCA: { value: 0.012 },
    uGrain: { value: 0.035 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform vec3 uSun; uniform float uAspect; uniform float uCA; uniform float uGrain;
    varying vec2 vUv;
    void main(){
      vec2 d = vUv - 0.5;
      float r = dot(d, d);
      vec2 off = d * uCA * r * 4.0;
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      if (uSun.z > 0.01) {
        vec2 a = vUv - uSun.xy; a.x *= uAspect;
        float l = length(a);
        col += vec3(1.0, 0.86, 0.62) * exp(-l * 7.0) * 0.28 * uSun.z;
        col += vec3(0.55, 0.78, 1.0) * exp(-abs(a.y) * 160.0) * exp(-abs(a.x) * 2.2) * 0.3 * uSun.z;
        vec2 axis = 0.5 - uSun.xy;
        for (int i = 1; i < 5; i++) {
          float fi = float(i);
          vec2 gd = vUv - (uSun.xy + axis * fi * 0.52); gd.x *= uAspect;
          float s = 0.018 + 0.022 * fi;
          float ring = smoothstep(s, s * 0.7, length(gd)) - 0.6 * smoothstep(s * 0.85, s * 0.5, length(gd));
          col += mix(vec3(0.3, 0.6, 1.0), vec3(1.0, 0.55, 0.25), fi / 4.0) * ring * 0.07 * uSun.z;
        }
      }
      col *= mix(1.0, 0.5, smoothstep(0.12, 0.7, r * 1.7));
      float n = fract(sin(dot(vUv * 1000.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

// Runs straight after the scene render: replaces NaN / Inf pixels (and clamps runaway HDR) before
// bloom can blur them into large black blocks. Some GPU drivers (Direct3D via ANGLE) produce NaN
// where others don't, so this keeps one bad pixel from blacking out the screen.
export const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; varying vec2 vUv;
    // isnan() can be optimised away by some drivers, so also test the value against itself and a range
    bool bad(float x){ return isnan(x) || isinf(x) || !(x == x) || !(abs(x) < 1e6); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      if (bad(c.r) || bad(c.g) || bad(c.b)) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 64.0), 1.0);
    }`,
};
