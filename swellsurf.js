'use strict';
// SwellSurf game server: beaches (up to 6 surfers sharing the same waves), surf contests, and checked leaderboards.
// It shares the arcade server's address and sign-in checks, but has its own connections (on /surf), and every
// handler is wrapped so that a problem in here can never affect the other games.
//
// Scores can't be faked: a wave is sent as where the surfer was before the wave plus the controls pressed on every
// physics step, and the server surfs the whole wave again itself with the same physics (surf-physics.js). Only the
// score the server gets is saved or counted.

const { WebSocketServer } = require('ws');
const S = require('./surf-physics.js');

const SURF_PROTO = 1;
const ROOM_MAX = 6, SEND_HZ = 12, BOARD_N = 50;
const TODS = ['dawn', 'day', 'sunset'];
const SUITS = ['shorts', 'spring', 'full'];
const BAD = /\b(fuck\w*|shit\w*|cunt\w*|nigg\w*|fag\w*|retard\w*|bitch\w*|whore\w*|slut\w*|rape\w*|kys)\b/gi;

module.exports = function createSurf(ctx) {
  const { verifyToken, modRec, knownNames } = ctx;
  const getDb = () => ctx.getDb();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 160 * 1024 });   // a long wave's controls fit easily
  const players = new Set(), byUid = new Map(), rooms = new Map(), codes = new Map();
  const boards = new Map();                 // 'spot_size/period' -> { m: Map(uid -> {n, v, m, b}), loaded }
  const memBest = new Map();
  let nextId = 1, nextRoom = 1;
  const safe = (fn, label) => (...a) => { try { return fn(...a); } catch (e) { console.error('[swellsurf]', label, e && e.stack || e); } };
  const send = (p, obj) => { if (!p || p.ws.readyState !== 1 || p.ws.bufferedAmount > 256 * 1024) return; try { p.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (_) {} };
  const num = (v, lo, hi) => typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
  const month = () => new Date().toISOString().slice(0, 7);

  function cleanLook(l) {
    l = l && typeof l === 'object' ? l : {};
    const i = (v, n) => Math.max(0, Math.min(n - 1, v | 0));
    return { b: S.BOARD_IDS.includes(l.b) ? l.b : 'short', st: l.st ? 1 : 0, su: SUITS.includes(l.su) ? l.su : 'spring', sc: i(l.sc, 8), ac: i(l.ac, 8), bc: i(l.bc, 8), sk: i(l.sk, 6) };
  }
  async function loadProfile(who) {
    const fromEmail = String(who.email).split('@')[0];
    let name = who.devName || fromEmail, banned = !!(modRec.get(who.uid) || {}).banned, best = memBest.get(who.uid) || {};
    const db = getDb();
    if (db) {
      try {
        const [un, mod, b] = await Promise.all(['username', 'mod', 'surf/best'].map(k => db.ref('users/' + who.uid + '/' + k).once('value').then(s => s.val())));
        if (typeof un === 'string' && un.toLowerCase() === fromEmail) name = un;
        if (mod && typeof mod === 'object') { if (!modRec.has(who.uid)) modRec.set(who.uid, { banned: !!mod.banned, tamperAt: Number(mod.tamperAt) || 0 }); banned = !!(modRec.get(who.uid) || {}).banned; }
        best = {};
        if (b && typeof b === 'object') for (const k in b) if (/^[a-z]+_(normal|extreme)$/.test(k) && Number(b[k]) > 0) best[k] = Math.min(10, Number(b[k]));
      } catch (e) { console.warn('[swellsurf] could not read profile', who.uid, e.message); }
    }
    memBest.set(who.uid, best);
    if (!/^[A-Za-z0-9]{3,20}$/.test(name)) name = (fromEmail.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)) || 'Surfer';
    return { name, banned, best };
  }

  /* ---------- leaderboards (best wave on each spot, all time and this month) ---------- */
  function board(key) {
    let b = boards.get(key); if (b) return b;
    b = { m: new Map(), loaded: null }; boards.set(key, b);
    const db = getDb();
    b.loaded = db ? db.ref('surf/boards/' + key).once('value').then(snap => {
      const v = snap.val() || {};
      for (const uid in v) { const e = v[uid]; if (e && typeof e.n === 'string' && Number(e.v) > 0) b.m.set(uid, { n: e.n.slice(0, 20), v: Math.min(1000, Number(e.v) | 0), m: typeof e.m === 'string' ? e.m.slice(0, 24) : '', b: typeof e.b === 'string' ? e.b.slice(0, 10) : '' }); }
    }).catch(e => console.warn('[swellsurf] board load failed', key, e.message)) : Promise.resolve();
    if (boards.size > 200) for (const k of boards.keys()) { if (k !== key && !k.endsWith('/all') && !k.endsWith('/' + month())) { boards.delete(k); break; } }
    return b;
  }
  const ranked = b => [...b.m.entries()].map(([uid, e]) => Object.assign({ uid }, e)).sort((x, y) => y.v - x.v);
  async function boardView(spot, size, period, uid) {
    const b = board(`${spot}_${size}/${period === 'all' ? 'all' : month()}`); await b.loaded;
    const list = ranked(b), mine = list.findIndex(e => e.uid === uid);
    return { top: list.slice(0, 20).map((e, i) => ({ r: i + 1, n: e.n, v: e.v, m: e.m, me: e.uid === uid })), me: mine >= 0 ? { r: mine + 1, v: list[mine].v } : null };
  }
  async function postBoard(p, spot, size, sc, top, bid) {
    const v = Math.round(sc * 100); let rank = 0;
    for (const period of ['all', month()]) {
      const key = `${spot}_${size}/${period}`, b = board(key); await b.loaded;
      const old = b.m.get(p.uid);
      if (!old || v > old.v) {
        const e = { n: p.name, v, m: top || '', b: bid || '' }; b.m.set(p.uid, e);
        const db = getDb(); if (db) db.ref('surf/boards/' + key + '/' + p.uid).set(e).catch(er => console.warn('[swellsurf] board not saved', er.message));
        const list = ranked(b);
        for (const x of list.slice(BOARD_N)) { b.m.delete(x.uid); const db2 = getDb(); if (db2) db2.ref('surf/boards/' + key + '/' + x.uid).remove().catch(() => {}); }
      }
      if (period !== 'all') rank = ranked(b).findIndex(e => e.uid === p.uid) + 1;
    }
    return rank;
  }

  /* ---------- checking a wave ---------- */
  async function onRide(p, msg) {
    const now = Date.now();
    if (now - (p.rideAt || 0) < 2000) return send(p, { t: 'rode', mine: true, ok: false, why: 'slow' });
    p.rideAt = now;
    const where = p.room ? { sch: p.room.sch, start: p.room.start } : p.solo ? { sch: p.solo.sch, start: p.solo.start } : null;
    if (!where || !msg.rec || typeof msg.rec !== 'object') return send(p, { t: 'rode', mine: true, ok: false });
    const inputs = S.unrle(msg.rec.inp, S.MAX_RECORD);
    const start = S.checkStart(msg.rec.start);
    const ticksNow = Math.floor((now - where.start) / 1000 / S.DT);
    // it must have happened in this beach's time, not in its future
    if (!inputs || !inputs.length || !start || start.t > ticksNow + 120 || start.t + inputs.length > ticksNow + 240) return send(p, { t: 'rode', mine: true, ok: false });
    let r; try { r = S.replay(where.sch, start, inputs); } catch (e) { console.error('[swellsurf] replay', e); }
    if (!r || !r.res) return send(p, { t: 'rode', mine: true, ok: false });
    const res = r.res, sc = res.sc, top = res.top, bid = S.BOARDS[start.b].id;
    const out = { t: 'rode', mine: true, ok: true, sc, pts: res.pts, top, why: res.why, claim: num(msg.claim, 0, 10) };
    if (p.solo && (p.solo.size === 'normal' || p.solo.size === 'extreme')) {
      const key = p.solo.spot + '_' + p.solo.size, best = memBest.get(p.uid) || {};
      out.key = key;
      if (sc > (best[key] || 0)) {
        best[key] = sc; memBest.set(p.uid, best); out.best = true;
        const db = getDb(); if (db) db.ref('users/' + p.uid + '/surf/best/' + key).set(sc).catch(e => console.warn('[swellsurf] best not saved', e.message));
      }
      if (sc > 0) out.rank = await postBoard(p, p.solo.spot, p.solo.size, sc, top, bid);
    }
    if (p.room) {
      const rm = p.room, c = rm.contest;
      if (c && c.state === 'on' && start.t >= c.startTick && now <= c.ends + 3000) {
        let e = c.scores.get(p.uid); if (!e) { e = { id: p.cid, n: p.name, s: [], used: 0, tot: 0 }; c.scores.set(p.uid, e); }
        if (e.used < c.waves) { e.used++; e.s.push(sc); const b2 = e.s.slice().sort((a, b) => b - a).slice(0, 2); e.tot = Math.round((b2[0] || 0) * 100 + (b2[1] || 0) * 100) / 100; out.counted = true; broadcastContest(rm); }
      }
      for (const q of rm.players) if (q !== p) send(q, { t: 'rode', id: p.cid, n: p.name, sc, top });
    }
    send(p, out);
  }

  /* ---------- beaches ---------- */
  function makeCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let n = 0; n < 60; n++) { let c = ''; for (let i = 0; i < 5; i++) c += A[Math.floor(Math.random() * A.length)]; if (!codes.has(c)) return c; }
    return null;
  }
  const contestView = c => c ? { waves: c.waves, mins: c.mins, state: c.state, ends: c.ends, winner: c.winner || '', scores: [...c.scores.values()].map(e => ({ id: e.id, n: e.n, s: e.s, used: e.used, tot: e.tot })) } : null;
  const roomInfo = r => ({ id: r.id, code: r.code, spot: r.spot, size: r.size, custom: r.custom, tod: r.tod, seed: r.seed, start: r.start, priv: r.priv, host: r.host ? r.host.cid : '', contest: contestView(r.contest) });
  const pubInfo = q => ({ id: q.cid, name: q.name, look: q.look });
  function openRoom(p, m) {
    const spot = S.SPOTS.find(s => s.id === m.spot) ? m.spot : 'coral';
    const size = S.SIZES.includes(m.size) ? m.size : 'normal';
    const code = makeCode(); if (!code) return;
    const r = { id: 'r' + (nextRoom++), code, spot, size, custom: size === 'custom' ? S.cleanCustom(m.custom) : null, tod: TODS.includes(m.tod) ? m.tod : 'day', priv: !!m.priv, seed: (Math.random() * 4294967296) >>> 0, start: Date.now(), players: new Set(), host: p, chat: [], contest: null };
    if (m.contest && typeof m.contest === 'object' && size !== 'custom') r.contest = { waves: m.contest.waves === 5 ? 5 : 3, mins: [6, 10, 15].includes(m.contest.mins) ? m.contest.mins : 10, state: 'wait', ends: 0, startTick: 0, scores: new Map(), winner: '' };
    r.sch = S.makeSchedule(r.seed, r.spot, r.size, r.custom);
    rooms.set(r.id, r); codes.set(code, r);
    joinRoom(p, r);
  }
  function joinRoom(p, r) {
    if (p.room === r) return;
    leaveRoom(p);
    if (r.players.size >= ROOM_MAX) return send(p, { t: 'err', code: 'full' });
    r.players.add(p); p.room = r; p.solo = null; p.st = null;
    if (!r.host || !r.players.has(r.host)) r.host = p;
    send(p, { t: 'room', room: roomInfo(r), players: [...r.players].filter(q => q !== p).map(pubInfo), now: Date.now(), chat: r.chat });
    for (const q of r.players) if (q !== p) send(q, { t: 'pj', p: pubInfo(p) });
  }
  function leaveRoom(p) {
    const r = p.room; if (!r) return;
    r.players.delete(p); p.room = null; p.st = null;
    for (const q of r.players) send(q, { t: 'pl', id: p.cid });
    if (!r.players.size) { rooms.delete(r.id); codes.delete(r.code); return; }
    if (r.host === p) { r.host = r.players.values().next().value; if (r.contest) broadcastContest(r); }
  }
  function broadcastContest(r) { const v = contestView(r.contest); for (const q of r.players) send(q, { t: 'contest', c: v }); }
  function sys(r, x) { r.chat.push({ n: '', x }); if (r.chat.length > 10) r.chat.shift(); for (const q of r.players) send(q, { t: 'sys', x }); }
  function onState(p, m) {
    if (!p.room) return;
    const md = m.m === 9 ? 9 : Math.max(0, Math.min(4, m.m | 0));
    p.st = [p.cid, Math.round(num(m.x, -800, 800) * 100) / 100, Math.round(num(m.y, -20, 60) * 100) / 100, Math.round(num(m.z, -400, 500) * 100) / 100, Math.round(num(m.yaw, -1e5, 1e5) * 1000) / 1000,
      Math.round(num(m.pitch, -1e4, 1e4) * 1000) / 1000, Math.round(num(m.roll, -1e4, 1e4) * 1000) / 1000, md, num(m.f, 0, 255) | 0, Math.round(num(m.sph, 0, 1) * 100) / 100, Math.round(num(m.wk, 0, 1) * 100) / 100];
  }
  setInterval(safe(() => {
    for (const r of rooms.values()) {
      if (r.players.size >= 2) { const all = [...r.players].filter(q => q.st).map(q => q.st); for (const q of r.players) send(q, { t: 'ps', p: all.filter(e => e[0] !== q.cid) }); }
      const c = r.contest;
      if (c && c.state === 'on' && Date.now() > c.ends + 3000) {
        c.state = 'done';
        const list = [...c.scores.values()].sort((a, b) => b.tot - a.tot);
        c.winner = list.length && list[0].tot > 0 ? list[0].n : '';
        broadcastContest(r); sys(r, c.winner ? `Heat over: ${c.winner} wins with ${list[0].tot.toFixed(2)}` : 'Heat over: nobody scored');
      }
    }
  }, 'rooms'), 1000 / SEND_HZ);
  function cleanChat(x) {
    x = String(x || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, '').trim().slice(0, 120);
    return x.replace(BAD, w => '*'.repeat(w.length));
  }

  /* ---------- messages ---------- */
  async function onHello(p, msg) {
    if (msg.v !== SURF_PROTO || msg.phys !== S.VERSION) { send(p, { t: 'err', code: 'version', game: 'swellsurf' }); setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 300); return; }
    let who; try { who = await verifyToken(msg.token); } catch (_) { send(p, { t: 'err', code: 'auth' }); setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 300); return; }
    const prof = await loadProfile(who);
    if (p.ws.readyState !== 1) return;
    if (prof.banned) { send(p, { t: 'err', code: 'banned' }); setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 400); return; }
    const old = byUid.get(who.uid);
    if (old && old !== p) { send(old, { t: 'err', code: 'elsewhere' }); leaveRoom(old); try { old.ws.close(); } catch (_) {} }
    p.uid = who.uid; p.name = prof.name; p.authed = true; byUid.set(p.uid, p);
    if (knownNames) knownNames.set(prof.name.toLowerCase(), p.uid);
    p.look = cleanLook(msg.look);
    send(p, { t: 'welcome', game: 'swellsurf', id: p.cid, name: p.name, best: prof.best, now: Date.now(), proto: SURF_PROTO });
  }
  function onMessage(p, raw) {
    const now = Date.now();
    if (now - p.msgWindow > 1000) { p.msgWindow = now; p.msgs = 0; }
    if (++p.msgs > 50) return;                            // flood guard (a surfer sends 12 a second)
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (!p.authed) { if (msg.t === 'hello' && !p.helloSeen) { p.helloSeen = true; onHello(p, msg).catch(e => { console.error('[swellsurf] hello', e); try { p.ws.close(); } catch (_) {} }); } return; }
    switch (msg.t) {
      case 'ping': send(p, { t: 'pong', c: num(msg.c, 0, 1e15), s: Date.now() }); break;
      case 's': onState(p, msg); break;
      case 'rooms': send(p, { t: 'rooms', list: [...rooms.values()].filter(r => !r.priv).slice(0, 40).map(r => ({ id: r.id, spot: r.spot, size: r.size, tod: r.tod, n: r.players.size, host: r.host ? r.host.name : '', contest: r.contest ? { waves: r.contest.waves, state: r.contest.state } : null })) }); break;
      case 'open': if (now - (p.openAt || 0) > 3000) { p.openAt = now; openRoom(p, msg); } break;
      case 'join': {
        let r = null;
        if (typeof msg.code === 'string') r = codes.get(msg.code.trim().toUpperCase().slice(0, 6)) || null;
        else if (typeof msg.id === 'string') { r = rooms.get(msg.id) || null; if (r && r.priv) r = null; }
        if (!r) send(p, { t: 'err', code: msg.code ? 'nocode' : 'gone' }); else joinRoom(p, r);
        break;
      }
      case 'leave': leaveRoom(p); break;
      case 'solo': {
        leaveRoom(p);
        const spot = S.SPOTS.find(s => s.id === msg.spot) ? msg.spot : 'coral', size = msg.size === 'extreme' ? 'extreme' : 'normal';
        const seed = (Math.random() * 4294967296) >>> 0;
        p.solo = { spot, size, seed, sch: S.makeSchedule(seed, spot, size), start: Date.now() };
        send(p, { t: 'solo', spot, size, seed });
        break;
      }
      case 'ride': onRide(p, msg).catch(e => console.error('[swellsurf] ride', e)); break;
      case 'board': {
        const spot = S.SPOTS.find(s => s.id === msg.spot) ? msg.spot : null, size = msg.size === 'extreme' ? 'extreme' : 'normal', period = msg.period === 'all' ? 'all' : 'month';
        if (spot) boardView(spot, size, period, p.uid).then(v => send(p, Object.assign({ t: 'board', spot, size, period }, v))).catch(() => {});
        break;
      }
      case 'look': {
        if (now - (p.lookAt || 0) < 500) return; p.lookAt = now;
        p.look = cleanLook(msg.look);
        if (p.room) for (const q of p.room.players) if (q !== p) send(q, { t: 'plook', id: p.cid, look: p.look });
        const db = getDb(); if (db) db.ref('users/' + p.uid + '/surf/look').set(p.look).catch(() => {});
        break;
      }
      case 'chat': {
        if (!p.room || now - (p.chatAt || 0) < 1200) return; p.chatAt = now;
        const x = cleanChat(msg.x); if (!x) return;
        p.room.chat.push({ n: p.name, x }); if (p.room.chat.length > 10) p.room.chat.shift();
        for (const q of p.room.players) send(q, { t: 'chat', n: p.name, x });
        break;
      }
      case 'ev': if (p.room && msg.k === 'catch' && now - (p.evAt || 0) > 1000) { p.evAt = now; for (const q of p.room.players) if (q !== p) send(q, { t: 'ev', id: p.cid, k: 'catch' }); } break;
      case 'cstart': {
        const r = p.room, c = r && r.contest;
        if (!c || r.host !== p || c.state === 'on') return;
        c.state = 'on'; c.ends = now + c.mins * 60000; c.startTick = Math.floor((now - r.start) / 1000 / S.DT); c.scores = new Map(); c.winner = '';
        for (const q of r.players) c.scores.set(q.uid, { id: q.cid, n: q.name, s: [], used: 0, tot: 0 });
        broadcastContest(r); sys(r, `The heat is on! ${c.waves} waves each, best 2 count, ${c.mins} minutes.`);
        break;
      }
    }
  }
  wss.on('connection', ws => {
    const p = { ws, cid: 's' + (nextId++), uid: '', name: '', authed: false, room: null, solo: null, st: null, look: cleanLook(null), msgs: 0, msgWindow: Date.now() };
    players.add(p);
    const helloTimer = setTimeout(() => { if (!p.authed) try { ws.close(); } catch (_) {} }, 15000);
    ws.on('pong', () => { ws._surfMissed = false; });
    ws.on('message', safe(raw => onMessage(p, raw), 'message'));
    ws.on('close', safe(() => { clearTimeout(helloTimer); players.delete(p); leaveRoom(p); if (byUid.get(p.uid) === p) byUid.delete(p.uid); }, 'close'));
    ws.on('error', () => {});
  });
  setInterval(safe(() => { for (const ws of wss.clients) { if (ws._surfMissed) { ws.terminate(); continue; } ws._surfMissed = true; try { ws.ping(); } catch (_) {} } }, 'heartbeat'), 20000);

  return {
    handleUpgrade(req, socket, head) {
      try { wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); }
      catch (e) { console.error('[swellsurf] upgrade', e.message); try { socket.destroy(); } catch (_) {} }
    },
    status() { let inRooms = 0; for (const r of rooms.values()) inRooms += r.players.size; return { players: [...players].filter(p => p.authed).length, inRooms, beaches: rooms.size }; },
    list() { return [...players].filter(p => p.authed).map(p => ({ name: p.name, room: p.room ? 'SwellSurf beach ' + p.room.code : p.solo ? 'SwellSurf championship' : 'SwellSurf', kills: 0, owner: false })); },
    findByName(lower) { for (const p of byUid.values()) if (p.name.toLowerCase() === lower) return { uid: p.uid, name: p.name }; return null; },
    kick(uid, code) { const p = byUid.get(uid); if (!p) return false; send(p, { t: 'err', code: code || 'banned' }); leaveRoom(p); setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 300); return true; },
  };
};
module.exports.SURF_PROTO = SURF_PROTO;
