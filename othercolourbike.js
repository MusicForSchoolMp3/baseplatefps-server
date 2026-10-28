'use strict';
// othercolourbike game server: the multiplayer bike park, and checked leaderboards for the solo trails.
// It shares the arcade server's address and sign-in checks, but has its own connections (on /ocb), and
// every handler is wrapped so that a problem in here can never affect Baseplate FPS or RockLeague.
//
// Leaderboards can't be faked: a finished run is sent as the controls pressed on every physics step, and
// the server rides the whole run again itself with the same physics. Only the time and score the server
// gets are saved.

const { WebSocketServer } = require('ws');
const O = require('./ocb-physics.js');

const OCB_PROTO = 1;
const MAX_RUN_TICKS = 120 * 150;          // 2.5 minutes is far longer than any trail
const PARK_MAX = 24, BOARD_N = 50, SEND_HZ = 15;
const KITS = 8;

module.exports = function createOCB(ctx) {
  const { verifyToken, modRec, knownNames, USER_RE, DEV_TOKENS } = ctx;
  const getDb = () => ctx.getDb();
  const admin = ctx.admin;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024 });   // a run's controls fit easily in this
  const players = new Set(), byUid = new Map(), parks = new Map();
  const boards = new Map();                 // level -> { time: Map(uid -> {n, v}), score: Map, loaded: Promise }
  const memProgress = new Map();
  let nextId = 1;
  const safe = (fn, label) => (...a) => { try { return fn(...a); } catch (e) { console.error('[othercolourbike]', label, e && e.stack || e); } };
  const LEVEL_IDS = O.LEVELS.map(l => l.id);

  function send(p, obj) {
    if (p.ws.readyState !== 1 || p.ws.bufferedAmount > 256 * 1024) return;
    try { p.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (_) {}
  }

  /* ---------- accounts and progress ---------- */
  function cleanProgress(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const id of LEVEL_IDS) {
      const r = raw[id]; if (!r || typeof r !== 'object') continue;
      out[id] = { t: Number(r.t) > 0 ? Math.floor(Number(r.t)) : 0, s: Math.max(0, Math.floor(Number(r.s) || 0)), c: Math.max(0, Math.floor(Number(r.c) || 0)) };
    }
    return out;
  }
  async function loadProfile(who) {
    const fromEmail = String(who.email).split('@')[0];
    let name = who.devName || fromEmail, banned = !!(modRec.get(who.uid) || {}).banned, progress = memProgress.get(who.uid) || {};
    const db = getDb();
    if (db) {
      try {
        const [un, mod, pr] = await Promise.all(['username', 'mod', 'ocb/progress'].map(k => db.ref('users/' + who.uid + '/' + k).once('value').then(s => s.val())));
        if (typeof un === 'string' && un.toLowerCase() === fromEmail) name = un;
        if (mod && typeof mod === 'object') { if (!modRec.has(who.uid)) modRec.set(who.uid, { banned: !!mod.banned, tamperAt: Number(mod.tamperAt) || 0 }); banned = !!(modRec.get(who.uid) || {}).banned; }
        progress = cleanProgress(pr);
      } catch (e) { console.warn('[othercolourbike] could not read profile', who.uid, e.message); }
    }
    memProgress.set(who.uid, progress);
    if (!USER_RE.test(name)) name = (fromEmail.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)) || 'Rider';
    return { name, banned, progress };
  }

  /* ---------- leaderboards ---------- */
  function board(level) {
    let b = boards.get(level);
    if (b) return b;
    b = { time: new Map(), score: new Map(), loaded: null };
    boards.set(level, b);
    const db = getDb();
    b.loaded = db ? db.ref('ocb/boards/' + level).once('value').then(snap => {
      const v = snap.val() || {};
      for (const kind of ['time', 'score']) for (const uid in (v[kind] || {})) { const e = v[kind][uid]; if (e && typeof e.n === 'string' && Number(e.v) > 0) b[kind].set(uid, { n: e.n.slice(0, 20), v: Number(e.v) }); }
    }).catch(e => console.warn('[othercolourbike] board load failed', level, e.message)) : Promise.resolve();
    return b;
  }
  function ranked(b, kind) {
    const list = [...b[kind].entries()].map(([uid, e]) => ({ uid, n: e.n, v: e.v }));
    list.sort((x, y) => kind === 'time' ? x.v - y.v : y.v - x.v);
    return list;
  }
  function trimBoard(b, kind, level) {
    const list = ranked(b, kind);
    for (const e of list.slice(BOARD_N)) { b[kind].delete(e.uid); const db = getDb(); if (db) db.ref(`ocb/boards/${level}/${kind}/${e.uid}`).remove().catch(() => {}); }
  }
  async function boardView(level, uid) {
    const b = board(level); await b.loaded;
    const out = {};
    for (const kind of ['time', 'score']) {
      const list = ranked(b, kind);
      const mine = list.findIndex(e => e.uid === uid);
      out[kind] = { top: list.slice(0, 20).map((e, i) => ({ r: i + 1, n: e.n, v: e.v, me: e.uid === uid })), me: mine >= 0 ? { r: mine + 1, v: list[mine].v } : null };
    }
    return out;
  }

  /* ---------- checking a run ---------- */
  async function onRun(p, msg) {
    const now = Date.now();
    if (now - (p.runAt || 0) < 1500) return send(p, { t: 'runerr', why: 'slow down' });
    p.runAt = now;
    const def = O.LEVELS.find(l => l.id === msg.level);
    if (!def) return;
    const inputs = O.unrle(msg.inp, MAX_RUN_TICKS);
    if (!inputs || !inputs.length) return send(p, { t: 'runerr', why: 'bad run' });
    const s = O.replay(def.id, inputs);                                 // ride it again, exactly as they did
    let mask = 0; def.ch.forEach((ch, i) => { if (O.challengeDone(ch, s)) mask |= 1 << i; });
    const prog = memProgress.get(p.uid) || {}; const old = prog[def.id] || { t: 0, s: 0, c: 0 };
    const cur = { t: old.t, s: old.s, c: old.c | mask };
    const fin = !!s.finished, ticks = s.finishTick, score = fin ? s.score : 0;
    const newTime = fin && (!old.t || ticks < old.t), newScore = fin && score > old.s;
    if (newTime) cur.t = ticks;
    if (newScore) cur.s = score;
    const changed = newTime || newScore || cur.c !== old.c;
    if (changed) {
      prog[def.id] = cur; memProgress.set(p.uid, prog);
      const db = getDb();
      if (db) db.ref('users/' + p.uid + '/ocb/progress/' + def.id).set(cur).catch(e => console.warn('[othercolourbike] progress not saved', e.message));
    }
    if (fin) {
      const b = board(def.id); await b.loaded;
      const db = getDb();
      for (const [kind, v, better] of [['time', ticks, newTime], ['score', score, newScore]]) {
        if (!better || (kind === 'score' && v <= 0)) continue;
        b[kind].set(p.uid, { n: p.name, v });
        if (db) db.ref(`ocb/boards/${def.id}/${kind}/${p.uid}`).set({ n: p.name, v }).catch(e => console.warn('[othercolourbike] board not saved', e.message));
        trimBoard(b, kind, def.id);
      }
    }
    send(p, { t: 'run', level: def.id, claim: msg.claim | 0, finished: fin, ticks, score, mask, newTime, newScore, progress: cur, crashed: s.crashed ? s.why : '' });
  }

  /* ---------- the bike park ---------- */
  function makeCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let n = 0; n < 50; n++) { let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; if (!parks.has(c)) return c; }
    return null;
  }
  function parkOf(code) { let r = parks.get(code); if (!r) { r = { code, players: new Set() }; parks.set(code, r); } return r; }
  const pubInfo = q => ({ id: q.cid, name: q.name, kit: q.kit, bike: q.bike });
  function joinPark(p, code) {
    leavePark(p);
    const r = parkOf(code);
    if (r.players.size >= PARK_MAX) { send(p, { t: 'err', code: 'parkfull' }); if (!r.players.size) parks.delete(code); return; }
    r.players.add(p); p.park = r; p.st = null;
    send(p, { t: 'park', code: code === 'PUBLIC' ? null : code, riders: [...r.players].filter(q => q !== p).map(pubInfo) });
    for (const q of r.players) if (q !== p) send(q, { t: 'join', r: pubInfo(p) });
  }
  function leavePark(p) {
    const r = p.park; if (!r) return;
    r.players.delete(p); p.park = null;
    for (const q of r.players) send(q, { t: 'leave', id: p.cid });
    if (!r.players.size && r.code !== 'PUBLIC') parks.delete(r.code);
  }
  const num = (v, lo, hi) => typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
  function onState(p, m) {
    p.lv = m.lv === 'park' || LEVEL_IDS.includes(m.lv) ? m.lv : p.park ? 'park' : null; p.stAt = Date.now();   // kept for the owner's hidden watching too
    // where you are and what you're doing; anything odd is clamped (in the park there's nothing to win anyway)
    p.st = [p.cid, Math.round(num(m.x, -100, 2000) * 100) / 100, Math.round(num(m.y, -500, 500) * 100) / 100, Math.round(num(m.a, -1e4, 1e4) * 1000) / 1000,
      Math.round(num(m.sp, -100, 100) * 100) / 100, num(m.tr, 0, 8) | 0, Math.round(num(m.tp, 0, 1) * 100) / 100, num(m.f, 0, 255) | 0,
      Math.round(num(m.vx, -40, 40) * 10) / 10, Math.round(num(m.vy, -60, 60) * 10) / 10];
  }
  setInterval(safe(() => {
    for (const r of parks.values()) {
      if (r.players.size < 2) continue;
      const all = [...r.players].filter(q => q.st).map(q => q.st);
      for (const q of r.players) send(q, { t: 'ps', p: all.filter(e => e[0] !== q.cid) });
    }
    // the owner watching someone: where they are (a trail or the park) and everyone riding with them
    for (const w of players) {
      if (!w.watcher) continue;
      const t = w.watchTarget;
      if (!t || !players.has(t)) { send(w, { t: 'wst', gone: 1 }); continue; }
      const live = t.st && t.lv && Date.now() - (t.stAt || 0) < 4000;
      if (!live) { send(w, { t: 'wst', lv: null }); continue; }
      const with_ = t.park ? [...t.park.players].filter(q => q.st && q !== t) : [];
      const n = {}; for (const q of [t, ...with_]) n[q.cid] = [q.name, q.kit, q.bike];
      send(w, { t: 'wst', lv: t.lv, id: t.cid, p: [t.st, ...with_.map(q => q.st)], n });
    }
  }, 'park'), 1000 / SEND_HZ);

  /* ---------- messages ---------- */
  async function onHello(p, msg) {
    if (msg.v !== OCB_PROTO) { send(p, { t: 'err', code: 'version' }); setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 300); return; }
    let who; try { who = await verifyToken(msg.token); } catch (_) { send(p, { t: 'err', code: 'auth' }); setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 300); return; }
    const prof = await loadProfile(who);
    if (p.ws.readyState !== 1) return;
    if (prof.banned) { send(p, { t: 'err', code: 'banned' }); setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 400); return; }
    if (typeof msg.watch === 'string' && msg.watch) {           // the owner watching someone, unseen (checked against the verified sign-in)
      if (!ctx.isOwnerWho || !ctx.isOwnerWho(who)) { send(p, { t: 'err', code: 'auth' }); setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 300); return; }
      const lower = msg.watch.toLowerCase().slice(0, 20);
      let t = null; for (const q of byUid.values()) if (q.name.toLowerCase() === lower && !q.watcher) t = q;
      p.uid = who.uid; p.name = prof.name; p.authed = true; p.watcher = true; p.watchTarget = t;
      send(p, { t: 'welcome', id: p.cid, name: p.name, progress: {}, proto: OCB_PROTO, watch: t ? t.cid : 0, wname: t ? t.name : '' });
      return;
    }
    const old = byUid.get(who.uid);
    if (old && old !== p) { send(old, { t: 'err', code: 'elsewhere' }); leavePark(old); try { old.ws.close(); } catch (_) {} }
    p.uid = who.uid; p.name = prof.name; p.authed = true; byUid.set(p.uid, p);
    if (knownNames) knownNames.set(prof.name.toLowerCase(), p.uid);
    p.kit = num(msg.kit, 0, KITS - 1) | 0; p.bike = num(msg.bike, 0, KITS - 1) | 0;
    send(p, { t: 'welcome', id: p.cid, name: p.name, progress: prof.progress, proto: OCB_PROTO });
  }
  function onMessage(p, raw) {
    const now = Date.now();
    if (now - p.msgWindow > 1000) { p.msgWindow = now; p.msgs = 0; }
    if (++p.msgs > 60) return;                            // flood guard (the park sends 15 a second)
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (!p.authed) { if (msg.t === 'hello' && !p.helloSeen) { p.helloSeen = true; onHello(p, msg).catch(e => { console.error('[othercolourbike] hello', e); try { p.ws.close(); } catch (_) {} }); } return; }
    if (p.watcher) return;                                // watchers only watch
    switch (msg.t) {
      case 's': onState(p, msg); break;
      case 'run': onRun(p, msg).catch(e => console.error('[othercolourbike] run', e)); break;
      case 'board': if (LEVEL_IDS.includes(msg.level)) boardView(msg.level, p.uid).then(v => send(p, { t: 'board', level: msg.level, ...v })).catch(() => {}); break;
      case 'park': {
        if (msg.create) { const c = makeCode(); if (c) joinPark(p, c); }
        else if (typeof msg.code === 'string' && msg.code.trim()) { const c = msg.code.trim().toUpperCase(); if (!parks.has(c)) send(p, { t: 'err', code: 'nocode' }); else joinPark(p, c); }
        else joinPark(p, 'PUBLIC');
        break;
      }
      case 'leave': leavePark(p); break;
      case 'kit': p.kit = num(msg.kit, 0, KITS - 1) | 0; p.bike = num(msg.bike, 0, KITS - 1) | 0; if (p.park) for (const q of p.park.players) if (q !== p) send(q, { t: 'join', r: pubInfo(p) }); break;
      case 'combo': {                                     // show other riders what you just landed (names come from the trick list only)
        if (!p.park || now - (p.comboAt || 0) < 400) return; p.comboAt = now;
        const names = Array.isArray(msg.n) ? msg.n.slice(0, 8).filter(n => typeof n === 'string' && (O.TRICKS.some(t => t && t.name === n) || ['Backflip', 'Frontflip', '360', 'Perfect landing', 'Manual'].includes(n))) : [];
        const pts = num(msg.pts, 0, 1e6) | 0;
        for (const q of p.park.players) if (q !== p) send(q, { t: 'combo', id: p.cid, pts, n: names });
        break;
      }
    }
  }
  wss.on('connection', ws => {
    const p = { ws, cid: 'b' + (nextId++), uid: '', name: '', authed: false, park: null, st: null, kit: 0, bike: 0, msgs: 0, msgWindow: Date.now() };
    players.add(p);
    const helloTimer = setTimeout(() => { if (!p.authed) try { ws.close(); } catch (_) {} }, 15000);
    ws.on('pong', () => { ws._ocbMissed = false; });
    ws.on('message', safe(raw => onMessage(p, raw), 'message'));
    ws.on('close', safe(() => { clearTimeout(helloTimer); players.delete(p); leavePark(p); if (byUid.get(p.uid) === p) byUid.delete(p.uid); }, 'close'));
    ws.on('error', () => {});
  });
  setInterval(safe(() => {
    for (const ws of wss.clients) { if (ws._ocbMissed) { ws.terminate(); continue; } ws._ocbMissed = true; try { ws.ping(); } catch (_) {} }
  }, 'heartbeat'), 20000);
  parkOf('PUBLIC');

  return {
    handleUpgrade(req, socket, head) {
      try { wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); }
      catch (e) { console.error('[othercolourbike] upgrade', e.message); try { socket.destroy(); } catch (_) {} }
    },
    status() {
      let inPark = 0; for (const r of parks.values()) inPark += r.players.size;
      return { players: [...players].filter(p => p.authed && !p.watcher).length, inPark, publicPark: (parks.get('PUBLIC') || { players: new Set() }).players.size };
    },
    list() { return [...players].filter(p => p.authed && !p.watcher).map(p => ({ name: p.name, room: p.park ? (p.park.code === 'PUBLIC' ? 'Bike park' : 'Bike park ' + p.park.code) : 'othercolourbike', kills: 0, owner: false })); },
    findByName(lower) { for (const p of byUid.values()) if (p.name.toLowerCase() === lower) return { uid: p.uid, name: p.name }; return null; },
    kick(uid, code) {
      const p = byUid.get(uid); if (!p) return false;
      send(p, { t: 'err', code: code || 'banned' }); leavePark(p);
      setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 300);
      return true;
    },
  };
};
module.exports.OCB_PROTO = OCB_PROTO;
