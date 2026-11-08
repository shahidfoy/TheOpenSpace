import * as THREE from 'three';
import { S, makeThruster } from './mechRig.js';
import { MOVES } from './swordAnim.js';
import { applyLivery, loadLivery } from './livery.js';
import { SUIT_GLOW } from '../materials.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

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
  // opts: { livery (defaults to the saved player livery), clone (own copy of the model: arena enemies), size, plume }
  constructor(scene, fx, asset, { livery = null, clone = false, size = 1, plume = 0x7fc8ff } = {}) {
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
    this.grip = model.getObjectByName(san('katana_grip'));
    // JSDF bone names, else the suit's Mixamo-style names
    this.hips = bone(/^(Hip_|Hips$)/);
    this.chest = bone(/^(Chest_|Spine2$)/);
    this.spine = this.chest;                       // the run lean / recoil bend the whole torso
    this.knee = { L: bone(/^(Lower_leg\.?L|LeftLeg$)/), R: bone(/^(Lower_leg\.?R|RightLeg$)/) };
    this.ankle = { L: bone(/^(Upper_Foot\.?L|LeftFoot$)/), R: bone(/^(Upper_Foot\.?R|RightFoot$)/) };
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
    this.trail = fx.makeTrail(0x6fdcff);
    this.slashColor = 0xbff4ff;

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
    this.trail.mesh.material.uniforms.color.value.set(l.blade).multiplyScalar(2);
  }

  has(name) { return !!this.actions[name]; }
  snapPose() {}

  // hold a clip at time t (the caller scrubs it, e.g. an enemy's windup stretched to its telegraph)
  pose(name, t, fade = 0.1) {
    const a = this.actions[name];
    if (!a) return;
    if (this.current !== a) this.play(name, { time: t, speed: 0, fade, restart: true });
    else { a.timeScale = 0; a.time = t; }
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
    const a = this.actions[name];
    if (!a) return null;
    if (this.current === a && !restart && time === null) { a.timeScale = speed; return a; }
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
    this.updateSword(dt, o.swinging);
    this.updateTint(dt);
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

  updateSword(dt, swinging) {
    const flick = 0.92 + Math.sin(this.time * 61) * 0.04 + Math.sin(this.time * 37) * 0.04;
    this.light.intensity = (swinging ? 22 : 0) * flick;
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

function groups(meta, clip, { minPeak = 22, gap = 0.09, limit = 99 } = {}) {
  const sw = (meta.clips[clip]?.swings ?? []).filter((s) => s.peak >= minPeak);
  const out = [];
  for (const s of sw) {
    const last = out[out.length - 1];
    if (last && s.t0 - last.t1 < gap) { last.t1 = s.t1; last.reach = Math.max(last.reach, s.reach); last.h0 = Math.min(last.h0, s.h0); last.h1 = Math.max(last.h1, s.h1); last.parts.push(s); }
    else out.push({ ...s, parts: [s] });
  }
  return out.slice(0, limit);
}

function moveFrom(k, clip, g, start, end, speed, extra) {
  return {
    ...BASE, ...extra, clip, start, speed,
    t: [Math.max(0.01, (g.t0 - start) / speed), Math.max(0.03, (g.t1 - g.t0) / speed), Math.max(0.05, (end - g.t1) / speed)],
    arcs: g.parts.map((p) => ({ ...p, dt: (p.t0 - g.t0) / speed, dur: (p.t1 - p.t0) / speed })),
    range: ((g.reach ?? 1.4) * k + 1.2) / S,
    cone: THREE.MathUtils.clamp(Math.max(Math.abs(g.h0 ?? -1), Math.abs(g.h1 ?? 1)) + 0.35, 0.7, Math.PI),
  };
}

function chain(k, meta, clip, { speed = 1, minPeak, limit = 99, lead = 0.2, tail = 0.45, base = {}, last = {} } = {}) {
  const gs = groups(meta, clip, { minPeak, limit });
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
function single(k, meta, clip, { t0, t1, lead = 0.25, tail = 0.5, speed = 1, extra = {} } = {}) {
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
  const reg = (prefix, list) => list.map((m, i) => { const id = `${prefix}${i}`; MOVES[id] = m; return id; });
  const has = (c) => !!meta.clips[c];
  const K = { dmg: 14 };
  const ground = has('combo1') ? reg('sg', chain(k, meta, 'combo1', { speed: 0.95, minPeak: 30, limit: 4, base: K, last: { dmg: 24, hitstop: 0.1, finisher: true } })) : [];
  return {
    ground: ground.length ? ground : ['k1', 'k2', 'k3', 'k4'],
    heavy: has('charge') ? reg('sh', [single(k, meta, 'charge', { speed: 1.05, extra: { dmg: 32, hitstop: 0.12, shock: 3.2, heavy: true } })])[0] : 'kH',
    launch: has('gs_slash') ? reg('sl', [single(k, meta, 'gs_slash', { speed: 1.3, extra: { dmg: 16, hitstop: 0.09, launch: true, lunge: 1.8 } })])[0] : 'kL',
    air: has('aerial') ? reg('sa', chain(k, meta, 'aerial', { speed: 1.25, minPeak: 30, limit: 3, base: { dmg: 12, air: true, lunge: 1.2 }, last: { dmg: 20, slam: true, heavy: true, hitstop: 0.1 } })) : ['kA1', 'kA2', 'kA3'],
    plunge: has('combo_down') ? reg('sp', [single(k, meta, 'combo_down', { speed: 1.25, extra: { dmg: 28, shock: 3.6, plunge: true, heavy: true, hitstop: 0.1 } })])[0] : 'kP',
  };
}
