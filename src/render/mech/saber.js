import * as THREE from 'three';

// Energy saber for the player suit: a machined hilt that always sits in the fist, and a beam that only exists while
// fighting. Igniting shoots the beam out of the emitter in ~0.1 s; letting go of the fight retracts it a little
// slower, the way the classic film sabers snap on and slide off. The beam is two layers: a white-hot core and an
// additive coloured sheath that is brightest along its axis (fresnel), so it reads as a rod of light from any angle
// and feeds the bloom pass. Built in metres, +Y out of the emitter (the grip bone's blade axis).

const ease = (t) => 1 - Math.pow(1 - t, 3);
const IGNITE_T = 0.1, RETRACT_T = 0.2;

const GLOW_VS = `varying vec3 vN; varying vec3 vV; varying float vY;
  void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; vY = position.y;
  gl_Position = projectionMatrix * mv; }`;
const GLOW_FS = `uniform vec3 color; uniform float alpha, uTime; varying vec3 vN; varying vec3 vV; varying float vY;
  void main(){
    float f = abs(dot(normalize(vN), normalize(vV)));
    float a = (pow(f, 1.6) * 0.9 + pow(f, 6.0) * 0.8) * alpha;
    a *= 0.92 + 0.08 * sin(vY * 40.0 - uTime * 55.0);     // faint energy ripple running up the blade
    gl_FragColor = vec4(mix(color, vec3(1.0), pow(f, 8.0) * 0.5) * a * 2.4, a);
  }`;

export class Saber {
  // length: beam length (m); size: hilt scale reference (m, roughly the hand height)
  constructor(length, size, color = 0x52d8ff) {
    this.length = length;
    this.group = new THREE.Group();
    this.k = 0;          // ignition 0..1
    this.time = 0;

    // ---- hilt: grip with ribs, emitter shroud, pommel ----
    const metal = new THREE.MeshStandardMaterial({ color: 0x3a3f47, metalness: 0.9, roughness: 0.32, envMapIntensity: 1.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14161a, metalness: 0.6, roughness: 0.55 });
    this.ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.6), toneMapped: false });
    const r = size * 0.11, hl = size * 0.66;
    const cyl = (rt, rb, h, y, mat, seg = 16) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
      m.position.y = y; m.castShadow = true;
      this.group.add(m);
      return m;
    };
    cyl(r, r, hl, -hl * 0.5, dark);                                          // grip
    for (let i = 0; i < 5; i++) cyl(r * 1.12, r * 1.12, hl * 0.045, -hl * (0.18 + i * 0.15), metal);   // ribs
    cyl(r * 1.25, r * 1.4, hl * 0.12, -hl - hl * 0.06, metal);               // pommel
    cyl(r * 1.35, r * 1.1, hl * 0.22, hl * 0.11, metal);                     // emitter shroud
    cyl(r * 1.0, r * 1.0, hl * 0.03, hl * 0.235, this.ringMat);              // glowing emitter ring
    this.base = hl * 0.24;

    // ---- beam ----
    this.coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffffff), toneMapped: false });
    this.glowMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      uniforms: { color: { value: new THREE.Color(color) }, alpha: { value: 1 }, uTime: { value: 0 } },
      vertexShader: GLOW_VS, fragmentShader: GLOW_FS,
    });
    const tube = new THREE.CylinderGeometry(1, 1, 1, 16, 8, true).translate(0, 0.5, 0);
    const cap = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    this.beam = new THREE.Group();
    this.beam.position.y = this.base;
    this.group.add(this.beam);
    const layer = (mat, rad, order) => {
      const body = new THREE.Mesh(tube, mat), tip = new THREE.Mesh(cap, mat);
      body.renderOrder = tip.renderOrder = order;
      body.frustumCulled = tip.frustumCulled = false;
      this.beam.add(body, tip);
      return { body, tip, rad };
    };
    this.core = layer(this.coreMat, size * 0.05, 2);
    this.glow = layer(this.glowMat, size * 0.17, 3);
    this.outerMat = this.glowMat.clone();
    this.outer = layer(this.outerMat, size * 0.34, 4);      // wide faint halo around the sheath
    this.beam.visible = false;
    this.setColor(color);
  }

  setColor(hex) {
    const c = new THREE.Color(hex);
    this.glowMat.uniforms.color.value.copy(c);
    this.outerMat.uniforms.color.value.copy(c);
    this.ringMat.color.copy(c).multiplyScalar(1.6);
    // the core is white-hot but keeps a breath of the blade colour so the bloom tints right
    this.coreMat.color.copy(c).lerp(new THREE.Color(1, 1, 1), 0.82).multiplyScalar(3.2);
  }

  // lit: the blade should be out; swinging: mid-cut (the sheath swells and brightens). Returns true on ignition.
  update(dt, lit, swinging) {
    this.time += dt;
    const was = this.k;
    this.k = lit ? Math.min(1, this.k + dt / IGNITE_T) : Math.max(0, this.k - dt / RETRACT_T);
    const on = this.k > 0.001;
    this.beam.visible = on;
    if (on) {
      const len = this.length * (lit ? ease(this.k) : this.k * this.k * (3 - 2 * this.k));
      const t = this.time;
      const hum = 1 + Math.sin(t * 83) * 0.035 + Math.sin(t * 47) * 0.03 + (Math.random() - 0.5) * 0.04;
      this.swell = THREE.MathUtils.lerp(this.swell ?? 1, swinging ? 1.18 : 1, Math.min(1, dt * 20));
      for (const L of [this.core, this.glow, this.outer]) {
        const rad = L.rad * (L === this.core ? 1 : hum * this.swell);
        L.body.scale.set(rad, Math.max(1e-3, len), rad);
        L.tip.scale.setScalar(rad);
        L.tip.position.y = len;
      }
      const a = Math.min(1, this.k * 3) * (swinging ? 1.2 : 1);
      this.glowMat.uniforms.uTime.value = this.outerMat.uniforms.uTime.value = t;
      this.glowMat.uniforms.alpha.value = 0.95 * a;
      this.outerMat.uniforms.alpha.value = 0.3 * a;
    }
    return was === 0 && this.k > 0;
  }

  // current beam extent (m) from the hilt origin
  get reach() { return this.base + this.length * this.k; }
}
