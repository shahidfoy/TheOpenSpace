import { C_KMS } from './bodies.js';

// value = Earth market sell price per tonne (credits)
export const RES = {
  ore: { name: 'Ore', short: 'ORE', color: '#c08a5a', value: 4 },
  metal: { name: 'Metal', short: 'MTL', color: '#a9bdd6', value: 22 },
  silicon: { name: 'Silicon', short: 'SIL', color: '#5cf2c0', value: 30 },
  ice: { name: 'Water Ice', short: 'H₂O', color: '#6fd3ff', value: 26 },
  he3: { name: 'Helium-3', short: 'He³', color: '#ff8bf0', value: 420 },
  exotics: { name: 'Exotics', short: 'EXO', color: '#ffd166', value: 950 },
  antimatter: { name: 'Antimatter', short: 'AM', color: '#ff3b6b', value: 6000 },
};
export const RES_KEYS = Object.keys(RES);

// Earth can only sell what it can mine and launch: bulk metal, silicon, water.
export const MARKET = { buy: { metal: 55, silicon: 75, ice: 60 } };

// Constant-cruise approximations of real & speculative propulsion.
export const DRIVES = [
  { tier: 1, name: 'Chemical Rocket', kms: 15 },
  { tier: 2, name: 'Plasma Ion Drive', kms: 200 },
  { tier: 3, name: 'Fusion Torch', kms: 3000 },
  { tier: 4, name: 'Antimatter Pion Drive', kms: 30000 },
  { tier: 5, name: 'Relativistic Ramjet', kms: 150000 },
  { tier: 6, name: 'Lumen Drive', kms: C_KMS },
];

// power: + generates MW, - consumes MW (per level). Cost grows 1.6x per level.
export const BUILDINGS = {
  solar: { name: 'Solar Array', tag: 'PWR', power: 8, cost: { metal: 12, silicon: 18 },
    desc: '8 MW at Earth distance. Output falls with the square of distance from the Sun.' },
  drones: { name: 'Robot Drone Swarm', tag: 'BOT', power: -3, cost: { metal: 25, silicon: 10, credits: 250 }, notAt: ['sun'],
    desc: 'Autonomous mining robots that strip local resources around the clock — even while you are offline.' },
  refinery: { name: 'Ore Refinery', tag: 'REF', power: -4, cost: { metal: 35, silicon: 12, credits: 400 }, notAt: ['sun'],
    desc: 'Smelts 6 ore/min into 3 metal/min.' },
  lab: { name: 'Research Lab', tag: 'LAB', power: -4, cost: { metal: 30, silicon: 35, credits: 500 },
    desc: 'Generates 5 research data (◆) per minute.' },
  depot: { name: 'Cargo Depot', tag: 'DEP', power: 0, cost: { metal: 30, credits: 200 },
    desc: '+600 t storage for every resource.' },
  shipyard: { name: 'Orbital Shipyard', tag: 'YRD', power: -6, cost: { metal: 100, silicon: 40, credits: 1200 }, only: ['earth'], max: 1,
    desc: 'Builds haulers and seed ships. Includes the mech assembly gantry.' },
  reactor: { name: 'Fusion Reactor', tag: 'FUS', power: 40, tech: 'fusion', cost: { metal: 150, silicon: 60, credits: 3000 },
    desc: '40 MW anywhere, burning 0.2 He-3/min. Essential past Mars where sunlight is weak.' },
  forge: { name: 'Antimatter Forge', tag: 'AMF', power: -30, tech: 'antimatter', only: ['sun'], cost: { metal: 600, silicon: 300, exotics: 20, credits: 20000 },
    desc: 'Converts raw solar flux into antiprotons: 0.06 t/min. Needs the Sun\'s enormous power.' },
};

export const TECHS = {
  automation: { name: 'Swarm Automation', rp: 40, cost: { silicon: 30 },
    desc: 'Drone swarms mine 50% faster.' },
  ion: { name: 'Plasma Ion Drive', rp: 90, cost: { metal: 60, silicon: 40 }, drive: 2,
    desc: 'VASIMR-style plasma propulsion, 200 km/s. The Moon in about 32 minutes.' },
  refining: { name: 'Zero-G Smelting', rp: 200, cost: { metal: 100 }, req: ['automation'],
    desc: 'Refineries process twice as much ore.' },
  fusion: { name: 'Fusion Torch', rp: 700, cost: { metal: 300, he3: 10 }, req: ['ion'], drive: 3,
    desc: 'D–He3 fusion at 1% light speed. Unlocks Fusion Reactors.' },
  deepcore: { name: 'Deep-Core Mining', rp: 1800, cost: { metal: 500, ice: 150 }, req: ['fusion', 'automation'],
    desc: 'Drone swarms mine twice as fast again.' },
  antimatter: { name: 'Antimatter Containment', rp: 6000, cost: { he3: 80, exotics: 20 }, req: ['fusion'], drive: 4,
    desc: 'Penning-trap pion drive at 10% c. Unlocks the Antimatter Forge (Sun only).' },
  relativistic: { name: 'Relativistic Ramjet', rp: 16000, cost: { antimatter: 10, exotics: 100 }, req: ['antimatter'], drive: 5,
    desc: 'Magnetic scoop with antimatter catalysis. 50% light speed.' },
  lumen: { name: 'Lumen Drive', rp: 40000, cost: { antimatter: 60, exotics: 250, he3: 400 }, req: ['relativistic'], drive: 6, win: true,
    desc: 'Speculative spacetime-metric drive. Light speed: the Sun in 8.3 minutes, Neptune in ~4 hours.' },
};

// Your own ship. The fleet always cruises at the pace of its slowest hull.
export const SKIFF = { name: 'Kestrel Skiff', cargo: 30, speed: 1 };

export const SHIPS = {
  hauler: { name: 'Mule Hauler', cargo: 150, speed: 0.8, cost: { metal: 80, silicon: 25, credits: 900 },
    desc: 'Container hauler. Sent alone it fetches the most valuable 150 t from an outpost and returns to Halo Station; in your fleet it adds 150 t of hold. Cruises at 80% of drive speed.' },
  seed: { name: 'Seed Ship', speed: 0.6, cost: { metal: 150, silicon: 80, ice: 30, credits: 2000 },
    desc: 'One-way colony lander. On arrival it unfolds into an outpost with solar power and a drone swarm. Heavy: cruises at 60% of drive speed.' },
};

const any = (s, k) => Object.values(s.bases).some((b) => (b.buildings[k] || 0) > 0);
export const GOALS = [
  { title: 'First Salvage', text: 'In PILOT, fly into the LEO debris belt and hold MINE on a dead satellite or spent rocket stage. Bring 20 t of salvage back to Halo Station.', check: (s) => s.stats.mined >= 20, reward: 600 },
  { title: 'Robot Workforce', text: 'Open BASE and build a Robot Drone Swarm.', check: (s) => (s.bases.earth.buildings.drones || 0) >= 1, reward: 600 },
  { title: 'Science', text: 'Build a Research Lab to generate research data.', check: (s) => any(s, 'lab'), reward: 800 },
  { title: 'Plasma Age', text: 'Research the Plasma Ion Drive in TECH.', check: (s) => !!s.techs.ion, reward: 1500 },
  { title: 'The Yards', text: 'Build an Orbital Shipyard at Halo Station.', check: (s) => any(s, 'shipyard'), reward: 1000 },
  { title: 'Moonshot', text: 'Build a Seed Ship in FLEET and launch it to the Moon.', check: (s) => !!s.bases.moon || s.trips.some((t) => t.type === 'found' && t.to === 'moon'), reward: 1000 },
  { title: 'Tycho Yards', text: 'Your Seed Ship travels in real time. When it lands, teleport there from the MAP.', check: (s) => !!s.bases.moon, reward: 3000 },
  { title: 'Moonwalker', text: 'At Tycho Yards, tap DEPLOY MECH. Walk the regolith in 1/6 g, drill glowing deposits and bring 20 t back to the landing pad.', check: (s) => (s.stats.surface || 0) >= 20, reward: 2500 },
  { title: 'Supply Line', text: 'Build a Hauler and send it to collect cargo from the Moon.', check: (s) => s.stats.hauled > 0, reward: 2000 },
  { title: 'Flight Plan', text: 'Open MAP, pick a world and tap AUTOPILOT FLEET. Ride along in third person: fly around your convoy and salvage whatever drifts past on the way.', check: (s) => (s.stats.voyages || 0) >= 1, reward: 3000 },
  { title: 'Star Fire', text: 'Research the Fusion Torch. It needs Helium-3, mined on the Moon.', check: (s) => !!s.techs.fusion, reward: 5000 },
  { title: 'Red Spire', text: 'Establish a base on Mars.', check: (s) => !!s.bases.mars, reward: 8000 },
  { title: 'Freeport', text: 'Establish Ceres Freeport in the Asteroid Belt.', check: (s) => !!s.bases.ceres, reward: 12000 },
  { title: 'Mirror Matter', text: 'Research Antimatter Containment.', check: (s) => !!s.techs.antimatter, reward: 20000 },
  { title: 'Helios', text: 'Found Helios Forge in close Sun orbit and build an Antimatter Forge.', check: (s) => (s.bases.sun?.buildings.forge || 0) > 0, reward: 30000 },
  { title: 'The Edge', text: 'Establish Trident Relay at Neptune.', check: (s) => !!s.bases.neptune, reward: 50000 },
  { title: 'Lumen', text: 'Research the Lumen Drive and reach the speed of light.', check: (s) => !!s.techs.lumen, reward: 0 },
];
