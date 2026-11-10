import * as THREE from 'three';

// The Hunter's Shotgun: a sawn-off double barrel with a pump grip, built for the frame of a closed hand
// (chars/handIK.js Hand.q): +X out along the barrels, +Y up, the pistol grip running down -Y through the fist, the
// origin in the middle of the fist. `size` is the overall length in metres (0.52 for a person; the mech's is its own
// scale). userData.muzzle is the point between the muzzles; userData.fire(k) lights the muzzle flash.
export function makeShotgun(size = 0.52, { metal = 0x24272d, trim = 0x8a1f2a, glow = 0xff5a3a } = {}) {
  const g = new THREE.Group(), s = size / 0.52;
  const steel = new THREE.MeshStandardMaterial({ color: metal, metalness: 0.95, roughness: 0.3, envMapIntensity: 1.4 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0f1013, metalness: 0.5, roughness: 0.6 });
  const wood = new THREE.MeshStandardMaterial({ color: trim, metalness: 0.2, roughness: 0.55 });
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(glow).multiplyScalar(2), toneMapped: false });
  const add = (geo, mat, x, y, z, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x * s, y * s, z * s); m.rotation.z = rz; m.castShadow = true; g.add(m); return m; };
  const barrel = (z) => { const m = add(new THREE.CylinderGeometry(0.014 * s, 0.014 * s, 0.34 * s, 12), steel, 0.25, 0.062, z, Math.PI / 2); return m; };
  barrel(0.015); barrel(-0.015);
  for (const z of [0.015, -0.015]) add(new THREE.CylinderGeometry(0.0105 * s, 0.0105 * s, 0.006 * s, 10), dark, 0.421, 0.062, z, Math.PI / 2);   // bores
  add(new THREE.BoxGeometry(0.2 * s, 0.012 * s, 0.012 * s), steel, 0.3, 0.08, 0);                       // rib
  add(new THREE.BoxGeometry(0.15 * s, 0.062 * s, 0.05 * s), steel, 0.03, 0.05, 0);                      // receiver
  add(new THREE.BoxGeometry(0.11 * s, 0.03 * s, 0.056 * s), wood, 0.2, 0.034, 0);                       // pump grip
  add(new THREE.BoxGeometry(0.036 * s, 0.092 * s, 0.032 * s), wood, -0.008, -0.014, 0, 0.26);             // pistol grip, raked back
  add(new THREE.BoxGeometry(0.05 * s, 0.045 * s, 0.04 * s), wood, -0.07, 0.03, 0, 0.5);                 // cut-down stock stub
  add(new THREE.TorusGeometry(0.02 * s, 0.004 * s, 6, 12, Math.PI), dark, 0.035, 0.012, 0, Math.PI);    // trigger guard
  add(new THREE.BoxGeometry(0.012 * s, 0.012 * s, 0.012 * s), lamp, 0.4, 0.092, 0);                     // glowing bead sight
  add(new THREE.BoxGeometry(0.05 * s, 0.004 * s, 0.052 * s), lamp, 0.03, 0.083, 0);                     // breech line

  // muzzle flash: a short additive burst, hidden until a shot
  const flashMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd9a0).multiplyScalar(3), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const flash = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.07 * s, 0.26 * s, 10, 1, true), flashMat);
  cone.rotation.z = Math.PI / 2; cone.position.x = 0.13 * s;
  flash.add(cone);
  for (let i = 0; i < 3; i++) { const p = new THREE.Mesh(new THREE.PlaneGeometry(0.34 * s, 0.1 * s), flashMat); p.rotation.x = i * Math.PI / 3; p.position.x = 0.12 * s; flash.add(p); }
  flash.position.set(0.425 * s, 0.062 * s, 0);
  flash.visible = false;
  g.add(flash);
  g.userData.muzzle = new THREE.Vector3(0.43 * s, 0.062 * s, 0);
  g.userData.size = size;
  let k = 0;
  g.userData.fire = () => { k = 1; flash.rotation.x = Math.random() * 3; };
  g.userData.update = (dt) => {
    if (k <= 0) return;
    k = Math.max(0, k - dt / 0.07);
    flash.visible = k > 0; flashMat.opacity = k; flash.scale.setScalar(0.6 + (1 - k) * 0.9);
  };
  return g;
}
