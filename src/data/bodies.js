// Real orbital data (J2000 mean elements) so planet positions — and therefore travel
// distances — match the actual solar system at the current real-world time.
export const AU_KM = 149597870.7;
export const C_KMS = 299792.458;
export const J2000 = Date.UTC(2000, 0, 1, 12);

// look.type: 0 rocky, 1 earth, 2 banded/cloudy, 3 icy, 4 star
// drones: robot-swarm output per level, tonnes per minute
// i / node: orbital inclination and longitude of ascending node (deg, ecliptic J2000).
// Moons use their orbit plane relative to the ecliptic (Titan rides Saturn's 27° tilt).
// mapOrbit: display radius of a moon around its parent on the strategic map
export const BODIES = [
  {
    id: 'sun', name: 'Sun', kind: 'star', radiusKm: 695700, mapSize: 4.2, orbitAU: 0.08,
    look: { type: 4, a: 0xffc46b, b: 0xff5a1f, c: 0xfff2c0 },
    base: 'Helios Forge', drones: {},
    desc: 'G-type star, 99.86% of the system\'s mass. A station at 0.08 AU (inside Mercury\'s orbit, like Parker Solar Probe) bathes in ~150x Earth sunlight. Light from here reaches Earth in 8.3 minutes.',
  },
  {
    id: 'mercury', name: 'Mercury', kind: 'planet', i: 7.005, node: 48.331, a: 0.387098, e: 0.20563, varpi: 77.4577, L0: 252.2503, period: 87.9691,
    radiusKm: 2439.7, mapSize: 0.45, look: { type: 0, a: 0x6b6460, b: 0x9d958c, c: 0x3b3633 },
    base: 'Caloris Forge', drones: { ore: 7, exotics: 0.04 },
    desc: 'Iron-heavy world with a core 85% of its radius. Ideal metal mine — if your shielding can take 430°C days.',
  },
  {
    id: 'venus', name: 'Venus', kind: 'planet', i: 3.3947, node: 76.680, a: 0.723332, e: 0.006772, varpi: 131.6025, L0: 181.9791, period: 224.701,
    radiusKm: 6051.8, mapSize: 0.8, look: { type: 2, a: 0xe8c98a, b: 0xc9a05a, c: 0xf6e7c0 }, atmo: 0xffd27a,
    base: 'Aphrodite Cloudport', drones: { silicon: 3, ore: 1 },
    desc: 'At 50 km altitude the clouds are near 1 bar and 30°C — the most Earth-like place off Earth. Floating cloud cities harvest CO₂ and sulfur.',
  },
  {
    id: 'earth', name: 'Earth', kind: 'planet', i: 0.00005, node: -11.26, a: 1.000003, e: 0.016709, varpi: 102.9373, L0: 100.4645, period: 365.256,
    radiusKm: 6371, mapSize: 0.85, look: { type: 1, a: 0x3a7bd5, b: 0x2d5a27, c: 0xffffff }, atmo: 0x4fa8ff,
    base: 'Halo Station', drones: { ore: 4, silicon: 1.5 },
    desc: 'Home. Low Earth orbit is littered with ~10,000 t of dead satellites and rocket stages — your first salvage field. Everything else must be launched up the gravity well at great cost.',
  },
  {
    id: 'moon', name: 'Moon', kind: 'moon', i: 5.145, node: 125.08, nodeRate: -19.341, parent: 'earth', orbitKm: 384400, period: 27.3217, L0: 218.316, mapOrbit: 1.6,
    radiusKm: 1737.4, mapSize: 0.3, look: { type: 0, a: 0x8a8a8a, b: 0xb8b5b0, c: 0x4a4a4a },
    base: 'Tycho Yards', drones: { ore: 3, silicon: 4, ice: 0.8, he3: 0.12 },
    desc: 'Regolith rich in silicon and oxygen, ice in permanently shadowed polar craters, and solar-wind-implanted Helium-3 — fusion fuel.',
  },
  {
    id: 'mars', name: 'Mars', kind: 'planet', i: 1.850, node: 49.558, a: 1.52371, e: 0.093394, varpi: 336.0408, L0: 355.4533, period: 686.98,
    radiusKm: 3389.5, mapSize: 0.6, look: { type: 0, a: 0xb5532a, b: 0xd88a4f, c: 0x6e2a14 }, atmo: 0xff8a5c,
    base: 'Red Spire', drones: { ore: 5, ice: 2, silicon: 2 },
    desc: 'Subsurface water ice, iron-oxide soil and 38% Earth gravity. Light-lag to Earth: 3 to 22 minutes.',
  },
  {
    id: 'ceres', name: 'Ceres', kind: 'dwarf', i: 10.594, node: 80.305, a: 2.7675, e: 0.0758, varpi: 153.9, L0: 95.0, period: 1680.5,
    radiusKm: 473, mapSize: 0.32, look: { type: 0, a: 0x6f6a64, b: 0x9a948c, c: 0x3c3a37 },
    base: 'Ceres Freeport', drones: { ore: 6, ice: 4, exotics: 0.08 },
    desc: 'Largest body in the Asteroid Belt — up to 25% water by mass. Neutral ground for belt miners and sky pirates alike.',
  },
  {
    id: 'jupiter', name: 'Jupiter', kind: 'planet', i: 1.303, node: 100.464, a: 5.202887, e: 0.048386, varpi: 14.7284, L0: 34.3964, period: 4332.59,
    radiusKm: 69911, mapSize: 1.9, look: { type: 2, a: 0xd9b48a, b: 0x8a5a3c, c: 0xf2e6d4 }, atmo: 0xe8c9a0,
    base: 'Jove Skimmer', drones: { he3: 0.4 },
    desc: 'Gas giant 318x Earth\'s mass. Atmospheric scoop-drones skim Helium-3 from the upper clouds. Radiation belts are lethal.',
  },
  {
    id: 'europa', name: 'Europa', kind: 'moon', i: 2.2, node: 100.5, parent: 'jupiter', orbitKm: 671100, period: 3.5512, L0: 0, mapOrbit: 2.8,
    radiusKm: 1560.8, mapSize: 0.26, look: { type: 3, a: 0xe0d8c8, b: 0x9b5b3a, c: 0xf8f4ee },
    base: 'Europa Deep', drones: { ice: 8, he3: 0.08 },
    desc: 'A 20 km ice shell over a global salt-water ocean holding twice Earth\'s seawater.',
  },
  {
    id: 'saturn', name: 'Saturn', kind: 'planet', i: 2.485, node: 113.665, a: 9.536676, e: 0.053862, varpi: 92.5989, L0: 49.9542, period: 10759.22,
    radiusKm: 58232, mapSize: 1.6, rings: true, look: { type: 2, a: 0xe8d4a4, b: 0xb89a64, c: 0xf6ecd4 }, atmo: 0xf0dcae,
    base: 'Ringside', drones: { he3: 0.5, ice: 3 },
    desc: 'Rings of 99.9% pure water ice and a hydrogen-helium atmosphere. Less dense than water.',
  },
  {
    id: 'titan', name: 'Titan', kind: 'moon', i: 27.1, node: 169.5, parent: 'saturn', orbitKm: 1221870, period: 15.945, L0: 120, mapOrbit: 4.6,
    radiusKm: 2574.7, mapSize: 0.3, look: { type: 2, a: 0xd99a3c, b: 0xa86a24, c: 0xe8b860 }, atmo: 0xffa040,
    base: 'Titan Haze', drones: { ice: 4, he3: 0.2 },
    desc: 'Thick nitrogen sky (1.5 bar) and lakes of liquid methane. You could fly here with strap-on wings.',
  },
  {
    id: 'uranus', name: 'Uranus', kind: 'planet', i: 0.773, node: 74.006, a: 19.189165, e: 0.047257, varpi: 170.9542, L0: 313.2381, period: 30688.5,
    radiusKm: 25362, mapSize: 1.15, look: { type: 2, a: 0x9fe3e8, b: 0x86ccd6, c: 0xc8f4f6 }, atmo: 0x9fe8ff,
    base: 'Ice Crown', drones: { he3: 0.6, ice: 2 },
    desc: 'An ice giant tipped on its side (98° axial tilt). Sunlight here is 1/370th of Earth\'s — solar power fails.',
  },
  {
    id: 'neptune', name: 'Neptune', kind: 'planet', i: 1.770, node: 131.784, a: 30.069923, e: 0.00859, varpi: 44.9648, L0: 304.88, period: 60182,
    radiusKm: 24622, mapSize: 1.12, look: { type: 2, a: 0x3f63d8, b: 0x2a44a8, c: 0x8aa8ff }, atmo: 0x5a8cff,
    base: 'Trident Relay', drones: { he3: 0.8, exotics: 0.1 },
    desc: 'Supersonic 2,100 km/h winds. Light takes over 4 hours to arrive from here.',
  },
  {
    id: 'pluto', name: 'Pluto', kind: 'dwarf', i: 17.14, node: 110.299, a: 39.482, e: 0.2488, varpi: 224.07, L0: 238.93, period: 90560,
    radiusKm: 1188, mapSize: 0.28, look: { type: 3, a: 0xcbb59a, b: 0x8a5a40, c: 0xf2e8da },
    base: 'Last Light', drones: { ice: 5, exotics: 0.25 },
    desc: 'Nitrogen glaciers and water-ice mountains in the Kuiper Belt. The frontier.',
  },
];

// What you can physically collect in orbit at each world (third-person salvage/mining).
// kind: junk = dead satellites & rocket stages, rocks = asteroids/ejecta, ice = icy
// ring particles and moonlets, canister = payloads lofted by surface mass drivers.
export const FIELDS = {
  sun: { kind: 'none', name: 'Corona · no solid matter survives here', res: {} },
  mercury: { kind: 'rocks', name: 'Impact ejecta', res: { ore: 4, metal: 1, exotics: 0.05 } },
  venus: { kind: 'canister', name: 'Cloud-harvest lift canisters', res: { silicon: 3, ore: 1 } },
  earth: { kind: 'junk', name: 'LEO debris belt · dead satellites & spent stages', res: { metal: 3, silicon: 2, ore: 0.6 } },
  moon: { kind: 'canister', name: 'Mass-driver catch zone', res: { ore: 3, silicon: 3, ice: 0.6, he3: 0.25 } },
  mars: { kind: 'rocks', name: 'Phobos debris arc', res: { ore: 4, silicon: 2, ice: 1 } },
  ceres: { kind: 'rocks', name: 'Main-belt asteroids', res: { ore: 4, metal: 2, ice: 2, exotics: 0.15 } },
  jupiter: { kind: 'rocks', name: 'Ring dust & inner moonlets', res: { ore: 2, ice: 1 } },
  europa: { kind: 'ice', name: 'Cryovolcanic plume ice', res: { ice: 5, he3: 0.1 } },
  saturn: { kind: 'ice', name: 'Ring particles · 99.9% water ice', res: { ice: 6, ore: 0.3 } },
  titan: { kind: 'ice', name: 'Hyperion-family ice', res: { ice: 4, he3: 0.15 } },
  uranus: { kind: 'ice', name: 'Ice-giant moonlets', res: { ice: 4, exotics: 0.08 } },
  neptune: { kind: 'ice', name: 'Triton ejecta', res: { ice: 3, exotics: 0.15, he3: 0.1 } },
  pluto: { kind: 'ice', name: 'Kuiper belt objects', res: { ice: 4, exotics: 0.25 } },
};

// Deep-space regions crossed in transit (heliocentric distance, AU). density = objects in the
// local field; 0 means empty space with only rare drifting contacts.
export const ZONES = [
  { id: 'nea', from: 0.9, to: 1.7, kind: 'rocks', name: 'Near-Earth asteroid lanes', res: { ore: 4, metal: 1.5, ice: 0.5 }, density: 0 },
  { id: 'belt', from: 2.1, to: 3.3, kind: 'rocks', name: 'Main Asteroid Belt', res: { ore: 4, metal: 2, ice: 2, exotics: 0.12 }, density: 26 },
  { id: 'trojan', from: 4.9, to: 5.5, kind: 'rocks', name: 'Jupiter Trojan swarm', res: { ore: 3, ice: 2, exotics: 0.1 }, density: 10 },
  { id: 'kuiper', from: 30, to: 55, kind: 'ice', name: 'Kuiper Belt', res: { ice: 5, exotics: 0.3 }, density: 14 },
];
export const DEEP = { id: 'deep', kind: 'rocks', name: 'Interplanetary space', res: { ice: 2, ore: 2 }, density: 0 };
