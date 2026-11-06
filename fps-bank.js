// Baseplate FPS cash, crates and wraps. Only this server ever changes any of it.
//  - cash is added here when the match code says you got a kill or won a round
//  - a crate is rolled here with a secure random generator, and paid for in one database transaction
//  - the page can only ask: "what do I have?", "open a crate", "wear this wrap I own". None of those can create anything.
// Saved at users/<uid>/bank = { cash, own: { <wrap id>: count }, eq: { rifle, pistol, sniper } }, which the database rules
// let the player read but never write.
const crypto = require('crypto');

module.exports = function createBank(ctx) {
  const { COS, getDb, admin, verifyToken, modRec } = ctx;
  const isOwnerWho = typeof ctx.isOwnerWho === 'function' ? ctx.isOwnerWho : () => false;
  const OWNER_CASH = 5000000000;                  // the owner (Ben) gets everything: every wrap and a few billion cash
  const mem = new Map();                        // uid -> bank: a cache, and the only store when there's no database
  const blank = () => ({ cash: 0, own: {}, eq: {} });
  const clean = v => {                          // only real wraps, whole numbers, and equipped wraps you actually own
    const b = blank();
    if (!v || typeof v !== 'object') return b;
    b.cash = Math.max(0, Math.floor(Number(v.cash) || 0));
    if (v.own && typeof v.own === 'object') for (const [k, n] of Object.entries(v.own)) { const c = Math.floor(Number(n) || 0); if (COS.wrap(k) && c > 0) b.own[k] = c; }
    if (v.eq && typeof v.eq === 'object') for (const w of COS.WEAPON_LIST) { const id = v.eq[w]; if (typeof id === 'string' && b.own[id] > 0 && COS.wrap(id).w === w) b.eq[w] = id; }
    return b;
  };

  async function load(uid, owner) {
    const db = getDb();
    let b = null;
    if (db) {
      try { b = clean((await db.ref('users/' + uid + '/bank').once('value')).val()); mem.set(uid, b); }
      catch (e) { console.warn('bank read failed', uid, e.message); }
    }
    if (!b) { if (!mem.has(uid)) mem.set(uid, blank()); b = mem.get(uid); }
    if (owner) await ownerGrant(uid, b);
    return b;
  }
  // only ever for the verified owner sign-in (the email Google checked), topped up here on the server
  async function ownerGrant(uid, b) {
    const low = b.cash < OWNER_CASH / 2, missing = COS.WRAPS.filter(w => !(b.own[w.id] > 0));
    if (!low && !missing.length) return;
    if (low) b.cash = OWNER_CASH;
    for (const w of missing) b.own[w.id] = 1;
    const db = getDb();
    if (db) {
      const upd = {}; if (low) upd.cash = OWNER_CASH; for (const w of missing) upd['own/' + w.id] = 1;
      try { await db.ref('users/' + uid + '/bank').update(upd); } catch (e) { console.warn('owner grant not saved', e.message); }
    }
  }

  // called by the match code only. Returns the new total when it's known.
  function addCash(uid, n) {
    if (!uid || !(n > 0)) return null;
    const db = getDb();
    let b = mem.get(uid);
    if (!b && !db) { b = blank(); mem.set(uid, b); }
    if (b) b.cash += n;
    if (db) db.ref('users/' + uid + '/bank/cash').set(admin.database.ServerValue.increment(n)).catch(e => console.warn('cash not saved for', uid, e.message));
    return b ? b.cash : null;
  }

  const busy = new Set(), lastOpen = new Map();
  async function open(uid, name) {
    if (busy.has(uid)) return { code: 429, error: 'Still opening your last crate.' };
    const now = Date.now();
    if (now - (lastOpen.get(uid) || 0) < 1500) return { code: 429, error: 'Slow down a little.' };
    lastOpen.set(uid, now); busy.add(uid);
    try {
      const price = COS.CRATE.price;
      // decide the item first, here, where nobody can see or change it
      const r = COS.rollRarity(crypto.randomInt(0, 1000000));
      const pool = COS.wrapsOf(r);
      const win = pool[crypto.randomInt(0, pool.length)];
      const db = getDb();
      if (db) {
        let spent = false;
        const res = await db.ref('users/' + uid + '/bank').transaction(cur => {
          spent = false;
          if (cur === null) return null;          // the first try can run before the saved value arrives; this makes it try again with it
          const cash = Math.floor(Number(cur.cash) || 0);
          if (cash < price) return;                // not enough: change nothing
          cur.cash = cash - price;
          if (!cur.own || typeof cur.own !== 'object') cur.own = {};
          cur.own[win.id] = Math.floor(Number(cur.own[win.id]) || 0) + 1;
          spent = true;
          return cur;
        });
        const b = clean(res.snapshot && res.snapshot.val());
        mem.set(uid, b);
        if (!res.committed || !spent) return { code: 402, error: `A crate costs ${price} cash.`, cash: b.cash };
        console.log(`${name || uid} opened a crate: ${win.name} (${COS.rarity(r).name})`);
        return { code: 200, ok: true, wrap: win.id, rarity: r, cash: b.cash, own: b.own };
      }
      const b = mem.get(uid) || blank(); mem.set(uid, b);
      if (b.cash < price) return { code: 402, error: `A crate costs ${price} cash.`, cash: b.cash };
      b.cash -= price; b.own[win.id] = (b.own[win.id] || 0) + 1;
      console.log(`${name || uid} opened a crate: ${win.name} (${COS.rarity(r).name})`);
      return { code: 200, ok: true, wrap: win.id, rarity: r, cash: b.cash, own: b.own };
    } catch (e) {
      console.warn('crate open failed', uid, e.message);
      return { code: 500, error: 'Could not open the crate. Your cash is safe; try again.' };
    } finally { busy.delete(uid); }
  }

  async function equip(uid, w, id, owner) {
    if (!COS.WEAPON_LIST.includes(w)) return { code: 400, error: 'Bad request.' };
    const b = await load(uid, owner);             // always the saved copy, never what the page says it has
    if (id) {
      const x = COS.wrap(id);
      if (!x || x.w !== w || !(b.own[id] > 0)) return { code: 403, error: "You don't own that wrap." };
      b.eq[w] = id;
    } else delete b.eq[w];
    const db = getDb();
    if (db) { try { await db.ref('users/' + uid + '/bank/eq/' + w).set(id || null); } catch (e) { return { code: 500, error: 'Could not save that.' }; } }
    return { code: 200, ok: true, eq: b.eq };
  }

  // what everyone else sees on your guns: an equipped wrap only shows on the standard model
  function wrapsFor(b, skins) {
    return COS.WEAPON_LIST.map(w => (!skins || !skins[w] || skins[w] === 'default') && b && b.eq[w] ? b.eq[w] : '').join('|');
  }

  /* ---------- the three requests the page can make ---------- */
  const hits = new Map();                         // uid -> recent request times
  function json(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      let n = 0; const chunks = [];
      req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }
  async function handle(req, res) {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) return json(res, 401, { error: 'Sign in first.' });
    let who; try { who = await verifyToken(h.slice(7)); } catch (_) { return json(res, 401, { error: 'Sign in first.' }); }
    if ((modRec.get(who.uid) || {}).banned) return json(res, 403, { error: 'banned' });
    const now = Date.now(), list = (hits.get(who.uid) || []).filter(x => now - x < 60000);
    if (list.length >= 60) return json(res, 429, { error: 'Too many requests. Wait a minute.' });
    list.push(now); hits.set(who.uid, list);
    const name = String(who.email || '').split('@')[0], owner = isOwnerWho(who);
    const path = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && path === '/fps/locker') {
      const b = await load(who.uid, owner);
      return json(res, 200, { cash: b.cash, own: b.own, eq: b.eq, price: COS.CRATE.price });
    }
    if (req.method === 'POST' && path === '/fps/crate/open') {
      if (owner) await load(who.uid, true);       // the owner never runs dry
      const r = await open(who.uid, name);
      return json(res, r.code, r);
    }
    if (req.method === 'POST' && path === '/fps/wrap') {
      let body; try { body = await readBody(req, 256); } catch (_) { return json(res, 400, { error: 'Bad request.' }); }
      const r = await equip(who.uid, String(body.w || ''), typeof body.wrap === 'string' ? body.wrap.slice(0, 40) : '', owner);
      return json(res, r.code, r);
    }
    return json(res, 404, { error: 'Unknown request.' });
  }

  return { load, addCash, open, equip, wrapsFor, handle, peek: uid => mem.get(uid) || null };
};
