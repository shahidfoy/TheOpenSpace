import { BODIES, AU_KM, J2000 } from '../data/bodies.js';

const D2R = Math.PI / 180;
export const BODY = Object.fromEntries(BODIES.map((b) => [b.id, b]));

// Rotate a point in an orbit plane (angle u from the ascending node, radius r) to ecliptic xyz.
function plane(r, u, i, node) {
  const cO = Math.cos(node), sO = Math.sin(node), ci = Math.cos(i), si = Math.sin(i);
  const cu = Math.cos(u), su = Math.sin(u);
  return [r * (cO * cu - sO * su * ci), r * (sO * cu + cO * su * ci), r * su * si];
}

// Heliocentric ecliptic position [x, y, z] in AU at time t (ms), solving Kepler's equation
// on the real inclined orbit (z = height above the ecliptic plane).
export function helioAU(b, t) {
  if (b.kind === 'star') return [0, 0, 0];
  const days = (t - J2000) / 864e5;
  if (b.parent) {
    const p = helioAU(BODY[b.parent], t);
    const node = (b.node + (b.nodeRate || 0) * days / 365.25) * D2R;
    const lon = (b.L0 + (360 * days) / b.period) * D2R;
    const q = plane(b.orbitKm / AU_KM, lon - node, (b.i || 0) * D2R, node);
    return [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
  }
  const M = (((b.L0 + (360 * days) / b.period - b.varpi) % 360) * D2R);
  let E = M;
  for (let k = 0; k < 8; k++) E -= (E - b.e * Math.sin(E) - M) / (1 - b.e * Math.cos(E));
  const nu = 2 * Math.atan2(Math.sqrt(1 + b.e) * Math.sin(E / 2), Math.sqrt(1 - b.e) * Math.cos(E / 2));
  const r = b.a * (1 - b.e * Math.cos(E));
  // argument of latitude = true anomaly + argument of perihelion (varpi - node)
  return plane(r, nu + (b.varpi - b.node) * D2R, b.i * D2R, b.node * D2R);
}

export const distAU = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
export function distKm(a, b, t) {
  return distAU(helioAU(BODY[a], t), helioAU(BODY[b], t)) * AU_KM;
}

export function sunDistAU(id, t) {
  const b = BODY[id];
  if (b.kind === 'star') return b.orbitAU;
  const p = helioAU(b, t);
  return Math.max(0.05, Math.hypot(p[0], p[1], p[2]));
}

// Compressed display coordinates for the strategic map: distance from the Sun on a sqrt
// scale, direction (including inclination) kept true. Ecliptic x/y → scene x/-z, z → y.
export function mapScale(r) {
  return r > 0 ? (16 * Math.sqrt(r)) / r : 0;
}
export function mapPos(id, t, out) {
  const b = BODY[id];
  if (b.kind === 'star') return out.set(0, 0, 0);
  if (b.parent) {
    mapPos(b.parent, t, out);
    const p = helioAU(BODY[b.parent], t), q = helioAU(b, t);
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], l = Math.hypot(...d) || 1;
    const k = b.mapOrbit / l;
    return out.set(out.x + d[0] * k, out.y + d[2] * k, out.z - d[1] * k);
  }
  const [x, y, z] = helioAU(b, t);
  const k = mapScale(Math.hypot(x, y, z));
  return out.set(x * k, z * k, -y * k);
}
export function mapPosAU(p, out) {
  const k = mapScale(Math.hypot(p[0], p[1], p[2]));
  return out.set(p[0] * k, p[2] * k, -p[1] * k);
}

// Transit position: ships launched from a world keep its orbital velocity, so the course is
// flown relative to the moving pair (Earth→Moon doesn't drift with Earth's 30 km/s).
// Returns the heliocentric AU position at time t, k of the way from origin to target.
export function transitAU(from, to, depart, arrive, t) {
  const tt = Math.min(arrive, Math.max(depart, t));
  const p = helioAU(BODY[from], tt), q = helioAU(BODY[to], tt);
  const k = Math.min(1, Math.max(0, (t - depart) / Math.max(1, arrive - depart)));
  return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k];
}

// Galactic reference directions in map-scene coordinates (x, ecliptic north, -y).
// Derived from IAU galactic coordinates: the ecliptic is tilted ~60° to the galactic plane.
export const GALACTIC = {
  north: [-0.868, 0.497, 0.0], // galactic north pole (ecliptic lon 180°, lat +29.8°)
  center: [-0.056, -0.096, 0.994], // Sgr A* (ecliptic lon 266.8°, lat -5.5°)
  apex: [0.494, 0.862, 0.111], // direction of the Sun's galactic orbit, toward Cygnus
  speedKms: 230,
  radiusLy: 26000,
  periodMyr: 230,
};
