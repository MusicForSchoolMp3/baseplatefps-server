'use strict';
// Highway Bike game server: public highways where up to 20 riders share one endless road and the same traffic.
// It shares the arcade server's address and sign-in checks, but has its own connections (on /hb), and every handler
// is wrapped so a problem in here can never affect the other games.
//
// The traffic runs here (hb-sim.js, the same drivers the website uses for solo rides), so everyone on a highway sees
// the same cars, the same honks and the same crashes. Riders send where they are ten or so times a second; the server
// passes that on to the others and tells the drivers where everyone is. Teleporting puts you near a rider, not on them.
// The owner can watch anyone without being seen (no rider, not in any list).

const { WebSocketServer } = require('ws');
const H = require('./hb-sim.js');

const HB_PROTO = 1;
const HW_MAX = 20, TICK_HZ = 30, SEND_HZ = 10, NEAR_BEHIND = 260, NEAR_AHEAD = 680;

module.exports = function createHB(ctx) {
  const { verifyToken, modRec, knownNames } = ctx;
  const getDb = () => ctx.getDb();
  const isOwner = ctx.isOwnerWho || (() => false);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const players = new Set(), byUid = new Map(), highways = new Map();
  let nextId = 1, nextHw = 1;
  const safe = (fn, label) => (...a) => { try { return fn(...a); } catch (e) { console.error('[highwaybike]', label, e && e.stack || e); } };
  const send = (p, obj) => { if (!p || p.ws.readyState !== 1 || p.ws.bufferedAmount > 256 * 1024) return; try { p.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (_) {} };
  const num = (v, lo, hi) => typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
  const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
  const close = (p, ms) => setTimeout(() => { try { p.ws.close(); } catch (_) {} }, ms || 300);

  function cleanLook(l) { l = l && typeof l === 'object' ? l : {}; const i = (v, n) => Math.max(0, Math.min(n - 1, v | 0)); return { liv: i(l.liv, 8), suit: i(l.suit, 8), helm: i(l.helm, 8) }; }
  async function loadProfile(who) {
    const fromEmail = String(who.email).split('@')[0];
    let name = who.devName || fromEmail, banned = !!(modRec.get(who.uid) || {}).banned;
    const db = getDb();
    if (db) {
      try {
        const [un, mod] = await Promise.all(['username', 'mod'].map(k => db.ref('users/' + who.uid + '/' + k).once('value').then(s => s.val())));
        if (typeof un === 'string' && un.toLowerCase() === fromEmail) name = un;
        if (mod && typeof mod === 'object') { if (!modRec.has(who.uid)) modRec.set(who.uid, { banned: !!mod.banned, tamperAt: Number(mod.tamperAt) || 0 }); banned = !!(modRec.get(who.uid) || {}).banned; }
      } catch (e) { console.warn('[highwaybike] could not read profile', who.uid, e.message); }
    }
    if (!/^[A-Za-z0-9]{3,20}$/.test(name)) name = (fromEmail.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)) || 'Rider';
    return { name, banned };
  }

  /* ---------- highways ---------- */
  function newHighway() {
    const hw = { id: nextHw++, riders: new Set(), watchers: new Set(), evq: [] };
    hw.sim = H.createTraffic({ ev: (k, c, a) => { hw.evq.push([k, c.id, a == null ? 0 : a]); if (hw.evq.length > 400) hw.evq.shift(); } });
    highways.set(hw.id, hw); return hw;
  }
  function pickHighway() {
    let best = null;
    for (const hw of highways.values()) if (hw.riders.size < HW_MAX && (!best || hw.riders.size > best.riders.size)) best = hw;   // fill highways up so people meet
    return best || newHighway();
  }
  function dropHighwayIfEmpty(hw) { if (!hw.riders.size && !hw.watchers.size) { hw.sim.clear(); highways.delete(hw.id); } }
  function joinHw(p, hw) {
    if (p.hw === hw) return;
    leaveHw(p, true);
    p.hw = hw; hw.riders.add(p); p.known = new Map();
    send(p, { t: 'hw', hw: hw.id });
    roster();
  }
  function leaveHw(p, quiet) {
    const hw = p.hw; if (!hw) return;
    hw.riders.delete(p); p.hw = null;
    for (const w of hw.watchers) if (w.watch === p) send(w, { t: 'hw', hw: 0 });
    dropHighwayIfEmpty(hw);
    if (!quiet) roster();
  }
  // everyone riding, on every highway (for the teleport list). Watchers are never in it
  let rosterT = null;
  function roster() {
    clearTimeout(rosterT);
    rosterT = setTimeout(safe(() => {
      const list = [...players].filter(p => p.authed && p.hw && !p.watcher).map(p => ({ id: p.cid, n: p.name, hw: p.hw.id, look: p.look }));
      const msg = JSON.stringify({ t: 'roster', list });
      for (const p of players) if (p.authed) send(p, msg);
    }, 'roster'), 80);
  }

  /* ---------- the traffic and the riders, thirty times a second ---------- */
  let sendAcc = 0;
  setInterval(safe(() => {
    const dt = 1 / TICK_HZ;
    for (const hw of highways.values()) {
      const wins = [], obs = [], ranges = [];
      for (const p of hw.riders) {
        const st = p.st; if (!st) continue;
        wins.push({ key: p.cid, s: st.s, v: st.c ? 0 : st.v });
        ranges.push([st.s - 200, st.s + 600]);
        if (!st.c) obs.push({ s: st.s, d: st.d, v: st.v, L: 2.1, W: 0.9, player: true });
        if (st.ob) for (const o of st.ob) obs.push({ s: o[0], d: o[1], v: 0, L: 2.2, W: 1.4 });
      }
      hw.sim.manage(wins, dt, 1);
      hw.sim.step(dt, obs, ranges);
    }
    sendAcc += dt;
    if (sendAcc >= 1 / SEND_HZ - 1e-6) { sendAcc = 0; for (const hw of highways.values()) sendHighway(hw); }
  }, 'tick'), 1000 / TICK_HZ);

  function riderEntry(q) {
    const st = q.st;
    const e = [q.cid, r2(st.s), r2(st.d), r2(st.h), r2(st.v), r3(st.psi), r3(st.lean), r3(st.pitch), r3(st.whip), st.tr, r2(st.sup), st.c ? 1 : 0, st.air ? 1 : 0];
    if (st.c) e.push(st.rag || 0, st.wk || 0);
    return e;
  }
  function sendHighway(hw) {
    const now = Date.now(), evq = hw.evq; hw.evq = [];
    const riders = [...hw.riders].filter(q => q.st);
    const entries = new Map(riders.map(q => [q, riderEntry(q)]));
    const viewers = [...hw.riders, ...[...hw.watchers].filter(w => w.watch && w.watch.hw === hw)];
    for (const p of viewers) {
      const focus = p.watcher ? p.watch.st : p.st;
      if (!focus) continue;
      const s0 = focus.s - NEAR_BEHIND, s1 = focus.s + NEAR_AHEAD, list = [], nw = [], seen = new Map();
      for (const c of hw.sim.cars) {
        if (c.s < s0 || c.s > s1) continue;
        const fl = (c.brake > 0 ? 1 : 0) | (c.sig < 0 ? 2 : 0) | (c.sig > 0 ? 4 : 0) | (c.hazard ? 8 : 0) | (c.wrecked ? 16 : 0) | (c.fire ? 32 : 0);
        list.push([c.id, r2(c.s), r2(c.d), r2(c.v), r3(c.psi), fl, r2(c.dmg), r3(c.roll)]);
        seen.set(c.id, c.dents.length);
        if (!p.known.has(c.id)) nw.push([c.id, H.TYPE_LIST.indexOf(c.type), c.ci, c.dents]);
        else if (p.known.get(c.id) < c.dents.length) nw.push([c.id, -2, 0, c.dents.slice(p.known.get(c.id))]);   // dents it missed
      }
      const gone = []; for (const id of p.known.keys()) if (!seen.has(id)) gone.push(id);
      const evs = evq.filter(e => seen.has(e[1]) && !(e[0] === 'dent' && nw.some(n => n[0] === e[1])));
      p.known = seen;
      const rs = riders.filter(q => q !== p).map(q => entries.get(q));
      const msg = { t: 'snap', tm: now, c: list, r: rs };
      if (nw.length) msg.nw = nw; if (gone.length) msg.g = gone; if (evs.length) msg.e = evs;
      send(p, msg);
    }
  }

  /* ---------- messages ---------- */
  async function onHello(p, msg) {
    if (msg.v !== HB_PROTO || msg.sim !== H.VERSION) { send(p, { t: 'err', code: 'version', game: 'highwaybike' }); close(p); return; }
    let who; try { who = await verifyToken(msg.token); } catch (_) { send(p, { t: 'err', code: 'auth' }); close(p); return; }
    const prof = await loadProfile(who);
    if (p.ws.readyState !== 1) return;
    if (prof.banned) { send(p, { t: 'err', code: 'banned' }); close(p, 400); return; }
    p.uid = who.uid; p.name = prof.name; p.look = cleanLook(msg.look);
    // the owner watching someone: checked against the verified sign-in, never anything the browser says
    if (typeof msg.watch === 'string' && msg.watch) {
      if (!isOwner(who)) { send(p, { t: 'err', code: 'auth' }); close(p); return; }
      const lower = msg.watch.toLowerCase().slice(0, 20);
      const target = [...players].find(q => q.authed && !q.watcher && q.name.toLowerCase() === lower);
      p.authed = true; p.watcher = true;
      if (!target) { send(p, { t: 'welcome', game: 'highwaybike', id: p.cid, name: p.name, watch: 0, proto: HB_PROTO }); return; }
      p.watch = target; p.known = new Map();
      if (target.hw) target.hw.watchers.add(p);
      send(p, { t: 'welcome', game: 'highwaybike', id: p.cid, name: p.name, watch: target.cid, wname: target.name, look: target.look, hw: target.hw ? target.hw.id : 0, proto: HB_PROTO });
      roster();
      return;
    }
    const old = byUid.get(who.uid);
    if (old && old !== p) { send(old, { t: 'err', code: 'elsewhere' }); leaveHw(old); try { old.ws.close(); } catch (_) {} }
    p.authed = true; byUid.set(p.uid, p);
    if (knownNames) knownNames.set(prof.name.toLowerCase(), p.uid);
    send(p, { t: 'welcome', game: 'highwaybike', id: p.cid, name: p.name, now: Date.now(), proto: HB_PROTO });
    roster();
  }
  function onState(p, m) {
    if (!p.hw) return;
    const st = p.st || (p.st = {});
    st.s = num(m.s, -1e7, 1e8); st.d = num(m.d, -12, 10); st.h = num(m.h, -2, 40); st.v = num(m.v, 0, 120);
    st.psi = num(m.psi, -3.2, 3.2); st.lean = num(m.lean, -1.5, 1.5); st.pitch = num(m.pitch, -3.2, 3.2); st.whip = num(m.whip, 0, 1);
    st.tr = ['k2k', 'nac', 'kick', 'stand'].includes(m.tr) ? m.tr : ''; st.sup = num(m.sup, 0, 1);
    st.c = !!m.c; st.air = !!m.air;
    st.rag = st.c && Array.isArray(m.rag) && m.rag.length === 48 ? m.rag.map(x => r2(num(x, -1e8, 1e8))) : 0;
    st.wk = st.c && Array.isArray(m.wk) && m.wk.length === 7 ? m.wk.map(x => r3(num(x, -1e8, 1e8))) : 0;
    st.ob = Array.isArray(m.ob) ? m.ob.slice(0, 3).filter(o => Array.isArray(o)).map(o => [num(o[0], -1e7, 1e8), num(o[1], -12, 10)]) : null;
  }
  function carNear(p, id, range) {
    if (!p.hw || !p.st) return null;
    const c = p.hw.sim.byId.get(id | 0);
    return c && Math.abs(c.s - p.st.s) < range && Math.abs(c.d - p.st.d) < 6 ? c : null;
  }
  function onMessage(p, raw) {
    const now = Date.now();
    if (now - p.msgWindow > 1000) { p.msgWindow = now; p.msgs = 0; p.hits = 0; }
    if (++p.msgs > 40) return;                               // flood guard (a rider sends about 12 a second)
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (!p.authed) { if (msg.t === 'hello' && !p.helloSeen) { p.helloSeen = true; onHello(p, msg).catch(e => { console.error('[highwaybike] hello', e); try { p.ws.close(); } catch (_) {} }); } return; }
    if (msg.t === 'ping') { send(p, { t: 'pong', c: num(msg.c, 0, 1e15), s: now }); return; }
    if (p.watcher) return;                                     // watchers only watch
    switch (msg.t) {
      case 'ride': if (!p.hw) { p.st = null; joinHw(p, pickHighway()); } break;          // onto a public highway
      case 'menu': if (p.hw) { leaveHw(p); p.st = null; } break;                           // back to the menu
      case 's': onState(p, msg); break;
      case 'hit': { if (++p.hits > 4) return; const c = carNear(p, msg.id, 40); if (c) p.hw.sim.hit(c, ['rear', 'hitfront', 'side'].includes(msg.k) ? msg.k : 'side', num(msg.sev, 0, 80), num(msg.pd, -12, 10), num(msg.ps, -1e7, 1e8)); break; }
      case 'brush': { if (++p.hits > 4) return; const c = carNear(p, msg.id, 30); if (c) p.hw.sim.brush(c, num(msg.sev, 0, 8), msg.side > 0 ? 1 : -1, num(msg.ps, -1e7, 1e8)); break; }
      case 'goto': {
        if (now - (p.gotoAt || 0) < 1500) return; p.gotoAt = now;
        const t = [...players].find(q => q.cid === msg.id && q.authed && !q.watcher && q.hw && q.st);
        if (!t || t === p) { send(p, { t: 'err', code: 'gone' }); return; }
        if (t.hw !== p.hw) { if (t.hw.riders.size >= HW_MAX) { send(p, { t: 'err', code: 'full' }); return; } joinHw(p, t.hw); }
        // near them, not on them: a bit behind, in the lane next to theirs, at their speed
        const lane = Math.max(0, Math.min(3, Math.round((t.st.d + 5.4) / 3.6))), nl = lane === 0 ? 1 : lane === 3 ? 2 : lane + (Math.random() < 0.5 ? -1 : 1);
        const s = t.st.s - 35 - Math.random() * 15;
        for (const c of p.hw.sim.cars) if (Math.abs(c.s - s) < 12 && Math.abs(c.d - H.laneD(nl)) < 2.5) c.s += 25;
        send(p, { t: 'tp', s: r2(s), d: r2(H.laneD(nl)), v: r2(t.st.c ? 0 : t.st.v), hw: p.hw.id, n: t.name });
        break;
      }
      case 'horn': if (now - (p.hornAt || 0) > 600 && p.hw && p.st) { p.hornAt = now; for (const q of [...p.hw.riders, ...p.hw.watchers]) if (q !== p) send(q, { t: 'horn', id: p.cid }); } break;
      case 'look': if (now - (p.lookAt || 0) > 500) { p.lookAt = now; p.look = cleanLook(msg.look); roster(); } break;
    }
  }
  wss.on('connection', ws => {
    const p = { ws, cid: 'h' + (nextId++), uid: '', name: '', authed: false, hw: null, st: null, look: cleanLook(null), known: new Map(), watcher: false, watch: null, msgs: 0, msgWindow: Date.now() };
    players.add(p);
    const helloTimer = setTimeout(() => { if (!p.authed) try { ws.close(); } catch (_) {} }, 15000);
    ws.on('pong', () => { ws._hbMissed = false; });
    ws.on('message', safe(raw => onMessage(p, raw), 'message'));
    ws.on('close', safe(() => {
      clearTimeout(helloTimer); players.delete(p);
      if (p.watcher) { if (p.watch && p.watch.hw) { p.watch.hw.watchers.delete(p); dropHighwayIfEmpty(p.watch.hw); } return; }
      for (const w of players) if (w.watch === p) send(w, { t: 'watchend' });
      leaveHw(p); if (byUid.get(p.uid) === p) byUid.delete(p.uid);
    }, 'close'));
    ws.on('error', () => {});
  });
  // watchers follow their rider from highway to highway
  setInterval(safe(() => { for (const w of players) if (w.watcher && w.watch) { const hw = w.watch.hw; for (const h of highways.values()) if (h !== hw) h.watchers.delete(w); if (hw && !hw.watchers.has(w)) { hw.watchers.add(w); w.known = new Map(); send(w, { t: 'hw', hw: hw.id }); } } }, 'watchers'), 500);
  setInterval(safe(() => { for (const ws of wss.clients) { if (ws._hbMissed) { ws.terminate(); continue; } ws._hbMissed = true; try { ws.ping(); } catch (_) {} } }, 'heartbeat'), 20000);

  const riding = () => [...players].filter(p => p.authed && !p.watcher);
  return {
    handleUpgrade(req, socket, head) {
      try { wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); }
      catch (e) { console.error('[highwaybike] upgrade', e.message); try { socket.destroy(); } catch (_) {} }
    },
    status() { return { players: riding().length, highways: highways.size }; },
    list() { return riding().map(p => ({ name: p.name, game: 'highwaybike', room: p.hw ? 'Highway ' + p.hw.id : 'Highway Bike menu', kills: 0, owner: false })); },
    findByName(lower) { for (const p of byUid.values()) if (p.name.toLowerCase() === lower) return { uid: p.uid, name: p.name }; return null; },
    kick(uid, code) { const p = byUid.get(uid); if (!p) return false; send(p, { t: 'err', code: code || 'banned' }); leaveHw(p); close(p); return true; },
  };
};
module.exports.HB_PROTO = HB_PROTO;
