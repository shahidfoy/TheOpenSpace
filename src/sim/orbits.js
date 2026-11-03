import { BODIES, AU_KM, J2000 } from '../data/bodies.js';

const D2R = Math.PI / 180;
export const BODY = Object.fromEntries(BODIES.map((b) => [b.id, b]));

const TAU = 2 * Math.PI;
const TT_UTC_MS = 69184; // Terrestrial Time runs ~69.2 s ahead of UTC (32.184 s + 37 leap seconds)
const MS_PER_CENTURY = 36525 * 864e5;
const OBLIQUITY = 23.4392911 * D2R; // J2000 mean obliquity: equatorial ↔ ecliptic frame
const cE = Math.cos(OBLIQUITY), sE = Math.sin(OBLIQUITY);
// Earth-Moon mass split: the Earth sits 1/82.3 of the way from the barycentre to the Moon.
const MOON_EMB_FRAC = 1 / 82.30057;

// Julian centuries of Terrestrial Time since J2000.0 for a real-world UTC timestamp (ms).
const centuries = (t) => (t + TT_UTC_MS - J2000) / MS_PER_CENTURY;
// Equatorial (J2000 / ICRF) → ecliptic (J2000) coordinates.
const eqToEcl = (x, y, z) => [x, y * cE + z * sE, -y * sE + z * cE];

// Rotate a point in an orbit plane (angle u from the ascending node, radius r) to ecliptic xyz.
function plane(r, u, i, node) {
  const cO = Math.cos(node), sO = Math.sin(node), ci = Math.cos(i), si = Math.sin(i);
  const cu = Math.cos(u), su = Math.sin(u);
  return [r * (cO * cu - sO * su * ci), r * (sO * cu + cO * su * ci), r * su * si];
}

// ---------- planets & dwarf planets: Keplerian elements with secular rates ----------
// Solves Kepler's equation on the real inclined, precessing orbit (z = height above the
// ecliptic). Accurate to roughly an arcminute for the planets over 1800–2050.
function keplerAU(el, T) {
  const at = (k) => el[k][0] + el[k][1] * T;
  const a = at('a'), e = at('e'), i = at('i') * D2R, node = at('node') * D2R, varpi = at('varpi') * D2R;
  let M = (at('L') * D2R - varpi) % TAU;
  if (M > Math.PI) M -= TAU; else if (M < -Math.PI) M += TAU;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 10; k++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const r = a * (1 - e * Math.cos(E));
  // argument of latitude = true anomaly + argument of perihelion (varpi - node)
  return plane(r, nu + varpi - node, i, node);
}

// Jupiter and Saturn tug each other off pure Kepler ellipses by up to ~0.15°. These terms
// (multiples of their mean anomalies Mj, Ms) were least-squares fitted to the VSOP87 theory
// over 1950–2050: [j, s, sin amp, cos amp] on top of a quadratic drift, for longitude (deg)
// and distance (AU). They bring both giants to ~0.01° of their true place.
const PERTURB = {
  jupiter: {
    lon: [[-0.00225, -0.05882, -0.00597], [2, -2, -0.0507, -0.02094], [1, -2, -0.0352, 0.00233], [1, -1, -0.00458, 0.02219], [2, -3, 0.01152, 0.01927], [3, -5, 0.003, 0.00457]],
    r: [[0.00012, 0.00006, -0.00002], [2, -2, -0.00105, 0.00259], [1, -2, 0.00004, 0.00026], [1, -1, 0.00066, 0.00011], [2, -3, 0.00072, -0.0005], [3, -5, 0.00018, -0.00012]],
  },
  saturn: {
    lon: [[0.0153, 0.15044, 0.18062], [2, -4, -0.06119, -0.01969], [1, -2, 0.16329, -0.0418], [2, -6, 0.04741, -0.00986], [1, -3, -0.03888, 0.03243], [1, -1, 0.008, 0.00072], [2, -3, 0.00252, 0.00875]],
    r: [[0.00309, 0.00128, 0.008], [2, -4, -0.0012, 0.00452], [1, -2, 0.00212, -0.00551], [2, -6, 0.00119, 0.00322], [1, -3, -0.00076, 0.0025], [1, -1, 0.00846, 0.00122], [2, -3, 0.00094, -0.00046]],
  },
};
const meanAnomaly = (el, T) => (el.L[0] + el.L[1] * T - el.varpi[0] - el.varpi[1] * T) * D2R;
function perturb(p, terms, T) {
  const Mj = meanAnomaly(BODY.jupiter.el, T), Ms = meanAnomaly(BODY.saturn.el, T);
  const Tc = Math.max(-0.5, Math.min(0.5, T)); // keep the fitted drift inside its window
  const sum = (rows) => {
    const [c0, c1, c2] = rows[0];
    let v = c0 + c1 * Tc + c2 * Tc * Tc;
    for (let k = 1; k < rows.length; k++) {
      const [j, s, a, b] = rows[k], arg = j * Mj + s * Ms;
      v += a * Math.sin(arg) + b * Math.cos(arg);
    }
    return v;
  };
  const dl = sum(terms.lon) * D2R, r = Math.hypot(p[0], p[1], p[2]), k = (r + sum(terms.r)) / r;
  const c = Math.cos(dl), s = Math.sin(dl);
  return [k * (c * p[0] - s * p[1]), k * (s * p[0] + c * p[1]), k * p[2]];
}

// ---------- the Moon: truncated ELP-2000/82 series (Meeus, Astronomical Algorithms ch. 47) ----------
// Main periodic terms only — good to ~0.01° in longitude and ~10 km in distance.
// Rows: multiples of D, M, M', F, then longitude (1e-6°) and distance (1e-3 km) amplitudes.
const MOON_LR = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884], [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258], [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354], [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421],
];
// Latitude terms (1e-6°).
const MOON_B = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833],
];
// Geocentric Moon in AU, ecliptic J2000.
function moonGeoAU(T) {
  const deg = (x) => (x % 360) * D2R;
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  const Lp = deg(218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000);
  const D = deg(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000);
  const M = deg(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000);
  const Mp = deg(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000);
  const F = deg(93.272095 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000);
  const A1 = deg(119.75 + 131.849 * T), A2 = deg(53.09 + 479264.29 * T), A3 = deg(313.45 + 481266.484 * T);
  const Ecc = 1 - 0.002516 * T - 0.0000074 * T2;
  const eccF = (m) => (m === 0 ? 1 : Math.abs(m) === 1 ? Ecc : Ecc * Ecc);
  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of MOON_LR) {
    const arg = d * D + m * M + mp * Mp + f * F, k = eccF(m);
    sl += l * k * Math.sin(arg);
    sr += r * k * Math.cos(arg);
  }
  for (const [d, m, mp, f, b] of MOON_B) sb += b * eccF(m) * Math.sin(d * D + m * M + mp * Mp + f * F);
  sl += 3958 * Math.sin(A1) + 1962 * Math.sin(Lp - F) + 318 * Math.sin(A2);
  sb += -2235 * Math.sin(Lp) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F) + 175 * Math.sin(A1 + F)
    + 127 * Math.sin(Lp - Mp) - 115 * Math.sin(Lp + Mp);
  // longitude is referred to the equinox of date: remove general precession to get J2000
  const lon = Lp + (sl / 1e6) * D2R - 1.3969713 * T * D2R, lat = (sb / 1e6) * D2R;
  const r = (385000.56 + sr / 1000) / AU_KM;
  return [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)];
}

// ---------- Europa: L1.2 Galilean-satellite theory (Duriez, Lainey & Vienne, IMCCE) ----------
// Truncated series as published in Astronomy Engine (MIT, © Don Cross). Elements are in
// Jupiter's equatorial frame; [amplitude, phase, frequency (rad/day)].
const EUROPA = {
  mu: 2.8248327439289299e-7, // AU³/day²
  al: [-3.7352634374713622e-1, 1.7693227111234699],
  a: [[0.0044871037804314, 0, 0], [0.0000004324367498, 1.819645606291, 1.7822295777568]],
  l: [
    [0.0008576433172936, 4.3188693178264, 1.303413830805e-2], [0.0004549582875086, 1.4936531751079, 1.293892881962e-2],
    [0.0003248939825174, 1.8196494533458, 1.7822295777568], [-0.0003074250079334, 4.9377037005911, 1.358483286724e-2],
    [0.0001982386144784, 1.907986905476, 3.05101212869e-3], [0.0001834063551804, 2.1402853388529, 1.45009789338e-3],
    [-0.0001434383188452, 5.622214036663, 8.9111478887838e-1], [-0.0000771939140944, 4.300272437235, 2.6733443704266],
  ],
  z: [
    [-0.0093589104136341, 4.0899396509039, -1.290686414666e-2], [0.0002988994545555, 5.9097265185595, 1.7693227079462],
    [0.000213903639035, 2.1256289300016, 1.2727418407e-4], [0.0001980963564781, 2.743516829265, 6.7797343009e-4],
    [0.0001210388158965, 5.5839943711203, 3.20566149e-5], [0.0000837042048393, 1.609453836804, -9.0402165808846e-1],
    [0.0000823525166369, 1.4461887708689, 3.5515522949802],
  ],
  zeta: [
    [0.0040404917832303, 1.0477063169425, -5.692064054e-4], [0.0002200421034564, 3.3368857864364, -1.2491307307e-4],
    [0.0001662544744719, 2.4134862374711, 0], [0.0000590282470983, 5.9719930968366, -3.056160225e-5],
  ],
};
// Jupiter equatorial → J2000 equatorial rotation.
const JUP_EQJ = [
  [9.99432765338654e-1, -3.36771074697641e-2, 0],
  [3.03959428906285e-2, 9.02057912352809e-1, 4.30543388542295e-1],
  [-1.44994559663353e-2, -4.30299169409101e-1, 9.02569881273754e-1],
];
// Jovicentric Europa in AU, ecliptic J2000.
function europaAU(T) {
  const m = EUROPA, t = T * 36525 + 18262.5; // days since 1950-01-01 0h TT
  let A = 0, AL = m.al[0] + t * m.al[1], K = 0, H = 0, Q = 0, P = 0;
  for (const [amp, ph, fr] of m.a) A += amp * Math.cos(ph + t * fr);
  for (const [amp, ph, fr] of m.l) AL += amp * Math.sin(ph + t * fr);
  AL %= TAU;
  for (const [amp, ph, fr] of m.z) { K += amp * Math.cos(ph + t * fr); H += amp * Math.sin(ph + t * fr); }
  for (const [amp, ph, fr] of m.zeta) { Q += amp * Math.cos(ph + t * fr); P += amp * Math.sin(ph + t * fr); }
  // equinoctial elements → position (ELEM2PV)
  let EE = AL + K * Math.sin(AL) - H * Math.cos(AL);
  for (let k = 0; k < 20; k++) {
    const dE = (AL - EE + K * Math.sin(EE) - H * Math.cos(EE)) / (1 - K * Math.cos(EE) - H * Math.sin(EE));
    EE += dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  const CE = Math.cos(EE), SE = Math.sin(EE), DLE = H * CE - K * SE;
  const PSI = 1 / (1 + Math.sqrt(1 - K * K - H * H));
  const X1 = A * (CE - K - PSI * H * DLE), Y1 = A * (SE - H + PSI * K * DLE);
  const F2 = 2 * Math.sqrt(1 - Q * Q - P * P), P2 = 1 - 2 * P * P, Q2 = 1 - 2 * Q * Q, PQ = 2 * P * Q;
  const v = [X1 * P2 + Y1 * PQ, X1 * PQ + Y1 * Q2, (Q * Y1 - X1 * P) * F2];
  const R = JUP_EQJ;
  return eqToEcl(
    R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2],
    R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2],
    R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2],
  );
}

// ---------- Titan: Meeus, Astronomical Algorithms ch. 46 (after Harper & Taylor) ----------
// Saturn-equatorial elements on the B1950 ecliptic, then precessed to J2000.
function titanAU(T) {
  const jde = 2451545 + T * 36525, d = D2R;
  const t4 = jde - 2411368, t5 = t4 / 365.25, t7 = (jde - 2415020) / 36525;
  const W3 = 42 * d - 0.5118 * d * t5, W4 = 276.59 * d + 0.5118 * d * t5;
  const W5 = 267.2635 * d + 1222.1136 * d * t7, W6 = 175.4762 * d + 1221.5515 * d * t7;
  const W7 = 2.4891 * d + 0.002435 * d * t7, W8 = 113.35 * d - 0.2597 * d * t7;
  const s1 = Math.sin(28.0817 * d), c1 = Math.cos(28.0817 * d); // Saturn's equator vs B1950 ecliptic
  const nodeEq = 168.8112 * d; // ...and its ascending node
  const e1 = 0.05589 - 0.000346 * t7;
  const L = 261.1582 * d + 22.57697855 * d * t4 + 0.074025 * d * Math.sin(W3);
  const ip = 27.45141 * d + 0.295999 * d * Math.cos(W3);
  const Op = 168.66925 * d + 0.628808 * d * Math.sin(W3);
  const a1 = Math.sin(W7) * Math.sin(Op - W8);
  const a2 = Math.cos(W7) * Math.sin(ip) - Math.sin(W7) * Math.cos(ip) * Math.cos(Op - W8);
  const g0 = 102.8623 * d, psi = Math.atan2(a1, a2), s = Math.hypot(a1, a2);
  let g = W4 - Op - psi, varpi = 0;
  for (let k = 0; k < 3; k++) { varpi = W4 + 0.37515 * d * (Math.sin(2 * g) - Math.sin(2 * g0)); g = varpi - Op - psi; }
  const ep = 0.029092 + 0.00019048 * (Math.cos(2 * g) - Math.cos(2 * g0));
  const qq = 2 * (W5 - varpi);
  const b1 = Math.sin(ip) * Math.sin(Op - W8);
  const b2 = Math.cos(W7) * Math.sin(ip) * Math.cos(Op - W8) - Math.sin(W7) * Math.cos(ip);
  const theta = Math.atan2(b1, b2) + W8;
  const e = ep + 0.002778797 * ep * Math.cos(qq);
  const p = varpi + 0.159215 * d * Math.sin(qq);
  const u0 = 2 * W5 - 2 * theta + psi;
  const h = 0.9375 * ep * ep * Math.sin(qq) + 0.1875 * s * s * Math.sin(2 * (W5 - theta));
  const lam = L - 0.254744 * d * (e1 * Math.sin(W6) + 0.75 * e1 * e1 * Math.sin(2 * W6) + h);
  const inc = ip + 0.031843 * d * s * Math.cos(u0);
  const Om = Op + 0.031843 * d * s * Math.sin(u0) / Math.sin(ip);
  // equation of the centre, then refer the orbit to Saturn's equator
  const Ma = lam - p, e2 = e * e, e3 = e2 * e, e4 = e2 * e2, e5 = e3 * e2;
  const C = (2 * e - 0.25 * e3 + 0.0520833333 * e5) * Math.sin(Ma) + (1.25 * e2 - 0.458333333 * e4) * Math.sin(2 * Ma)
    + (1.083333333 * e3 - 0.671875 * e5) * Math.sin(3 * Ma) + 1.072917 * e4 * Math.sin(4 * Ma) + 1.142708 * e5 * Math.sin(5 * Ma);
  const r = (20.216193 * (1 - e2)) / (1 + e * Math.cos(Ma + C)); // Saturn radii
  const gg = Om - nodeEq;
  const c1a = Math.sin(inc) * Math.sin(gg), c2a = c1 * Math.sin(inc) * Math.cos(gg) - s1 * Math.cos(inc);
  const gamma = Math.asin(Math.hypot(c1a, c2a)), uu = Math.atan2(c1a, c2a);
  const hh = c1 * Math.sin(inc) - s1 * Math.cos(inc) * Math.cos(gg);
  const ps = Math.atan2(s1 * Math.sin(gg), hh);
  const lon = lam + C + uu - gg - ps, node = nodeEq + uu;
  const u = lon - node, w = node - nodeEq;
  const X = r * (Math.cos(u) * Math.cos(w) - Math.sin(u) * Math.cos(gamma) * Math.sin(w));
  const Y = r * (Math.sin(u) * Math.cos(w) * Math.cos(gamma) + Math.cos(u) * Math.sin(w));
  const Z = r * Math.sin(u) * Math.sin(gamma);
  // Saturn equator → B1950 ecliptic
  const yb = c1 * Y - s1 * Z, zb = s1 * Y + c1 * Z;
  const xe = Math.cos(nodeEq) * X - Math.sin(nodeEq) * yb, ye = Math.sin(nodeEq) * X + Math.cos(nodeEq) * yb;
  // B1950 → J2000 ecliptic: 50 years of general precession along the ecliptic
  const pr = 0.69859 * d, k = BODY.titan.orbitKm / 20.216193 / AU_KM;
  return [k * (Math.cos(pr) * xe - Math.sin(pr) * ye), k * (Math.sin(pr) * xe + Math.cos(pr) * ye), k * zb];
}

const MOON_THEORY = { moon: moonGeoAU, europa: europaAU, titan: titanAU };

// Heliocentric ecliptic (J2000) position [x, y, z] in AU at real-world time t (ms):
// where the body actually is right now, including its height above the ecliptic plane.
export function helioAU(b, t) {
  if (b.kind === 'star') return [0, 0, 0];
  const T = centuries(t);
  if (b.parent) {
    const p = helioAU(BODY[b.parent], t), q = MOON_THEORY[b.id](T);
    return [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
  }
  let p = keplerAU(b.el, T);
  if (PERTURB[b.id]) p = perturb(p, PERTURB[b.id], T);
  if (b.emb) {
    // the elements track the Earth-Moon barycentre; step the Earth back from the Moon
    const m = moonGeoAU(T);
    return [p[0] - m[0] * MOON_EMB_FRAC, p[1] - m[1] * MOON_EMB_FRAC, p[2] - m[2] * MOON_EMB_FRAC];
  }
  return p;
}

// Current tilt of a body's orbit plane to the ecliptic (deg), from its real motion around its
// parent (the Moon ~5°, Titan rides Saturn's ~28° equator).
export function orbitTilt(id, t) {
  const b = BODY[id];
  if (b.kind === 'star') return 0;
  const rel = (tt) => {
    const q = helioAU(b, tt);
    if (!b.parent) return q;
    const p = helioAU(BODY[b.parent], tt);
    return [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  };
  const dt = Math.min(b.period, 30) * 864e5 / 200, r = rel(t), r2 = rel(t + dt);
  const h = [r[1] * r2[2] - r[2] * r2[1], r[2] * r2[0] - r[0] * r2[2], r[0] * r2[1] - r[1] * r2[0]];
  return Math.acos(Math.min(1, Math.abs(h[2]) / Math.hypot(...h))) / D2R;
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
