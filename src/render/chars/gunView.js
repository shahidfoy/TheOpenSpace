import * as THREE from 'three';

// Gun mode for the chase cameras (characters and mechs): with the shotgun out a crosshair marks the centre of the
// screen and the camera slides over the shoulder so the body is not in the way; holding aim pulls the camera into
// the eyes for a first-person view down the barrels, with a tighter lens. The view calls update() for the blend
// weights, apply() after it has placed its chase camera, and ray() for the line a shot follows.

const _r = new THREE.Vector3(), _f = new THREE.Vector3();
export const ADS_FOV = 40;

export class GunView {
  constructor() {
    const el = (this.el = document.createElement('div'));
    el.className = 'crosshair'; el.hidden = true;
    el.innerHTML = '<i></i><i></i><i></i><i></i><b></b>';
    document.body.appendChild(el);
    this.gunK = 0; this.adsK = 0; this.kick = 0;
    this.origin = new THREE.Vector3(); this.dir = new THREE.Vector3(0, 0, -1);
  }
  // gun: the shotgun is out; ads: aim is held. Returns the first-person weight (0..1)
  update(dt, gun, ads) {
    this.gunK += ((gun ? 1 : 0) - this.gunK) * Math.min(1, dt * 9);
    this.adsK += ((gun && ads ? 1 : 0) - this.adsK) * Math.min(1, dt * 12);
    if (this.adsK < 0.002) this.adsK = 0;
    // the camera only sits in the scene while it carries the view model (a parented camera is not refreshed by the
    // renderer when another scene is drawn)
    if (this.adsK === 0 && this.cam?.parent) this.cam.removeFromParent();
    this.kick = Math.max(0, this.kick - dt * 5);
    if (this.el.hidden === gun) this.el.hidden = !gun;
    if (gun) {
      this.el.classList.toggle('ads', this.adsK > 0.5);
      this.el.style.setProperty('--gap', `${(this.adsK > 0.5 ? 5 : 11) + this.kick * 14}px`);
    }
    return this.adsK;
  }
  // a shot was fired: the crosshair jumps open
  fired() { this.kick = 1; }
  // after the chase camera is placed and aimed: slide it over the right shoulder, then into the eyes.
  // eye: world point of the first-person view; shoulder: metres to the right in third person
  apply(camera, eye, shoulder) {
    this.cam = camera;
    if (this.gunK < 0.002) return;
    _r.set(1, 0, 0).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(_r, shoulder * this.gunK * (1 - this.adsK));
    if (this.adsK > 0) camera.position.lerp(eye, this.adsK);
    camera.getWorldDirection(_f);
    this.origin.copy(camera.position); this.dir.copy(_f);
  }
  // the line through the crosshair: { o, d, fps }
  ray() { return this.gunK > 0.5 ? { o: this.origin, d: this.dir, fps: this.adsK > 0.6 } : null; }
  hide() { this.el.hidden = true; this.gunK = this.adsK = 0; if (this.cam?.parent) this.cam.removeFromParent(); }
}

// the gun as a first-person view model: on the camera, low and to the right, barrels down the view
const FPS_Q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)));
export function mountFps(gun, camera, scene, recoil = 0) {
  if (camera.parent !== scene) scene.add(camera);
  if (gun.parent !== camera) { camera.add(gun); gun.scale.set(1, 1, 1); gun.quaternion.copy(FPS_Q); }
  const s = (gun.userData.size || 0.5) / 0.5;
  gun.position.set(0.17 * s, (-0.19 + recoil * 0.03) * s, (-0.42 + recoil * 0.09) * s);
  gun.rotation.x = recoil * 0.12;
}
