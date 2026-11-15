# Third-party assets and data

The game's **source code** is MIT licensed (see [LICENSE](LICENSE)). The assets below are **not** covered by
the MIT License: each keeps the licence of its creator. If you reuse or redistribute one, follow its licence
(most need attribution, and one data set is non-commercial).

Full per-file credits live next to the files:

| Folder | What | Licence | Credits |
|---|---|---|---|
| `public/models/` | Player mechs, enemy mech, ships, drone, satellite | CC BY 4.0 (Sketchfab creators); others procedural (MIT, built by `blender/`) | [CREDITS.txt](public/models/CREDITS.txt) |
| `public/characters/*.vrm` | Playable VRoid characters and outfits | VRoid Hub terms set by each author: modification, redistribution and commercial use allowed | [CREDITS.txt](public/characters/CREDITS.txt) |
| `public/characters/anims/` | Character animation clips, baked into game-only `.bin` packs | Mixamo (Adobe) and the katana pack's terms (see note below) | [CREDITS.txt](public/characters/CREDITS.txt) |
| `public/planets/` | Planet and moon surface maps | CC BY 4.0 (Solar System Scope) and NASA / USGS public domain | [CREDITS.txt](public/planets/CREDITS.txt) |
| `public/sky/` | Star catalogue, constellation lines and names | BSD-3-Clause (d3-celestial, Olaf Frohn) | [LICENSE-d3-celestial.txt](public/sky/LICENSE-d3-celestial.txt) |
| `public/data/cables.json` | Submarine cable routes | **CC BY-NC-SA 3.0** (TeleGeography): non-commercial, share-alike | [planets/CREDITS.txt](public/planets/CREDITS.txt) |
| `public/draco/` | Draco mesh decoder | Apache-2.0 (Google) | three.js distribution |

Data fetched at runtime (not stored in this repo): AWS Terrain Tiles, Sentinel-2 cloudless by EOX (CC BY 4.0),
NASA GIBS imagery, GDACS / NOAA NHC storm feeds, and the cyber-threat feeds listed in the README. Each is
subject to its provider's terms.

## Notes for forks

- **Commercial forks** must drop or replace `public/data/cables.json` (non-commercial licence).
- **Animations** are shipped only as baked game data (`vrm.bin`, `loco.bin`, `katana.bin`), never as raw FBX:
  Mixamo's terms allow animations inside a game but not redistributing the source files. To rebuild or change
  them, download your own copies and run the matching script in `scripts/`. Don't commit `.fbx` files.
- Keep the CC BY 4.0 credits when you ship the models or planet maps.

Adding a new asset? Add its source, author, licence and any modifications to the `CREDITS.txt` in its folder in
the same pull request. Assets with no clear licence that allows redistribution can't be merged.
