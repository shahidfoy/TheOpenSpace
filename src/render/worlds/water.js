import * as THREE from 'three';

// Open water with real reflections: a planar mirror render of the skyline and sky (only objects on the reflection
// layer, so trees and small props stay out of it), blended with a deep body colour by a Fresnel term, rippled by four
// octaves of a scrolling normal map, with a sharp sun glint and a broader sheen. The mirror camera is the same
// oblique-clipped reflection Three's Reflector uses; it renders at half resolution right before the water is drawn.

const _plane = new THREE.Plane(), _normal = new THREE.Vector3(), _rw = new THREE.Vector3(), _cw = new THREE.Vector3();
const _rot = new THREE.Matrix4(), _look = new THREE.Vector3(), _clip = new THREE.Vector4(), _view = new THREE.Vector3();
const _target = new THREE.Vector3(), _q = new THREE.Vector4(), _size = new THREE.Vector2();
export const REFLECT_LAYER = 1;

// a tileable, irregular wave normal map: many random waves with whole-number wave vectors
export function waveNormalMap(n = 256, seed = 3) {
  let s = seed;
  const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const waves = [];
  for (let i = 0; i < 48; i++) {
    const f = 1 + Math.floor(Math.pow(rand(), 2) * 14), a = rand() * Math.PI * 2;
    waves.push([Math.round(Math.cos(a) * f), Math.round(Math.sin(a) * f), rand() * Math.PI * 2, 1 / (0.6 + f)]);
  }
  const H = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let h = 0;
    for (const [kx, ky, ph, amp] of waves) h += Math.sin(((kx * x + ky * y) / n) * Math.PI * 2 + ph) * amp;
    H[y * n + x] = h;
  }
  const c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d'), im = g.createImageData(n, n), d = im.data;
  const at = (x, y) => H[((y + n) % n) * n + ((x + n) % n)];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 2.2, dy = (at(x, y + 1) - at(x, y - 1)) * 2.2, l = Math.hypot(dx, dy, 1), i = (y * n + x) * 4;
    d[i] = (-dx / l * 0.5 + 0.5) * 255; d[i + 1] = (-dy / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export class ReflectiveWater extends THREE.Mesh {
  constructor({ size = 6000, sunDir, sunColor = 0xfff1dc, deep = 0x06262b, scatter = 0x1c5650, resScale = 0.5 } = {}) {
    const rt = new THREE.WebGLRenderTarget(16, 16, { type: THREE.HalfFloatType });
    const mat = new THREE.ShaderMaterial({
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        tReflect: { value: null }, tNormal: { value: null }, textureMatrix: { value: new THREE.Matrix4() }, time: { value: 0 },
        sunDir: { value: new THREE.Vector3() }, sunColor: { value: new THREE.Color(sunColor) }, deep: { value: new THREE.Color(deep) }, scatter: { value: new THREE.Color(scatter) },
      }]),
      vertexShader: `uniform mat4 textureMatrix; varying vec4 vRef; varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main(){
          vRef = textureMatrix * vec4(position, 1.0);
          vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `uniform sampler2D tReflect, tNormal; uniform float time; uniform vec3 sunDir, sunColor, deep, scatter;
        varying vec4 vRef; varying vec3 vWorld;
        #include <fog_pars_fragment>
        vec2 nrm(vec2 uv){ return texture2D(tNormal, uv).xy * 2.0 - 1.0; }
        void main(){
          vec2 p = vWorld.xz;
          vec2 n2 = nrm(p * 0.017 + vec2(time * 0.006, time * 0.004)) * 0.55
                  + nrm(p * 0.043 + vec2(-time * 0.010, time * 0.013)) * 0.4
                  + nrm(p * 0.13 + vec2(time * 0.024, -time * 0.017)) * 0.28
                  + nrm(p * 0.41 + vec2(-time * 0.045, -time * 0.035)) * 0.14;
          vec3 eye = cameraPosition - vWorld; float dist = length(eye); vec3 V = eye / dist;
          float calm = clamp(dist / 1400.0, 0.0, 1.0);
          float k = mix(0.42, 0.1, calm);
          vec3 N = normalize(vec3(-n2.x * k, 1.0, -n2.y * k));
          float fres = 0.025 + 0.975 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
          vec2 ruv = vRef.xy / vRef.w + N.xz * mix(0.045, 0.012, calm);
          vec3 refl = texture2D(tReflect, ruv).rgb;
          float down = max(V.y, 0.0);
          vec3 body = mix(scatter, deep, pow(down, 0.6));
          body += scatter * 0.35 * max(dot(N, normalize(sunDir + vec3(0.0, 0.5, 0.0))), 0.0);
          vec3 col = mix(body, refl, clamp(fres * 1.05, 0.0, 1.0));
          vec3 Hh = normalize(sunDir + V);
          float nh = max(dot(N, Hh), 0.0);
          col += sunColor * (pow(nh, 1400.0) * 9.0 + pow(nh, 160.0) * 0.35);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    mat.uniforms.tReflect.value = rt.texture;
    mat.uniforms.tNormal.value = waveNormalMap();
    mat.uniforms.sunDir.value.copy(sunDir).normalize();
    super(new THREE.PlaneGeometry(size, size), mat);
    this.rotation.x = -Math.PI / 2;
    this.frustumCulled = false;
    this.receiveShadow = false;
    this.rt = rt; this.resScale = resScale;
    const cam = (this.mirrorCam = new THREE.PerspectiveCamera());
    cam.layers.set(REFLECT_LAYER);
    const texM = mat.uniforms.textureMatrix.value;
    this.onBeforeRender = (renderer, scene, camera) => {
      renderer.getDrawingBufferSize(_size);
      const w = Math.max(16, Math.round(_size.x * this.resScale)), h = Math.max(16, Math.round(_size.y * this.resScale));
      if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
      _rw.setFromMatrixPosition(this.matrixWorld);
      _cw.setFromMatrixPosition(camera.matrixWorld);
      _rot.extractRotation(this.matrixWorld);
      _normal.set(0, 0, 1).applyMatrix4(_rot);
      _view.subVectors(_rw, _cw);
      if (_view.dot(_normal) > 0) return;                       // looking from below
      _view.reflect(_normal).negate().add(_rw);
      _rot.extractRotation(camera.matrixWorld);
      _look.set(0, 0, -1).applyMatrix4(_rot).add(_cw);
      _target.subVectors(_rw, _look).reflect(_normal).negate().add(_rw);
      cam.position.copy(_view);
      cam.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_normal);
      cam.lookAt(_target);
      cam.far = camera.far;
      cam.updateMatrixWorld();
      cam.projectionMatrix.copy(camera.projectionMatrix);
      texM.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
      texM.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse).multiply(this.matrixWorld);
      // oblique near plane: clip everything below the water
      _plane.setFromNormalAndCoplanarPoint(_normal, _rw).applyMatrix4(cam.matrixWorldInverse);
      _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
      const P = cam.projectionMatrix.elements;
      _q.x = (Math.sign(_clip.x) + P[8]) / P[0];
      _q.y = (Math.sign(_clip.y) + P[9]) / P[5];
      _q.z = -1;
      _q.w = (1 + P[10]) / P[14];
      _clip.multiplyScalar(2 / _clip.dot(_q));
      P[2] = _clip.x; P[6] = _clip.y; P[10] = _clip.z + 1 - 0.003; P[14] = _clip.w;
      this.visible = false;
      const prevRT = renderer.getRenderTarget(), prevXR = renderer.xr.enabled, prevShadow = renderer.shadowMap.autoUpdate;
      renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(rt);
      renderer.state.buffers.depth.setMask(true);
      if (renderer.autoClear === false) renderer.clear();
      renderer.render(scene, cam);
      renderer.xr.enabled = prevXR; renderer.shadowMap.autoUpdate = prevShadow;
      renderer.setRenderTarget(prevRT);
      if (camera.viewport !== undefined) renderer.state.viewport(camera.viewport);
      this.visible = true;
    };
  }
  tick(dt) { this.material.uniforms.time.value += dt; }
}
