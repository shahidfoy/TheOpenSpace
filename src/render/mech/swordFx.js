import * as THREE from 'three';

// Sword VFX for the surface mech, condensed from the Noir arena's fx.js: slash crescents swept along the move's
// arc, a ribbon trail sampled from the blade, stretched HDR sparks and ground shock rings. Everything is pooled.

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _m = new THREE.Matrix4();
const _d = new THREE.Object3D();

export class SwordFx {
  constructor(scene) {
    this.scene = scene;
    this.initCrescents();
    this.initSparks();
    this.initRings();
    this.trail = this.makeTrail(0x5fdcff);
  }

  initCrescents() {
    this.cres = [];
    const geo = new THREE.RingGeometry(0, 1, 96, 1);
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
        uniforms: { a0: { value: 0 }, head: { value: 0 }, sgn: { value: 1 }, tail: { value: 2 }, inner: { value: 0.4 }, alpha: { value: 1 }, color: { value: new THREE.Color() } },
        vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `varying vec2 vP; uniform float a0, head, sgn, tail, inner, alpha; uniform vec3 color;
          void main(){
            float r = length(vP);
            if (r < inner) discard;
            float ang = atan(vP.y, vP.x);
            float rel = mod((ang - a0) * sgn, 6.2831853);
            float h = (head - a0) * sgn;
            if (rel > h) discard;
            float along = smoothstep(h - tail, h, rel);
            float rt = (r - inner) / (1.0 - inner);
            float radial = pow(rt, 2.2) * smoothstep(1.0, 0.9, rt);
            float edge = smoothstep(0.86, 0.97, rt) * smoothstep(1.0, 0.97, rt);
            float a = (radial * 0.9 + edge * 1.6) * along * alpha;
            gl_FragColor = vec4(color * a * 2.2, a);
          }`,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false; m.frustumCulled = false;
      this.scene.add(m);
      this.cres.push({ m, life: 0, max: 0.25, a0: 0, a1: 0, dur: 0.1, t: 0 });
    }
    this.crI = 0;
  }
  // center: world point; U, V: world unit vectors of the arc plane; radius outer, innerFrac: inner/outer
  crescent(center, U, V, a0, a1, dur, { radius = 2, innerFrac = 0.45, color = 0x9fefff, life = 0.22, tail = 2.6 } = {}) {
    const c = this.cres[this.crI]; this.crI = (this.crI + 1) % this.cres.length;
    const W = _v.crossVectors(U, V).normalize();
    _m.makeBasis(U, V, W);
    c.m.quaternion.setFromRotationMatrix(_m);
    c.m.position.copy(center);
    c.m.scale.setScalar(radius);
    const u = c.m.material.uniforms;
    u.a0.value = a0; u.sgn.value = Math.sign(a1 - a0) || 1; u.inner.value = innerFrac; u.tail.value = tail; u.alpha.value = 1;
    u.color.value.set(color);
    u.head.value = a0;
    c.a0 = a0; c.a1 = a1; c.dur = Math.max(0.01, dur); c.t = 0; c.life = c.max = dur + life;
    c.m.visible = true;
  }

  initSparks() {
    const N = this.NS = 300;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0, -0.5);
    this.sparks = new THREE.InstancedMesh(geo, mat, N);
    this.sparks.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.sparks.frustumCulled = false;
    this.sp = Array.from({ length: N }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, c: new THREE.Color(), w: 0.05, g: 2, floor: 0 }));
    this.spI = 0;
    _d.scale.setScalar(0); _d.updateMatrix();
    for (let i = 0; i < N; i++) this.sparks.setMatrixAt(i, _d.matrix);
    this.scene.add(this.sparks);
  }
  sparksAt(pos, n, { color = 0xbff4ff, speed = 14, dir = null, spread = 1, life = 0.5, width = 0.07, grav = 3, intensity = 4, floor = -1e9 } = {}) {
    const col = new THREE.Color(color).multiplyScalar(intensity);
    for (let k = 0; k < n; k++) {
      const s = this.sp[this.spI]; this.spI = (this.spI + 1) % this.NS;
      s.p.copy(pos);
      _v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      if (dir) _v.multiplyScalar(spread).add(dir).normalize();
      s.v.copy(_v).multiplyScalar(speed * (0.35 + Math.random() * 0.9));
      s.life = s.max = life * (0.5 + Math.random() * 0.8);
      s.c.copy(col); s.w = width; s.g = grav; s.floor = floor;
    }
  }

  initRings() {
    this.rings = [];
    const geo = new THREE.RingGeometry(0.85, 1, 64); geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
      const m = new THREE.Mesh(geo, mat); m.visible = false; this.scene.add(m);
      this.rings.push({ m, life: 0, max: 0.4, r: 3 });
    }
    this.riI = 0;
  }
  ring(pos, r, { life = 0.45, color = 0x9fe8ff, k = 2 } = {}) {
    const R = this.rings[this.riI]; this.riI = (this.riI + 1) % this.rings.length;
    R.m.position.copy(pos);
    R.m.material.color.set(color).multiplyScalar(k);
    R.life = R.max = life; R.r = r;
    R.m.visible = true;
  }

  makeTrail(color, n = 16) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    geo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(n * 2), 1));
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
      uniforms: { color: { value: new THREE.Color(color).multiplyScalar(2) } },
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 color; varying float vA; void main(){ gl_FragColor = vec4(color * vA, vA); }',
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    const tr = { mesh, n, base: [], tip: [], fade: 0 };
    for (let i = 0; i < n; i++) { tr.base.push(new THREE.Vector3()); tr.tip.push(new THREE.Vector3()); }
    return tr;
  }
  pushTrail(base, tip, on) {
    const tr = this.trail;
    tr.base.unshift(tr.base.pop().copy(base));
    tr.tip.unshift(tr.tip.pop().copy(tip));
    if (on) tr.fade = 1;
  }

  setVisible(v) {
    for (const c of this.cres) if (!v) c.m.visible = false;
    this.sparks.visible = v;
    this.trail.mesh.visible = v && this.trail.fade > 0.01;
  }

  update(dt) {
    for (let i = 0; i < this.NS; i++) {
      const s = this.sp[i];
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { _d.position.set(0, -1e4, 0); _d.scale.setScalar(0); _d.updateMatrix(); this.sparks.setMatrixAt(i, _d.matrix); continue; }
      s.v.y -= s.g * dt;
      s.v.multiplyScalar(1 - 2 * dt);
      s.p.addScaledVector(s.v, dt);
      if (s.p.y < s.floor) { s.p.y = s.floor; s.v.y *= -0.35; }
      const k = s.life / s.max;
      _d.position.copy(s.p);
      _d.lookAt(_v.copy(s.p).add(s.v));
      _d.scale.set(s.w * k + 0.01, s.w * k + 0.01, Math.max(0.08, s.v.length() * 0.04));
      _d.updateMatrix();
      this.sparks.setMatrixAt(i, _d.matrix);
      this.sparks.instanceColor.setXYZ(i, s.c.r * k, s.c.g * k, s.c.b * k);
    }
    this.sparks.instanceMatrix.needsUpdate = true;
    this.sparks.instanceColor.needsUpdate = true;
    for (const c of this.cres) {
      if (!c.m.visible) continue;
      c.t += dt; c.life -= dt;
      const p = Math.min(1, c.t / c.dur);
      const e = 1 - Math.pow(1 - p, 3);
      const u = c.m.material.uniforms;
      u.head.value = c.a0 + (c.a1 - c.a0) * e;
      u.alpha.value = c.t < c.dur ? 1 : Math.max(0, c.life / (c.max - c.dur));
      if (c.life <= 0) c.m.visible = false;
    }
    for (const r of this.rings) {
      if (!r.m.visible) continue;
      r.life -= dt;
      const k = 1 - r.life / r.max;
      r.m.scale.setScalar(0.3 + r.r * (1 - Math.pow(1 - k, 3)));
      r.m.material.opacity = Math.max(0, 1 - k);
      if (r.life <= 0) r.m.visible = false;
    }
    const tr = this.trail;
    tr.fade = Math.max(0, tr.fade - dt * 5);
    const pos = tr.mesh.geometry.attributes.position, al = tr.mesh.geometry.attributes.alpha;
    let broken = false;
    for (let i = 0; i < tr.n; i++) {
      pos.setXYZ(i * 2, tr.base[i].x, tr.base[i].y, tr.base[i].z);
      pos.setXYZ(i * 2 + 1, tr.tip[i].x, tr.tip[i].y, tr.tip[i].z);
      if (i > 0 && tr.tip[i].distanceToSquared(tr.tip[i - 1]) > 30) broken = true;   // cut where the blade jumped
      const a = broken ? 0 : (1 - i / (tr.n - 1)) * tr.fade;
      al.setX(i * 2, a * 0.05); al.setX(i * 2 + 1, a * 0.6);
    }
    pos.needsUpdate = true; al.needsUpdate = true;
    tr.mesh.visible = tr.fade > 0.01;
  }
}
