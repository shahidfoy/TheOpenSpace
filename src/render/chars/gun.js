import * as THREE from 'three';

// The Hunter's Shotgun as a pulse scattergun: a slab-sided receiver, twin emitter rails with a lit channel between
// them, a glowing energy cell under the barrel, cooling vents and a holo sight. Built for the frame of a closed hand
// (chars/handIK.js Hand.q): +X out along the barrel, +Y up, the grip running down -Y through the fist, the origin in
// the middle of the fist. `size` is the overall length in metres (0.5 for a person; the mech's is its own scale).
// userData: muzzle (the point between the emitters), fire() (flash, and the cell and vents flare), update(dt),
// setGlow(hex) (the energy colour).
export function makeShotgun(size = 0.52, { metal = 0x2b3038, trim = 0x14171c, glow = 0x39d8ff } = {}) {
  const g = new THREE.Group(), s = size / 0.52;
  const shell = new THREE.MeshStandardMaterial({ color: metal, metalness: 0.9, roughness: 0.32, envMapIntensity: 1.5 });
  const dark = new THREE.MeshStandardMaterial({ color: trim, metalness: 0.6, roughness: 0.55 });
  const plate = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 0.75, roughness: 0.28, envMapIntensity: 1.6 });
  const energy = new THREE.MeshStandardMaterial({ color: 0x05080c, emissive: new THREE.Color(glow), emissiveIntensity: 2.4 });
  const sightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(glow).multiplyScalar(1.6), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const add = (geo, mat, x, y, z, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x * s, y * s, z * s); m.rotation.z = rz; m.castShadow = true; g.add(m); return m; };
  const box = (w, h, d) => new THREE.BoxGeometry(w * s, h * s, d * s);
  const cyl = (r, l, n = 12) => new THREE.CylinderGeometry(r * s, r * s, l * s, n);

  // receiver: a wedge-backed slab with a lighter top plate
  add(box(0.17, 0.07, 0.052), shell, 0.035, 0.05, 0);
  add(box(0.15, 0.012, 0.046), plate, 0.04, 0.09, 0);
  add(box(0.06, 0.05, 0.048), shell, -0.07, 0.045, 0, 0.42);                       // raked rear
  add(box(0.05, 0.03, 0.04), dark, -0.105, 0.02, 0, 0.5);                           // stub stock
  // twin emitter rails, one over the other, a lit channel between
  add(box(0.29, 0.02, 0.04), shell, 0.265, 0.078, 0);
  add(box(0.29, 0.02, 0.04), shell, 0.265, 0.032, 0);
  add(box(0.27, 0.012, 0.018), energy, 0.26, 0.055, 0);
  for (const y of [0.078, 0.032]) add(box(0.018, 0.026, 0.046), plate, 0.405, y, 0);   // emitter caps
  for (let i = 0; i < 4; i++) add(box(0.008, 0.07, 0.044), dark, 0.16 + i * 0.062, 0.055, 0);   // rail clamps
  // energy cell under the barrel, in a cradle
  add(cyl(0.017, 0.12), energy, 0.2, 0.004, 0, Math.PI / 2);
  for (const x of [0.145, 0.255]) add(cyl(0.021, 0.014), dark, x, 0.004, 0, Math.PI / 2);
  add(box(0.13, 0.008, 0.03), dark, 0.2, -0.018, 0);
  // cooling vents down each flank
  for (const z of [0.0265, -0.0265]) for (let i = 0; i < 4; i++) add(box(0.016, 0.006, 0.002), energy, -0.01 + i * 0.026, 0.062, z, -0.5);
  // grip and trigger guard
  add(box(0.036, 0.095, 0.032), dark, -0.008, -0.014, 0, 0.26);
  add(new THREE.TorusGeometry(0.02 * s, 0.004 * s, 6, 12, Math.PI), dark, 0.035, 0.012, 0, Math.PI);
  // holo sight: a frame with a floating reticle
  add(box(0.05, 0.006, 0.03), dark, 0.03, 0.099, 0);
  for (const z of [0.014, -0.014]) add(box(0.004, 0.034, 0.002), dark, 0.05, 0.117, z);
  add(box(0.004, 0.003, 0.03), dark, 0.05, 0.134, 0);
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.026 * s, 0.03 * s), new THREE.MeshBasicMaterial({ color: new THREE.Color(glow), transparent: true, opacity: 0.08, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  pane.rotation.y = Math.PI / 2; pane.position.set(0.05 * s, 0.117 * s, 0); g.add(pane);
  const dot = new THREE.Mesh(new THREE.RingGeometry(0.003 * s, 0.0052 * s, 16), sightMat);
  dot.rotation.y = Math.PI / 2; dot.position.set(0.0505 * s, 0.117 * s, 0); g.add(dot);

  // muzzle flash: a short additive burst, hidden until a shot
  const flashMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(glow).lerp(new THREE.Color(0xffffff), 0.5).multiplyScalar(3), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const flash = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.07 * s, 0.26 * s, 10, 1, true), flashMat);
  cone.rotation.z = Math.PI / 2; cone.position.x = 0.13 * s;
  flash.add(cone);
  for (let i = 0; i < 3; i++) { const p = new THREE.Mesh(new THREE.PlaneGeometry(0.34 * s, 0.1 * s), flashMat); p.rotation.x = i * Math.PI / 3; p.position.x = 0.12 * s; flash.add(p); }
  flash.position.set(0.42 * s, 0.055 * s, 0);
  flash.visible = false;
  g.add(flash);
  g.userData.muzzle = new THREE.Vector3(0.425 * s, 0.055 * s, 0);
  g.userData.size = size;
  let k = 0, heat = 0;
  g.userData.fire = () => { k = 1; heat = 1; flash.rotation.x = Math.random() * 3; };
  g.userData.update = (dt) => {
    if (heat > 0) { heat = Math.max(0, heat - dt * 2.2); energy.emissiveIntensity = 2.4 + heat * 5; }
    if (k <= 0) return;
    k = Math.max(0, k - dt / 0.07);
    flash.visible = k > 0; flashMat.opacity = k; flash.scale.setScalar(0.6 + (1 - k) * 0.9);
  };
  g.userData.setGlow = (hex) => {
    energy.emissive.set(hex); sightMat.color.set(hex).multiplyScalar(1.6); pane.material.color.set(hex);
    flashMat.color.set(hex).lerp(new THREE.Color(0xffffff), 0.5).multiplyScalar(3);
  };
  return g;
}
