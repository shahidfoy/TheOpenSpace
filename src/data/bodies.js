// Real orbital data so planet and moon positions — and therefore travel distances — match
// the actual solar system at the current real-world time (see src/sim/orbits.js).
export const AU_KM = 149597870.7;
export const C_KMS = 299792.458;
export const J2000 = Date.UTC(2000, 0, 1, 12);

// look.type: 0 rocky, 1 earth, 2 banded/cloudy, 3 icy, 4 star
// drones: robot-swarm output per level, tonnes per minute
// el: heliocentric Keplerian elements, each [value at J2000, change per Julian century], in
//   AU / degrees on the J2000 ecliptic & equinox: a, e, i (inclination), L (mean longitude),
//   varpi (longitude of perihelion), node (longitude of ascending node). Planets and Pluto use
//   JPL's "Approximate Positions of the Planets" fit to DE405 (Standish, valid 1800–2050);
//   Earth's row is the Earth-Moon barycentre. Ceres uses MPC osculating elements.
// Moons are computed from dedicated satellite theories in orbits.js; orbitKm / period are
// their mean distance and sidereal period (used for display, e.g. drawing the orbit line).
// period: sidereal orbital period, days
// mapOrbit: display radius of a moon around its parent on the strategic map
export const BODIES = [
  {
    id: 'sun', name: 'Sun', kind: 'star', radiusKm: 695700, mapSize: 4.2, orbitAU: 0.08,
    look: { type: 4, a: 0xffc46b, b: 0xff5a1f, c: 0xfff2c0 },
    base: 'Helios Forge', drones: {},
    desc: 'G-type star, 99.86% of the system\'s mass. A station at 0.08 AU (inside Mercury\'s orbit, like Parker Solar Probe) bathes in ~150x Earth sunlight. Light from here reaches Earth in 8.3 minutes.',
  },
  {
    id: 'mercury', name: 'Mercury', kind: 'planet', period: 87.9691,
    el: { a: [0.38709927, 0.00000037], e: [0.20563593, 0.00001906], i: [7.00497902, -0.00594749], L: [252.25032350, 149472.67411175], varpi: [77.45779628, 0.16047689], node: [48.33076593, -0.12534081] },
    radiusKm: 2439.7, mapSize: 0.45, look: { type: 0, a: 0x6b6460, b: 0x9d958c, c: 0x3b3633 },
    base: 'Caloris Forge', drones: { ore: 7, exotics: 0.04 },
    desc: 'Iron-heavy world with a core 85% of its radius. Ideal metal mine — if your shielding can take 430°C days.',
  },
  {
    id: 'venus', name: 'Venus', kind: 'planet', period: 224.701,
    el: { a: [0.72333566, 0.00000390], e: [0.00677672, -0.00004107], i: [3.39467605, -0.00078890], L: [181.97909950, 58517.81538729], varpi: [131.60246718, 0.00268329], node: [76.67984255, -0.27769418] },
    radiusKm: 6051.8, mapSize: 0.8, look: { type: 2, a: 0xe8c98a, b: 0xc9a05a, c: 0xf6e7c0 }, atmo: 0xffd27a,
    base: 'Aphrodite Cloudport', drones: { silicon: 3, ore: 1 },
    desc: 'At 50 km altitude the clouds are near 1 bar and 30°C — the most Earth-like place off Earth. Floating cloud cities harvest CO₂ and sulfur.',
  },
  {
    id: 'earth', name: 'Earth', kind: 'planet', period: 365.256,
    el: { a: [1.00000261, 0.00000562], e: [0.01671123, -0.00004392], i: [-0.00001531, -0.01294668], L: [100.46457166, 35999.37244981], varpi: [102.93768193, 0.32327364], node: [0, 0] },
    emb: true,
    radiusKm: 6371, mapSize: 0.85, look: { type: 1, a: 0x3a7bd5, b: 0x2d5a27, c: 0xffffff }, atmo: 0x4fa8ff,
    base: 'Eden', drones: { ore: 4, silicon: 1.5 },
    desc: 'Home. Low Earth orbit is littered with ~10,000 t of dead satellites and rocket stages — your first salvage field. Everything else must be launched up the gravity well at great cost.',
  },
  {
    id: 'moon', name: 'Moon', kind: 'moon', parent: 'earth', orbitKm: 384400, period: 27.3217, mapOrbit: 1.6,
    radiusKm: 1737.4, mapSize: 0.3, look: { type: 0, a: 0x8a8a8a, b: 0xb8b5b0, c: 0x4a4a4a },
    base: 'Tycho Yards', drones: { ore: 3, silicon: 4, ice: 0.8, he3: 0.12 },
    desc: 'Regolith rich in silicon and oxygen, ice in permanently shadowed polar craters, and solar-wind-implanted Helium-3 — fusion fuel.',
  },
  {
    id: 'mars', name: 'Mars', kind: 'planet', period: 686.98,
    el: { a: [1.52371034, 0.00001847], e: [0.09339410, 0.00007882], i: [1.84969142, -0.00813131], L: [-4.55343205, 19140.30268499], varpi: [-23.94362959, 0.44441088], node: [49.55953891, -0.29257343] },
    radiusKm: 3389.5, mapSize: 0.6, look: { type: 0, a: 0xb5532a, b: 0xd88a4f, c: 0x6e2a14 }, atmo: 0xff8a5c,
    base: 'Red Spire', drones: { ore: 5, ice: 2, silicon: 2 },
    desc: 'Subsurface water ice, iron-oxide soil and 38% Earth gravity. Light-lag to Earth: 3 to 22 minutes.',
  },
  {
    id: 'ceres', name: 'Ceres', kind: 'dwarf', period: 1679.9,
    // MPC osculating elements, epoch JD 2461000.5 (2025-11-21): a 2.7656157, e 0.0795763,
    // i 10.58789, node 80.24963, arg. perihelion 73.29974, M 231.53975, n 0.21429712°/day.
    // Mean longitude is carried back to J2000 (9455.5 days earlier) at the mean motion.
    el: { a: [2.7656157, 0], e: [0.0795763, 0], i: [10.58789, 0], L: [80.24963 + 73.29974 + 231.53975 - 0.21429712 * 9455.5, 0.21429712 * 36525], varpi: [80.24963 + 73.29974, 0], node: [80.24963, 0] },
    radiusKm: 473, mapSize: 0.32, look: { type: 0, a: 0x6f6a64, b: 0x9a948c, c: 0x3c3a37 },
    base: 'Ceres Freeport', drones: { ore: 6, ice: 4, exotics: 0.08 },
    desc: 'Largest body in the Asteroid Belt — up to 25% water by mass. Neutral ground for belt miners and sky pirates alike.',
  },
  {
    id: 'jupiter', name: 'Jupiter', kind: 'planet', period: 4332.59,
    el: { a: [5.20288700, -0.00011607], e: [0.04838624, -0.00013253], i: [1.30439695, -0.00183714], L: [34.39644051, 3034.74612775], varpi: [14.72847983, 0.21252668], node: [100.47390909, 0.20469106] },
    radiusKm: 69911, mapSize: 1.9, look: { type: 2, a: 0xd9b48a, b: 0x8a5a3c, c: 0xf2e6d4 }, atmo: 0xe8c9a0,
    base: 'Jove Skimmer', drones: { he3: 0.4 },
    desc: 'Gas giant 318x Earth\'s mass. Atmospheric scoop-drones skim Helium-3 from the upper clouds. Radiation belts are lethal.',
  },
  {
    id: 'europa', name: 'Europa', kind: 'moon', parent: 'jupiter', orbitKm: 671100, period: 3.5512, mapOrbit: 2.8,
    radiusKm: 1560.8, mapSize: 0.26, look: { type: 3, a: 0xe0d8c8, b: 0x9b5b3a, c: 0xf8f4ee },
    base: 'Europa Deep', drones: { ice: 8, he3: 0.08 },
    desc: 'A 20 km ice shell over a global salt-water ocean holding twice Earth\'s seawater.',
  },
  {
    id: 'saturn', name: 'Saturn', kind: 'planet', period: 10759.22,
    el: { a: [9.53667594, -0.00125060], e: [0.05386179, -0.00050991], i: [2.48599187, 0.00193609], L: [49.95424423, 1222.49362201], varpi: [92.59887831, -0.41897216], node: [113.66242448, -0.28867794] },
    radiusKm: 58232, mapSize: 1.6, rings: true, look: { type: 2, a: 0xe8d4a4, b: 0xb89a64, c: 0xf6ecd4 }, atmo: 0xf0dcae,
    base: 'Ringside', drones: { he3: 0.5, ice: 3 },
    desc: 'Rings of 99.9% pure water ice and a hydrogen-helium atmosphere. Less dense than water.',
  },
  {
    id: 'titan', name: 'Titan', kind: 'moon', parent: 'saturn', orbitKm: 1221870, period: 15.945, mapOrbit: 4.6,
    radiusKm: 2574.7, mapSize: 0.3, look: { type: 2, a: 0xd99a3c, b: 0xa86a24, c: 0xe8b860 }, atmo: 0xffa040,
    base: 'Titan Haze', drones: { ice: 4, he3: 0.2 },
    desc: 'Thick nitrogen sky (1.5 bar) and lakes of liquid methane. You could fly here with strap-on wings.',
  },
  {
    id: 'uranus', name: 'Uranus', kind: 'planet', period: 30688.5,
    el: { a: [19.18916464, -0.00196176], e: [0.04725744, -0.00004397], i: [0.77263783, -0.00242939], L: [313.23810451, 428.48202785], varpi: [170.95427630, 0.40805281], node: [74.01692503, 0.04240589] },
    radiusKm: 25362, mapSize: 1.15, look: { type: 2, a: 0x9fe3e8, b: 0x86ccd6, c: 0xc8f4f6 }, atmo: 0x9fe8ff,
    base: 'Ice Crown', drones: { he3: 0.6, ice: 2 },
    desc: 'An ice giant tipped on its side (98° axial tilt). Sunlight here is 1/370th of Earth\'s — solar power fails.',
  },
  {
    id: 'neptune', name: 'Neptune', kind: 'planet', period: 60182,
    el: { a: [30.06992276, 0.00026291], e: [0.00859048, 0.00005105], i: [1.77004347, 0.00035372], L: [-55.12002969, 218.45945325], varpi: [44.96476227, -0.32241464], node: [131.78422574, -0.00508664] },
    radiusKm: 24622, mapSize: 1.12, look: { type: 2, a: 0x3f63d8, b: 0x2a44a8, c: 0x8aa8ff }, atmo: 0x5a8cff,
    base: 'Trident Relay', drones: { he3: 0.8, exotics: 0.1 },
    desc: 'Supersonic 2,100 km/h winds. Light takes over 4 hours to arrive from here.',
  },
  {
    id: 'pluto', name: 'Pluto', kind: 'dwarf', period: 90560,
    el: { a: [39.48211675, -0.00031596], e: [0.24882730, 0.00005170], i: [17.14001206, 0.00004818], L: [238.92903833, 145.20780515], varpi: [224.06891629, -0.04062942], node: [110.30393684, -0.01183482] },
    radiusKm: 1188, mapSize: 0.28, look: { type: 3, a: 0xcbb59a, b: 0x8a5a40, c: 0xf2e8da },
    base: 'Last Light', drones: { ice: 5, exotics: 0.25 },
    desc: 'Nitrogen glaciers and water-ice mountains in the Kuiper Belt. The frontier.',
  },
];

// What you can physically collect in orbit at each world (third-person salvage/mining).
// kind: junk = dead satellites & rocket stages, rocks = asteroids/ejecta, ice = icy ring particles
// and moonlets. Only Earth orbit holds human-made objects: everywhere else it is natural matter
// (impact ejecta, asteroids, ice). item = what the targeting bracket calls one piece of it.
export const FIELDS = {
  sun: { kind: 'none', name: 'Corona · no solid matter survives here', res: {} },
  mercury: { kind: 'rocks', name: 'Impact ejecta', item: 'IMPACT EJECTA', res: { ore: 4, metal: 1, exotics: 0.05 } },
  // Venus has no moons or rings; its only companions are co-orbital asteroids like Zoozve (2002 VE68)
  venus: { kind: 'rocks', name: 'Co-orbital asteroids · Zoozve family', item: 'CO-ORBITAL ASTEROID', res: { silicon: 3, ore: 2, metal: 0.5 } },
  earth: { kind: 'junk', name: 'LEO debris belt · dead satellites & spent stages', item: 'DERELICT HARDWARE', res: { metal: 3, silicon: 2, ore: 0.6 } },
  // rock blasted off the Moon by impacts: anorthosite highland crust and regolith breccia, solar-wind He-3 in the fines
  moon: { kind: 'rocks', name: 'Lunar impact ejecta · anorthosite & regolith breccia', item: 'LUNAR EJECTA', res: { ore: 3, silicon: 3, ice: 0.3, he3: 0.25 } },
  mars: { kind: 'rocks', name: 'Phobos debris arc', item: 'PHOBOS FRAGMENT', res: { ore: 4, silicon: 2, ice: 1 } },
  ceres: { kind: 'rocks', name: 'Main-belt asteroids', item: 'ASTEROID', res: { ore: 4, metal: 2, ice: 2, exotics: 0.15 } },
  jupiter: { kind: 'rocks', name: 'Ring dust & inner moonlets', item: 'RING MOONLET', res: { ore: 2, ice: 1 } },
  europa: { kind: 'ice', name: 'Cryovolcanic plume ice', item: 'PLUME ICE', res: { ice: 5, he3: 0.1 } },
  saturn: { kind: 'ice', name: 'Ring particles · 99.9% water ice', item: 'RING PARTICLE', res: { ice: 6, ore: 0.3 } },
  titan: { kind: 'ice', name: 'Hyperion-family ice', item: 'ICY MOONLET', res: { ice: 4, he3: 0.15 } },
  uranus: { kind: 'ice', name: 'Ice-giant moonlets', item: 'ICY MOONLET', res: { ice: 4, exotics: 0.08 } },
  neptune: { kind: 'ice', name: 'Triton ejecta', item: 'TRITON EJECTA', res: { ice: 3, exotics: 0.15, he3: 0.1 } },
  pluto: { kind: 'ice', name: 'Kuiper belt objects', item: 'KUIPER OBJECT', res: { ice: 4, exotics: 0.25 } },
};

// Where a cruising fleet really passes through enough matter to collect anything: only close to
// a few worlds. reach = distance from the body's centre (km). Nothing natural near the Moon or
// Venus is dense enough to collect at cruise, so flying past them is empty space.
export const TRANSIT_FIELDS = {
  earth: { reach: 42000, name: 'Earth orbital debris · LEO to the GEO graveyard' }, // ~10,000 t of junk
  saturn: { reach: 140000, name: 'Saturn\'s rings · 99.9% water ice' }, // out to the F ring
};

// Regions crossed in transit (heliocentric distance, AU). Even the "belts" are almost empty: the
// fleet sees nothing but stars, the Sun and the worlds it's flying between.
export const ZONES = [
  { id: 'nea', from: 0.9, to: 1.7, name: 'Near-Earth asteroid region', note: 'nearest known asteroid typically tens of millions of km away' },
  { id: 'belt', from: 2.1, to: 3.3, name: 'Main Asteroid Belt', note: 'asteroids average ~1 million km apart · nothing in sight' },
  { id: 'trojan', from: 4.9, to: 5.5, name: 'Jupiter Trojan region', note: 'swarm members millions of km apart' },
  { id: 'kuiper', from: 30, to: 55, name: 'Kuiper Belt', note: 'icy bodies tens of millions of km apart · sunlight ~1/1000 of Earth\'s' },
];
export const DEEP = { id: 'deep', name: 'Interplanetary space', note: 'solar wind ~5 protons per cm³ · nearest object millions of km away' };
