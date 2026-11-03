// How to play: one short card per system, with the controls for touch and for keyboard + mouse.
// Each control row is [input, what it does]. `k:` keyboard/mouse (with [key] caps), `t:` touch gestures.
export const TUTORIAL = [
  {
    kicker: 'WELCOME', title: 'Your goal',
    body: 'Start in a salvage exosuit above Earth, with your Kestrel Mk II waiting at the station berth. Mine, build robot swarms, found outposts across the real solar system and push your drives all the way to <b>light speed</b>. Everything runs in <b>real time</b>, even while you are offline.',
    mobile: [['t:Bottom bar', 'PILOT · MAP · BASE · TECH · FLEET · MARKET'], ['t:Objective card', 'Tap it to see every objective and its reward']],
    desktop: [['k:Bottom bar', 'Click PILOT · MAP · BASE · TECH · FLEET · MARKET'], ['k:Objective card', 'Click it to see every objective and its reward']],
  },
  {
    kicker: 'PILOT', title: 'Fly your exosuit',
    body: 'You start in orbit at Eden. Fly into the debris field around you. The <b>amber bracket</b> marks what you are aimed at.',
    mobile: [['t:Left stick', 'Fly forward, back and sideways'], ['t:Drag the screen', 'Steer and look around'], ['t:▲', 'Rise'], ['t:BOOST', 'Hold to go faster']],
    desktop: [['k:[W] [A] [S] [D]', 'Fly forward, back and sideways'], ['k:Mouse drag · [←] [→] [↑] [↓]', 'Steer and look around'], ['k:[R] / [F]', 'Rise / sink'], ['k:[Shift]', 'Boost']],
  },
  {
    kicker: 'YOUR SHIP', title: 'Board and step out',
    body: 'Your <b>Kestrel Mk II</b> waits beside the station, marked by the amber <b>YOUR SHIP</b> marker. Fly up to it: when it glows the button on the left turns amber and reads <b>BOARD SHIP</b>. To step out again, tap <b>EXIT SHIP</b> near a station, or anywhere while your fleet is on autopilot (the ship holds formation until you come back).',
    mobile: [['t:BOARD SHIP', 'Climb in when the button turns amber'], ['t:EXIT SHIP', 'Step out on EVA in the exosuit']],
    desktop: [['k:[B]', 'Board your ship / step out on EVA'], ['k:Amber marker', 'Points to your ship while you are out']],
  },
  {
    kicker: 'SALVAGE', title: 'Mine and unload',
    body: 'Aim at a dead satellite, rocket stage or rock and hold mine. Each world has realistic material: scrap metal near Earth, ice at Saturn, asteroids in the Belt. Fly back near the station and your hold <b>unloads automatically</b>.',
    mobile: [['t:Hold MINE', 'Cut the targeted object into cargo'], ['t:Cargo ring', 'Bottom left: how full your hold is']],
    desktop: [['k:Hold [Space]', 'Cut the targeted object into cargo'], ['k:Cargo ring', 'Bottom left: how full your hold is']],
  },
  {
    kicker: 'BASE · TECH · MARKET', title: 'Grow your economy',
    body: '<b>BASE</b>: build solar power, robot drone swarms, refineries, labs and depots. Watch the power bar: too little power slows everything. <b>TECH</b>: spend research to unlock faster drives (each tier cuts travel time). <b>MARKET</b>: sell resources on Earth for credits.',
    mobile: [['t:Tap BASE', 'Build and upgrade modules here'], ['t:Tap TECH', 'Research drives and upgrades']],
    desktop: [['k:Click BASE', 'Build and upgrade modules here'], ['k:Click TECH', 'Research drives and upgrades']],
  },
  {
    kicker: 'MAP · FLEET', title: 'Travel the real solar system',
    body: 'Planets are where they really are today. Build a <b>Shipyard</b>, then haulers and seed ships in FLEET. In MAP, tap a world to <b>autopilot your fleet</b> there (you ride along; space between worlds is truly empty), send ships unmanned, or <b>neural uplink</b> instantly to any base you own.',
    mobile: [['t:Drag', 'Pan the map'], ['t:Pinch', 'Zoom'], ['t:Twist two fingers', 'Rotate the map (drag two fingers up/down to tilt)'], ['t:Tap a world', 'Open it: autopilot, send ships, uplink'], ['t:Tabs', 'SYSTEM · DRIFT · GALAXY · COSMOS · CYBER (live cyber threats on Earth)']],
    desktop: [['k:Drag', 'Pan the map'], ['k:Mouse wheel', 'Zoom'], ['k:Right-drag', 'Orbit the camera'], ['k:Click a world', 'Open it: autopilot, send ships, uplink']],
  },
  {
    kicker: 'SURFACE', title: 'Walk in the mech',
    body: 'At a base on a solid world (Moon, Mars, Mercury, Ceres, Europa, Titan, Pluto) tap <b>DEPLOY MECH</b>. Gravity is the real value for that world. Drill glowing deposits and walk back onto the landing pad to unload.',
    mobile: [['t:Left stick', 'Walk'], ['t:Drag', 'Turn the camera'], ['t:▲', 'Jetpack'], ['t:SPRINT · hold DRILL', 'Run · drill a deposit']],
    desktop: [['k:[W] [A] [S] [D]', 'Walk'], ['k:Mouse drag', 'Turn the camera'], ['k:[R]', 'Jetpack'], ['k:[Shift] · hold [Space]', 'Run · drill a deposit']],
  },
  {
    kicker: 'EARTH 2087', title: 'Fly down to Earth',
    body: 'At Eden tap <b>DESCEND TO EARTH</b>. Fly over real terrain and neon megacities, open <b>DESTINATIONS</b> to pick Singapore, Tokyo, Everest and more, and use <b>AUTOPILOT</b> for long trips. Climb above 80 km to return to orbit.',
    mobile: [['t:Left stick', 'Turn and climb / dive'], ['t:▲ · BOOST', 'Throttle up · burn hard'], ['t:BRAKE', 'Slow down'], ['t:Drag', 'Look around']],
    desktop: [['k:[A] [D] · [W] [S]', 'Turn · climb / dive'], ['k:[R] · [Shift]', 'Throttle up · burn hard'], ['k:Hold [Space]', 'Brake'], ['k:Mouse drag', 'Look around']],
  },
  {
    kicker: 'TIPS', title: 'Good to know',
    body: 'Ships and drones keep working while you are away, so check back often. If your phone runs hot, choose <b>HIGH</b> or <b>LOW</b> graphics in Settings (⚙). Your progress saves automatically, and to Telegram Cloud when you play inside Telegram.',
    mobile: [['t:⚙', 'Settings, graphics and this tutorial'], ['t:?', 'Open this tutorial any time']],
    desktop: [['k:[⚙]', 'Settings, graphics and this tutorial'], ['k:[?]', 'Open this tutorial any time · [←] [→] page through, [Esc] closes']],
  },
];

export const isTouch = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
