// Baseplate FPS cosmetics: every wearable item and what it takes to unlock it.
// This one file is used by both the website and the game server. The server (and the database rules,
// which are generated from this list) decide what you can actually wear; the website only shows it.
(function (root) {
  'use strict';

  // stats every account has (the server is the only thing that can change them)
  const STATS = ['kills', 'deaths', 'wins', 'matches', 'headshots', 'rifleKills', 'pistolKills', 'sniperKills', 'bestStreak'];
  const STAT_WORDS = {
    kills: ['kill', 'kills'], deaths: ['death', 'deaths'], wins: ['win', 'wins'], matches: ['match played', 'matches played'],
    headshots: ['headshot kill', 'headshot kills'], rifleKills: ['rifle kill', 'rifle kills'], pistolKills: ['pistol kill', 'pistol kills'],
    sniperKills: ['sniper kill', 'sniper kills'], bestStreak: ['kill streak', 'kill streak'],
  };
  const TIERS = {
    common:    { name: 'Common',    color: '#b9c0b2' },
    rare:      { name: 'Rare',      color: '#5ea8f2' },
    epic:      { name: 'Epic',      color: '#b77cf2' },
    legendary: { name: 'Legendary', color: '#f2b84b' },
  };
  // accounts that have everything unlocked (by username; checked against the signed-in email, which can't be faked)
  const OWNERS = ['ben'];

  const I = (id, name, tier, k, n) => ({ id, name, tier, need: k ? { k, n } : null });
  const ITEMS = {
    head: [
      I('none', 'Nothing', 'common'),
      I('headband', 'Sweatband', 'common', 'matches', 3),
      I('beanie', 'Beanie', 'common', 'kills', 5),
      I('fish', 'Fish hat', 'rare', 'kills', 10),
      I('cap', 'Baseball cap', 'common', 'kills', 25),
      I('party', 'Party hat', 'common', 'wins', 1),
      I('cone', 'Traffic cone', 'rare', 'deaths', 50),
      I('cowboy', 'Cowboy hat', 'rare', 'kills', 75),
      I('tophat', 'Top hat', 'rare', 'wins', 10),
      I('viking', 'Viking helmet', 'epic', 'kills', 200),
      I('tricorn', 'Pirate captain', 'epic', 'headshots', 75),
      I('shark', 'Shark hat', 'epic', 'bestStreak', 10),
      I('halo', 'Halo', 'epic', 'wins', 30),
      I('kabuto', 'Samurai kabuto', 'legendary', 'headshots', 300),
      I('crown', 'Royal crown', 'legendary', 'wins', 75),
      I('astro', 'Space helmet', 'legendary', 'kills', 1000),
    ],
    body: [
      I('none', 'Nothing', 'common'),
      I('bowtie', 'Bow tie', 'common', 'matches', 5),
      I('scarf', 'Scarf', 'common', 'kills', 15),
      I('bandolier', 'Bandolier', 'common', 'rifleKills', 50),
      I('lei', 'Flower lei', 'rare', 'matches', 25),
      I('medal', 'Medal of valour', 'rare', 'wins', 5),
      I('badge', 'Sheriff star', 'rare', 'pistolKills', 50),
      I('chain', 'Gold chain', 'rare', 'kills', 150),
      I('sash', 'Royal sash', 'epic', 'wins', 40),
      I('plate', 'Knight armour', 'epic', 'kills', 300),
      I('ghillie', 'Ghillie wrap', 'epic', 'sniperKills', 100),
      I('core', 'Energy core', 'legendary', 'bestStreak', 20),
      I('scales', 'Dragon scale armour', 'legendary', 'kills', 1500),
    ],
    back: [
      I('none', 'Nothing', 'common'),
      I('teddy', 'Teddy bear', 'common', 'matches', 3),
      I('backpack', 'Backpack', 'common', 'kills', 20),
      I('rod', 'Fishing rod', 'rare', 'kills', 40),
      I('shield', 'Round shield', 'rare', 'deaths', 100),
      I('guitar', 'Guitar', 'rare', 'matches', 40),
      I('quiver', 'Quiver', 'rare', 'headshots', 40),
      I('cape', 'Hero cape', 'epic', 'wins', 15),
      I('katana', 'Katana', 'epic', 'headshots', 150),
      I('jetpack', 'Jetpack', 'epic', 'kills', 400),
      I('wings', 'Angel wings', 'legendary', 'wins', 60),
      I('dragon', 'Dragon wings', 'legendary', 'kills', 750),
    ],
  };
  const SLOTS = ['head', 'body', 'back'];
  const byId = {};
  for (const slot of SLOTS) for (const it of ITEMS[slot]) { it.slot = slot; byId[slot + ':' + it.id] = it; }

  const item = (slot, id) => byId[slot + ':' + id] || null;
  const isOwner = name => OWNERS.includes(String(name || '').toLowerCase());
  // can this account wear this item? stats come from the server/database, never from the player
  function unlocked(slot, id, stats, owner) {
    const it = item(slot, id);
    if (!it) return false;
    if (!it.need || owner) return true;
    return (Number(stats && stats[it.need.k]) || 0) >= it.need.n;
  }
  function needText(it) {
    if (!it.need) return '';
    const w = STAT_WORDS[it.need.k] || [it.need.k, it.need.k];
    return it.need.k === 'bestStreak' ? it.need.n + ' ' + w[0] : it.need.n + ' ' + (it.need.n === 1 ? w[0] : w[1]);
  }

  // weapon skins. Exclusive skins are never sold: only the owners, and accounts the owner grants them to
  // (users/<uid>/grants/<skin id> = true in the database, which only the owner can set from the Firebase console)
  const WEAPON_LIST = ['rifle', 'pistol', 'sniper'];
  const SK = (id, name, tier, blurb, exclusive) => ({ id, name, tier, blurb, exclusive: !!exclusive });
  const SKINS = {
    rifle: [SK('default', 'Standard issue', 'common', 'Tan polymer and black steel.'),
      SK('nebula', 'Nebula Flow', 'legendary', 'Blue and violet liquid that never stops moving across the whole gun.', true)],
    pistol: [SK('default', 'Standard issue', 'common', 'Black steel slide and polymer frame.'),
      SK('banana', 'Banana Blaster', 'legendary', 'A ripe banana. Inspect it to peel it and take a bite. The peels fly back every shot.', true)],
    sniper: [SK('default', 'Standard issue', 'common', 'Olive stock and heavy steel barrel.'),
      SK('crimson', 'Crimson Laser', 'legendary', 'Red energy crackles through glass panels along the barrel and stock.', true)],
  };
  SKINS.rifle.push(SK('sakura', 'Sakura Glass', 'legendary', 'Pearl white with cherry blossoms drifting through clear glass panels. G.I. mini reflex sight.', true));
  // exclusive skins given to particular accounts (by username, matched to the signed-in email like the owners)
  const SKIN_GRANTS = { soggybiscuit: ['nebula', 'banana', 'crimson'], chickenjoe91: ['sakura'] };

  /* ---------- cash, crates and wraps ----------
     Cash is earned in matches and only the game server can change it. A crate costs cash and holds one wrap:
     a finish painted over a gun's standard model. The server rolls the crate; this list is only what's in it. */
  const CASH = { kill: 10, win: 100 };
  const CRATE = { id: 'baseplate', name: 'Baseplate Crate', price: 500 };
  // odds are parts per million; they add up to exactly 1,000,000
  const RARITIES = [
    { id: 'common',   name: 'Common',          color: '#b0c3d9', ppm: 500000 },
    { id: 'uncommon', name: 'Uncommon',        color: '#5e98d9', ppm: 250000 },
    { id: 'rare',     name: 'Rare',            color: '#4b69ff', ppm: 150000 },
    { id: 'veryrare', name: 'Very Rare',       color: '#8847ff', ppm: 80000 },
    { id: 'obscene',  name: 'Obscenely Rare',  color: '#eb4b4b', ppm: 19000 },
    { id: 'artifact', name: 'Artifact',        color: '#ffc928', ppm: 1000 },
  ];
  const rarity = id => RARITIES.find(r => r.id === id) || RARITIES[0];
  // pattern names the game draws (each is a shader on the gun)
  const PATTERNS = ['solid', 'camo', 'digi', 'speck', 'bands', 'tiger', 'carbon', 'hex', 'marble', 'topo', 'circuit', 'damascus', 'fade', 'geo',
    'waves', 'dots', 'scales', 'kintsugi', 'synth', 'lava', 'galaxy', 'plasma', 'holo', 'gilded', 'chrome', 'pulse', 'splat', 'check', 'zebra', 'aurora', 'wood'];
  // [id, gun, name, rarity, pattern, colours, scale, roughness, metalness, glow, animation speed, shine sweep, metal veins, darker parts]
  const WRAP_ROWS = [
    // Common: field camos, solids and plain finishes
    ['dustbowl', 'rifle', 'Dustbowl', 'common', 'camo', 'b9a37a,8a6f4a,cdb88f,5f4b34', 14, 0.85, 0.05],
    ['gravel', 'pistol', 'Gravel', 'common', 'speck', '6d7074,9a9da1,c9ccd0', 40, 0.8, 0.1],
    ['bracken', 'sniper', 'Bracken', 'common', 'camo', '55613c,3b4529,7a7f4d,2a2f1e', 10, 0.85, 0.05],
    ['slatedigi', 'rifle', 'Slate Digital', 'common', 'digi', '5f666d,858c93,3f454b,a9aeb3', 12, 0.8, 0.1],
    ['sanddune', 'pistol', 'Sand Dune', 'common', 'solid', 'c8ad7f', 10, 0.75, 0.05],
    ['ashdigi', 'sniper', 'Ash Digital', 'common', 'digi', '8b8b86,b3b2ab,62625e,d6d4cc', 9, 0.8, 0.1],
    ['olivedrab', 'rifle', 'Olive Drab', 'common', 'solid', '5d6443', 10, 0.8, 0.05],
    ['desertdigi', 'pistol', 'Desert Digital', 'common', 'digi', 'c2a676,a4885b,dcc89f,7d6644', 22, 0.8, 0.05],
    ['granite', 'sniper', 'Granite', 'common', 'speck', '3d3f42,5d6064,8a8d91', 30, 0.75, 0.1],
    ['urbangrid', 'rifle', 'Urban Grid', 'common', 'check', '6b7075,52575c', 20, 0.8, 0.1],
    ['forestfloor', 'pistol', 'Forest Floor', 'common', 'camo', '5b4a32,3f5530,7b6a45,2d2418', 26, 0.85, 0.05],
    ['drygrass', 'sniper', 'Dry Grass', 'common', 'bands', 'b79f6a,8f7a4c,d2bf8e', 14, 0.85, 0.05],
    ['concrete', 'rifle', 'Concrete', 'common', 'speck', '9fa2a3,b8babb,7e8182', 38, 0.9, 0.0],
    ['nightops', 'pistol', 'Night Ops', 'common', 'solid', '1f2124', 10, 0.7, 0.2],
    ['swamp', 'sniper', 'Swamp', 'common', 'camo', '4a4f35,5f5a3a,33382a,6f6e48', 9, 0.85, 0.05],
    ['tundra', 'rifle', 'Tundra', 'common', 'camo', 'd9dcdc,a7acaf,eef0f0,7f868a', 13, 0.8, 0.05],
    ['rustbucket', 'pistol', 'Rust Bucket', 'common', 'speck', '7a4a2a,a8622f,5a3722', 45, 0.9, 0.3],
    ['coyote', 'sniper', 'Coyote', 'common', 'solid', '9b7a52', 10, 0.8, 0.05],
    ['twotone', 'rifle', 'Two-Tone Field', 'common', 'bands', '5d6443,25272a,5d6443', 7, 0.8, 0.1],
    ['arcticdigi', 'pistol', 'Arctic Digital', 'common', 'digi', 'e3e8ec,b9c4cc,f6f8f9,8e9ba5', 22, 0.75, 0.05],
    ['driftwood', 'sniper', 'Driftwood', 'common', 'wood', 'a89a85,867a68', 6, 0.85, 0.0],
    ['walnut', 'rifle', 'Walnut', 'common', 'wood', '6b4428,4a2d18', 8, 0.6, 0.0],
    ['brickdust', 'pistol', 'Brick Dust', 'common', 'speck', '8e4a3a,b06450,6a3428', 40, 0.9, 0.0],
    ['asphalt', 'sniper', 'Asphalt', 'common', 'speck', '262729,3b3c3f,55575a', 34, 0.95, 0.0],
    ['moss', 'rifle', 'Moss', 'common', 'camo', '5f7a34,486027,7d9446,34461d', 13, 0.85, 0.05],
    ['sage', 'pistol', 'Sage', 'common', 'solid', '8d9b80', 10, 0.75, 0.05],
    ['marshdigi', 'sniper', 'Marsh Digital', 'common', 'digi', '5f6640,7a6b45,454b2f,8f8a5c', 9, 0.85, 0.05],
    ['charcoal', 'rifle', 'Charcoal Splash', 'common', 'splat', '46494d,1d1f21,6c7075', 10, 0.85, 0.1],
    ['pine', 'pistol', 'Pine', 'common', 'wood', '4e3a26,33241a', 14, 0.7, 0.0],
    ['clay', 'sniper', 'Clay', 'common', 'solid', 'b06a48', 10, 0.8, 0.0],
    // Uncommon: brighter and bolder
    ['carbonweave', 'rifle', 'Carbon Weave', 'uncommon', 'carbon', '15171a,3a3e44', 60, 0.35, 0.4],
    ['tigerlily', 'pistol', 'Tiger Lily', 'uncommon', 'tiger', 'f08a24,1a1410', 28, 0.55, 0.1],
    ['nightmarble', 'sniper', 'Night Marble', 'uncommon', 'marble', '121315,e8e8e4,3a3c40', 7, 0.3, 0.1],
    ['cobalthex', 'rifle', 'Cobalt Hex', 'uncommon', 'hex', '1f3f8f,7fb0ff', 40, 0.45, 0.4],
    ['topoteal', 'pistol', 'Topo Teal', 'uncommon', 'topo', '0f4a4f,7ee0d6', 16, 0.6, 0.1],
    ['frostdigi', 'sniper', 'Frostbite Digital', 'uncommon', 'digi', 'bfe3f7,6fb2dd,eaf7ff,3e7fb0', 10, 0.5, 0.1],
    ['embertiger', 'rifle', 'Ember Tiger', 'uncommon', 'tiger', 'd8321c,140d0b', 14, 0.55, 0.1],
    ['mintcheck', 'pistol', 'Mint Check', 'uncommon', 'check', '9fe8c9,f4fbf7', 40, 0.5, 0.05],
    ['bluecarbon', 'sniper', 'Blue Carbon', 'uncommon', 'carbon', '0d1a33,2d5fb8', 50, 0.35, 0.5],
    ['coralsplash', 'rifle', 'Coral Splash', 'uncommon', 'splat', 'f2efe9,ff6f61,ffb3a7', 10, 0.5, 0.05],
    ['lilacmarble', 'pistol', 'Lilac Marble', 'uncommon', 'marble', 'cdb6ea,f7f2ff,8f6cc0', 18, 0.3, 0.1],
    ['redzebra', 'sniper', 'Red Zebra', 'uncommon', 'zebra', 'c4161c,101012', 9, 0.5, 0.1],
    ['topodesert', 'rifle', 'Desert Survey', 'uncommon', 'topo', 'c9a46a,4a3420', 9, 0.7, 0.05],
    ['navyhex', 'pistol', 'Navy Hex', 'uncommon', 'hex', '15213b,dfe6f2', 70, 0.45, 0.3],
    ['aquawaves', 'sniper', 'Aqua Waves', 'uncommon', 'waves', '0b6f8a,7ce6f2,0a3b52', 7, 0.35, 0.2],
    ['bubbledigi', 'rifle', 'Bubblegum Digital', 'uncommon', 'digi', 'ff9ccf,ffd1e8,e85aa6,fff0f7', 12, 0.5, 0.05],
    ['lemonzest', 'pistol', 'Lemon Zest', 'uncommon', 'bands', 'ffe14a,fffbe6,ffe14a', 24, 0.45, 0.05],
    ['jungletiger', 'sniper', 'Jungle Tiger', 'uncommon', 'tiger', '3f8a2e,0f1a0d', 10, 0.55, 0.1],
    ['steelweave', 'rifle', 'Steel Weave', 'uncommon', 'carbon', '8a9096,c9ced3', 60, 0.3, 0.8],
    ['skycamo', 'pistol', 'Sky Camo', 'uncommon', 'camo', 'a8d4f5,6fa9dc,e3f3ff,3f78b5', 26, 0.6, 0.05],
    ['mochamarble', 'sniper', 'Mocha Marble', 'uncommon', 'marble', '6b4a35,f0e2cf,3d2a1e', 7, 0.3, 0.1],
    ['checkpoint', 'rifle', 'Checkpoint', 'uncommon', 'check', '17181a,f2c418', 22, 0.5, 0.1],
    ['orangezebra', 'pistol', 'Orange Zebra', 'uncommon', 'zebra', 'ff7a1a,15110e', 22, 0.5, 0.1],
    ['plumsplash', 'sniper', 'Plum Splash', 'uncommon', 'splat', '3b1d4f,a35bd6,e3c7f5', 8, 0.5, 0.1],
    ['glacier', 'rifle', 'Glacier', 'uncommon', 'topo', 'e9f6fb,7fc6e4', 9, 0.4, 0.1],
    // Rare: clean, striking patterns
    ['circuitbreaker', 'rifle', 'Circuit Breaker', 'rare', 'circuit', '0b120d,3cff7a', 20, 0.4, 0.3, 0.9],
    ['candycoil', 'pistol', 'Candy Coil', 'rare', 'bands', 'fff6f8,ff4f8b,fff6f8', 30, 0.2, 0.05],
    ['damascustide', 'sniper', 'Damascus Tide', 'rare', 'damascus', '20324a,8fb3d9,e3edf7', 9, 0.25, 0.9],
    ['shard', 'rifle', 'Shard', 'rare', 'geo', '1fb6b0,6a3fd1', 14, 0.35, 0.2],
    ['halftonepop', 'pistol', 'Halftone Pop', 'rare', 'dots', 'f6ecd8,e3263f', 60, 0.45, 0.05],
    ['dragonscale', 'sniper', 'Dragon Scale', 'rare', 'scales', '1f5a32,d4b24a,0c2414', 22, 0.35, 0.4, 0, 0, 0, 0.8],
    ['oceandamascus', 'rifle', 'Ocean Damascus', 'rare', 'damascus', '0b3d3f,5fd1c8,d9fff9', 12, 0.25, 0.9],
    ['goldcircuit', 'pistol', 'Gold Circuit', 'rare', 'circuit', '0e1a33,f2c14e', 40, 0.4, 0.5, 0.5, 0, 0, 1],
    ['polysunset', 'sniper', 'Polygon Sunset', 'rare', 'geo', 'ff8a3d,e03c8a', 9, 0.35, 0.1],
    ['koiscales', 'rifle', 'Koi Scales', 'rare', 'scales', 'fff4e8,ff6b2b,c9351a', 30, 0.3, 0.2],
    ['icedamascus', 'pistol', 'Ice Damascus', 'rare', 'damascus', '9fb7c7,eef6fb,5a7385', 26, 0.2, 0.95],
    ['neonhalftone', 'sniper', 'Neon Halftone', 'rare', 'dots', '08090c,21e6ff', 40, 0.4, 0.2, 0.9],
    ['coppertopo', 'rifle', 'Copper Survey', 'rare', 'topo', '16110e,d9874a', 12, 0.35, 0.3, 0, 0, 0, 1],
    ['rubyhex', 'pistol', 'Ruby Hex', 'rare', 'hex', '6a0716,ff4a6a', 70, 0.2, 0.5, 0.4],
    ['ivorygold', 'sniper', 'Ivory Vein', 'rare', 'marble', 'f2ede3,d8b24a,c9c2b3', 7, 0.25, 0.1, 0, 0, 0, 1],
    ['midnightwaves', 'rifle', 'Midnight Waves', 'rare', 'waves', '0b1026,c9d3ea,1f2c5a', 12, 0.3, 0.5],
    ['toxiccircuit', 'pistol', 'Toxic Circuit', 'rare', 'circuit', '111a06,b6ff2a', 40, 0.4, 0.3, 1.2],
    ['arcticshard', 'sniper', 'Arctic Shard', 'rare', 'geo', 'f2f7fb,8fc7ec', 9, 0.3, 0.2],
    ['rosecarbon', 'rifle', 'Rose Carbon', 'rare', 'carbon', '2a1a1c,e8a49a', 60, 0.25, 0.9],
    ['electricscales', 'pistol', 'Electric Scales', 'rare', 'scales', '0a1440,2f7bff,0a0f22', 44, 0.3, 0.4, 0.8],
    // Very Rare: clean fades, gold cracks and neon. Two of them move.
    ['synthwave', 'rifle', 'Synthwave', 'veryrare', 'synth', '1a0633,ff3fd2,ff9a3c', 16, 0.35, 0.2, 1.1, 0.5],
    ['kintsugi', 'pistol', 'Kintsugi', 'veryrare', 'kintsugi', '121214,e8b84a', 30, 0.35, 0.1, 0.25],
    ['sunsetfade', 'sniper', 'Sunset Fade', 'veryrare', 'fade', 'ffb347,ff4f8b,6a2fd6', 1, 0.15, 0.6],
    ['oceanfade', 'rifle', 'Ocean Fade', 'veryrare', 'fade', '5ff2e0,1f7ae0,0c1a5a', 1, 0.15, 0.6],
    ['neonpulse', 'pistol', 'Neon Pulse', 'veryrare', 'pulse', '07090f,23e8ff', 30, 0.3, 0.4, 1.4, 1],
    ['jadekintsugi', 'sniper', 'Jade Kintsugi', 'veryrare', 'kintsugi', '1e5a46,f0c860', 12, 0.25, 0.2, 0.25],
    ['aurora', 'rifle', 'Aurora', 'veryrare', 'aurora', '050b18,3dffb0,a45bff', 10, 0.25, 0.3, 0.7, 0.6],
    ['candyfade', 'pistol', 'Candy Fade', 'veryrare', 'fade', 'ffc2e2,c9b6ff,8fe3ff', 1, 0.15, 0.5],
    ['trongrid', 'sniper', 'Tron Grid', 'veryrare', 'synth', '05070a,ff8a1f,ff3a1f', 10, 0.35, 0.3, 1.2, 0.4],
    ['obsidianveins', 'rifle', 'Obsidian Veins', 'veryrare', 'marble', '0a0a0c,e6b94a,1c1c22', 8, 0.15, 0.4, 0.15, 0, 0, 1],
    ['vaporwave', 'pistol', 'Vaporwave', 'veryrare', 'synth', '2a1b5c,5ff2e0,ff7ad9', 40, 0.3, 0.2, 0.9, 0.5],
    ['arcticaurora', 'sniper', 'Arctic Aurora', 'veryrare', 'aurora', '0a1630,8fe8ff,f2f7ff', 8, 0.2, 0.4, 0.6, 0.5],
    ['crimsonfade', 'rifle', 'Crimson Fade', 'veryrare', 'fade', 'ff4a3a,8a0f1f,0d0607', 1, 0.15, 0.6],
    // Obscenely Rare: all of these move
    ['magmacore', 'rifle', 'Magma Core', 'obscene', 'lava', '120806,ff5a12,ffd24a', 14, 0.6, 0.1, 2.2, 1],
    ['deepspace', 'sniper', 'Deep Space', 'obscene', 'galaxy', '04040c,2a1a6a,ff6ad5', 7, 0.25, 0.3, 1.0, 1],
    ['prismshift', 'pistol', 'Prism Shift', 'obscene', 'holo', 'd9dce3', 30, 0.12, 1.0, 0.25, 1],
    ['plasmastorm', 'rifle', 'Plasma Storm', 'obscene', 'plasma', '0a0630,5b2cff,ff4fd8', 12, 0.25, 0.4, 1.2, 1],
    ['frostplasma', 'sniper', 'Frost Plasma', 'obscene', 'plasma', '06142a,3fb6ff,e8fbff', 9, 0.2, 0.5, 1.1, 1],
    ['inferno', 'pistol', 'Inferno', 'obscene', 'lava', '1a0a06,ff3a0a,fff04a', 34, 0.6, 0.1, 2.6, 1.4],
    ['eventhorizon', 'rifle', 'Event Horizon', 'obscene', 'galaxy', '020208,0f2a5a,7ad8ff', 10, 0.25, 0.3, 1.0, 1],
    ['spectrum', 'sniper', 'Spectrum', 'obscene', 'holo', 'eef0f5', 9, 0.1, 1.0, 0.3, 1],
    // Artifact: gold, clean and alive
    ['gildedrelic', 'rifle', 'Gilded Relic', 'artifact', 'gilded', 'ffc93c,3a2606', 26, 0.16, 1.0, 0.12, 1, 1],
    ['sunforged', 'pistol', 'Sunforged', 'artifact', 'chrome', 'ffd25a,ff9a2a', 1, 0.08, 1.0, 0.35, 1, 1],
    ['pharaoh', 'sniper', 'Pharaoh', 'artifact', 'gilded', '06192a,ffd05a', 14, 0.2, 0.3, 0.3, 1, 1],
    ['halogold', 'rifle', 'Halo Gold', 'artifact', 'holo', 'fff3cf', 12, 0.06, 1.0, 0.45, 0.6, 1],
  ];
  const WRAPS = WRAP_ROWS.map(([id, w, name, r, pat, cols, s, ro, me, gl, an, sw, mv, dk]) => ({
    id, w, name, r, pat, c: cols.split(',').map(h => '#' + h), s: s || 10, ro: ro == null ? 0.6 : ro, me: me || 0,
    gl: gl || 0, an: an || 0, sw: sw ? 1 : 0, mv: mv || 0, dk: dk == null ? 0.6 : dk,
  }));
  const wrapById = Object.fromEntries(WRAPS.map(x => [x.id, x]));
  const wrap = id => wrapById[id] || null;
  const wrapsOf = r => WRAPS.filter(x => x.r === r);
  // the server rolls a number from 0 to 999,999 with a secure random generator and passes it here
  function rollRarity(n) {
    let acc = 0;
    for (const r of RARITIES) { acc += r.ppm; if (n < acc) return r.id; }
    return RARITIES[0].id;
  }
  const skin = (weapon, id) => (SKINS[weapon] || []).find(k => k.id === id) || null;
  function skinUnlocked(weapon, id, owner, grants, name) {
    const k = skin(weapon, id);
    if (!k) return false;
    if (!k.exclusive || owner) return true;
    const given = SKIN_GRANTS[String(name || '').toLowerCase()];
    if (given && given.includes(id)) return true;
    return !!(grants && grants[id] === true);
  }

  const api = { STATS, TIERS, OWNERS, ITEMS, SLOTS, item, isOwner, unlocked, needText, WEAPON_LIST, SKINS, SKIN_GRANTS, skin, skinUnlocked,
    CASH, CRATE, RARITIES, rarity, PATTERNS, WRAPS, wrap, wrapsOf, rollRarity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BPCos = api;
})(typeof window !== 'undefined' ? window : this);
