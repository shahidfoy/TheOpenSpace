import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { upgrade } from './materials.js';

// Hero models built by blender/build_models.py (Draco-compressed). Any that fail to
// load fall back to procedural meshes.
const NAMES = ['skiff', 'hauler', 'seed', 'drone', 'mech', 'station', 'junk'];
const ASSETS = {};

export async function loadAssets(timeoutMs = 15000, onProgress) {
  const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`).setDecoderConfig({ type: 'wasm' });
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const base = `${import.meta.env.BASE_URL}models/`;
  let done = 0;
  const all = Promise.all(NAMES.map((n) => loader.loadAsync(`${base}${n}.glb`)
    .then((g) => { ASSETS[n] = upgrade(g.scene); })
    .catch((e) => console.warn(`model ${n} failed, using procedural fallback`, e))
    .finally(() => onProgress?.(++done / NAMES.length))));
  await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  draco.dispose();
}

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
