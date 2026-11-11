import * as THREE from 'three';
import { worldBox } from '../chars/simTextures.js';

// Shared pieces for the walkable areas inside the mothership and its simulator: an Area is one scene plus the
// axis-aligned collision boxes the parkour controller runs on, the meshes the chase camera collides with, and the
// interaction points (E prompts). Labels are glowing holo signs.

export function label(text, sub = '', color = '#7fe6ff') {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.font = '700 54px "Rajdhani", "Segoe UI", sans-serif'; g.textAlign = 'center';
  g.shadowColor = color; g.shadowBlur = 18; g.fillStyle = color;
  g.fillText(text, 256, 66);
  if (sub) { g.font = '500 26px "Rajdhani", "Segoe UI", sans-serif'; g.shadowBlur = 8; g.fillStyle = '#cfefff'; g.fillText(sub, 256, 108); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false }));
  s.scale.set(4, 1, 1);
  return s;
}

export class Area {
  constructor(name) {
    this.name = name;
    this.scene = new THREE.Scene();
    this.boxes = [];
    this.meshes = [];              // camera collision
    this.interact = [];
    this.spawn = { pos: new THREE.Vector3(), yaw: 0 };
    this.killY = -30;
  }
  // a box from min corner + size; kind: solid (default), run, climb
  box(x, y, z, w, h, d, mat, { kind = 'solid', tile = 1, collide = true, shadow = true } = {}) {
    const m = new THREE.Mesh(worldBox(w, h, d, tile), mat);
    m.position.set(x + w / 2, y + h / 2, z + d / 2);
    m.castShadow = shadow; m.receiveShadow = true;
    this.scene.add(m);
    if (collide) { this.collider(x, y, z, w, h, d, kind); this.meshes.push(m); }
    return m;
  }
  collider(x, y, z, w, h, d, kind = 'solid') {
    this.boxes.push({ min: new THREE.Vector3(x, y, z), max: new THREE.Vector3(x + w, y + h, z + d), kind });
  }
}
