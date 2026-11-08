import * as THREE from 'three';

// Mech liveries: the player frame's armour is split into three paint zones in Blender (paint_a main, paint_b second,
// paint_c trim; see blender/build_mech_player.py) plus the inner frame, the lamps and the blade's edge inlay.
// A livery sets a colour per zone, a paint finish, and which zones are bare metal (gold / chrome plating).
// The choice is per device (localStorage), like the graphics quality.

export const FINISHES = {
  gloss: { metal: 0.42, rough: 0.2, coat: 1, coatRough: 0.06 },
  satin: { metal: 0.3, rough: 0.46, coat: 0.35, coatRough: 0.3 },
  matte: { metal: 0.08, rough: 0.8, coat: 0, coatRough: 0.5 },
  metal: { metal: 0.9, rough: 0.28, coat: 0.5, coatRough: 0.15 },
};

export const LIVERIES = {
  knight: { name: 'Knight', a: '#86938b', b: '#5d6a63', c: '#b5452f', frame: '#2b3035', glow: '#4ef0d8', blade: '#52d8ff', finish: 'satin', metals: '' },
  titan: { name: 'Titan', a: '#b81a1e', b: '#d4a030', c: '#d4a030', frame: '#1c1820', glow: '#60e8ff', blade: '#60e8ff', finish: 'gloss', metals: 'bc' },
  federation: { name: 'Federation', a: '#e8ecf0', b: '#1a3a8c', c: '#c41a1e', frame: '#2a2e36', glow: '#60e8ff', blade: '#60d0ff', finish: 'gloss', metals: '' },
  crimson: { name: 'Crimson Gold', a: '#9a1414', b: '#d6a43a', c: '#d6a43a', frame: '#2a2326', glow: '#a8ecff', blade: '#8fe6ff', finish: 'gloss', metals: 'bc' },
  tricolor: { name: 'Tricolor', a: '#e9ecef', b: '#1b3c9c', c: '#c81e1e', frame: '#2c3036', glow: '#63ffb8', blade: '#ff5aa8', finish: 'gloss', metals: '' },
  paladin: { name: 'Paladin', a: '#eef0f2', b: '#c9a24a', c: '#1f4fa8', frame: '#30343a', glow: '#8fd8ff', blade: '#ffd27a', finish: 'gloss', metals: 'b' },
  striker: { name: 'Striker', a: '#d4d8de', b: '#4a5058', c: '#c41a1e', frame: '#1c2028', glow: '#60e8ff', blade: '#40d8ff', finish: 'gloss', metals: '' },
  shadow: { name: 'Shadow', a: '#25282c', b: '#17191c', c: '#ff6a1a', frame: '#101114', glow: '#ff7a2a', blade: '#ff6a2a', finish: 'matte', metals: '' },
  azure: { name: 'Azure', a: '#1d4fa0', b: '#e6eaee', c: '#e0b040', frame: '#262a30', glow: '#7fe0ff', blade: '#7fe0ff', finish: 'gloss', metals: 'c' },
  desert: { name: 'Desert', a: '#b59a6c', b: '#5e5a3c', c: '#2b2d24', frame: '#2a2a26', glow: '#ffc35a', blade: '#ffd27a', finish: 'matte', metals: '' },
  chrome: { name: 'Chrome', a: '#c9ced4', b: '#8a9099', c: '#e04a1c', frame: '#26292e', glow: '#ff9a4a', blade: '#7fe0ff', finish: 'metal', metals: 'abc' },
  unicorn: { name: 'Unicorn', a: '#f0f2f4', b: '#e8eaee', c: '#30a8e0', frame: '#2c3038', glow: '#40ff90', blade: '#40ffb0', finish: 'gloss', metals: 'ab' },
};
export const ZONES = [['a', 'Main'], ['b', 'Second'], ['c', 'Trim'], ['frame', 'Frame'], ['glow', 'Lights'], ['blade', 'Blade edge']];

const KEY = 'openspace_livery';
export function loadLivery() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (v && v.a) return { ...LIVERIES.striker, ...v };
  } catch {}
  return { ...LIVERIES.striker };
}
export function saveLivery(l) {
  try { localStorage.setItem(KEY, JSON.stringify(l)); } catch {}
}

// mats: { a, b, c, frame, glow, edge } materials of one body
export function applyLivery(mats, l) {
  const fin = FINISHES[l.finish] || FINISHES.satin;
  for (const z of ['a', 'b', 'c']) {
    const m = mats[z];
    if (!m) continue;
    const bare = (l.metals || '').includes(z);
    m.color.set(l[z]);
    m.metalness = bare ? 1 : fin.metal;
    m.roughness = bare ? 0.24 : fin.rough;
    if ('clearcoat' in m) { m.clearcoat = bare ? 0.6 : fin.coat; m.clearcoatRoughness = fin.coatRough; }
    m.envMapIntensity = bare ? 1.6 : 1.0;
  }
  if (mats.frame) mats.frame.color.set(l.frame);
  if (mats.glow) mats.glow.emissive.set(l.glow);
  if (mats.edge) mats.edge.emissive.set(l.blade);
}

export const hex = (c) => new THREE.Color(c).getHex();

// arena enemies: hostile schemes per frame type (plume = thruster exhaust colour)
export const HOSTILE = {
  lancer: { name: 'Raider', a: '#2d3238', b: '#1a1d21', c: '#c4161c', frame: '#121417', glow: '#ff3a1c', blade: '#ff3b2a', finish: 'satin', metals: '', plume: 0xff7a3a },
  gunner: { name: 'Lance Gunner', a: '#4b5244', b: '#2a2e25', c: '#e07a12', frame: '#16181a', glow: '#ffa030', blade: '#ffa030', finish: 'matte', metals: '', plume: 0xffa84a },
  brute: { name: 'Brute', a: '#8e1218', b: '#1c1416', c: '#d8b040', frame: '#121012', glow: '#ffd23a', blade: '#ffcc33', finish: 'gloss', metals: 'c', plume: 0xffc05a },
};
