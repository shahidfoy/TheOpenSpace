# The Open Space

A real-time space economy game for Telegram Mini Apps, built with Three.js. Planet and moon positions come from real ephemerides, so every distance and travel time matches the actual solar system right now. At light speed the Sun is 8.3 minutes away.

## Run

```bash
npm install
npm run dev          # http://localhost:5173  (add ?dev=1 for time-warp buttons in Settings)
npm run build        # static output in dist/
```

## 3D models (Blender)

Hero models (Kestrel skiff, Mule hauler, colony seed ship, utility drone, articulated loader mech, Eden ring core, and the LEO junk set) are built by a Blender Python script, so they can be tweaked and rebuilt. The seed ship, Eden station and most of the junk are procedural (lathed hulls, lattice trusses, ribbed modules, lit window bands). The Kestrel, the hauler, the drone and the dead satellite are CC BY models from Sketchfab (credits in `public/models/CREDITS.txt`) that the script imports from `../game-assets/ships/<name>/original.glb` (or `TOS_ASSETS`), rescales, fits with the game's anchors and re-exports with WebP textures; without those originals it falls back to the procedural versions. Exports are Draco-compressed (about 2 MB for the six ship/station files; decoder in `public/draco/`):

```bash
"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" --background --factory-startup --python blender/build_models.py -- public/models
```

Add a second path after `public/models` to also render preview PNGs, and model names after that to rebuild only those (e.g. `-- public/models previews mech`). Conventions: Blender forward is -Y, up is +Z; empties named `anchor_*` mark nose/exhaust points the game reads; the mech's parts (`pelvis`, `torso`, `head`, `arm_*`, `thigh_*`, `shin_*`, `foot_*`) have their origins on their joints, ready for animation. Every face gets box-projected UVs in metres, and materials are matched by name at runtime (`src/render/materials.js`) and swapped for a procedural PBR set: panel lines, rivets, vents, grime, worn paint chips, gold MLI foil, solar cells and lit windows, all generated at boot with no texture downloads. If a GLB fails to load, the game falls back to procedural meshes.

## Real sky data

The background sky is the real one: 25,723 stars to magnitude 7.5 (Hipparcos / Yale Bright Star catalogue) at their true positions and B-V colours, constellation figures and bright-star names, packed from [d3-celestial](https://github.com/ofrohn/d3-celestial) (BSD-3, licence in `public/sky/`). The Milky Way, Magellanic Clouds and Andromeda are drawn in true galactic coordinates. To regenerate:

```bash
npm pack d3-celestial && tar -xzf d3-celestial-*.tgz
node scripts/build-sky.mjs package/data
```

## Real planets

**Real-time ephemeris** (`src/sim/orbits.js`): planets and Pluto use JPL's Keplerian elements with secular rates (Standish, fit to DE405), plus Jupiter–Saturn perturbation terms fitted to VSOP87; Ceres uses current MPC osculating elements. The Moon comes from a truncated ELP-2000/82 lunar theory (Meeus ch. 47), Europa from the IMCCE L1.2 Galilean-satellite theory, and Titan from Meeus ch. 46 (Harper & Taylor). Checked against Astronomy Engine and PyEphem: planets within ~0.03° over 1990–2045 (Mercury, Venus and Earth within ~0.01°), the Moon within ~60 km, Europa within ~300 km, Titan within ~0.1 Saturn radii. Time is converted from UTC to Terrestrial Time (+69.2 s) for the theories.

Every world uses a real surface map (Solar System Scope CC BY 4.0 and NASA/USGS public-domain mosaics; credits in `public/planets/CREDITS.txt`). Earth has day, city lights, clouds and ocean glint. Each body is oriented with its IAU pole direction (including pole drift, the Moon's librations and Europa's and Neptune's periodic terms) and rotates to its true prime-meridian angle for the current moment (Earth via the Earth Rotation Angle, so the day/night line is within ~0.01° of reality), so the real hemisphere faces the Sun; Saturn's rings sit in its true equatorial plane (nearly edge-on in 2025-26). Station views fly a real-time orbit (Earth: ~105 min), and the Sun and parent worlds sit at their real directions and angular sizes. The map's TRUE SCALE switch shows real distances and real sizes together.

## Flying down to Earth

At Eden tap **DESCEND TO EARTH**: you enter the atmosphere 100 km above the station's real ground point and fly a spaceplane over the real planet. Terrain heights stream from AWS Terrain Tiles (Terrarium: SRTM/GMTED/ETOPO1) and imagery from Sentinel-2 cloudless 2016 by EOX (CC BY 4.0), as level-of-detail Web-Mercator tiles around a floating origin with the horizon curved in the shader. The Sun sits where it really is for that place and moment (night side shows city lights). Pick real **Destinations** (Singapore, Mount Fuji, Tokyo, Everest, Dubai, Paris, New York, Rio, Sydney…) and fly yourself or use **AUTOPILOT**: long legs climb into the hypersonic corridor (~7.6 km/s at 60–85 km) and glide down on approach, so Singapore → Mount Fuji takes ~25 minutes of real time. Climb above 80 km to return to orbit. Code: `src/render/earthView.js`.

**Earth, 2087** (`src/render/futureEarth.js`): on top of the real planet sits an imagined cyberpunk future. Real cities grow procedural neon megacities placed only on real land (glass megatowers up to 2.8 km, neon corner tubes and crowns, holographic billboards, sky-traffic lanes, glowing street grids and purple light pollution at night). A space elevator rises from the strait off Singapore (1.3° from the equator) to an equatorial orbital ring at 600 km that arcs across the sky. Day and night still follow the real Sun.

## Live weather

Earth's clouds are real: after boot the game downloads the latest global true-colour mosaics from NASA GIBS (VIIRS on Suomi-NPP and NOAA-20, no API key, CORS-enabled), lays today's passes over yesterday's full map with feathered seams, and extracts cloud cover by comparing against the cloud-free Earth map (so deserts and ice caps aren't read as cloud). Each region shows its latest satellite pass, typically under 24 hours old; it refreshes every 30 minutes and falls back to a static cloud map offline. The same map drives the globe in orbit/map views and, during Earth flight, a cloud deck at ~2.2 km where real cover is filled in with fractal detail. Code: `src/render/weather.js`.

## Live cyber threats (MAP → CYBER)

A real-time threat globe: ransomware incidents posted on leak sites in the last 72 h (ransomware.live; shown by victim country and sector only, no names), the IPs hitting the most SANS ISC/DShield sensors (by network country), abuse.ch Feodo botnet command servers, and CISA's newest known-exploited vulnerabilities. Tap a country for details; INCIDENT LOG shows top groups, targets and sectors. US incidents are split by state: ransomware posts by the state named in the post itself (state names, "City, ST", ZIP codes; otherwise "state unknown"), attack sources and botnet servers by IP location (ip-api.com). The globe also shows the real submarine cable network (TeleGeography Submarine Cable Map, CC BY-NC-SA 3.0; rebuilt with `node scripts/build-cables.mjs`). For ransomware groups with solid public attribution (sanctions, indictments, major research; table in `src/data/ransomwareGroups.js`), pulses travel from the origin country's main internet hub to each victim along the shortest path over those cables, with straight links standing in for land fibre between landing stations. It is a plausible physical path, not a traced one; other groups stay "origin unknown" and get no route. Nothing is simulated.

Browsers can't read most of these feeds (no CORS), so a **DigitalOcean Function** aggregates them: `functions/packages/threats/feed/index.js` (cached 10 min, ~20 KB JSON) is served at `/api/threats/feed` on the game's own domain. In dev, `vite.config.js` serves the same function locally. To deploy, add the `functions` component and `ingress` rules from `.do/app.yaml` to the app's spec (match the static site's component name in the `/` rule).

## Ship it as a Telegram Mini App

1. Host `dist/` on any HTTPS static host. This repo includes a DigitalOcean App Platform spec (`.do/app.yaml`): a static site that runs `npm run build`, serves `dist/`, and redeploys on every push to `main`.
2. In @BotFather: `/newbot`, then `/newapp` (or Bot Settings → Menu Button) and paste the HTTPS URL.
3. Saves go to `localStorage` and Telegram CloudStorage (chunked), so progress follows the player across devices.

## Controls

- **Pilot (third person):** left stick to fly, drag anywhere to steer, hold MINE on salvage or rock (the amber bracket marks your target), ▲ to rise, BOOST. Desktop: WASD, drag/arrows, R/F, Space, Shift.
- **Mech (on foot):** at a base on a solid world (Moon, Mars, Mercury, Ceres, Europa, Titan, Pluto) tap DEPLOY MECH. Stick to walk, drag to orbit the camera, ▲ jetpack, SPRINT, hold DRILL at glowing deposits, walk back onto the landing pad to unload. Gravity is each world's real value.
- **Map (top-down):** drag to pan, pinch/scroll to zoom, right-drag (or two-finger twist on touch) to rotate, two-finger drag up/down to tilt, tap a world to open it and teleport, launch or haul. SYSTEM shows real inclined orbits with drop lines to the ecliptic; DRIFT shows each planet's helix as the Sun moves 230 km/s around the galaxy (ecliptic tilted 60° to the galactic plane); GALAXY shows the Milky Way as mapped today (bar, Perseus / Scutum–Centaurus / Sagittarius–Carina / Norma arms, the Sun in the Orion Spur, Magellanic Clouds at real positions); COSMOS shows the observable universe on a log scale: Local Group, Virgo Cluster, Great Attractor, Shapley Supercluster, out to the cosmic microwave background.
- **Fleet autopilot:** in MAP, tap a world → AUTOPILOT FLEET, pick escorts (haulers add hold, a seed ship founds a base on arrival). The convoy flies a real intercept at the speed of its slowest hull. You ride along in third person: fly around the convoy and salvage what you cross (LEO junk leaving Earth, asteroids in the Belt, ice in the Kuiper Belt, rare drifting contacts in open space). Neural-uplink to a base any time and REJOIN FLEET later; the fleet keeps flying offline.
- **Orbital fields:** each world has a realistic collectable field: dead satellites and spent stages in LEO, mass-driver canisters at the Moon, Phobos debris at Mars, belt asteroids at Ceres, water-ice ring particles at Saturn, Kuiper objects at Pluto.

## Code map

| Path | What |
|---|---|
| `src/data/bodies.js` | Real orbital elements (with secular rates), sizes, per-world resources and lore |
| `src/data/economy.js` | Resources, buildings, drives, techs, ships, objectives (balance lives here) |
| `src/sim/orbits.js` | Real-time ephemeris (planets, Ceres, Moon, Europa, Titan), real distances, map projection |
| `src/sim/state.js` | Sim tick, power/production, trips, offline catch-up, saves |
| `src/render/*` | Planet/sky shaders, PBR material generator, GLB loading, station/voyage/surface/map views, lens post pass |
| `src/ui/*` | HUD panels, touch joystick, keyboard |
| `src/telegram.js` | Mini App SDK: expand, haptics, back button, CloudStorage |

## Drive ladder (constant cruise)

| Tier | Drive | km/s | Earth→Moon | Earth→Mars (avg) | Earth→Sun |
|---|---|---|---|---|---|
| 1 | Chemical | 15 | ~7 h | months | months |
| 2 | Plasma Ion | 200 | ~32 min | ~13 days | ~8.7 days |
| 3 | Fusion Torch | 3,000 | ~2 min | ~20 h | ~14 h |
| 4 | Antimatter | 30,000 (0.1c) | 20 s | ~2 h | ~83 min |
| 5 | Relativistic | 150,000 (0.5c) | 20 s | ~25 min | ~17 min |
| 6 | Lumen | 299,792 (c) | 20 s | ~13 min | 8.3 min |

## Roadmap

- **Phase 1 (done):** engine, real-time solar system, economy loop, piloting/mining, map, 14 worlds, Telegram integration.
- **Phase 2 (done):** Blender hero assets, PBR texture generator, pilotable mech, fleet autopilot with explore mode, realistic orbital fields, inclined orbits + galactic motion, UI overhaul.
- **Phase 2b:** audio, Blender station modules, per-world surface props.
- **Phase 3:** automated trade routes, outpost-to-outpost logistics, ship classes and refits, crew/robot upgrades.
- **Phase 4:** sky pirate factions, contracts and bounties, light combat and escorts (still exploration-first).
- **Phase 5:** multiplayer economy: shared market, player stations, leaderboards, Telegram Stars cosmetics.
