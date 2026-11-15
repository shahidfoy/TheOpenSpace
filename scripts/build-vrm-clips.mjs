// Builds public/characters/anims/vrm.{json,bin}: the VRM characters' movement clips (idle, run, sprint, jump, fall,
// land, climb, wall run) baked from their Mixamo FBX sources into a game-only pack, so the repo ships no raw FBX.
//
// The rig-dependent half of the retarget is done here: every keyframe rotation is re-expressed relative to the
// Mixamo rest pose (parent rest * q * rest^-1, three-vrm's Mixamo method) and keyed by VRM humanoid bone name. At
// load, src/render/chars/vrmChar.js only applies the per-model part (VRM 0.x axis flip, hips scale, root motion).
//
//   node scripts/build-vrm-clips.mjs [fbxDir]      (default D:/TAMAMO/game-assets/characters/vrm-anims)
//
// fbxDir holds idle.fbx, run.fbx, sprint.fbx, jump.fbx, fall.fbx, land.fbx, climb_up.fbx, climb_down.fbx,
// wallrun.fbx and wall_start.fbx (Mixamo, "FBX Binary", without skin). Keep them outside the repo.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || 'D:/TAMAMO/game-assets/characters/vrm-anims';
const OUT = path.join(ROOT, 'public/characters/anims');
globalThis.self = globalThis; globalThis.window = globalThis;
const stub = () => ({ style: {}, addEventListener() {}, removeEventListener() {} });
globalThis.document = { createElementNS: stub, createElement: stub };
const THREE = await import(`file:///${ROOT}/node_modules/three/build/three.module.js`);
const { FBXLoader } = await import(`file:///${ROOT}/node_modules/three/examples/jsm/loaders/FBXLoader.js`);

const FILES = ['idle', 'run', 'sprint', 'jump', 'fall', 'land', 'climb_up', 'climb_down', 'wallrun', 'wall_start'];

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

const load = (file) => {
  const b = fs.readFileSync(file);
  return new FBXLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '');
};

const parts = [], clips = {};
let off = 0;
const push = (arr) => { const rec = off; parts.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)); off += arr.byteLength; return rec; };
const restInv = new THREE.Quaternion(), parentRest = new THREE.Quaternion(), q = new THREE.Quaternion();

for (const name of FILES) {
  const fp = path.join(SRC, name + '.fbx');
  if (!fs.existsSync(fp)) throw new Error(`missing ${fp}`);
  const asset = load(fp);
  const src = THREE.AnimationClip.findByName(asset.animations, 'mixamo.com') || asset.animations[0];
  const tracks = [];
  for (const track of src.tracks) {
    const [rig, prop] = track.name.split('.');
    const bone = MIXAMO_TO_VRM[rig];
    const mxNode = asset.getObjectByName(rig);
    if (!bone || !mxNode) continue;
    if (track instanceof THREE.QuaternionKeyframeTrack) {
      mxNode.getWorldQuaternion(restInv).invert();
      mxNode.parent.getWorldQuaternion(parentRest);
      const vals = new Float32Array(track.values.length);
      for (let i = 0; i < vals.length; i += 4) q.fromArray(track.values, i).premultiply(parentRest).multiply(restInv).toArray(vals, i);
      tracks.push({ bone, prop, n: track.times.length, t: push(Float32Array.from(track.times)), v: push(vals) });
    } else if (track instanceof THREE.VectorKeyframeTrack && bone === 'hips' && prop === 'position') {
      tracks.push({ bone, prop, n: track.times.length, t: push(Float32Array.from(track.times)), v: push(Float32Array.from(track.values)) });
    }
  }
  clips[name] = { dur: src.duration, hips: asset.getObjectByName('mixamorigHips').position.y, tracks };
  console.log(name.padEnd(11), src.duration.toFixed(2) + 's', tracks.length, 'tracks');
}
fs.writeFileSync(path.join(OUT, 'vrm.bin'), Buffer.concat(parts));
fs.writeFileSync(path.join(OUT, 'vrm.json'), JSON.stringify({ version: 1, clips }));
console.log(`wrote ${Object.keys(clips).length} clips, ${(off / 1024).toFixed(0)} KB`);
