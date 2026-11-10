import * as THREE from 'three';
import { PISTOL_LEN } from './gun.js';

// Gun mode for the chase cameras (characters and mechs): with the shotgun out a crosshair marks the centre of the
// screen and the camera slides over the shoulder so the body is not in the way; holding aim pulls the camera into
// the eyes for a first-person view down the barrel, with a tighter lens. The crosshair opens with each shot, turns
// red over a target, flashes a hit marker, and carries the shell count. The view calls begin() before it places its
// chase camera, apply() after, update() for the blend weights, and ray() for the line a shot follows.

const _r = new THREE.Vector3(), _f = new THREE.Vector3();
export const ADS_FOV = 40;

export class GunView {
  constructor() {
    const el = (this.el = document.createElement('div'));
    el.className = 'crosshair'; el.hidden = true;
    el.innerHTML = '<i></i><i></i><i></i><i></i><b></b><u></u><em></em>';
    document.body.appendChild(el);
    this.$ammo = el.querySelector('em');
    this.gunK = 0; this.adsK = 0; this.kick = 0; this.hitT = 0; this.rise = 0;
    this.origin = new THREE.Vector3(); this.dir = new THREE.Vector3(0, 0, -1);
    this.off = new THREE.Vector3();          // what apply() added to the chase camera last frame
    // the first-person view model's sway: lags the look, bobs with the stride, dips to reload
    this.vm = { x: 0, y: 0, rx: 0, ry: 0, dip: 0, bob: 0 };
    this.shown = {};
  }
  // gun: the shotgun is out; ads: aim is held. o: { lookX, lookY (this frame's look input), speed (m/s over the
  // ground, in body lengths), kit (for the shell count), on (the crosshair is over a target) }. Returns the
  // first-person weight (0..1)
  update(dt, gun, ads, o = {}) {
    this.gunK += ((gun ? 1 : 0) - this.gunK) * Math.min(1, dt * 9);
    this.adsK += ((gun && ads ? 1 : 0) - this.adsK) * Math.min(1, dt * 12);
    if (this.adsK < 0.002) this.adsK = 0;
    // the camera only sits in the scene while it carries the view model (a parented camera is not refreshed by the
    // renderer when another scene is drawn)
    if (this.adsK === 0 && this.cam?.parent) this.cam.removeFromParent();
    this.kick = Math.max(0, this.kick - dt * 5);
    this.rise += (0 - this.rise) * Math.min(1, dt * 7);
    this.hitT = Math.max(0, this.hitT - dt);
    const vm = this.vm, k = Math.min(1, dt * 10), K = o.kit;
    vm.ry += (THREE.MathUtils.clamp(-(o.lookX || 0) * 0.004, -0.09, 0.09) - vm.ry) * k;
    vm.rx += (THREE.MathUtils.clamp(-(o.lookY || 0) * 0.004, -0.07, 0.07) - vm.rx) * k;
    vm.bob += dt * (4 + Math.min(1.6, o.speed || 0) * 6);
    const amp = Math.min(1, (o.speed || 0) / 1.2) * (1 - this.adsK * 0.7);
    vm.x = Math.cos(vm.bob) * 0.006 * amp; vm.y = Math.abs(Math.sin(vm.bob)) * 0.008 * amp;
    vm.dip += ((K && K.reload > 0 ? 1 : 0) - vm.dip) * Math.min(1, dt * 8);
    if (this.el.hidden === gun) this.el.hidden = !gun;
    if (gun) {
      const set = (key, v, fn) => { if (this.shown[key] !== v) { this.shown[key] = v; fn(v); } };
      set('ads', this.adsK > 0.5, (v) => this.el.classList.toggle('ads', v));
      set('on', !!o.on, (v) => this.el.classList.toggle('on', v));
      set('hit', this.hitT > 0 ? this.hitKind : '', (v) => { this.el.classList.toggle('hit', !!v); this.el.classList.toggle('kill', v === 'kill'); });
      this.el.style.setProperty('--gap', `${(this.adsK > 0.5 ? 4 : 10) + this.kick * 14 + Math.min(1, (o.speed || 0) / 1.5) * 4 * (1 - this.adsK)}px`);
      if (K) set('ammo', K.reload > 0 ? 'RELOAD' : String(K.ammo), (v) => { this.$ammo.textContent = v; this.$ammo.classList.toggle('low', v === 'RELOAD' || +v <= 1); });
    }
    return this.adsK;
  }
  // a shot was fired: the crosshair jumps open and the muzzle climbs
  fired() { this.kick = 1; this.rise = 1; }
  // pellets landed: a hit marker, red if it finished the target
  hit(kill) { this.hitT = kill ? 0.3 : 0.16; this.hitKind = kill ? 'kill' : 'hit'; }
  // before the chase camera eases toward its place: take last frame's shoulder offset back out, so it never
  // compounds into the easing (which would leave the view skewed off the line you walk along)
  begin(camera) { camera.position.sub(this.off); this.off.set(0, 0, 0); }
  // after the chase camera is placed and aimed: slide it over the right shoulder, then into the eyes.
  // eye: world point of the first-person view; shoulder: metres to the right in third person
  apply(camera, eye, shoulder) {
    this.cam = camera;
    if (this.gunK < 0.002) return;
    const base = this.off.copy(camera.position);
    _r.set(1, 0, 0).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(_r, shoulder * this.gunK * (1 - this.adsK));
    if (this.adsK > 0) camera.position.lerp(eye, this.adsK);
    this.off.subVectors(camera.position, base);
    // the line of fire is the unkicked view; the recoil only lifts the picture
    camera.getWorldDirection(_f);
    this.origin.copy(camera.position); this.dir.copy(_f);
    if (this.rise > 0.002) camera.rotateX(this.rise * (0.012 + this.adsK * 0.014));
  }
  // the line through the crosshair: { o, d, fps }
  ray() { return this.gunK > 0.5 ? { o: this.origin, d: this.dir, fps: this.adsK > 0.6 } : null; }
  hide() { this.el.hidden = true; this.gunK = this.adsK = 0; this.off.set(0, 0, 0); if (this.cam?.parent) this.cam.removeFromParent(); }
}

// the gun as a first-person view model: on the camera, low and to the right, barrel down the view. vm: GunView.vm
const FPS_Q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)));
const _q = new THREE.Quaternion(), _e = new THREE.Euler();
export function mountFps(gun, camera, scene, recoil = 0, vm = null) {
  if (camera.parent !== scene) scene.add(camera);
  if (gun.parent !== camera) { camera.add(gun); gun.scale.set(1, 1, 1); }
  const s = (gun.userData.size || PISTOL_LEN) / PISTOL_LEN, v = vm || { x: 0, y: 0, rx: 0, ry: 0, dip: 0 };
  gun.position.set((0.1 + v.x) * s, (-0.135 + v.y + recoil * 0.02 - v.dip * 0.14) * s, (-0.46 + recoil * 0.07) * s);
  gun.quaternion.copy(_q.setFromEuler(_e.set(v.rx + recoil * 0.13 - v.dip * 0.7, v.ry, v.ry * 0.6 + v.dip * 0.25))).multiply(FPS_Q);
}
