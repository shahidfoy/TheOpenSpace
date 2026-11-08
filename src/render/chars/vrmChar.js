import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// Playable VRM characters (VRoid Hub models, see public/characters/CREDITS.txt) animated with Mixamo clips retargeted
// at load time onto the VRM humanoid. The retarget follows three-vrm's Mixamo example: every Mixamo bone's rotation
// is re-expressed relative to its rest pose and applied to the matching normalized VRM bone, and the hips translation
// is rescaled to the model's leg length. Root motion is stripped (the controller moves the character), keeping only the
// clip's own bob so loops stay seamless.

export const CHARACTERS = [
  { id: 'rachael', name: 'Rachael', file: 'rachael.vrm', thumb: 'rachael.png', blurb: 'Vampire succubus · agile', by: 'Banjo Boi' },
  { id: 'remi', name: 'Ayame Remi', file: 'remi.vrm', thumb: 'remi.jpg', blurb: 'Summer ver. · light on her feet', by: 'ゔぁんそこ' },
  { id: 'emo', name: 'Kuro', file: 'emo.vrm', thumb: 'emo.png', blurb: 'Hoodie runner · steady', by: 'Em0 MFXXX' },
];

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
  static async load(def, onProgress) {
    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    const fbx = Promise.all(Object.values(CLIPS).map(([f]) => loadFbx(f)));
    const gltf = await loader.loadAsync(BASE + def.file, (e) => onProgress?.(e.total ? e.loaded / e.total : 0));
    const vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons?.(gltf.scene);
    VRMUtils.rotateVRM0(vrm);             // VRM 0.x faces -Z; face +Z like everything else
    vrm.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    vrm.scene.updateMatrixWorld(true);
    const assets = await fbx;
    const c = new VrmChar(def, vrm);
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
