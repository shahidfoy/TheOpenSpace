import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { upgrade } from './materials.js';
import { trimMechPlayer } from './mech/trimMech.js';
import { buildX12, buildOmega } from './mech/frames.js';

// Hero models built by blender/build_models.py (Draco-compressed). Any that fail to
// load fall back to procedural meshes.
const NAMES = ['frame', 'skiff', 'hauler', 'seed', 'drone', 'mech', 'mech_lo', 'station', 'junk'];
const ASSETS = {};
// Skinned, clip-animated models (kept as whole glTFs for their animations) + their swing metadata json.
const SKINNED = ['mech_player', 'mech_enemy'];
const SKIN = {};

export async function loadAssets(timeoutMs = 15000, onProgress) {
  const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`).setDecoderConfig({ type: 'wasm' });
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const base = `${import.meta.env.BASE_URL}models/`;
  let done = 0;
  const all = Promise.all(NAMES.map((n) => loader.loadAsync(`${base}${n}.glb`)
    .then((g) => { ASSETS[n] = upgrade(g.scene); })
    .catch((e) => console.warn(`model ${n} failed, using procedural fallback`, e))
    .finally(() => onProgress?.(++done / NAMES.length))));
  const skins = Promise.all(SKINNED.map((n) => Promise.all([loader.loadAsync(`${base}${n}.glb`), fetch(`${base}${n}.json`).then((r) => r.json())])
    .then(([gltf, meta]) => {
      // the player mech sheds its back fins and belt (see mech/trimMech.js)
      if (n === 'mech_player') { try { trimMechPlayer(gltf); } catch (e) { console.warn('mech trim failed', e); } }
      SKIN[n] = { gltf, meta };
    })
    .catch((e) => console.warn(`skinned model ${n} failed, using procedural fallback`, e))));
  // the player's mech frames come as the artists' files and are rigged here (mech/frames.js)
  const frames = Promise.all([['mech_x12', buildX12], ['mech_omega', buildOmega]].map(([n, build]) => loader.loadAsync(`${base}${n}.glb`)
    .then((gltf) => { const a = build(gltf); if (a) SKIN[n] = a; })
    .catch((e) => console.warn(`mech frame ${n} failed`, e))));
  await Promise.race([Promise.all([all, skins, frames]), new Promise((r) => setTimeout(r, timeoutMs))]);
  draco.dispose();
}

export const skinned = (name) => SKIN[name] || null;
export const instance = (name) => ASSETS[name]?.clone(true) || null;

// One named root object out of a multi-object file (e.g. junk.glb → junk_sat).
export function instanceChild(name, child) {
  const o = ASSETS[name]?.getObjectByName(child);
  if (!o) return null;
  const c = o.clone(true);
  c.position.set(0, 0, 0);
  return c;
}

// Named empties exported from Blender as anchor_<name>.
export function anchors(obj) {
  const out = {};
  obj.traverse((o) => { if (o.name.startsWith('anchor_')) out[o.name.slice(7)] = o; });
  return out;
}

export function part(obj, name) {
  return obj.getObjectByName(name);
}
