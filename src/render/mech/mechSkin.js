import * as THREE from 'three';
import { S, makeThruster } from './mechRig.js';
import { MOVES } from './swordAnim.js';
import { applyLivery, loadLivery } from './livery.js';
import { SUIT_GLOW } from '../materials.js';
import { Saber } from './saber.js';
import { loadPack, retargetPack, layerClip } from '../chars/katanaPack.js';
import { makeKatana } from '../chars/katana.js';
import { twoBoneIK } from '../chars/handIK.js';
import { makeShotgun } from '../chars/gun.js';
import { RAGE_COLOR } from '../chars/bladeKit.js';

// The katana pack (see chars/katanaPack.js) retargeted onto a mech's own skeleton: clips, swings, root motion and
// the sword grip, computed once per asset on a bind-posed clone and shared by every body made from it.
const MECH_BONES = {
  hips: 'Hips', spine: 'Spine1', chest: 'Spine2', neck: 'Neck', head: 'Head',
  leftShoulder: 'LeftShoulder', leftUpperArm: 'LeftArm', leftLowerArm: 'LeftForeArm', leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder', rightUpperArm: 'RightArm', rightLowerArm: 'RightForeArm', rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpLeg', leftLowerLeg: 'LeftLeg', leftFoot: 'LeftFoot', leftToes: 'LeftToeBase',
  rightUpperLeg: 'RightUpLeg', rightLowerLeg: 'RightLeg', rightFoot: 'RightFoot', rightToes: 'RightToeBase',
};
// pack clips that replace the baked ones (same names) and the new ones the mech gains
const PACK_CLIPS = ['idle', 'run', 'dash', 'dodge', 'dodge2', 'block', 'block_hit', 'hit', 'hit2', 'circle', 'combo1', 'charge', 'aerial',
  'combo_down', 'rush', 'jump_attack', 'double_slash', 'strikes', 'run_attack', 'thrust'];
// locomotion loops from the Mixamo pack (scripts/build-loco.mjs) that replace the baked ones. A frame that comes
// without baked clips (mech/frames.js) takes the whole pack: falling, landing and the reactions too
const LOCO_CLIPS = ['walk', 'walk_b', 'sprint'];
// the NEXORION's hands, in hand-bone units: rigid claws (+Y along the hand, the palm on +X of the right hand and -X
// of the left, the thumb side toward -Z). Other frames bring their own (asset.hands). dir: the way the fingers
// point; axis: the knuckle row, little finger -> index; knuckle: its centre; half: half its width; centre: where a
// handle sits in the fist
const NEX_HAND = (s) => ({ dir: new THREE.Vector3(0, 1, 0), axis: new THREE.Vector3(0, 0, -1), knuckle: new THREE.Vector3(0, 0.36, 0), half: 0.13, centre: new THREE.Vector3(s * 0.17, 0.44, 0) });
const NEX_HANDS = { left: NEX_HAND(-1), right: NEX_HAND(1) };
const handsOf = (asset) => asset.hands || NEX_HANDS;
const bonesOf = (asset) => asset.bones || MECH_BONES;
function mechKatana(asset, pack, loco) {
  if (asset._katana) return asset._katana;
  const clone = SkeletonUtils.clone(asset.gltf.scene);
  clone.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.pose(); });
  clone.updateMatrixWorld(true);
  const bones = {};
  clone.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const MB = bonesOf(asset), HANDS = handsOf(asset), B = (b) => bones[MB[b]];
  if (!Object.values(MB).every((n) => bones[n])) return (asset._katana = null);
  // Knuckle points from the frame's hand measurements give the retarget each hand's direction and roll (the packs
  // do not animate fingers, and most frames have none).
  const rootInv = new THREE.Matrix4().copy(clone.matrixWorld).invert();
  const point = (b) => {
    const m = /^(left|right)(Index|Middle|Little)Proximal$/.exec(b);
    if (!m) return null;
    const H = HANDS[m[1]], k = m[2] === 'Index' ? 1 : m[2] === 'Little' ? -1 : 0;
    return H.knuckle.clone().addScaledVector(H.axis, H.half * k).applyMatrix4(B(m[1] + 'Hand').matrixWorld).applyMatrix4(rootInv);
  };
  const bare = !asset.gltf.animations.length;                 // no baked clips: everything comes from the packs
  const r = retargetPack(pack, { root: clone, node: (b) => bones[MB[b]] || null, point }, PACK_CLIPS);
  // the bind-pose height of the lowest foot (model units), for keeping feet on the ground
  let foot = Infinity;
  for (const n of ['leftFoot', 'rightFoot', 'leftToes', 'rightToes']) foot = Math.min(foot, new THREE.Vector3().setFromMatrixPosition(B(n).matrixWorld).y);
  r.footRest = foot;
  // where the weapon that is not in hand rides, in thigh-bone space: the shotgun on the right thigh (barrels down,
  // grip to the rear), the saber hilt on the left (emitter down)
  {
    const P = (n) => new THREE.Vector3().setFromMatrixPosition(B(n).matrixWorld).applyMatrix4(rootInv);
    const u = asset.meta.height / 6;                           // offsets below were measured on the 6-unit NEXORION
    const left = P('leftUpperLeg').sub(P('rightUpperLeg')).normalize();
    const up = P('head').sub(P('hips')); up.addScaledVector(left, -up.dot(left)).normalize();
    const fwd = new THREE.Vector3().crossVectors(left, up), down = up.clone().negate();
    const local = (bone, pos, X, Y) => {
      const m = new THREE.Matrix4().makeBasis(X, Y, new THREE.Vector3().crossVectors(X, Y)).setPosition(pos);
      m.premultiply(new THREE.Matrix4().multiplyMatrices(rootInv, B(bone).matrixWorld).invert());
      const q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
      m.decompose(p, q, sc);
      return { bone: MB[bone], p, q };
    };
    r.stow = {
      gun: local('rightUpperLeg', P('rightUpperLeg').addScaledVector(left, -0.62 * u).addScaledVector(up, -0.35 * u).addScaledVector(fwd, 0.05 * u), down, fwd),
      saber: local('leftUpperLeg', P('leftUpperLeg').addScaledVector(left, 0.62 * u).addScaledVector(up, -0.2 * u), fwd.clone().negate(), down),
    };
  }
  if (loco) {
    const l = retargetPack(loco, { root: clone, node: (b) => bones[MB[b]] || null, point }, bare ? null : LOCO_CLIPS);
    for (const n of Object.keys(l.clips)) {
      r.clips[n] = l.clips[n]; r.rm[n] = l.rm[n];
      // metres per second (model units) the feet cover at normal speed
      r.meta.clips[n] = { ...l.meta.clips[n], pace: loco.json.clips[n].travel[0] * l.scale / l.meta.clips[n].dur };
    }
    // walking behind the block: the walk's legs under the held guard
    if (r.clips.walk && r.clips.block) {
      const lower = ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'].map((b) => MB[b]);
      r.clips.block_walk = layerClip('block_walk', r.clips.walk, r.clips.block, 0.7, lower);
      const two = r.meta.clips.block.two?.[21] ?? 1;
      r.meta.clips.block_walk = { dur: r.clips.walk.duration, swings: [], pace: r.meta.clips.walk.pace, two: new Float32Array(Math.ceil(r.clips.walk.duration * 30) + 2).fill(two) };
      r.loops = ['block_walk'];
    }
  }
  return (asset._katana = r);
}
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
const _hv = new THREE.Vector3(), _hv2 = new THREE.Vector3(), _hv3 = new THREE.Vector3();
const _ax = new THREE.Vector3(), _ay = new THREE.Vector3(), _az = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _aq = new THREE.Quaternion(), _aq2 = new THREE.Quaternion(), _am = new THREE.Matrix4();

// Skinned mechs built by blender/build_mech_player.py: the player suit ("NEXORION // The Neon Vanguard" by Atahan3D)
// and the arena enemies ("JSDF MECHA" by Kussa), both Sketchfab CC-BY 4.0, with a long sword and katana-pack / Mixamo
// / Noir clips retargeted onto them. Same interface as MechBody (solve, recoil, hitFlash, setTint, bladeWorld,
// setVisible) so MechPilot drives either; the pilot picks clips (play) instead of pose targets. The json beside each
// glb holds every clip's detected blade swings (time window, arc plane, reach), which become the hit windows and
// slash crescents of the clip moves built below.

export const MECH_H = 1.95 * S;    // in-game height (binders included), a touch over the procedural frame

const san = (n) => THREE.PropertyBinding.sanitizeNodeName(n);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _pv = new THREE.Vector3(), _pv2 = new THREE.Vector3();
const _white = new THREE.Color(1, 1, 1);

// Paint: the JSDF export carries plain material names; the look is decided here and by the livery (livery.js):
// three armour paint zones over a gunmetal frame, lamps, and a polished blade with a glowing edge inlay. The suit
// keeps its textures; only its glow lines follow the livery. Returns [zone, material].
function paint(name, src) {
  if (/^suit/.test(name)) {
    src.emissiveIntensity = 2.2;
    src.envMapIntensity = 1.4;
    src.userData.lumaGlow = true;
    return ['glow', src];
  }
  const armour = () => new THREE.MeshPhysicalMaterial({ color: 0xd4d8de, metalness: 0.3, roughness: 0.38, clearcoat: 0.45, clearcoatRoughness: 0.2 });
  const z = /^paint_([abc])/.exec(name);
  if (z) return [z[1], armour()];
  if (/^Main_Color/.test(name)) return ['a', armour()];
  if (/^Secondary_Color/.test(name)) return ['frame', new THREE.MeshStandardMaterial({ color: 0x1c2028, metalness: 0.82, roughness: 0.4, envMapIntensity: 1.2 })];
  if (/^Light/.test(name)) return ['glow', new THREE.MeshStandardMaterial({ color: 0x081218, emissive: 0x60e8ff, emissiveIntensity: 2.8 })];
  if (/^mech_blade_edge/.test(name)) return ['edge', new THREE.MeshStandardMaterial({ color: 0x081418, emissive: 0x40d8ff, emissiveIntensity: 3.6 })];
  if (/^mech_blade/.test(name)) return ['blade', new THREE.MeshPhysicalMaterial({ color: 0xc8ced4, metalness: 1, roughness: 0.18, clearcoat: 0.5, envMapIntensity: 1.9 })];
  return [null, null];
}

export class SkinnedMechBody {
  // opts: { livery (defaults to the saved player livery), clone (own copy of the model: arena enemies), size, plume,
  //         saber (swap the modelled sword for an energy saber that only ignites in a fight: the player) }
  constructor(scene, fx, asset, { livery = null, clone = false, size = 1, plume = 0x7fc8ff, saber = false, katana = false } = {}) {
    this.skinned = true;
    this.meta = asset.meta;
    this.root = new THREE.Group();
    const model = (this.model = clone ? SkeletonUtils.clone(asset.gltf.scene) : asset.gltf.scene);
    this.root.add(model);
    scene.add(this.root);
    this.fx = fx;
    this.k = MECH_H * size / asset.meta.height;   // model units -> metres
    model.scale.setScalar(this.k);                 // clips stand the feet on the model's y = 0

    // materials: rim light so the silhouette reads against black space, plus a hit flash / tint channel
    this.flashU = { value: new THREE.Color(0, 0, 0) };
    this.mats = [];
    this.zone = {};
    const made = new Map();
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
      const src = o.material;
      if (!made.has(src)) {
        const [zone, pm] = paint(src.name, src);
        const m = pm || src;
        if (zone && !this.zone[zone]) this.zone[zone] = m;
        m.name = src.name;
        const rim = new THREE.Color(0xdfe8ff).multiplyScalar(0.22);
        const luma = !!m.userData.lumaGlow;
        m.onBeforeCompile = (sh) => {
          sh.uniforms.rimColor = { value: rim };
          sh.uniforms.hitFlash = this.flashU;
          sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform vec3 rimColor;\nuniform vec3 hitFlash;')
            .replace('#include <emissivemap_fragment>', `${luma ? SUIT_GLOW : '#include <emissivemap_fragment>'}
              float rimF = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
              totalEmissiveRadiance += rimColor * pow(rimF, 3.2) + hitFlash;`);
        };
        m.customProgramCacheKey = () => (luma ? 'mechskin-luma' : 'mechskin');
        made.set(src, m);
        this.mats.push(m);
      }
      o.material = made.get(src);
    });

    const bone = (re) => { let b = null; model.traverse((o) => { if (!b && o.isBone && re.test(o.name)) b = o; }); return b; };
    const MB = (this.MB = bonesOf(asset)), named = (b) => (asset.bones ? model.getObjectByName(MB[b]) : null);
    this.grip = model.getObjectByName(san('katana_grip')) || named('rightHand');
    // JSDF bone names, else the suit's Mixamo-style names
    this.hips = named('hips') || bone(/^(Hip_|Hips$)/);
    this.chest = named('chest') || bone(/^(Chest_|Spine2$)/);
    this.spine = this.chest;                       // the run lean / recoil bend the whole torso
    this.knee = { L: named('leftLowerLeg') || bone(/^(Lower_leg\.?L|LeftLeg$)/), R: named('rightLowerLeg') || bone(/^(Lower_leg\.?R|RightLeg$)/) };
    this.ankle = { L: named('leftFoot') || bone(/^(Upper_Foot\.?L|LeftFoot$)/), R: named('rightFoot') || bone(/^(Upper_Foot\.?R|RightFoot$)/) };
    this.blade = asset.meta.blade;

    // clips first: the raw rest stance faces backwards, so the thrusters are placed on the idle pose
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    const loops = new Set(asset.meta.loops || []);
    for (const clip of asset.gltf.animations) {
      const a = this.mixer.clipAction(clip);
      if (!loops.has(clip.name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.actions[clip.name] = a;
    }
    this.alt = {};                                 // twin actions, so a clip can crossfade into itself
    this.current = null; this.currentName = '';
    this.play('idle', { fade: 0 });
    this.mixer.update(0);
    this.root.updateMatrixWorld(true);

    // thrusters on the joints: twin nozzles on the backpack, calves and soles (exhaust = anchor local -Y)
    this.thrusters = [];
    const ws = new THREE.Vector3();
    const jet = (parent, group, off, dir, size = 1) => {
      if (!parent) return;
      const a = new THREE.Object3D();
      parent.add(a);
      parent.getWorldScale(ws);
      a.scale.set(S / ws.x, S / ws.y, S / ws.z).multiplyScalar(size);
      const p = _v.copy(off).applyMatrix4(this.root.matrixWorld);
      a.position.copy(parent.worldToLocal(p));
      parent.getWorldQuaternion(_q);
      _q2.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
      a.quaternion.copy(_q.invert().multiply(_q2));
      this.thrusters.push(makeThruster(a, group, undefined, plume));
    };
    const at = (b) => this.root.worldToLocal(b.getWorldPosition(new THREE.Vector3()));
    const H = MECH_H;
    if (this.chest) {
      const c = at(this.chest);
      for (const sx of [-1, 1]) jet(this.chest, 'back', new THREE.Vector3(c.x + sx * 0.09 * H, c.y + 0.02 * H, c.z - 0.12 * H), new THREE.Vector3(sx * 0.12, -1, -0.5), 1.5);
    }
    for (const s of ['L', 'R']) {
      if (this.knee[s]) { const p = at(this.knee[s]); jet(this.knee[s], 'calf', new THREE.Vector3(p.x, p.y - 0.1 * H, p.z - 0.05 * H), new THREE.Vector3(0, -1, -0.4), 1.2); }
      if (this.ankle[s]) { const p = at(this.ankle[s]); jet(this.ankle[s], 'foot', new THREE.Vector3(p.x, p.y - 0.03 * H, p.z), new THREE.Vector3(0, -1, 0), 1.3); }
    }

    // blade light: always in the scene (toggling lights recompiles every material), dimmed when idle
    this.light = new THREE.PointLight(0x9fe4ff, 0, 26, 2);
    (this.grip || model).add(this.light);

    // energy saber: hide the modelled blade (and on the suit, whose frame material is the sword's alone, its hilt)
    // and mount a saber on the grip bone in metres
    this.saber = null;
    if (saber && this.grip) {
      const suit = this.mats.some((m) => /^suit/.test(m.name));
      model.traverse((o) => {
        if (o.isMesh && (/^mech_blade/.test(o.material.name) || (suit && /^Secondary_Color/.test(o.material.name)))) o.visible = false;
      });
      const H = asset.meta.height * this.k;
      this.saber = new Saber(this.blade * this.k * 1.04, H * 0.165, 0x52d8ff, 1.45);     // a two-handed hilt
      this.grip.getWorldScale(ws);
      this.saber.group.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
      this.saber.group.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
      this.grip.add(this.saber.group);
      this.saber.group.add(this.light);
      this.light.position.set(0, this.saber.base + this.saber.length * 0.45, 0);
    }
    // enemy frames: their modelled sword is skinned to the hand pointing out of the pinky side; swap it for a katana
    // held the right way round on the grip bone
    if (katana && this.grip) {
      model.traverse((o) => { if (o.isMesh && /^mech_blade/.test(o.material.name)) o.visible = false; });
      const kt = makeKatana(this.blade * this.k * 0.95);
      kt.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
      this.grip.getWorldScale(ws);
      kt.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
      kt.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
      this.grip.add(kt);
      this.katanaMesh = kt;
    }
    this.trail = fx.makeTrail(0x6fdcff);
    this.slashColor = 0xbff4ff;
    this.rm = {};
    this.charge = 0;
    // the player frame takes the anime katana pack: clean retargeted clips, root motion, the true grip
    if (saber) Promise.all([loadPack('katana'), loadPack('loco').catch(() => null)]).then(([pack, loco]) => this.applyPack(pack, asset, loco)).catch((e) => console.warn('katana pack failed', e));

    this.thr = { back: 0, wing: 0, sh: 0, calf: 0, foot: 0 };
    this.tintColor = new THREE.Color(); this.tintK = 0; this.tintWant = 0; this.flash = 0;
    this.kick = new THREE.Vector3(); this.kickV = new THREE.Vector3();   // recoil (rad about char x / z), spring-damped
    this.time = 0;
    this.rig = { root: this.root, thrusters: this.thrusters, skinned: true };
    this.setLivery(livery || loadLivery());
  }

  setLivery(l) {
    this.livery = l;
    applyLivery(this.zone, l);
    this.slashColor = new THREE.Color(l.blade).lerp(new THREE.Color(0xffffff), 0.55).getHex();
    this.light.color.set(l.blade).lerp(new THREE.Color(0xffffff), 0.3);
    this.trail.mesh.material.uniforms.color.value.set(l.blade).multiplyScalar(this.saber ? 2.6 : 2);
    this.saber?.setColor(l.blade);
  }

  applyPack(pack, asset, loco) {
    const r = mechKatana(asset, pack, loco);
    if (!r) return;
    const loops = new Set([...(asset.meta.loops || []), ...(r.loops || [])]);
    for (const [name, clip] of Object.entries(r.clips)) {
      const old = this.actions[name];
      const a = this.mixer.clipAction(clip);
      if (!loops.has(name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.actions[name] = a;
      delete this.alt[name];
      if (old) {
        if (this.current === old || this.currentName === name) { a.play(); a.time = Math.min(old.time, clip.duration); a.setEffectiveWeight(old.getEffectiveWeight()); this.current = a; }
        old.stop();
        this.mixer.uncacheAction(old.getClip());
      }
      this.meta.clips[name] = r.meta.clips[name];
      this.rm[name] = r.rm[name];
    }
    this.footRest = r.footRest;
    const MB = this.MB, N = (b) => this.model.getObjectByName(MB[b]), HANDS = handsOf(asset), HR = HANDS.right;
    this.handL = HANDS.left;
    this.feet = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'].map(N).filter(Boolean);
    this.hipsBone = N('hips');
    // the saber moves from the grip bone to the hand, on the grip the pack's two-handed frames agree on
    const hand = N('rightHand');
    if (this.saber && hand) {
      const g = this.saber.group, ws = new THREE.Vector3();
      hand.add(g);
      hand.getWorldScale(ws);
      g.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
      // in the claw: the hilt along the knuckle row, the emitter just clear of the index finger
      // the hilt's own frame in the fist: +Y out of the thumb side, +X toward the knuckles
      const hx = HR.dir.clone().addScaledVector(HR.axis, -HR.dir.dot(HR.axis)).normalize();
      g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(hx, HR.axis, new THREE.Vector3().crossVectors(hx, HR.axis)));
      g.position.copy(HR.centre).addScaledVector(HR.axis, HR.half * 1.77);
      this.handScale = ws.x;
      this.saberOnHand = true;
      this.armL = ['leftUpperArm', 'leftLowerArm', 'leftHand'].map(N);
      this.armR = ['rightUpperArm', 'rightLowerArm', 'rightHand'].map(N);
      this.twoK = 0;
      // the shotgun, sized to the claw; mounts: in the right hand / stowed on the thigh
      const gun = (this.gun = makeShotgun(0.31 * asset.meta.height * this.k, { metal: 0x2a2f38, trim: 0x16191f, glow: 0xff5a3a }));
      gun.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
      // the gun in the fist: barrels the way the fingers point, its grip down through the knuckle row
      const X = hx, Y = HR.axis.clone();
      this.gunGrip = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, new THREE.Vector3().crossVectors(X, Y)));
      this.gripP = HR.centre.clone();
      this.mount = { hand, saberP: g.position.clone(), saberQ: g.quaternion.clone(), stow: r.stow };
      this.weapon = null;
      this.setWeapon('sword');
    }
    this.packed = true;
    this.onPack?.();
  }

  // which weapon is in the right hand: 'sword' (the saber hilt) or 'gun'; the other rides on a thigh
  setWeapon(w) {
    if (!this.mount || this.weapon === w) return;
    this.weapon = w;
    const M = this.mount, g = this.saber.group, gun = this.gun;
    const put = (obj, st) => { const b = this.model.getObjectByName(st.bone); if (b) { b.add(obj); obj.position.copy(st.p); obj.quaternion.copy(st.q); } };
    if (w === 'gun') { put(g, M.stow.saber); M.hand.add(gun); gun.position.copy(this.gripP); gun.quaternion.copy(this.gunGrip); }
    else { put(gun, M.stow.gun); M.hand.add(g); g.position.copy(M.saberP); g.quaternion.copy(M.saberQ); }
  }
  // Raise the gun arm onto `dir` (world, unit) by weight k, kicked by the recoil (0..1). Called after the clip pose.
  aimGun(dir, k, recoil = 0) {
    if (!this.armR || this.weapon !== 'gun' || k < 0.01) return;
    const [up, lo, hd] = this.armR;
    up.updateWorldMatrix(true, false); lo.updateWorldMatrix(true, false); hd.updateWorldMatrix(true, false);
    const sh = _hv.setFromMatrixPosition(up.matrixWorld);
    const len = sh.distanceTo(_hv2.setFromMatrixPosition(lo.matrixWorld)) + _hv2.distanceTo(_hv3.setFromMatrixPosition(hd.matrixWorld));
    const X = _ax.copy(dir).addScaledVector(_up, recoil * 0.35).normalize();
    const Z = _az.crossVectors(X, _up).normalize(), Y = _ay.crossVectors(Z, X);
    _aq.setFromRotationMatrix(_am.makeBasis(X, Y, Z)).multiply(_aq2.copy(this.gunGrip).invert());
    const ws = hd.getWorldScale(_hv2).x;
    const wrist = _hv3.copy(sh).addScaledVector(X, len * (0.8 - recoil * 0.14)).addScaledVector(_up, len * (recoil * 0.06 - 0.04));
    wrist.sub(_hv2.copy(this.gripP).multiplyScalar(ws).applyQuaternion(_aq));
    twoBoneIK(up, lo, hd, wrist, k, { handQ: _aq, pole: _ay.set(0, -1, 0) });
  }
  // the gun's muzzle in world space
  muzzle(out) { this.gun.updateWorldMatrix(true, false); return out.copy(this.gun.userData.muzzle).applyMatrix4(this.gun.matrixWorld); }
  // Bloodline Awakening: the blade, its light and the glow lines turn blood red
  setRage(on) {
    if (this.rage === on) return;
    this.rage = on;
    if (on) {
      this.saber?.setColor(RAGE_COLOR);
      this.light.color.set(RAGE_COLOR);
      this.trail.mesh.material.uniforms.color.value.set(RAGE_COLOR).multiplyScalar(2.6);
      this.slashColor = 0xff6a6a;
      this.setTint(RAGE_COLOR, 0.1);
    } else { this.setLivery(this.livery); this.setTint(0x000000, 0); }
  }

  has(name) { return !!this.actions[name]; }
  // ground speed (m/s) a locomotion loop's feet match at normal playback, if known
  pace(name) { const p = this.meta.clips[name]?.pace; return p ? p * this.k : 0; }
  snapPose() {}

  // hold a clip at time t (the caller scrubs it, e.g. an enemy's windup stretched to its telegraph)
  pose(name, t, fade = 0.1) {
    const a = this.actions[name];
    if (!a) return;
    if (this.currentName !== name) this.play(name, { time: t, speed: 0, fade, restart: true });
    else this.scrub(t);
  }

  // a clip-space swing arc (mech_player.json) in world space
  arcWorld(a, outC, outU, outV) {
    const m = this.root.matrixWorld;
    outC.set(a.c[0], a.c[1], a.c[2]).multiplyScalar(this.k).add(this.model.position).applyMatrix4(m);
    outU.set(a.u[0], a.u[1], a.u[2]).transformDirection(m);
    outV.set(a.v[0], a.v[1], a.v[2]).transformDirection(m);
  }
  dur(name) { return this.actions[name]?.getClip().duration ?? 1; }

  // crossfade to a clip. opts: time (s), fade (s), speed, restart
  play(name, { time = null, fade = 0.15, speed = 1, restart = false } = {}) {
    let a = this.actions[name];
    if (!a) return null;
    if (this.currentName === name && !restart && time === null) { this.current.timeScale = speed; return this.current; }
    // restarting the clip that is already playing: blend from its twin. Resetting the playing action and fading it
    // back in from zero weight would dip the whole body toward the rest stance for the length of the fade.
    if (this.currentName === name && fade > 0) a = this.current === a ? this.twin(name) : a;
    a.enabled = true;
    a.reset();
    a.timeScale = speed;
    if (time !== null) a.time = time;
    a.setEffectiveWeight(1);
    a.play();
    if (this.current && this.current !== a) this.current.crossFadeTo(a, fade, false);
    else if (fade > 0) a.fadeIn(fade);
    this.current = a; this.currentName = name;
    return a;
  }

  twin(name) {
    if (!this.alt[name]) {
      const src = this.actions[name];
      const t = this.mixer.clipAction(src.getClip().clone());
      t.setLoop(src.loop, Infinity);
      t.clampWhenFinished = src.clampWhenFinished;
      this.alt[name] = t;
    }
    return this.alt[name];
  }

  // drive the playing clip's time directly (attacks follow a time-warp curve instead of a constant speed)
  scrub(t) {
    if (!this.current) return;
    this.current.timeScale = 0;
    this.current.paused = false;
    this.current.time = t;
  }

  recoil(lx, lz, k = 1) {
    this.kickV.x -= lz * 6 * k;
    this.kickV.z += lx * 5 * k;
  }
  setTint(hex, k) { this.tintColor.set(hex); this.tintWant = k; }
  hitFlash(k = 1) { this.flash = Math.max(this.flash, k); }

  // o: { pos, yaw, pitch, roll, pivot, lift, thr, swinging, lean }
  solve(dt, o) {
    this.time += dt;
    const root = this.root;
    root.rotation.set(o.pitch || 0, o.yaw, o.roll || 0, 'YXZ');
    _pv.set(0, o.pivot ?? 0, 0);
    _pv2.copy(_pv).applyEuler(root.rotation);
    root.position.copy(o.pos).add(_pv).sub(_pv2);
    if (o.lift) root.position.y += o.lift;
    this.mixer.update(dt);
    if (this.armL && this.weapon === 'sword') this.twoHands();
    this.gun?.userData.update(dt);
    o.afterPose?.(this);
    if (o.grounded && this.feet && this.hipsBone) this.groundFeet();

    // recoil spring + run lean on the spine, on top of the clip
    const kk = 170, c = 2 * 0.55 * 13;
    this.kickV.x += (-kk * this.kick.x - c * this.kickV.x) * dt; this.kick.x += this.kickV.x * dt;
    this.kickV.z += (-kk * this.kick.z - c * this.kickV.z) * dt; this.kick.z += this.kickV.z * dt;
    const lean = (o.lean || 0) + this.kick.x;
    if (this.spine && (Math.abs(lean) > 1e-3 || Math.abs(this.kick.z) > 1e-3)) {
      root.updateMatrixWorld(true);
      const pw = this.spine.parent.getWorldQuaternion(_q);
      const w = this.spine.getWorldQuaternion(_q2);
      w.premultiply(new THREE.Quaternion().setFromAxisAngle(_v.set(1, 0, 0).applyQuaternion(root.quaternion), lean));
      w.premultiply(new THREE.Quaternion().setFromAxisAngle(_v.set(0, 0, 1).applyQuaternion(root.quaternion), this.kick.z));
      this.spine.quaternion.copy(pw.invert().multiply(w));
    }
    root.updateMatrixWorld(true);
    this.updateThrusters(dt, o.thr);
    this.updateSword(dt, o.swinging, o.lit);
    this.updateTint(dt);
  }

  // in the pack's two-handed frames the left claw is brought onto the hilt below the right
  twoHands() {
    const a = this.current, two = a ? this.meta.clips[this.currentName]?.two : null;
    let tw = 0;
    if (two) {
      const f = a.time * 30, i = Math.max(0, Math.min(two.length - 1, Math.floor(f))), j = Math.min(two.length - 1, i + 1);
      tw = two[i] + (two[j] - two[i]) * (f - i);
    }
    this.twoK += (tw - this.twoK) * 0.35;
    if (this.twoK < 0.02) return;
    const [up, lo, hd] = this.armL, g = this.saber.group;
    hd.updateWorldMatrix(true, false); g.updateWorldMatrix(true, false);
    const below = this.handL.half * 4.2 * this.handScale;              // metres down the hilt from the emitter
    _hv.set(0, -below, 0).applyMatrix4(g.matrixWorld);
    _hv2.copy(this.handL.centre).applyMatrix4(hd.matrixWorld).sub(_hv3.setFromMatrixPosition(hd.matrixWorld));
    twoBoneIK(up, lo, hd, _hv.sub(_hv2), this.twoK);
  }

  // keep the lowest foot on the ground plane: move the hips up / down by the difference to the bind-pose foot height
  groundFeet() {
    this.root.updateMatrixWorld(true);
    let y = Infinity;
    for (const f of this.feet) y = Math.min(y, _v.setFromMatrixPosition(f.matrixWorld).y);
    const want = this.root.position.y + this.footRest * this.k;
    const dy = THREE.MathUtils.clamp(want - y, -0.25 * MECH_H, 0.2 * MECH_H);
    if (Math.abs(dy) < 1e-4) return;
    const par = this.hipsBone.parent;
    const inv = _q.copy(par.getWorldQuaternion(_q)).invert();
    const sc = par.getWorldScale(_v2);
    this.hipsBone.position.add(_v.set(0, dy, 0).applyQuaternion(inv).divide(sc));
    this.hipsBone.updateMatrixWorld(true);
  }

  updateThrusters(dt, want) {
    const thr = this.thr, t = this.time;
    if (want) for (const g in thr) thr[g] += ((want[g] || 0) - thr[g]) * Math.min(1, dt * 12);
    else for (const g in thr) thr[g] *= Math.max(0, 1 - dt * 12);
    for (const th of this.thrusters) {
      const v = thr[th.group] ?? 0;
      const on = v > 0.03;
      th.plume.visible = th.glow.visible = on;
      if (!on) continue;
      const flick = 0.85 + Math.random() * 0.3;
      th.plume.scale.set(0.7 + v * 0.5, (0.4 + v * 1.4) * flick, 0.7 + v * 0.5);
      th.plume.material.uniforms.uThr.value = Math.min(1.4, v) * 0.75;
      th.plume.material.uniforms.uTime.value = t;
      th.glow.scale.setScalar(0.1 * th.k * (0.5 + v * 0.6) * flick);
    }
  }

  updateSword(dt, swinging, lit) {
    const flick = 0.92 + Math.sin(this.time * 61) * 0.04 + Math.sin(this.time * 37) * 0.04;
    if (this.saber) {
      if (this.saber.update(dt, (lit || this.charge > 0) && this.weapon !== 'gun', swinging || this.charge > 0)) {
        // ignition crackle at the emitter
        const p = this.saber.group.localToWorld(_v.set(0, this.saber.base, 0));
        this.fx.sparksAt(p, 8, { color: this.light.color.getHex(), speed: 6, life: 0.22, width: 0.04, grav: 0 });
      }
      this.light.intensity = this.saber.k * (swinging ? 24 : 10) * flick * (1 + this.charge * 0.9);
    } else this.light.intensity = (swinging ? 22 : 0) * flick;
    const b = _v, t = _v2;
    this.bladeWorld(b, t);
    this.fx.pushTrail(b, t, swinging, this.trail);
  }

  updateTint(dt) {
    this.tintK += (this.tintWant - this.tintK) * Math.min(1, dt * 14);
    this.flash = Math.max(0, this.flash - dt * 6);
    const f = this.flash * 0.5;
    this.flashU.value.copy(this.tintColor).multiplyScalar(this.tintK * 0.6).lerp(_white, Math.min(1, this.flash) * 0.6).addScalar(f * 0.2);
    if (this.flash <= 0 && this.tintK < 0.002) this.flashU.value.setRGB(0, 0, 0);
  }

  // beam blade in world space: from 30% up the blade to its tip
  bladeWorld(outBase, outTip) {
    if (!this.grip) { outBase.copy(this.root.position); outTip.copy(this.root.position); return; }
    const m = this.grip.matrixWorld;
    const ax = _q.setFromRotationMatrix(m);
    const dir = outTip.set(0, 1, 0).applyQuaternion(ax).normalize();
    const p = this.grip.getWorldPosition(outBase);
    if (this.saber) {
      const s = this.saber, g = s.group;
      g.updateMatrixWorld(true);
      outTip.set(0, s.reach, 0).applyMatrix4(g.matrixWorld);
      outBase.set(0, s.base + s.length * s.k * 0.12, 0).applyMatrix4(g.matrixWorld);
      return;
    }
    if (this.katanaMesh) {
      const g = this.katanaMesh, L = g.userData.length;
      g.updateMatrixWorld(true);
      outTip.set(0, L, 0).applyMatrix4(g.matrixWorld);
      outBase.set(0, L * 0.3, 0).applyMatrix4(g.matrixWorld);
      return;
    }
    const L = this.blade * this.k;
    outTip.copy(p).addScaledVector(dir, L);
    outBase.copy(p).addScaledVector(dir, L * 0.3);
  }

  setVisible(v) {
    this.root.visible = v;
    this.trail.on = v;
    if (!v) this.trail.mesh.visible = false;
  }
}

// ---------- moves generated from the clip metadata ----------
// Each move plays a slice of a clip; t = [wind, swing, recover] in seconds of game time, so the pilot's hit window
// lands exactly where the blade moves fastest. Ranges are converted to the procedural moves' units (multiples of S).
const BASE = { path: 'clip', R: 0.5, c: [0, 1.3, 0.14], roll: 0, a0: 0, a1: 0, pull: 0, cone: 1.25, range: 2.3, lunge: 2.4, hitstop: 0.06, dmg: 12, chain: 0.6 };

export function groups(meta, clip, { minPeak = 22, gap = 0.09, limit = 99 } = {}) {
  const sw = (meta.clips[clip]?.swings ?? []).filter((s) => s.peak >= minPeak);
  const out = [];
  for (const s of sw) {
    const last = out[out.length - 1];
    if (last && s.t0 - last.t1 < gap) { last.t1 = s.t1; last.reach = Math.max(last.reach, s.reach); last.h0 = Math.min(last.h0, s.h0); last.h1 = Math.max(last.h1, s.h1); last.parts.push(s); }
    else out.push({ ...s, parts: [s] });
  }
  return out.slice(0, limit);
}

// Clip moves don't play at one constant speed: the clip time follows a smooth curve through four keys (segment start,
// swing start, swing end, segment end). The windup eases in (anticipation), the cut itself runs fast, and the
// follow-through decelerates into a held finish - the rhythm of an anime katana cut: draw, flash, freeze. The curve
// is a monotone cubic Hermite, so the motion has no velocity pops, and a chained move can pick up the previous
// one's clip time and speed for a seamless flow through the combo.
const WIND_K = 0.9, SWING_K = 1.25, REC_K = 0.85;

// (re)builds mv.warp and mv.t starting from clip time c0 at clip speed v0 (null: a fresh start, easing in)
export function makeWarp(mv, c0, v0 = null) {
  const sp = mv.speed, [, s0, s1, s2] = mv.seg;
  const ws = sp * WIND_K, ss = sp * SWING_K, rs = sp * REC_K;
  const tw = v0 != null ? Math.max(0.05, 2 * (s0 - c0) / (Math.max(0, v0) + ss)) : Math.max(0.03, (s0 - c0) / ws);
  const T = [0, tw, tw + Math.max(0.03, (s1 - s0) / ss), 0];
  T[3] = T[2] + Math.max(0.05, (s2 - s1) / rs);
  const C = [c0, s0, s1, s2];
  const M = [v0 != null ? Math.max(0, v0) : ws * 0.5, ss * 1.15, ss * 0.65, rs * 0.2];
  for (let i = 0; i < 3; i++) {                     // Fritsch-Carlson: keep every segment monotone
    const d = (C[i + 1] - C[i]) / (T[i + 1] - T[i]);
    if (d <= 1e-6) { M[i] = M[i + 1] = 0; continue; }
    const a = M[i] / d, b = M[i + 1] / d, h = a * a + b * b;
    if (h > 9) { const tau = 3 / Math.sqrt(h); M[i] = tau * a * d; M[i + 1] = tau * b * d; }
  }
  mv.warp = { T, C, M };
  mv.t = [T[1], T[2] - T[1], T[3] - T[2]];
  return mv;
}
export function clipTime(mv, e) {
  const { T, C, M } = mv.warp;
  if (e <= 0) return C[0];
  if (e >= T[3]) return C[3];
  const i = e < T[1] ? 0 : e < T[2] ? 1 : 2;
  const h = T[i + 1] - T[i], s = (e - T[i]) / h, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * C[i] + (s3 - 2 * s2 + s) * h * M[i] + (-2 * s3 + 3 * s2) * C[i + 1] + (s3 - s2) * h * M[i + 1];
}
export function clipRate(mv, e) { return (clipTime(mv, e + 1e-3) - clipTime(mv, Math.max(0, e - 1e-3))) / (e + 1e-3 - Math.max(0, e - 1e-3)); }

function moveFrom(k, clip, g, start, end, speed, extra) {
  const ss = speed * SWING_K;
  return makeWarp({
    ...BASE, ...extra, clip, start, speed, seg: [start, g.t0, g.t1, end],
    arcs: g.parts.map((p) => ({ ...p, dt: (p.t0 - g.t0) / ss, dur: (p.t1 - p.t0) / ss })),
    range: ((g.reach ?? 1.4) * k + 1.2) / S,
    cone: THREE.MathUtils.clamp(Math.max(Math.abs(g.h0 ?? -1), Math.abs(g.h1 ?? 1)) + 0.35, 0.7, Math.PI),
  }, start);
}

export function chain(k, meta, clip, { speed = 1, minPeak, gap, limit = 99, lead = 0.2, tail = 0.45, base = {}, last = {} } = {}) {
  const gs = groups(meta, clip, { minPeak, gap, limit });
  const dur = meta.clips[clip]?.dur ?? 1;
  return gs.map((g, i) => {
    const start = i === 0 ? Math.max(0, g.t0 - lead) : (gs[i - 1].t1 + g.t0) / 2;
    const end = i === gs.length - 1 ? Math.min(dur, g.t1 + tail) : (g.t1 + gs[i + 1].t0) / 2;
    return moveFrom(k, clip, g, start, end, speed, i === gs.length - 1 ? { ...base, ...last } : base);
  });
}

// one swing of a clip as a timeline segment: { clip, start, t0, t1, end, arcs } (clip seconds). which = 'max' (the
// strongest swing) or an index into the clip's swings
export function clipSegment(meta, clip, which = 'max', { lead = 0.3, tail = 0.45, minPeak = 22 } = {}) {
  const gs = groups(meta, clip, { minPeak });
  if (!gs.length) return null;
  const g = which === 'max' ? gs.slice().sort((a, b) => b.peak - a.peak)[0] : gs[Math.min(which, gs.length - 1)];
  const dur = meta.clips[clip].dur;
  return { clip, start: Math.max(0, g.t0 - lead), t0: g.t0, t1: g.t1, end: Math.min(dur, g.t1 + tail), arcs: g.parts.map((p) => ({ ...p, dt: p.t0 - g.t0 })) };
}

// the strongest swing of a clip as one move (or a hand-picked window)
export function single(k, meta, clip, { t0, t1, lead = 0.25, tail = 0.5, speed = 1, extra = {} } = {}) {
  const gs = groups(meta, clip, { minPeak: 0 });
  let g = t0 != null ? gs.find((x) => x.t1 >= t0 && x.t0 <= t1) : gs.slice().sort((a, b) => b.peak - a.peak)[0];
  if (t0 != null) g = g ? { ...g, t0, t1 } : { t0, t1, reach: 1.4, h0: -0.6, h1: 0.6, parts: [] };
  if (!g) g = { t0: 0.3, t1: 0.5, reach: 1.4, h0: -0.6, h1: 0.6, parts: [] };
  const dur = meta.clips[clip]?.dur ?? g.t1 + tail;
  return moveFrom(k, clip, g, Math.max(0, g.t0 - lead), Math.min(dur, g.t1 + tail), speed, extra);
}

// registers the clip moves into MOVES and returns a combo table shaped like swordAnim's COMBO
export function buildSkinCombos(body) {
  const { meta, k } = body;
  const reg = (prefix, list) => list.map((m, i) => { const id = `${prefix}${i}`; m.rm = body.rm?.[m.clip] || null; MOVES[id] = m; return id; });
  const has = (c) => !!meta.clips[c];
  const K = { dmg: 14 };
  // every cut of the katana combo clip, back to back: picking only its two biggest swings left a second-long dead
  // windup between hits while the clip played through the cuts it skipped
  const ground = has('combo1') ? reg('sg', chain(k, meta, 'combo1', { speed: 1, minPeak: 22, gap: 0.12, limit: 5, base: K, last: { dmg: 26, hitstop: 0.1, finisher: true } })) : [];
  return {
    ground: ground.length ? ground : ['k1', 'k2', 'k3', 'k4'],
    heavy: has('charge') ? reg('sh', [single(k, meta, 'charge', { speed: 1.05, extra: { dmg: 32, hitstop: 0.12, shock: 3.2, heavy: true } })])[0] : 'kH',
    launch: body.packed && has('jump_attack') ? reg('sl', [single(k, meta, 'jump_attack', { t0: meta.clips.jump_attack.swings[0].t0, t1: meta.clips.jump_attack.swings[0].t1, lead: 0.2, tail: 0.3, speed: 1.1, extra: { dmg: 16, hitstop: 0.09, launch: true, lunge: 1.8 } })])[0]
      : has('gs_slash') ? reg('sl', [single(k, meta, 'gs_slash', { speed: 1.3, extra: { dmg: 16, hitstop: 0.09, launch: true, lunge: 1.8 } })])[0] : 'kL',
    rush: body.packed && has('rush'),
    // Bloodline Awakening's whirlwind: the circle clip's spinning cuts
    whirl: body.packed && meta.clips.circle?.swings?.[1] ? reg('sw', [single(k, meta, 'circle', { t0: meta.clips.circle.swings[1].t0, t1: meta.clips.circle.swings[1].t1, lead: 0.06, tail: 0.1, speed: 1.35, extra: { dmg: 11, cone: Math.PI, whirl: true, hitstop: 0.02 } })])[0] : null,
    air: has('aerial') ? reg('sa', chain(k, meta, 'aerial', { speed: 1.25, minPeak: 30, limit: 3, base: { dmg: 12, air: true, lunge: 1.2 }, last: { dmg: 20, slam: true, heavy: true, hitstop: 0.1 } })) : ['kA1', 'kA2', 'kA3'],
    plunge: has('combo_down') ? reg('sp', [single(k, meta, 'combo_down', { speed: 1.25, extra: { dmg: 28, shock: 3.6, plunge: true, heavy: true, hitstop: 0.1 } })])[0] : 'kP',
  };
}
