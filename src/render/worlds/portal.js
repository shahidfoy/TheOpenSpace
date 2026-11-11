import * as THREE from 'three';
import { label } from './area.js';

// A portal gate: a standing ring on a plinth with a swirling event surface. Online gates swirl in their area's
// colours; offline ones show slow grey static. `tick(t)` drives the swirl.

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';
const FRAG = `uniform float time, on; uniform vec3 colA, colB; varying vec2 vUv;
  void main(){
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p), a = atan(p.y, p.x);
    if (r > 1.0) discard;
    float sw = sin(a * 3.0 + r * 9.0 - time * 2.4 * on) * 0.5 + 0.5;
    float sw2 = sin(a * 5.0 - r * 14.0 + time * 1.7) * 0.5 + 0.5;
    vec3 c = mix(colA, colB, sw * 0.7 + sw2 * 0.3);
    c += vec3(1.0) * pow(1.0 - r, 4.0) * 0.3 * on;          // bright core
    c += colA * smoothstep(0.82, 1.0, r) * 0.6;               // hot rim
    float alpha = mix(0.55, 0.9, sw) * mix(0.5, 1.0, on);
    gl_FragColor = vec4(c * mix(0.35, 0.75, on), alpha);
  }`;

export function portalGate({ colA = 0x58e4ff, colB = 0x1a3a8a, title = 'PORTAL', sub = '', online = true, labelColor = '#7fe6ff' } = {}) {
  const g = new THREE.Group();
  const trim = new THREE.MeshStandardMaterial({ color: 0x1a1e25, metalness: 0.8, roughness: 0.35 });
  const glow = new THREE.MeshStandardMaterial({ color: 0x0b1c24, emissive: online ? colA : 0x445566, emissiveIntensity: online ? 2.2 : 0.6 });
  const mat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, on: { value: online ? 1 : 0 }, colA: { value: new THREE.Color(colA) }, colB: { value: new THREE.Color(colB) } },
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
  });
  const R = 2.4;
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.5, 2.2), trim); plinth.position.y = 0.25;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.28, 12, 64), trim); ring.position.y = R + 0.6;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R - 0.12, 0.08, 8, 64), glow); rim.position.y = R + 0.6;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(R - 0.15, 48), mat); disc.position.y = R + 0.6;
  for (const m of [plinth, ring]) { m.castShadow = true; m.receiveShadow = true; }
  g.add(plinth, ring, rim, disc);
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.6, 0.6), trim); post.position.set(s * (R + 0.1), 1.2, 0); post.castShadow = true;
    g.add(post);
  }
  const l = label(title, sub, labelColor); l.position.y = 2 * R + 2; l.scale.set(5, 1.25, 1);
  g.add(l);
  return { group: g, tick: (t) => { mat.uniforms.time.value = t; }, online };
}
