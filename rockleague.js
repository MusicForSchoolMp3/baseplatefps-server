'use strict';
// RockLeague game server: 1v1 car football matches.
// It shares the Baseplate FPS server's web address and sign-in checks, but has its own connections
// (on the /rl path), its own rooms and its own game loop, and every handler is wrapped so that a
// problem in here can never take the FPS game down with it.
//
// The server runs the real match. Each player's browser sends its controls 120 times a second (in
// small batches); the server uses exactly one set of controls per player per physics step, so going
// faster than everyone else is impossible, and it sends the true state of the match back 30 times a
// second. Browsers predict ahead from that so driving feels instant, and correct themselves to it.

const { WebSocketServer } = require('ws');
const P = require('./rl-physics.js');

const RL_PROTO = 1;
const MATCH_S = 300;                     // five minute matches
const COUNT_S = 3;                       // kickoff countdown
const GOAL_S = 3;                        // celebration after a goal
const ZERO_WAIT_S = 6;                   // at 0:00 the match ends when the ball next touches the ground (or after this long)
const SNAP_EVERY = 4;                    // 120 / 4 = 30 snapshots a second
const QUEUE_MAX = 36;                    // controls a player may have waiting (0.3 s); older ones are dropped
const STARVE_IDLE = 18;                  // no controls arriving for 0.15 s: let go of everything
const MAX_ROOMS = 60;
const BODIES = ['breaker', 'dune', 'pebble'];
const ACCENTS = ['#f5f5f5', '#1c1c1c', '#ffd23f', '#3fd17a', '#b56cff', '#ff5fa2', '#4fd8ff', '#ff7a2f'];
const STAT_KEYS = ['played', 'wins', 'losses', 'goals', 'shots', 'saves', 'demos', 'mvps'];

module.exports = function createRockLeague(ctx) {
  const { verifyToken, modRec, knownNames, USER_RE, EMAIL_DOMAIN, DEV_TOKENS } = ctx;
  const getDb = () => ctx.getDb();
  const admin = ctx.admin;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const players = new Set();             // every RockLeague connection
  const byUid = new Map();
  const rooms = new Map();               // id -> room
  const codes = new Map();               // private code -> room
  const queue = [];                      // quick match
  const memStats = new Map();
  let nextId = 1, nextRoom = 1;
  const blank = () => Object.fromEntries(STAT_KEYS.map(k => [k, 0]));
  const safe = (fn, label) => (...a) => { try { return fn(...a); } catch (e) { console.error('[rockleague]', label, e && e.stack || e); } };

  function send(p, obj) {
    if (p.ws.readyState !== 1) return;
    if (p.ws.bufferedAmount > 256 * 1024) return;      // a player whose connection can't keep up just misses a snapshot
    try { p.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (_) {}
  }

  /* ---------- accounts ---------- */
  async function loadProfile(who) {
    const fromEmail = String(who.email).split('@')[0];
    let name = who.devName || fromEmail, banned = !!(modRec.get(who.uid) || {}).banned;
    const stats = Object.assign(blank(), memStats.get(who.uid) || {});
    const db = getDb();
    if (db) {
      try {
        const [un, mod, st] = await Promise.all(['username', 'mod', 'rockleague/stats'].map(k => db.ref('users/' + who.uid + '/' + k).once('value').then(s => s.val())));
        if (typeof un === 'string' && un.toLowerCase() === fromEmail) name = un;
        if (mod && typeof mod === 'object') { if (!modRec.has(who.uid)) modRec.set(who.uid, { banned: !!mod.banned, tamperAt: Number(mod.tamperAt) || 0 }); banned = !!(modRec.get(who.uid) || {}).banned; }
        if (st && typeof st === 'object') for (const k of STAT_KEYS) stats[k] = Number(st[k]) || 0;
      } catch (e) { console.warn('[rockleague] could not read profile', who.uid, e.message); }
    }
    memStats.set(who.uid, stats);
    if (!USER_RE.test(name)) name = (fromEmail.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)) || 'Player';
    return { name, stats, banned };
  }
  function saveStats(uid, delta) {
    const s = memStats.get(uid) || blank();
    for (const k of Object.keys(delta)) s[k] = (s[k] || 0) + delta[k];
    memStats.set(uid, s);
    const db = getDb();
    if (db && admin) {
      const upd = {};
      for (const k of Object.keys(delta)) if (delta[k]) upd[k] = admin.database.ServerValue.increment(delta[k]);
      if (Object.keys(upd).length) db.ref('users/' + uid + '/rockleague/stats').update(upd).catch(e => console.warn('[rockleague] stats not saved for', uid, e.message));
    }
  }

  /* ---------- rooms ---------- */
  function makeCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let n = 0; n < 50; n++) { let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; if (!codes.has(c)) return c; }
    return null;
  }
  function newRoom(isPrivate) {
    if (rooms.size >= MAX_ROOMS) return null;
    const room = { id: nextRoom++, code: isPrivate ? makeCode() : null, isPrivate, seats: [null, null], world: P.newWorld(), phase: 'wait', pt: 0,
      clock: MATCH_S * 120, ot: false, score: [0, 0], ev: [], lastTouch: null, st: {}, rematch: new Set(), zeroWait: 0, startTick: 0, forfeit: null, mvp: null };
    if (isPrivate && !room.code) return null;
    room.world.ball.p = [0, P.BALL.r, 0];
    rooms.set(room.id, room);
    if (room.code) codes.set(room.code, room);
    return room;
  }
  function closeRoom(room) {
    rooms.delete(room.id);
    if (room.code) codes.delete(room.code);
  }
  const seated = room => room.seats.filter(Boolean);
  function roomInfo(room) {
    return { t: 'room', code: room.code, priv: room.isPrivate, phase: room.phase,
      seats: room.seats.map(p => p ? { id: p.cid, name: p.name, team: p.team, body: p.car.body, accent: p.car.accent } : null) };
  }
  function broadcast(room, obj) { const s = JSON.stringify(obj); for (const p of seated(room)) send(p, s); }
  function seat(room, p, team) {
    room.seats[team] = p; p.room = room; p.team = team;
    p.q = []; p.ack = p.lastSeq; p.last = P.IDLE; p.starve = 0;
    const c = P.newCar(p.cid, team);
    room.world.cars = room.world.cars.filter(x => x.id !== p.cid).concat(c);
    room.world.cars.sort((a, b) => a.team - b.team);
    const s = room.seats[1 - team];
    // a fresh car sits on its own half until the match starts
    Object.assign(c, { p: [0, P.CAR.ride, team === 0 ? -30 : 30], q: team === 0 ? [0, 0, 0, 1] : [0, 1, 0, 0] });
    if (s) startMatch(room);
    else { room.phase = 'wait'; broadcast(room, roomInfo(room)); }
  }
  function startMatch(room) {
    room.score = [0, 0]; room.clock = MATCH_S * 120; room.ot = false; room.zeroWait = 0; room.forfeit = null; room.mvp = null;
    room.rematch.clear(); room.lastTouch = null; room.statsSaved = false;
    room.st = {}; for (const p of seated(room)) room.st[p.cid] = { goals: 0, shots: 0, saves: 0, demos: 0, score: 0, lastShot: -999 };
    room.startTick = room.world.tick;
    kickoff(room);
    broadcast(room, roomInfo(room));
  }
  function kickoff(room) {
    P.kickoffPlace(room.world, Math.floor(Math.random() * P.KICKOFFS.length));
    room.phase = 'count'; room.pt = COUNT_S * 120; room.lastTouch = null;
    room.ev.push({ t: 'kickoff' });
  }
  function leaveRoom(p, why) {
    const room = p.room; if (!room) return;
    p.room = null;
    room.seats[p.team] = null;
    room.world.cars = room.world.cars.filter(c => c.id !== p.cid);
    const other = seated(room)[0];
    const live = room.phase === 'count' || room.phase === 'play' || room.phase === 'goal';
    if (live && other) {
      // leaving a match in progress forfeits it
      room.forfeit = p.cid;
      endMatch(room, other.team, p);
    }
    if (!other) { closeRoom(room); return; }
    if (room.isPrivate) {
      // the host keeps the room and its code, and warms up until someone else joins
      room.phase = 'wait'; room.rematch.clear();
      room.world.ball = { p: [0, P.BALL.r + 4, 0], v: [0, 0, 0], w: [0, 0, 0] };
      send(other, { t: 'left', name: p.name, why }); broadcast(room, roomInfo(room));
    } else {
      // a quick match ends when someone leaves; the other player goes back to the menu
      send(other, { t: 'left', name: p.name, why }); broadcast(room, roomInfo(room));
      other.room = null; closeRoom(room);
    }
  }
  function endMatch(room, winner, leaver) {
    if (room.phase === 'over') return;
    room.phase = 'over'; room.pt = 0;
    const list = seated(room).concat(leaver ? [leaver] : []);
    // the player of the match: the winner, unless the loser outplayed them by a long way
    let mvp = null; for (const p of list) { const s = room.st[p.cid]; if (!s) continue; s.score = s.goals * 100 + s.shots * 20 + s.saves * 50 + s.demos * 15; }
    const w = list.find(p => p.team === winner); if (w) mvp = w.cid;
    room.mvp = mvp;
    if (!room.statsSaved) {
      room.statsSaved = true;
      for (const p of list) {
        const s = room.st[p.cid] || {};
        const won = p.team === winner;
        saveStats(p.uid, { played: 1, wins: won ? 1 : 0, losses: won ? 0 : 1, goals: s.goals || 0, shots: s.shots || 0, saves: s.saves || 0, demos: s.demos || 0, mvps: mvp === p.cid ? 1 : 0 });
      }
    }
    const res = { t: 'end', winner, score: room.score.slice(), forfeit: leaver ? leaver.name : null, mvp,
      stats: list.map(p => ({ id: p.cid, name: p.name, team: p.team, ...(room.st[p.cid] || {}) })) };
    room.ev.push({ t: 'end' });
    broadcast(room, res);
    for (const p of seated(room)) send(p, { t: 'me', stats: memStats.get(p.uid) || blank() });
  }

  /* ---------- the game loop ---------- */
  const groundTouch = b => P.inside(b.p[0], b.p[1], b.p[2]) < P.BALL.r + 0.06 && b.p[1] < P.BALL.r + 0.1;
  function tickRoom(room) {
    const w = room.world, inputs = {};
    for (const p of seated(room)) {
      let inp;
      if (p.q.length) { const e = p.q.shift(); p.ack = e.s; p.last = e.inp; p.starve = 0; inp = e.inp; }
      else { p.starve++; inp = p.starve > STARVE_IDLE ? P.IDLE : p.last; }
      inputs[p.cid] = inp;
    }
    const frozen = room.phase === 'count', noBall = room.phase === 'goal' || room.phase === 'over';
    const ballBefore = { p: w.ball.p.slice(), v: w.ball.v.slice(), w: w.ball.w.slice() };
    const ev = P.step(w, inputs, frozen, noBall);
    for (const e of ev) {
      if (e.t === 'touch') {
        const car = w.cars.find(c => c.id === e.id);
        room.lastTouch = { id: e.id, team: car ? car.team : -1, tick: w.tick };
        room.ev.push({ t: 'touch', id: e.id, s: Math.round(e.s * 10) / 10 });
        if (room.phase === 'play' && car && room.st[e.id]) {
          const st = room.st[e.id];
          // a save: the ball was going into your own goal, and now it isn't
          const before = P.ballFuture(ballBefore, 2.5), after = P.ballFuture(w.ball, 2.5);
          if (before === 1 - car.team && after !== 1 - car.team) { st.saves++; room.ev.push({ t: 'save', id: e.id }); }
          else if (after === car.team && w.tick - st.lastShot > 120) { st.shots++; st.lastShot = w.tick; room.ev.push({ t: 'shot', id: e.id }); }
        }
      } else if (e.t === 'demo') {
        if (room.st[e.id] && room.phase === 'play') room.st[e.id].demos++;
        room.ev.push({ t: 'demo', id: e.id, victim: e.victim, p: e.p.map(v => Math.round(v * 100) / 100) });
      }
    }
    if (room.phase === 'count') { if (--room.pt <= 0) { room.phase = 'play'; room.ev.push({ t: 'go' }); } }
    else if (room.phase === 'play') {
      const g = P.goalCheck(w.ball);
      if (g >= 0) return scoreGoal(room, g);
      if (room.ot) room.clock++;
      else if (room.clock > 0) room.clock--;
      else {
        // 0:00 — play on until the ball touches the ground
        room.zeroWait++;
        if (groundTouch(w.ball) || room.zeroWait > ZERO_WAIT_S * 120) {
          if (room.score[0] !== room.score[1]) endMatch(room, room.score[0] > room.score[1] ? 0 : 1);
          else { room.ot = true; room.clock = 0; room.ev.push({ t: 'overtime' }); kickoff(room); }
        }
      }
    } else if (room.phase === 'goal') {
      if (--room.pt <= 0) {
        if (room.ot || (room.clock <= 0 && room.score[0] !== room.score[1])) endMatch(room, room.score[0] > room.score[1] ? 0 : 1);
        else if (room.clock <= 0) { room.ot = true; room.clock = 0; room.ev.push({ t: 'overtime' }); kickoff(room); }
        else kickoff(room);
      }
    } else if (room.phase === 'wait') {
      // warming up alone: a goal just puts the ball back
      if (P.goalCheck(w.ball) >= 0) { w.ball = { p: [0, P.BALL.r + 4, 0], v: [0, 0, 0], w: [0, 0, 0] }; room.ev.push({ t: 'reset' }); }
    }
  }
  function scoreGoal(room, team) {
    const w = room.world, b = w.ball;
    room.score[team]++;
    const lt = room.lastTouch, scorer = lt && lt.team === team ? seated(room).find(p => p.cid === lt.id) : null;
    if (scorer && room.st[scorer.cid]) room.st[scorer.cid].goals++;
    room.ev.push({ t: 'goal', team, by: scorer ? scorer.name : null, kmh: Math.round(Math.hypot(...b.v) * 3.6), p: b.p.map(v => Math.round(v * 100) / 100) });
    room.phase = 'goal'; room.pt = GOAL_S * 120;
  }
  function snapshot(room) {
    const w = room.world;
    const li = {}; for (const p of seated(room)) li[p.cid] = P.packInput(p.last);
    const base = { t: 's', k: w.tick, ph: room.phase, pt: room.pt, cl: room.clock, ot: room.ot ? 1 : 0, sc: room.score,
      c: w.cars.map(P.packCar), b: P.packBall(w.ball), pd: w.pads.map(v => Math.round(v * 10) / 10), li, ev: room.ev };
    room.ev = [];
    for (const p of seated(room)) { base.a = p.ack; base.qd = p.q.length; send(p, base); }
  }
  let last = Date.now(), acc = 0;
  setInterval(safe(() => {
    const now = Date.now(); acc += (now - last) / 1000; last = now;
    if (acc > 0.25) acc = 0.25;                         // after a stall, catch up a little and move on
    while (acc >= P.DT) {
      acc -= P.DT;
      for (const room of rooms.values()) {
        if (!seated(room).length) continue;
        try { tickRoom(room); if (room.world.tick % SNAP_EVERY === 0) snapshot(room); }
        catch (e) { console.error('[rockleague] room error', e && e.stack || e); try { for (const p of seated(room)) { send(p, { t: 'err', code: 'room' }); p.room = null; } closeRoom(room); } catch (_) {} }
      }
    }
  }, 'loop'), 4);

  /* ---------- messages ---------- */
  function unqueue(p) { const i = queue.indexOf(p); if (i >= 0) queue.splice(i, 1); }
  async function onHello(p, msg) {
    if (msg.v !== RL_PROTO) { send(p, { t: 'err', code: 'version' }); setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 300); return; }
    let who; try { who = await verifyToken(msg.token); } catch (_) { send(p, { t: 'err', code: 'auth' }); setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 300); return; }
    const prof = await loadProfile(who);
    if (p.ws.readyState !== 1) return;
    if (prof.banned) { send(p, { t: 'err', code: 'banned' }); setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 400); return; }
    const old = byUid.get(who.uid);
    if (old && old !== p) { send(old, { t: 'err', code: 'elsewhere' }); if (old.room) leaveRoom(old, 'left'); unqueue(old); try { old.ws.close(); } catch (_) {} }
    p.uid = who.uid; p.name = prof.name; p.authed = true; byUid.set(p.uid, p);
    if (knownNames) knownNames.set(prof.name.toLowerCase(), p.uid);
    setCar(p, msg.car);
    send(p, { t: 'welcome', id: p.cid, name: p.name, stats: prof.stats, proto: RL_PROTO });
  }
  function setCar(p, car) {
    const c = car && typeof car === 'object' ? car : {};
    p.car = { body: BODIES.includes(c.body) ? c.body : 'breaker', accent: ACCENTS.includes(c.accent) ? c.accent : ACCENTS[0] };
  }
  function onInputs(p, msg) {
    if (!p.room || !Array.isArray(msg.k) || msg.k.length > 8 || !Number.isInteger(msg.s) || msg.s < 0) return;
    for (let i = 0; i < msg.k.length; i++) {
      const s = msg.s + i;
      if (s <= p.lastSeq) continue;                      // already have it
      p.lastSeq = s;
      p.q.push({ s, inp: P.unpackInput(msg.k[i]) });
    }
    if (p.q.length > QUEUE_MAX) p.q.splice(0, p.q.length - QUEUE_MAX + 4);   // far behind: skip ahead rather than lag
  }
  function onMessage(p, raw) {
    const now = Date.now();
    if (now - p.msgWindow > 1000) { p.msgWindow = now; p.msgs = 0; }
    if (++p.msgs > 160) return;                           // flood guard
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (!p.authed) { if (msg.t === 'hello' && !p.helloSeen) { p.helloSeen = true; onHello(p, msg).catch(e => { console.error('[rockleague] hello', e); try { p.ws.close(); } catch (_) {} }); } return; }
    switch (msg.t) {
      case 'i': onInputs(p, msg); break;
      case 'car': if (!p.room) setCar(p, msg.car); break;
      case 'quick': {
        if (p.room) return;
        unqueue(p);
        const other = queue.find(o => o.uid !== p.uid && o.ws.readyState === 1);
        if (other) {
          unqueue(other);
          const room = newRoom(false);
          if (!room) { send(p, { t: 'err', code: 'full' }); return; }
          const first = Math.random() < 0.5;
          seat(room, first ? p : other, 0);
          seat(room, first ? other : p, 1);
        } else { queue.push(p); send(p, { t: 'queue', n: queue.length }); }
        break;
      }
      case 'cancel': unqueue(p); send(p, { t: 'unqueued' }); break;
      case 'create': {
        if (p.room) return;
        unqueue(p);
        const room = newRoom(true);
        if (!room) { send(p, { t: 'err', code: 'full' }); return; }
        seat(room, p, 0);
        break;
      }
      case 'join': {
        if (p.room) return;
        const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
        const room = codes.get(code);
        if (!room) { send(p, { t: 'err', code: 'nocode' }); return; }
        const free = room.seats.indexOf(null);
        if (free < 0) { send(p, { t: 'err', code: 'roomfull' }); return; }
        if (seated(room).some(o => o.uid === p.uid)) return;
        unqueue(p);
        seat(room, p, free);
        break;
      }
      case 'rematch': {
        const room = p.room; if (!room || room.phase !== 'over') return;
        room.rematch.add(p.cid);
        broadcast(room, { t: 'rematch', ids: [...room.rematch] });
        if (seated(room).length === 2 && seated(room).every(o => room.rematch.has(o.cid))) startMatch(room);
        break;
      }
      case 'leave': if (p.room) leaveRoom(p, 'left'); unqueue(p); send(p, { t: 'menu' }); break;
      case 'dbg': {                                       // local testing only: DEV_TOKENS is never set on Render
        if (!DEV_TOKENS || !p.room) return;
        const nums = a => Array.isArray(a) && a.length === 3 && a.every(v => typeof v === 'number' && isFinite(v));
        if (nums(msg.bp)) p.room.world.ball = { p: msg.bp.slice(), v: nums(msg.bv) ? msg.bv.slice() : [0, 0, 0], w: [0, 0, 0] };
        if (Number.isInteger(msg.clock)) p.room.clock = msg.clock;
        break;
      }
      case 'chat': {                                      // quick chat: fixed phrases only
        const room = p.room; const i = msg.i | 0;
        if (!room || i < 0 || i > 11 || now - (p.chatAt || 0) < 900) return;
        p.chatAt = now; broadcast(room, { t: 'chat', id: p.cid, name: p.name, i });
        break;
      }
    }
  }

  wss.on('connection', ws => {
    const p = { ws, cid: 'c' + (nextId++), uid: '', name: '', authed: false, room: null, team: -1, car: { body: 'breaker', accent: ACCENTS[0] },
      q: [], lastSeq: -1, ack: -1, last: P.IDLE, starve: 0, msgs: 0, msgWindow: Date.now() };
    players.add(p);
    const helloTimer = setTimeout(() => { if (!p.authed) try { ws.close(); } catch (_) {} }, 15000);
    ws.on('pong', () => { ws._rlMissed = false; });
    ws.on('message', safe(raw => onMessage(p, raw), 'message'));
    ws.on('close', safe(() => {
      clearTimeout(helloTimer); players.delete(p); unqueue(p);
      if (p.room) leaveRoom(p, 'disconnected');
      if (byUid.get(p.uid) === p) byUid.delete(p.uid);
    }, 'close'));
    ws.on('error', () => {});
  });
  setInterval(safe(() => {
    for (const ws of wss.clients) {
      if (ws._rlMissed) { ws.terminate(); continue; }
      ws._rlMissed = true;
      try { ws.ping(); } catch (_) {}
    }
  }, 'heartbeat'), 20000);

  return {
    handleUpgrade(req, socket, head) {
      try { wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); }
      catch (e) { console.error('[rockleague] upgrade', e.message); try { socket.destroy(); } catch (_) {} }
    },
    status() {
      let inMatch = 0; for (const r of rooms.values()) inMatch += seated(r).length;
      return { players: [...players].filter(p => p.authed).length, inMatch, queue: queue.length, matches: rooms.size };
    },
    list() { return [...players].filter(p => p.authed).map(p => ({ name: p.name, room: p.room ? (p.room.code ? 'RockLeague ' + p.room.code : 'RockLeague') : 'RockLeague menu', kills: 0, owner: false })); },
    findByName(lower) { for (const p of byUid.values()) if (p.name.toLowerCase() === lower) return { uid: p.uid, name: p.name }; return null; },
    kick(uid, code) {
      const p = byUid.get(uid); if (!p) return false;
      send(p, { t: 'err', code: code || 'banned' });
      try { if (p.room) leaveRoom(p, 'banned'); unqueue(p); } catch (_) {}
      setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 300);
      return true;
    },
  };
};
module.exports.RL_PROTO = RL_PROTO;
module.exports.BODIES = BODIES;
module.exports.ACCENTS = ACCENTS;
