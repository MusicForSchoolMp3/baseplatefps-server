'use strict';
// Baseplate FPS game server.
// Runs every match: one big public battle royale plus private rooms with codes.
// Players sign in with Firebase; the server checks their sign-in, decides every hit, kill and
// zone tick, and saves each account's stats to the Firebase Realtime Database.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'baseplatefps-e1fc1';
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://baseplatefps-e1fc1-default-rtdb.asia-southeast1.firebasedatabase.app';
const DEV_TOKENS = process.env.DEV_TOKENS === '1';           // local testing only, never set this on Render
const PROTO = 2;
const EMAIL_DOMAIN = 'players.baseplatefps.game';
const USER_RE = /^[A-Za-z0-9]{3,20}$/;

const TICK_HZ = 15;
const COUNT_S = 8, GRACE_S = 25, SHRINK_S = 150, OVER_S = 8, R0 = 230, R1 = 14, ZONE_DPS = 4;
const PUBLIC_MAX = 50, PRIVATE_MAX = 16, MAP_HALF = 255;
const WEAPONS = {
  rifle:  { interval: 60 / 750, body: 20, head: 45, range: 330 },
  pistol: { interval: 60 / 420, body: 24, head: 55, range: 150, falloffAt: 40, falloff: 0.75 },
  sniper: { interval: 1.25,     body: 85, head: 150, range: 720 },
};
const WEAPON_LIST = ['rifle', 'pistol', 'sniper'];
const SWITCH_LOCK_MS = 900;                                  // client waits 1.0 s; a little slack for lag

/* ---------- Firebase ---------- */
let admin = null, db = null;
try {
  admin = require('firebase-admin');
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), databaseURL: DATABASE_URL, projectId: PROJECT_ID });
    db = admin.database();
    console.log('Firebase connected: stats will be saved.');
  } else {
    admin.initializeApp({ projectId: PROJECT_ID });
    console.warn('FIREBASE_SERVICE_ACCOUNT is not set: sign-ins are checked, but stats only last until the server restarts.');
  }
} catch (e) {
  console.error('Firebase setup failed:', e.message);
}

async function verifyToken(token) {
  if (DEV_TOKENS && typeof token === 'string' && token.startsWith('dev:')) {
    const [, uid, name, kills] = token.split(':');
    if (!uid || !USER_RE.test(name || '')) throw new Error('bad dev token');
    if (kills && !memStats.has(uid)) memStats.set(uid, Object.assign(blankStats(), { kills: Number(kills) || 0 }));
    return { uid, email: name.toLowerCase() + '@' + EMAIL_DOMAIN, devName: name };
  }
  if (!admin || typeof token !== 'string' || token.length > 4096) throw new Error('no auth');
  const d = await admin.auth().verifyIdToken(token);
  return { uid: d.uid, email: d.email || '' };
}

const memStats = new Map();   // uid -> stats, used when there's no database (and as a cache)
const blankStats = () => ({ kills: 0, deaths: 0, wins: 0, matches: 0, headshots: 0 });

async function loadProfile(who, requestedHead) {
  const fromEmail = String(who.email).split('@')[0];
  let name = who.devName || fromEmail, head = requestedHead === 'fish' ? 'fish' : 'none';
  let stats = Object.assign(blankStats(), memStats.get(who.uid) || {});
  if (db) {
    try {
      const u = (await db.ref('users/' + who.uid).once('value')).val() || {};
      if (typeof u.username === 'string' && u.username.toLowerCase() === fromEmail) name = u.username;
      if (u.avatar && typeof u.avatar.head === 'string') head = u.avatar.head === 'fish' ? 'fish' : 'none';
      if (u.stats && typeof u.stats === 'object') for (const k of Object.keys(blankStats())) stats[k] = Number(u.stats[k]) || 0;
    } catch (e) { console.warn('Could not read profile', who.uid, e.message); }
  }
  memStats.set(who.uid, stats);
  if (!USER_RE.test(name)) name = (fromEmail.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)) || 'Player';
  return { name, stats, head };
}

function addStats(uid, delta) {
  const s = memStats.get(uid) || blankStats();
  for (const k of Object.keys(delta)) s[k] = (s[k] || 0) + delta[k];
  memStats.set(uid, s);
  if (db) {
    const upd = {};
    for (const k of Object.keys(delta)) upd[k] = admin.database.ServerValue.increment(delta[k]);
    db.ref('users/' + uid + '/stats').update(upd).catch(e => console.warn('Stats not saved for', uid, e.message));
  }
}

/* ---------- helpers ---------- */
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r2 = v => Math.round(v * 100) / 100;
const vec3 = (a, lim) => Array.isArray(a) ? [clamp(num(a[0]), -lim, lim), clamp(num(a[1]), -lim, lim), clamp(num(a[2]), -lim, lim)] : null;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() { let s = ''; const b = crypto.randomBytes(5); for (let i = 0; i < 5; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length]; return s; }
function send(p, msg) { if (p.ws.readyState === 1) { try { p.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch (_) {} } }

/* ---------- rooms ---------- */
const rooms = new Map();         // code -> room ('PUBLIC' is the big match)
const byUid = new Map();         // uid -> player (one connection per account)
let nextId = 1;

function makeRoom(code, isPublic) {
  const room = { code, isPublic, max: isPublic ? PUBLIC_MAX : PRIVATE_MAX, players: new Map(),
    m: { id: 0, phase: 'wait', t: 0, cx: 0, cz: 0, w: '' }, zoneK: 0 };
  rooms.set(code, room);
  return room;
}
makeRoom('PUBLIC', true);

function zoneOf(room) {
  const m = room.m;
  if (m.phase === 'live') room.zoneK = clamp((m.t - GRACE_S) / SHRINK_S, 0, 1);
  else if (m.phase !== 'over') room.zoneK = 0;
  const k = room.zoneK;
  return { x: m.cx * k, z: m.cz * k, r: R0 + (R1 - R0) * k, k };
}
function randomSpawn() {
  const a = Math.random() * Math.PI * 2, d = 170 * Math.sqrt(Math.random());
  const x = Math.cos(a) * d, z = Math.sin(a) * d;
  return { p: [r2(x), 0, r2(z)], yw: r2(Math.atan2(x, z)) };
}
function spawn(p, room) {
  const s = randomSpawn();
  p.s.p = s.p.slice(); p.s.v = [0, 0, 0]; p.s.yw = s.yw; p.lastPosAt = Date.now();
  p.hp = 100; p.alive = true; p.zoneAcc = 0; p.kills = 0;
  send(p, { t: 'spawn', p: s.p, yw: s.yw });
}
function aliveIn(room) {
  const out = [];
  for (const p of room.players.values()) if (p.alive && p.part === room.m.id) out.push(p);
  return out;
}
function startCount(room) {
  const m = room.m;
  m.id = 1 + Math.floor(Math.random() * 2e9); m.phase = 'count'; m.t = 0; m.w = '';
  m.cx = r2((Math.random() - 0.5) * 120); m.cz = r2((Math.random() - 0.5) * 120);
  room.zoneK = 0;
  for (const p of room.players.values()) { p.part = m.id; spawn(p, room); }
}
function endRound(room) {
  const m = room.m, alive = aliveIn(room);
  const winner = alive.length === 1 ? alive[0] : null;
  for (const p of room.players.values()) if (p.part === m.id) addStats(p.uid, { matches: 1 });
  if (winner) addStats(winner.uid, { wins: 1 });
  m.phase = 'over'; m.t = 0; m.w = winner ? winner.name : '';
  console.log(`${room.code}: round over, ${winner ? winner.name + ' wins' : 'no winner'}`);
}

function kill(room, victim, killer, weapon, head, byZone) {
  if (!victim.alive) return;
  victim.alive = false; victim.hp = 0;
  const live = room.m.phase === 'live' && victim.part === room.m.id;
  if (live) {
    addStats(victim.uid, { deaths: 1 });
    if (killer && killer !== victim) { killer.kills++; addStats(killer.uid, head ? { kills: 1, headshots: 1 } : { kills: 1 }); }
  }
  const place = aliveIn(room).length + 1;
  console.log(`${room.code}: ${byZone ? 'the zone' : killer ? killer.name : '?'} eliminated ${victim.name}${weapon ? ' (' + weapon + (head ? ', headshot' : '') + ')' : ''}`);
  const feed = JSON.stringify({ t: 'kill', k: killer ? killer.name : '', v: victim.name, w: weapon || '', hs: head ? 1 : 0, z: byZone ? 1 : 0 });
  for (const p of room.players.values()) send(p, feed);
  send(victim, { t: 'died', by: byZone ? 'the zone' : killer ? killer.name : '', place });
}

function tickRoom(room, dt) {
  const m = room.m;
  m.t += dt;
  const n = room.players.size;
  switch (m.phase) {
    case 'wait':
      if (n >= 2) startCount(room);
      break;
    case 'count':
      if (n < 2) { m.phase = 'wait'; m.t = 0; for (const p of room.players.values()) { p.part = 0; p.alive = true; p.hp = 100; } }
      else if (m.t >= COUNT_S) { m.phase = 'live'; m.t = 0; }
      break;
    case 'live': {
      const alive = aliveIn(room);
      if (m.t > 1 && alive.length <= 1) { endRound(room); break; }
      const z = zoneOf(room);
      for (const p of alive) {
        if (Math.hypot(p.s.p[0] - z.x, p.s.p[2] - z.z) <= z.r) continue;
        p.zoneAcc += ZONE_DPS * (z.k >= 1 ? 2.5 : 1) * dt;
        if (p.zoneAcc >= 1) {
          const d = Math.floor(p.zoneAcc); p.zoneAcc -= d; p.hp -= d;
          send(p, { t: 'hurt', a: d, zone: 1 });
          if (p.hp <= 0) kill(room, p, null, '', false, true);
        }
      }
      break;
    }
    case 'over':
      if (m.t >= OVER_S) {
        if (n >= 2) startCount(room);
        else { m.phase = 'wait'; m.t = 0; for (const p of room.players.values()) { p.part = 0; p.alive = true; p.hp = 100; } }
      }
      break;
  }

  // snapshot: [id, name, x, y, z, vx, vy, vz, yaw, pitch, flags, weapon, shots, ex, ey, ez, hp, cosmetic, kills]
  const ps = [];
  let alive = 0;
  for (const p of room.players.values()) {
    const s = p.s, inRound = p.part === m.id && m.id !== 0;
    if (p.alive && inRound) alive++;
    const flags = (s.g ? 1 : 0) | (s.sp ? 2 : 0) | (s.ad ? 4 : 0) | (s.rl ? 8 : 0) | (p.alive ? 16 : 0) | (inRound ? 32 : 0);
    ps.push([p.id, p.name, s.p[0], s.p[1], s.p[2], s.v[0], s.v[1], s.v[2], s.yw, s.pt, flags,
      WEAPON_LIST.indexOf(s.w), p.shots, p.se[0], p.se[1], p.se[2], Math.max(0, Math.ceil(p.hp)), p.cos, p.kills]);
  }
  const msg = JSON.stringify({ t: 's', m: { id: m.id, phase: m.phase, t: r2(m.t), cx: m.cx, cz: m.cz, w: m.w, al: alive, n,
    code: room.isPublic ? '' : room.code }, ps });
  for (const p of room.players.values()) send(p, msg);
}

setInterval(() => {
  for (const room of rooms.values()) tickRoom(room, 1 / TICK_HZ);
}, 1000 / TICK_HZ);

/* ---------- joining and leaving ---------- */
function joinRoom(p, room) {
  p.room = room;
  room.players.set(p.id, p);
  const m = room.m;
  if (m.phase === 'wait') { p.part = 0; spawn(p, room); }
  else if (m.phase === 'count') { p.part = m.id; spawn(p, room); }
  else { p.part = 0; p.alive = false; p.hp = 0; }                           // live or over: watch until the next round
}
function leaveRoom(p, reason) {
  const room = p.room;
  if (!room) return;
  if (room.m.phase === 'live' && p.alive && p.part === room.m.id) {
    addStats(p.uid, { deaths: 1 });                                         // leaving mid-round counts as a death
    p.alive = false;
    const feed = JSON.stringify({ t: 'kill', k: '', v: p.name, w: '', hs: 0, z: 0, left: 1 });
    for (const o of room.players.values()) if (o !== p) send(o, feed);
  }
  room.players.delete(p.id);
  p.room = null;
  if (!room.isPublic && room.players.size === 0) rooms.delete(room.code);
  if (byUid.get(p.uid) === p) byUid.delete(p.uid);
  if (reason) console.log(`${p.name} left ${room.code} (${reason})`);
}

/* ---------- messages ---------- */
async function onHello(p, msg) {
  if (msg.v !== PROTO) { send(p, { t: 'err', code: 'version' }); p.ws.close(); return; }
  let who;
  try { who = await verifyToken(msg.token); }
  catch (e) { send(p, { t: 'err', code: 'auth' }); p.ws.close(); return; }
  if (p.ws.readyState !== 1) return;
  const prof = await loadProfile(who, msg.cos);
  if (p.ws.readyState !== 1) return;
  const old = byUid.get(who.uid);
  if (old && old !== p) { send(old, { t: 'err', code: 'elsewhere' }); leaveRoom(old, 'signed in elsewhere'); try { old.ws.close(); } catch (_) {} }

  let room;
  const req = String(msg.room || 'public');
  if (req === 'public') room = rooms.get('PUBLIC');
  else if (req === 'create') { let c = newCode(); while (rooms.has(c)) c = newCode(); room = makeRoom(c, false); }
  else room = rooms.get(req.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5));
  if (!room) { send(p, { t: 'err', code: 'no_room' }); p.ws.close(); return; }
  if (room.players.size >= room.max) { send(p, { t: 'err', code: 'full' }); p.ws.close(); return; }

  const lo = String(msg.loadout || '').split(',');
  p.loadout = lo.length === 3 && WEAPON_LIST.every(w => lo.includes(w)) ? lo : WEAPON_LIST.slice();
  p.uid = who.uid; p.name = prof.name; p.authed = true;
  p.cos = prof.head === 'fish' && (prof.stats.kills || 0) >= 10 ? 'fish' : '';
  p.s.w = p.loadout[0]; p.wSince = 0;
  byUid.set(p.uid, p);
  joinRoom(p, room);
  send(p, { t: 'welcome', id: p.id, name: p.name, cos: p.cos, room: room.isPublic ? '' : room.code, pub: room.isPublic, max: room.max });
  console.log(`${p.name} joined ${room.code} (${room.players.size} players)`);
}

function onUpdate(p, msg) {
  const s = p.s, now = Date.now();
  const pos = vec3(msg.p, MAP_HALF + 5);
  if (pos) {
    pos[1] = clamp(pos[1], 0, 30);
    const dtS = Math.max(0.02, (now - (p.lastPosAt || now)) / 1000);
    const moved = Math.hypot(pos[0] - s.p[0], pos[2] - s.p[2]);
    if (moved <= 9.5 * dtS + 1.5 || !p.alive || DEV_TOKENS) { s.p = pos; p.lastPosAt = now; }   // speed limit (off for local tests)
    else if (now - (p.lastFixAt || 0) > 1000) { p.lastFixAt = now; send(p, { t: 'pos', p: s.p }); }
  }
  const v = vec3(msg.v, 40); if (v) s.v = v;
  s.yw = num(msg.yw, s.yw); s.pt = clamp(num(msg.pt, s.pt), -1.6, 1.6);
  s.g = !!msg.g; s.sp = !!msg.sp; s.ad = !!msg.ad; s.rl = !!msg.rl;
  if (typeof msg.w === 'string' && msg.w !== s.w && p.loadout.includes(msg.w)) { s.w = msg.w; p.wSince = now; }
}

function onShot(p, msg) {
  const room = p.room, now = Date.now(), w = WEAPONS[p.s.w];
  if (!room || !w || !p.alive || msg.w !== p.s.w) return;
  if (now - p.wSince < SWITCH_LOCK_MS) return;                             // just switched weapons
  if (now - p.lastShot < w.interval * 1000 * 0.8) return;                  // faster than the gun can fire
  p.lastShot = now;
  p.shots++;
  const se = vec3(msg.se, 3000); if (se) p.se = se.map(r2);

  const target = msg.hit ? room.players.get(Number(msg.hit)) : null;
  const m = room.m;
  if (!target || target === p || !target.alive || m.phase !== 'live' || p.part !== m.id || target.part !== m.id) return;
  const ex = p.s.p[0], ey = p.s.p[1] + 1.65, ez = p.s.p[2];
  const tx = target.s.p[0], ty = target.s.p[1] + 1.0, tz = target.s.p[2];
  const dist = Math.hypot(tx - ex, ty - ey, tz - ez);
  if (dist > w.range + 4) return;
  // the shot has to be roughly where the shooter is looking
  const cy = Math.cos(p.s.pt);
  const ax = -Math.sin(p.s.yw) * cy, ay = Math.sin(p.s.pt), az = -Math.cos(p.s.yw) * cy;
  const dot = (ax * (tx - ex) + ay * (ty - ey) + az * (tz - ez)) / Math.max(dist, 0.01);
  const angle = Math.acos(clamp(dot, -1, 1));
  if (angle > 0.4 + Math.atan(1.4 / Math.max(dist, 0.5))) return;

  const head = !!msg.hd;
  let dmg = head ? w.head : w.body;
  if (w.falloffAt && dist > w.falloffAt) dmg = Math.round(dmg * w.falloff);
  target.hp -= dmg;
  const killed = target.hp <= 0;
  send(p, { t: 'hit', hd: head ? 1 : 0, k: killed ? 1 : 0 });
  send(target, { t: 'hurt', a: dmg, x: r2(ex), z: r2(ez) });
  if (killed) kill(room, target, p, p.s.w, head, false);
}

/* ---------- server ---------- */
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  let players = 0; for (const r of rooms.values()) players += r.players.size;
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  if (DEV_TOKENS && req.url === '/stats') { res.end(JSON.stringify(Object.fromEntries(memStats))); return; }
  res.end(`Baseplate FPS game server is running. ${players} playing right now.\n`);
});
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });

wss.on('connection', ws => {
  const p = { id: nextId++, ws, uid: '', name: '', authed: false, room: null, loadout: WEAPON_LIST.slice(), cos: '',
    s: { p: [0, 0, 0], v: [0, 0, 0], yw: 0, pt: 0, g: true, sp: false, ad: false, rl: false, w: 'rifle' },
    hp: 100, alive: true, part: 0, kills: 0, shots: 0, se: [0, 0, 0], lastShot: 0, wSince: 0, zoneAcc: 0,
    lastPosAt: 0, lastFixAt: 0, msgs: 0, msgWindow: Date.now() };
  const helloTimer = setTimeout(() => { if (!p.authed) ws.close(); }, 15000);
  ws.on('pong', () => { ws._bpMissed = false; });
  ws.on('message', raw => {
    const now = Date.now();
    if (now - p.msgWindow > 1000) { p.msgWindow = now; p.msgs = 0; }
    if (++p.msgs > 90) return;                                              // flood guard
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (!p.authed) { if (msg.t === 'hello' && !p.helloSeen) { p.helloSeen = true; onHello(p, msg).catch(e => { console.error(e); ws.close(); }); } return; }
    if (msg.t === 'u') onUpdate(p, msg);
    else if (msg.t === 'f') onShot(p, msg);
    else if (msg.t === 'leave') { leaveRoom(p, 'left'); ws.close(); }
  });
  ws.on('close', () => { clearTimeout(helloTimer); if (p.room) leaveRoom(p, 'disconnected'); });
  ws.on('error', () => {});
});

// drop connections that stop answering
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._bpMissed) { ws.terminate(); continue; }
    ws._bpMissed = true;
    try { ws.ping(); } catch (_) {}
  }
}, 20000);

server.listen(PORT, () => console.log(`Baseplate FPS server listening on port ${PORT}${DEV_TOKENS ? ' (DEV TOKENS ON)' : ''}`));
