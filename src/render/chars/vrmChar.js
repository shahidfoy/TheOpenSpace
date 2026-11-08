import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// Playable VRM characters (VRoid Hub models, see public/characters/CREDITS.txt) animated with Mixamo clips retargeted
// at load time onto the VRM humanoid. The retarget follows three-vrm's Mixamo example: every Mixamo bone's rotation
// is re-expressed relative to its rest pose and applied to the matching normalized VRM bone, and the hips translation
// is rescaled to the model's leg length. Root motion is stripped (the controller moves the character), keeping only the
// clip's own bob so loops stay seamless.

// Each character has one or more outfits: separate VRM models of the same character published by its creator
// (every outfit's file and licence is listed in public/characters/CREDITS.txt). The first outfit is the default.
export const CHARACTERS = [
  { id: 'rachael', name: 'Rachael', thumb: 'rachael.png', blurb: 'Goth vampire · agile', by: 'Banjo Boi',
    outfits: [
      { id: 'goth', name: 'Goth', file: 'rachael.vrm', thumb: 'rachael.png' },
      { id: 'vampire', name: 'Vampire Dress', file: 'outfits/rachael_vampire.vrm', thumb: 'outfits/rachael_vampire.jpg' },
      { id: 'dream', name: 'Dream', file: 'outfits/rachael_dream.vrm', thumb: 'outfits/rachael_dream.jpg' },
      { id: 'xmas', name: 'Christmas', file: 'outfits/rachael_xmas.vrm', thumb: 'outfits/rachael_xmas.jpg' },
    ] },
  { id: 'remi', name: 'Ayame Remi', thumb: 'remi.jpg', blurb: 'Light on her feet', by: 'ゔぁんそこ',
    outfits: [
      { id: 'swim', name: 'Summer Swimsuit', file: 'remi.vrm', thumb: 'remi.jpg' },
      { id: 'rider', name: 'Rider Suit', file: 'outfits/remi_rider.vrm', thumb: 'outfits/remi_rider.jpg' },
      { id: 'ninja', name: 'Ninja', file: 'outfits/remi_ninja.vrm', thumb: 'outfits/remi_ninja.jpg' },
      { id: 'coat', name: 'Long Coat', file: 'outfits/remi_coat.vrm', thumb: 'outfits/remi_coat.jpg' },
      { id: 'cat', name: 'Black Cat', file: 'outfits/remi_cat.vrm', thumb: 'outfits/remi_cat.jpg' },
      { id: 'dress', name: 'Black Dress', file: 'outfits/remi_dress.vrm', thumb: 'outfits/remi_dress.jpg' },
      { id: 'hoodie', name: 'Hoodie', file: 'outfits/remi_hoodie.vrm', thumb: 'outfits/remi_hoodie.jpg' },
      { id: 'yukata', name: 'Yukata', file: 'outfits/remi_yukata.vrm', thumb: 'outfits/remi_yukata.jpg' },
    ] },
  { id: 'emo', name: 'Kuro', thumb: 'emo.png', blurb: 'Hoodie runner · steady', by: 'Em0 MFXXX',
    outfits: [{ id: 'hoodie', name: 'Hoodie', file: 'emo.vrm', thumb: 'emo.png' }] },
];

// Colourways: a true recolour (not a multiply) of a model's clothing or hair. VRoid exports name their materials
// *_CLOTH and *_HAIR; those get a small patch at the end of the MToon shader that maps the shaded colour's
// brightness onto the chosen colour, so even black clothes can turn red and green hair can go silver.
export const SWATCHES = [
  null, '#1e1e24', '#f2f2f4', '#c41e3a', '#ff7ec4', '#8a5cff', '#3a78ff', '#22c7b8', '#e6b24a', '#b8c0cc',
];
export function applyColours(vrm, { cloth = null, hair = null } = {}) {
  vrm.scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      const kind = /_CLOTH/.test(m.name) ? 'cloth' : /_HAIR/.test(m.name) ? 'hair' : null;
      if (!kind || !m.isShaderMaterial) continue;
      if (!m.userData.recolor) patchRecolor(m);
      const hex = kind === 'cloth' ? cloth : hair;
      m.userData.recolor.amt.value = hex ? 1 : 0;
      if (hex) m.userData.recolor.tint.value.set(hex);
    }
  });
}
function patchRecolor(m) {
  const u = (m.userData.recolor = { tint: { value: new THREE.Color() }, amt: { value: 0 } });
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    sh.uniforms.uRecolorTint = u.tint; sh.uniforms.uRecolorAmt = u.amt;
    sh.fragmentShader = 'uniform vec3 uRecolorTint;\nuniform float uRecolorAmt;\n' + sh.fragmentShader.replace('#include <tonemapping_fragment>', `
      if (uRecolorAmt > 0.0) {
        float lum = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
        vec3 rc = uRecolorTint * (0.12 + lum * 1.15) + max(vec3(0.0), vec3(lum - 0.85)) * 0.6;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, rc, uRecolorAmt);
      }
      #include <tonemapping_fragment>`);
  };
  m.customProgramCacheKey = () => (prevKey ? prevKey.call(m) : '') + '|recolor';
  m.needsUpdate = true;
}

// clip name -> [file, root mode]: 'loop' strips all drift, 'xz' keeps the vertical motion (jumps, landings)
const CLIPS = {
  idle: ['idle', 'loop'], run: ['run', 'loop'], sprint: ['sprint', 'loop'], jump: ['jump', 'xz'], fall: ['fall', 'loop'],
  land: ['land', 'xz'], climb_up: ['climb_up', 'loop'], climb_down: ['climb_down', 'loop'], wallrun: ['wallrun', 'loop'],
  wall_start: ['wall_start', 'xz'],
};
const ONCE = new Set(['jump', 'land', 'wall_start']);

const MIXAMO_TO_VRM = {
  mixamorigHips: 'hips', mixamorigSpine: 'spine', mixamorigSpine1: 'chest', mixamorigSpine2: 'upperChest', mixamorigNeck: 'neck', mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder', mixamorigLeftArm: 'leftUpperArm', mixamorigLeftForeArm: 'leftLowerArm', mixamorigLeftHand: 'leftHand',
  mixamorigRightShoulder: 'rightShoulder', mixamorigRightArm: 'rightUpperArm', mixamorigRightForeArm: 'rightLowerArm', mixamorigRightHand: 'rightHand',
  mixamorigLeftUpLeg: 'leftUpperLeg', mixamorigLeftLeg: 'leftLowerLeg', mixamorigLeftFoot: 'leftFoot', mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg', mixamorigRightLeg: 'rightLowerLeg', mixamorigRightFoot: 'rightFoot', mixamorigRightToeBase: 'rightToes',
};
for (const side of ['Left', 'Right']) {
  const s = side.toLowerCase();
  for (const [mx, vr] of [['Thumb', 'Thumb'], ['Index', 'Index'], ['Middle', 'Middle'], ['Ring', 'Ring'], ['Pinky', 'Little']]) {
    const parts = mx === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
    for (let i = 1; i <= 3; i++) MIXAMO_TO_VRM[`mixamorig${side}Hand${mx}${i}`] = `${s}${vr}${parts[i - 1]}`;
  }
}

const BASE = '/characters/';
const fbxCache = new Map();
const loadFbx = (name) => {
  if (!fbxCache.has(name)) fbxCache.set(name, new FBXLoader().loadAsync(`${BASE}anims/${name}.fbx`));
  return fbxCache.get(name);
};

const _q = new THREE.Quaternion(), _restInv = new THREE.Quaternion(), _parentRest = new THREE.Quaternion(), _v = new THREE.Vector3();

function retarget(asset, vrm, name, mode) {
  const src = THREE.AnimationClip.findByName(asset.animations, 'mixamo.com') || asset.animations[0];
  const tracks = [];
  const motionHips = asset.getObjectByName('mixamorigHips').position.y;
  const vrmHips = vrm.humanoid.getNormalizedBoneNode('hips').getWorldPosition(_v).y - vrm.scene.getWorldPosition(new THREE.Vector3()).y;
  const scale = Math.abs(vrmHips) / motionHips;
  const v0 = vrm.meta?.metaVersion === '0';
  for (const track of src.tracks) {
    const [rig, prop] = track.name.split('.');
    const bone = MIXAMO_TO_VRM[rig];
    const node = bone && vrm.humanoid.getNormalizedBoneNode(bone);
    const mxNode = asset.getObjectByName(rig);
    if (!node || !mxNode) continue;
    mxNode.getWorldQuaternion(_restInv).invert();
    mxNode.parent.getWorldQuaternion(_parentRest);
    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const vals = new Float32Array(track.values.length);
      for (let i = 0; i < vals.length; i += 4) {
        _q.fromArray(track.values, i).premultiply(_parentRest).multiply(_restInv);
        vals[i] = v0 ? -_q.x : _q.x; vals[i + 1] = _q.y; vals[i + 2] = v0 ? -_q.z : _q.z; vals[i + 3] = _q.w;
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.${prop}`, track.times, vals));
    } else if (track instanceof THREE.VectorKeyframeTrack && bone === 'hips' && prop === 'position') {
      const n = track.times.length, vals = new Float32Array(track.values.length);
      for (let i = 0; i < vals.length; i++) vals[i] = (v0 && i % 3 !== 1 ? -track.values[i] : track.values[i]) * scale;
      // root motion: the controller owns translation. Remove the clip's drift so it plays in place
      const x0 = vals[0], y0 = vals[1], z0 = vals[2];
      const dx = vals[(n - 1) * 3] - x0, dy = vals[(n - 1) * 3 + 1] - y0, dz = vals[(n - 1) * 3 + 2] - z0;
      for (let k = 0; k < n; k++) {
        const f = n > 1 ? k / (n - 1) : 0;
        if (mode === 'xz') { vals[k * 3] = x0; vals[k * 3 + 2] = z0; }
        else { vals[k * 3] -= dx * f; vals[k * 3 + 2] -= dz * f; }
        if (mode === 'loop') vals[k * 3 + 1] -= dy * f;
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${node.name}.${prop}`, track.times, vals));
    }
  }
  return new THREE.AnimationClip(name, src.duration, tracks);
}

export class VrmChar {
  // def: a CHARACTERS entry; outfit: one of its outfits (default: the first)
  static async load(def, outfit, onProgress) {
    outfit = outfit || def.outfits[0];
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    const fbx = Promise.all(Object.values(CLIPS).map(([f]) => loadFbx(f)));
    const gltf = await loader.loadAsync(BASE + outfit.file, (e) => onProgress?.(e.total ? e.loaded / e.total : 0));
    const vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons?.(gltf.scene);
    VRMUtils.rotateVRM0(vrm);             // VRM 0.x faces -Z; face +Z like everything else
    vrm.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    vrm.scene.updateMatrixWorld(true);
    const assets = await fbx;
    const c = new VrmChar(def, vrm);
    c.outfit = outfit;
    Object.keys(CLIPS).forEach((name, i) => c.addClip(name, retarget(assets[i], vrm, name, CLIPS[name][1])));
    c.play('idle', { fade: 0 });
    c.mixer.update(0);
    return c;
  }

  constructor(def, vrm) {
    this.def = def;
    this.vrm = vrm;
    this.root = new THREE.Group();
    this.root.add(vrm.scene);
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.actions = {};
    this.current = null; this.currentName = '';
    const box = new THREE.Box3().setFromObject(vrm.scene);
    this.height = box.max.y - box.min.y;
  }

  addClip(name, clip) {
    const a = this.mixer.clipAction(clip);
    if (ONCE.has(name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    this.actions[name] = a;
  }

  // crossfade to a clip; restart replays a one-shot from `time`
  play(name, { fade = 0.2, speed = 1, time = 0, restart = false } = {}) {
    const a = this.actions[name];
    if (!a) return;
    if (this.current === a && !restart) { a.timeScale = speed; return; }
    a.reset(); a.time = time; a.timeScale = speed; a.setEffectiveWeight(1); a.play();
    if (this.current && this.current !== a) this.current.crossFadeTo(a, fade, false);
    else if (fade > 0 && this.current !== a) a.fadeIn(fade);
    this.current = a; this.currentName = name;
  }
  done() { const a = this.current; return !a || (a.loop === THREE.LoopOnce && a.time >= a.getClip().duration - 1e-3); }

  update(dt) {
    this.mixer.update(dt);
    this.vrm.update(dt);              // humanoid -> raw bones, spring-bone hair and cloth, expressions
  }

  dispose() {
    this.root.removeFromParent();
    VRMUtils.deepDispose(this.vrm.scene);
  }
}
