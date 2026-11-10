import * as THREE from 'three';

// The Hunter's sidearm, a pulse pistol: a squared slide with lit channels down each flank, an emitter at the muzzle,
// a glowing cell under the barrel and lit sights. Built for the frame of a closed hand (chars/handIK.js Hand.q): +X
// out along the barrel, +Y up, the grip running down -Y through the fist, the origin in the middle of the fist.
// `size` is the overall length in metres (0.26 for a person; the mech's is its own scale).
// userData: muzzle, size, fire() (flash, and the cell flares), update(dt), setGlow(hex) (the energy colour).
export const PISTOL_LEN = 0.26;
export function makePistol(size = PISTOL_LEN, { metal = 0x2b3038, trim = 0x14171c, glow = 0x39d8ff } = {}) {
  const g = new THREE.Group(), s = size / PISTOL_LEN;
  const shell = new THREE.MeshStandardMaterial({ color: metal, metalness: 0.9, roughness: 0.32, envMapIntensity: 1.5 });
  const dark = new THREE.MeshStandardMaterial({ color: trim, metalness: 0.6, roughness: 0.55 });
  const plate = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 0.75, roughness: 0.28, envMapIntensity: 1.6 });
  const energy = new THREE.MeshStandardMaterial({ color: 0x05080c, emissive: new THREE.Color(glow), emissiveIntensity: 2.4 });
  const add = (geo, mat, x, y, z, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x * s, y * s, z * s); m.rotation.z = rz; m.castShadow = true; g.add(m); return m; };
  const box = (w, h, d) => new THREE.BoxGeometry(w * s, h * s, d * s);
  const cyl = (r, l, n = 12) => new THREE.CylinderGeometry(r * s, r * s, l * s, n);

  // slide and frame
  add(box(0.2, 0.034, 0.03), shell, 0.075, 0.058, 0);
  add(box(0.19, 0.006, 0.024), plate, 0.075, 0.078, 0);                               // top strap
  add(box(0.165, 0.022, 0.027), dark, 0.068, 0.031, 0);
  add(box(0.03, 0.034, 0.03), shell, -0.034, 0.052, 0, 0.3);                          // beavertail
  for (const z of [0.0156, -0.0156]) {
    add(box(0.11, 0.006, 0.002), energy, 0.1, 0.06, z);                               // lit channel
    for (let i = 0; i < 5; i++) add(box(0.004, 0.024, 0.002), dark, -0.012 + i * 0.009, 0.058, z, -0.35);   // slide serrations
  }
  // emitter and the cell under the barrel
  add(cyl(0.011, 0.014), plate, 0.181, 0.058, 0, Math.PI / 2);
  add(cyl(0.007, 0.016), energy, 0.183, 0.058, 0, Math.PI / 2);
  add(box(0.06, 0.014, 0.02), energy, 0.115, 0.012, 0);
  add(box(0.07, 0.006, 0.024), dark, 0.115, 0.003, 0);
  // grip and trigger guard
  add(box(0.034, 0.1, 0.028), dark, -0.006, -0.02, 0, 0.24);
  add(box(0.04, 0.012, 0.03), shell, -0.018, -0.07, 0, 0.24);                         // magazine base
  add(new THREE.TorusGeometry(0.018 * s, 0.0035 * s, 6, 12, Math.PI), dark, 0.036, 0.016, 0, Math.PI);
  // sights
  add(box(0.006, 0.008, 0.004), energy, 0.168, 0.085, 0);
  for (const z of [0.008, -0.008]) add(box(0.006, 0.008, 0.004), energy, -0.018, 0.085, z);

  // muzzle flash: a short additive burst, hidden until a shot
  const flashMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(glow).lerp(new THREE.Color(0xffffff), 0.5).multiplyScalar(3), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const flash = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.04 * s, 0.16 * s, 10, 1, true), flashMat);
  cone.rotation.z = Math.PI / 2; cone.position.x = 0.08 * s;
  flash.add(cone);
  for (let i = 0; i < 3; i++) { const p = new THREE.Mesh(new THREE.PlaneGeometry(0.2 * s, 0.06 * s), flashMat); p.rotation.x = i * Math.PI / 3; p.position.x = 0.07 * s; flash.add(p); }
  flash.position.set(0.19 * s, 0.058 * s, 0);
  flash.visible = false;
  g.add(flash);
  g.userData.muzzle = new THREE.Vector3(0.192 * s, 0.058 * s, 0);
  g.userData.size = size;
  let k = 0, heat = 0;
  g.userData.fire = () => { k = 1; heat = 1; flash.rotation.x = Math.random() * 3; };
  g.userData.update = (dt) => {
    if (heat > 0) { heat = Math.max(0, heat - dt * 3); energy.emissiveIntensity = 2.4 + heat * 5; }
    if (k <= 0) return;
    k = Math.max(0, k - dt / 0.06);
    flash.visible = k > 0; flashMat.opacity = k; flash.scale.setScalar(0.6 + (1 - k) * 0.9);
  };
  g.userData.setGlow = (hex) => {
    energy.emissive.set(hex);
    flashMat.color.set(hex).lerp(new THREE.Color(0xffffff), 0.5).multiplyScalar(3);
  };
  return g;
}
