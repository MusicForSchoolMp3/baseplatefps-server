/* Banned-before detector (owner panel only).
   Every browser that connects to any of the games gets a random device ID in a cookie that only this server can read
   or write: it's HttpOnly (page scripts, the DevTools console and extension scripts can't see or change it) and signed
   (a made-up or edited ID is just ignored). When an account signs in, the server notes "this account, this browser".
   When you ban an account, that's remembered for good. Any other account that has been on one of the same browsers
   then shows up in the owner panel with a red dot and the banned accounts listed. Nothing about this is ever sent to
   players, and it never uses the Wi-Fi / IP address (everyone at a school shares one).
   Stored in the database under devlinks/ — the database rules give players no access to it at all. */
const crypto = require('crypto');

module.exports = function createAlts({ getDb, admin, modRec, secret, EMAIL_DOMAIN, isOwner }) {
  const KEY = crypto.createHash('sha256').update('bp-device-v1:' + (secret || crypto.randomBytes(32).toString('hex'))).digest();
  const NAME = 'bpd';                                            // partitioned (works even where third-party cookies are blocked)
  const NAME2 = 'bpd2';                                          // ordinary, for browsers without partitioned cookies
  const AGE = 60 * 60 * 24 * 400;                                // the longest a browser keeps a cookie (400 days); refreshed every visit
  const sig = id => crypto.createHmac('sha256', KEY).update(id).digest('base64url').slice(0, 22);
  const ID_RE = /^[A-Za-z0-9_-]{16}$/;

  function readCookie(req) {
    const raw = String((req.headers && req.headers.cookie) || '');
    if (!raw || raw.length > 8192) return '';
    for (const part of raw.split(';')) {
      const i = part.indexOf('='); if (i < 0) continue;
      const k = part.slice(0, i).trim(); if (k !== NAME && k !== NAME2) continue;
      const v = part.slice(i + 1).trim(), dot = v.indexOf('.');
      if (dot !== 16) continue;
      const id = v.slice(0, 16), s = v.slice(17);
      if (!ID_RE.test(id) || s.length !== 22) continue;
      const want = Buffer.from(sig(id)), got = Buffer.from(s);
      if (got.length === want.length && crypto.timingSafeEqual(got, want)) return id;   // only IDs this server made
    }
    return '';
  }
  // called on every connection to any game, before anything else
  function tag(req) {
    if (!req || req.bpDev) return;
    let id = readCookie(req);
    if (!id) id = crypto.randomBytes(12).toString('base64url');            // a browser we haven't met: give it an ID
    const tok = id + '.' + sig(id);
    req.bpDev = id;
    req.bpCookies = [
      `Set-Cookie: ${NAME}=${tok}; Max-Age=${AGE}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`,
      `Set-Cookie: ${NAME2}=${tok}; Max-Age=${AGE}; Path=/; Secure; HttpOnly; SameSite=None`,
    ];
  }
  const headers = (h, req) => { if (req && req.bpCookies) h.push(...req.bpCookies); };   // rides on the connection's own handshake
  const devOf = req => (req && req.bpDev) || '';

  /* ---------- who has been on which browser ---------- */
  const devAcc = new Map();      // device -> Map(uid -> name)
  const uidDevs = new Map();     // uid -> Set(device)
  const loadedDev = new Set(), loadedUid = new Set();
  const bans = new Map();        // uid -> { n, at, unb } or null (checked: never banned)
  const MAX_DEV = 40, MAX_ACC = 60;
  const nameOf = who => String(who.devName || (who.email || '').split('@')[0] || '').slice(0, 20);
  const safeKey = s => String(s).replace(/[.#$\[\]\/]/g, '_');

  function link(dev, uid, name) {
    let m = devAcc.get(dev); if (!m) devAcc.set(dev, m = new Map());
    if (m.size < MAX_ACC || m.has(uid)) m.set(uid, name || m.get(uid) || '?');
    let s = uidDevs.get(uid); if (!s) uidDevs.set(uid, s = new Set());
    if (s.size < MAX_DEV) s.add(dev);
  }
  async function banInfo(uid) {                                  // a ban made with this update, or one from before it
    if (bans.has(uid)) return bans.get(uid);
    const db = getDb();
    let info = null;
    const mr = modRec && modRec.get(uid);
    if (db) {
      try {
        const [h, m] = await Promise.all([db.ref('devlinks/bans/' + uid).get(), db.ref('users/' + uid + '/mod').get()]);
        const hv = h.val(), mv = m.val();
        if (hv && typeof hv === 'object') info = { n: String(hv.n || ''), at: Number(hv.at) || 0, unb: !!hv.unb && !(mv && mv.banned) };
        else if (mv && mv.banned) info = { n: '', at: Number(mv.bannedAt) || 0, unb: false };
      } catch (e) { return mr && mr.banned ? { n: '', at: 0, unb: false } : null; }   // try again next time
    } else if (mr && mr.banned) info = { n: '', at: 0, unb: false };
    bans.set(uid, info);
    return info;
  }
  async function loadDev(db, dev) {
    if (loadedDev.has(dev) || loadedDev.size > 20000) return;
    loadedDev.add(dev);
    const v = (await db.ref('devlinks/devices/' + dev).limitToLast(MAX_ACC).get()).val() || {};
    for (const [uid, r] of Object.entries(v)) link(dev, uid, r && r.n);
  }
  async function loadUid(db, uid) {
    if (loadedUid.has(uid) || loadedUid.size > 20000) return;
    loadedUid.add(uid);
    const v = (await db.ref('devlinks/accounts/' + uid).limitToLast(MAX_DEV).get()).val() || {};
    for (const dev of Object.keys(v)) if (ID_RE.test(dev)) { link(dev, uid, ''); await loadDev(db, dev); }
  }
  // an account signed in from this browser (called by every game, right after the sign-in is verified)
  function seen(dev, who) {
    if (!dev || !who || !who.uid) return;
    const name = nameOf(who);
    if (isOwner && isOwner(name.toLowerCase())) return;          // the owner's own browsers are never tracked
    const fresh = !(devAcc.get(dev) && devAcc.get(dev).has(who.uid));
    link(dev, who.uid, name);
    const db = getDb();
    (async () => {
      if (db) {
        if (fresh) {
          const T = admin && admin.database ? admin.database.ServerValue.TIMESTAMP : Date.now();
          await db.ref('devlinks/devices/' + dev + '/' + safeKey(who.uid)).set({ n: name, t: T });
          await db.ref('devlinks/accounts/' + safeKey(who.uid) + '/' + dev).set(T);
        }
        await loadDev(db, dev); await loadUid(db, who.uid);
      }
      for (const d of uidDevs.get(who.uid) || []) for (const u of (devAcc.get(d) || new Map()).keys()) await banInfo(u);
    })().catch(e => console.warn('device link failed', e.message));
  }
  function noteBan(uid, name, by) {
    const info = { n: String(name || ''), at: Date.now(), unb: false };
    bans.set(uid, info);
    const db = getDb();
    if (db) db.ref('devlinks/bans/' + safeKey(uid)).set({ n: info.n, at: admin && admin.database ? admin.database.ServerValue.TIMESTAMP : info.at, by: String(by || '') }).catch(e => console.warn('ban note failed', e.message));
    if (db) loadUid(db, uid).catch(() => {});
  }
  function noteUnban(uid) {
    const b = bans.get(uid); if (b) b.unb = true;
    const db = getDb();
    if (db) db.ref('devlinks/bans/' + safeKey(uid)).update({ unb: true }).catch(() => {});
  }
  // the banned accounts that share a browser with this one (for the owner panel)
  function bannedAltsOf(uid) {
    if (!uid) return [];
    const out = new Map();
    for (const d of uidDevs.get(uid) || []) {
      for (const [u, n] of devAcc.get(d) || []) {
        if (u === uid || out.has(u)) continue;
        const b = bans.get(u);
        if (b) out.set(u, { name: b.n || n || '?', at: b.at || 0, unbanned: !!b.unb });
      }
    }
    return [...out.values()].sort((a, b) => b.at - a.at);
  }
  // when an account is looked at in the panel but hasn't connected since the server started (flags from earlier)
  function warm(uid) { const db = getDb(); if (db && uid && !loadedUid.has(uid)) loadUid(db, uid).then(async () => { for (const d of uidDevs.get(uid) || []) for (const u of (devAcc.get(d) || new Map()).keys()) await banInfo(u); }).catch(() => {}); }

  return { tag, headers, devOf, seen, noteBan, noteUnban, bannedAltsOf, warm, _readCookie: readCookie };
};
