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
  const skin = (weapon, id) => (SKINS[weapon] || []).find(k => k.id === id) || null;
  function skinUnlocked(weapon, id, owner, grants) {
    const k = skin(weapon, id);
    if (!k) return false;
    if (!k.exclusive || owner) return true;
    return !!(grants && grants[id] === true);
  }

  const api = { STATS, TIERS, OWNERS, ITEMS, SLOTS, item, isOwner, unlocked, needText, WEAPON_LIST, SKINS, skin, skinUnlocked };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BPCos = api;
})(typeof window !== 'undefined' ? window : this);
