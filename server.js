'use strict';
// Baseplate FPS game server.
// Runs every match: one big public match plus private rooms with codes. Each room plays rounds of
// free for all, team deathmatch or last man standing, then everyone votes on the next map and mode.
// Players sign in with Firebase; the server checks their sign-in, decides every hit, kill and win,
// and saves each account's stats to the Firebase Realtime Database.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const MAPS = require('./maps.js');

const PORT = Number(process.env.PORT) || 8080;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'baseplatefps-e1fc1';
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://baseplatefps-e1fc1-default-rtdb.asia-southeast1.firebasedatabase.app';
const DEV_TOKENS = process.env.DEV_TOKENS === '1';           // local testing only, never set this on Render
const PROTO = 3;
const EMAIL_DOMAIN = 'players.baseplatefps.game';
const USER_RE = /^[A-Za-z0-9]{3,20}$/;

const TICK_HZ = 15;
const START_S = Number(process.env.START_S) || 6;            // everyone spawns and reads the round explainer
const ROUND_S = Number(process.env.ROUND_S) || 600;          // 10 minute rounds
const VOTE_S = Number(process.env.VOTE_S) || 20;             // vote for the next map and mode
const RESPAWN_MS = 3000, PROTECT_MS = 2000, LEAVE_HURT_MS = 10000;
const GRACE_S = 25, SHRINK_S = 180, ZONE_DPS = 4;            // last man standing only
const PUBLIC_MAX = 50, PRIVATE_MAX = 16;
const MODES = ['tdm', 'ffa', 'lms'];
const MODE_NAMES = { tdm: 'Team deathmatch', ffa: 'Free for all', lms: 'Last man standing' };
const TEAM_NAMES = ['Blue', 'Red'];
const WEAPONS = {
  rifle:  { interval: 60 / 750, body: 20, head: 45, range: 330, mag: 30, reload: 2100 },
  pistol: { interval: 60 / 420, body: 24, head: 55, range: 150, falloffAt: 40, falloff: 0.75, mag: 12, reload: 1500 },
  sniper: { interval: 1.6,      body: 85, head: 150, range: 720, mag: 1, reload: 2200 },     // one round, then a reload
};
const WEAPON_LIST = ['rifle', 'pistol', 'sniper'];
const SWITCH_LOCK_MS = 900;                                  // client waits 1.0 s; a little slack for lag
const RELOAD_SLACK_MS = 250;                                 // allow for lag before a reload is "done"

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

const memStats = new Map();   // uid -> stats, used when there's no database (and as a cache)
const blankStats = () => ({ kills: 0, deaths: 0, wins: 0, matches: 0, headshots: 0 });

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

const modRec = new Map();     // uid -> { banned, tamperAt } — cheater warnings and bans, server-only
const TAMPER_BAN_MS = (Number(process.env.TAMPER_BAN_S) || 5 * 60 * 60) * 1000;   // a second DevTools open within 5 hours is a ban

async function loadProfile(who, requestedHead) {
  const fromEmail = String(who.email).split('@')[0];
  let name = who.devName || fromEmail, head = requestedHead === 'fish' ? 'fish' : 'none';
  const stats = Object.assign(blankStats(), memStats.get(who.uid) || {});
  if (db) {
    try {
      const u = (await db.ref('users/' + who.uid).once('value')).val() || {};
      if (typeof u.username === 'string' && u.username.toLowerCase() === fromEmail) name = u.username;
      if (u.avatar && typeof u.avatar.head === 'string') head = u.avatar.head === 'fish' ? 'fish' : 'none';
      if (u.stats && typeof u.stats === 'object') for (const k of Object.keys(blankStats())) stats[k] = Number(u.stats[k]) || 0;
      if (u.mod && typeof u.mod === 'object' && !modRec.has(who.uid)) modRec.set(who.uid, { banned: !!u.mod.banned, tamperAt: Number(u.mod.tamperAt) || 0 });
    } catch (e) { console.warn('Could not read profile', who.uid, e.message); }
  }
  memStats.set(who.uid, stats);
  if (!USER_RE.test(name)) name = (fromEmail.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)) || 'Player';
  return { name, stats, head, banned: (modRec.get(who.uid) || {}).banned };
}

function onTamper(p) {
  const now = Date.now();
  const rec = modRec.get(p.uid) || { banned: false, tamperAt: 0 };
  if (rec.banned) return banPlayer(p, rec);
  if (rec.tamperAt && now - rec.tamperAt < TAMPER_BAN_MS) { rec.banned = true; rec.tamperAt = now; modRec.set(p.uid, rec); banPlayer(p, rec); }
  else {
    rec.tamperAt = now; modRec.set(p.uid, rec);
    if (db) db.ref('users/' + p.uid + '/mod').update({ tamperAt: admin.database.ServerValue.TIMESTAMP }).catch(e => console.warn('mod write failed', e.message));
    console.log(`${p.name} warned for opening DevTools`);
  }
}
function banPlayer(p, rec) {
  if (db) db.ref('users/' + p.uid + '/mod').update({ banned: true, bannedAt: admin.database.ServerValue.TIMESTAMP }).catch(e => console.warn('ban write failed', e.message));
  console.log(`${p.name} BANNED (repeat DevTools within 5h)`);
  send(p, { t: 'err', code: 'banned' });
  if (p.room) leaveRoom(p, 'banned');
  setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 400);
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
function broadcast(room, msg) { const s = JSON.stringify(msg); for (const p of room.players.values()) send(p, s); }
const pick = list => list[Math.floor(Math.random() * list.length)];

/* ---------- rooms ---------- */
const rooms = new Map();         // code -> room ('PUBLIC' is the big match)
const byUid = new Map();         // uid -> player (one connection per account)
let nextId = 1;

function makeRoom(code, isPublic) {
  const room = {
    code, isPublic, max: isPublic ? PUBLIC_MAX : PRIVATE_MAX, players: new Map(),
    phase: 'wait', t: 0, rid: 0, mode: 'ffa', map: MAPS.MAP_LIST[0], teamKills: [0, 0], cx: 0, cz: 0, zoneK: 0, result: '',
  };
  rooms.set(code, room);
  return room;
}
makeRoom('PUBLIC', true);
if (DEV_TOKENS && MODES.includes(process.env.START_MODE)) rooms.get('PUBLIC').mode = process.env.START_MODE;   // local tests only

const mapOf = room => MAPS.MAPS[room.map];
const phaseDur = room => room.phase === 'start' ? START_S : room.phase === 'live' ? ROUND_S : room.phase === 'vote' ? VOTE_S : 0;
const inRound = (room, p) => room.rid !== 0 && p.part === room.rid;

function zoneOf(room) {
  const zd = mapOf(room).zone;
  if (room.mode !== 'lms') return null;
  if (room.phase === 'live') room.zoneK = clamp((room.t - GRACE_S) / SHRINK_S, 0, 1);
  else if (room.phase !== 'vote') room.zoneK = 0;
  const k = room.zoneK;
  return { x: room.cx * k, z: room.cz * k, r: zd.r0 + (zd.r1 - zd.r0) * k, k };
}

// spawn somewhere open, as far as practical from the nearest enemy
function chooseSpawn(room, p) {
  const map = mapOf(room);
  const list = room.mode === 'tdm' && p.team >= 0 ? map.teamSpawns[p.team] : map.spawns;
  const foes = [...room.players.values()].filter(o => o !== p && o.alive && inRound(room, o) && !(room.mode === 'tdm' && o.team === p.team));
  const scored = list.map(([x, z]) => {
    let d = 1e9;
    for (const o of foes) d = Math.min(d, Math.hypot(o.s.p[0] - x, o.s.p[2] - z));
    return { x, z, d: d + Math.random() * 6 };
  }).sort((a, b) => b.d - a.d);
  return pick(scored.slice(0, Math.min(3, scored.length)));
}
function spawn(room, p) {
  const sp = chooseSpawn(room, p);
  const x = r2(sp.x + (Math.random() - 0.5) * 1.5), z = r2(sp.z + (Math.random() - 0.5) * 1.5);
  const yw = r2(Math.atan2(x, z));
  p.s.p = [x, 0, z]; p.s.v = [0, 0, 0]; p.s.yw = yw; p.lastPosAt = Date.now();
  p.hp = 100; p.alive = true; p.zoneAcc = 0; p.respawnAt = 0; p.protectUntil = Date.now() + PROTECT_MS;
  for (const id of WEAPON_LIST) p.ammo[id] = WEAPONS[id].mag;
  p.reloadUntil = 0;
  send(p, { t: 'spawn', p: p.s.p, yw });
}
function aliveIn(room) {
  const out = [];
  for (const p of room.players.values()) if (p.alive && inRound(room, p)) out.push(p);
  return out;
}
function assignTeam(room, p) {
  const n = [0, 0];
  for (const o of room.players.values()) if (o !== p && inRound(room, o) && o.team >= 0) n[o.team]++;
  p.team = n[0] < n[1] ? 0 : n[1] < n[0] ? 1 : (room.teamKills[0] <= room.teamKills[1] ? 0 : 1);
}

function startRound(room) {
  room.rid = 1 + Math.floor(Math.random() * 2e9);
  room.phase = 'start'; room.t = 0; room.result = ''; room.teamKills = [0, 0]; room.zoneK = 0;
  const c = mapOf(room).zone.centre;
  room.cx = r2((Math.random() - 0.5) * 2 * c); room.cz = r2((Math.random() - 0.5) * 2 * c);
  const list = [...room.players.values()].sort(() => Math.random() - 0.5);
  list.forEach((p, i) => {
    p.part = room.rid; p.kills = 0; p.deaths = 0; p.lastHurtBy = null; p.lastHurtAt = 0;
    p.team = room.mode === 'tdm' ? i % 2 : -1;
  });
  for (const p of list) spawn(room, p);
  console.log(`${room.code}: ${MODE_NAMES[room.mode]} on ${mapOf(room).name} starting with ${list.length} players`);
}
function toWait(room) {
  room.phase = 'wait'; room.t = 0; room.rid = 0; room.result = '';
  for (const p of room.players.values()) { p.part = 0; p.team = -1; if (!p.alive) spawn(room, p); }
}

function endRound(room) {
  const ps = [...room.players.values()].filter(p => inRound(room, p));
  let winners = [], text = '';
  if (room.mode === 'ffa') {
    const top = Math.max(0, ...ps.map(p => p.kills));
    const best = ps.filter(p => p.kills === top);
    if (top > 0 && best.length === 1) { winners = best; text = `${best[0].name} wins with ${top} ${top === 1 ? 'kill' : 'kills'}`; }
    else text = top > 0 ? `Draw: ${best.map(p => p.name).join(' and ')} tied on ${top} kills` : 'Draw: nobody got a kill';
  } else if (room.mode === 'tdm') {
    const [a, b] = room.teamKills;
    if (a !== b) { const w = a > b ? 0 : 1; winners = ps.filter(p => p.team === w); text = `${TEAM_NAMES[w]} team wins ${Math.max(a, b)} to ${Math.min(a, b)}`; }
    else text = `Draw: ${a} kills each`;
  } else {
    const alive = aliveIn(room);
    if (alive.length === 1) { winners = alive; text = `${alive[0].name} is the last one standing`; }
    else text = 'Time ran out: no winner';
  }
  for (const p of ps) addStats(p.uid, { matches: 1 });
  for (const p of winners) addStats(p.uid, { wins: 1 });
  room.result = text;
  room.phase = 'vote'; room.t = 0;
  for (const p of room.players.values()) { p.voteMode = ''; p.voteMap = ''; }
  console.log(`${room.code}: round over. ${text}`);
}
function tally(room) {
  const mc = Object.fromEntries(MODES.map(m => [m, 0])), pc = Object.fromEntries(MAPS.MAP_LIST.map(m => [m, 0]));
  for (const p of room.players.values()) { if (p.voteMode in mc) mc[p.voteMode]++; if (p.voteMap in pc) pc[p.voteMap]++; }
  return { mc, pc };
}
function winnerOf(counts, current) {
  const top = Math.max(...Object.values(counts));
  if (top === 0) return current;                              // nobody voted: keep what we had
  return pick(Object.keys(counts).filter(k => counts[k] === top));
}

function kill(room, victim, killer, weapon, head, byZone, quit) {
  if (!victim.alive) return;
  victim.alive = false; victim.hp = 0;
  const live = room.phase === 'live' && inRound(room, victim);
  if (live) {
    victim.deaths++;
    addStats(victim.uid, { deaths: 1 });
    if (killer && killer !== victim && inRound(room, killer)) {
      killer.kills++;
      if (room.mode === 'tdm' && killer.team >= 0) room.teamKills[killer.team]++;
      addStats(killer.uid, head ? { kills: 1, headshots: 1 } : { kills: 1 });
    }
    if (room.mode !== 'lms') victim.respawnAt = Date.now() + RESPAWN_MS;
  }
  const place = room.mode === 'lms' ? aliveIn(room).length + 1 : 0;
  broadcast(room, { t: 'kill', k: killer ? killer.name : '', v: victim.name, w: weapon || '', hs: head ? 1 : 0, z: byZone ? 1 : 0, left: quit ? 1 : 0 });
  if (!quit) send(victim, { t: 'died', by: byZone ? 'the zone' : killer ? killer.name : '', byId: killer && !byZone ? killer.id : 0, place, respawn: room.mode !== 'lms' && live ? RESPAWN_MS : 0 });
  console.log(`${room.code}: ${byZone ? 'the zone' : killer ? killer.name : '?'} eliminated ${victim.name}${weapon ? ' (' + weapon + (head ? ', headshot' : '') + ')' : ''}${quit ? ' (left the match)' : ''}`);
}

function tickRoom(room, dt) {
  room.t += dt;
  const n = room.players.size, now = Date.now();
  switch (room.phase) {
    case 'wait':
      if (n >= 2) startRound(room);
      break;
    case 'start':
      if (n < 2) toWait(room);
      else if (room.t >= START_S) { room.phase = 'live'; room.t = 0; }
      break;
    case 'live': {
      if (room.mode === 'lms') {
        const alive = aliveIn(room);
        if ((room.t > 1 && alive.length <= 1) || room.t >= ROUND_S) { endRound(room); break; }
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
      } else {
        if (n < 2) { console.log(`${room.code}: not enough players, round cancelled`); toWait(room); break; }
        if (room.t >= ROUND_S) { endRound(room); break; }
        for (const p of room.players.values()) if (!p.alive && p.respawnAt && now >= p.respawnAt && inRound(room, p)) spawn(room, p);
      }
      break;
    }
    case 'vote':
      if (room.t >= VOTE_S) {
        const { mc, pc } = tally(room);
        room.mode = winnerOf(mc, room.mode);
        room.map = winnerOf(pc, room.map);
        console.log(`${room.code}: vote picked ${MODE_NAMES[room.mode]} on ${mapOf(room).name}`);
        if (n >= 2) startRound(room); else toWait(room);
      }
      break;
  }

  // snapshot: [id, name, x, y, z, vx, vy, vz, yaw, pitch, flags, weapon, shots, ex, ey, ez, hp, cosmetic, kills, team, deaths]
  const ps = [];
  let alive = 0;
  for (const p of room.players.values()) {
    const s = p.s, ir = inRound(room, p);
    if (p.alive && ir) alive++;
    const flags = (s.g ? 1 : 0) | (s.sp ? 2 : 0) | (s.ad ? 4 : 0) | (s.rl ? 8 : 0) | (p.alive ? 16 : 0) | (ir ? 32 : 0) | (now < p.protectUntil ? 64 : 0);
    ps.push([p.id, p.name, s.p[0], s.p[1], s.p[2], s.v[0], s.v[1], s.v[2], s.yw, s.pt, flags,
      WEAPON_LIST.indexOf(s.w), p.shots, p.se[0], p.se[1], p.se[2], Math.max(0, Math.ceil(p.hp)), p.cos, p.kills, p.team, p.deaths]);
  }
  const meta = { rid: room.rid, phase: room.phase, t: r2(room.t), dur: phaseDur(room), mode: room.mode, map: room.map,
    cx: room.cx, cz: room.cz, res: room.result, al: alive, n, code: room.isPublic ? '' : room.code, tk: room.teamKills };
  if (room.phase === 'vote') { const { mc, pc } = tally(room); meta.vm = MODES.map(m => mc[m]); meta.vp = MAPS.MAP_LIST.map(m => pc[m]); }
  broadcast(room, { t: 's', m: meta, ps });
}

setInterval(() => {
  for (const room of rooms.values()) tickRoom(room, 1 / TICK_HZ);
}, 1000 / TICK_HZ);

/* ---------- joining and leaving ---------- */
function joinRoom(p, room) {
  p.room = room;
  room.players.set(p.id, p);
  p.part = 0; p.team = -1; p.kills = 0; p.deaths = 0;
  if (room.phase === 'live' && room.mode !== 'lms') {                      // join the round in progress
    p.part = room.rid;
    if (room.mode === 'tdm') assignTeam(room, p);
    spawn(room, p);
  } else if (room.phase === 'live') {
    p.alive = false; p.hp = 0;                                             // last man standing: watch until the next round
    const s = MAPS.MAPS[room.map].spawns[0]; p.s.p = [s[0], 0, s[1]];
  } else {
    if (room.phase === 'start') { p.part = room.rid; if (room.mode === 'tdm') assignTeam(room, p); }
    spawn(room, p);
  }
}
function leaveRoom(p, reason) {
  const room = p.room;
  if (!room) return;
  if (room.phase === 'live' && p.alive && inRound(room, p)) {
    // leaving to dodge a death still counts as one
    const recent = Date.now() - p.lastHurtAt < LEAVE_HURT_MS;
    if (room.mode === 'lms' || recent) {
      const by = recent && p.lastHurtBy && room.players.has(p.lastHurtBy.id) ? p.lastHurtBy : null;
      kill(room, p, by, '', false, false, true);
    }
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
  if (prof.banned) { send(p, { t: 'err', code: 'banned' }); setTimeout(() => { try { p.ws.close(); } catch (_) {} }, 400); return; }
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
  send(p, { t: 'welcome', id: p.id, name: p.name, cos: p.cos, room: room.isPublic ? '' : room.code, pub: room.isPublic, max: room.max,
    modes: MODES, maps: MAPS.MAP_LIST, roundS: ROUND_S, voteS: VOTE_S });
  joinRoom(p, room);
  console.log(`${p.name} joined ${room.code} (${room.players.size} players)`);
}

function onUpdate(p, msg) {
  const s = p.s, now = Date.now(), map = mapOf(p.room), half = map.half;
  const pos = vec3(msg.p, half + 2);
  if (pos) {
    pos[0] = clamp(pos[0], -half, half); pos[2] = clamp(pos[2], -half, half); pos[1] = clamp(pos[1], 0, 12);
    const dtS = Math.max(0.02, (now - (p.lastPosAt || now)) / 1000);
    const moved = Math.hypot(pos[0] - s.p[0], pos[2] - s.p[2]);
    // local tests use dev tokens and teleport bots around; AC_FORCE turns the checks on anyway to test them
    const check = p.alive && (!DEV_TOKENS || process.env.AC_FORCE);
    const bad = check && (
      moved > 9.5 * dtS + 1.5 ||                                           // faster than a sprint can carry you
      MAPS.illegalStand(map, pos[0], pos[1], pos[2]) ||                    // inside a wall, or floating
      MAPS.crossedWall(map, s.p[0], s.p[2], pos[0], pos[2], Math.min(s.p[1], pos[1])));   // stepped through a wall
    if (bad) {
      if (now - (p.lastFixAt || 0) > 500) { p.lastFixAt = now; send(p, { t: 'pos', p: s.p }); }   // snap them back
    } else { s.p = pos; p.lastPosAt = now; }
  }
  const v = vec3(msg.v, 40); if (v) s.v = v;
  s.yw = num(msg.yw, s.yw); s.pt = clamp(num(msg.pt, s.pt), -1.6, 1.6);
  s.g = !!msg.g; s.sp = !!msg.sp; s.ad = !!msg.ad; s.rl = !!msg.rl;
  if (typeof msg.w === 'string' && msg.w !== s.w && p.loadout.includes(msg.w)) { s.w = msg.w; p.wSince = now; p.reloadUntil = 0; }   // switching cancels a reload, like on the client
}

function refreshAmmo(p, now) {                                            // a reload finishes lazily, when it next matters
  if (p.reloadUntil && now >= p.reloadUntil - RELOAD_SLACK_MS) { p.ammo[p.reloadWeapon] = WEAPONS[p.reloadWeapon].mag; p.reloadUntil = 0; }
}
function startReload(p, now) {
  if (p.reloadUntil || !WEAPONS[p.s.w]) return;
  p.reloadWeapon = p.s.w; p.reloadUntil = now + WEAPONS[p.s.w].reload;
}
function onReload(p) {
  const now = Date.now(), w = WEAPONS[p.s.w];
  if (!p.alive || !w) return;
  refreshAmmo(p, now);
  if (!p.reloadUntil && p.ammo[p.s.w] < w.mag) startReload(p, now);
}

function onShot(p, msg) {
  const room = p.room, now = Date.now(), wid = p.s.w, w = WEAPONS[wid];
  if (!room || !w || !p.alive || msg.w !== wid) return;
  if (now - p.wSince < SWITCH_LOCK_MS) return;                             // just switched weapons
  refreshAmmo(p, now);
  if (p.reloadUntil && now < p.reloadUntil - RELOAD_SLACK_MS) return;      // still reloading
  if (now - p.lastShot < w.interval * 1000 * 0.8) return;                  // faster than the gun can fire
  if (p.ammo[wid] <= 0) { startReload(p, now); return; }                   // out of ammo: no free shots
  p.ammo[wid]--;
  if (p.ammo[wid] <= 0) startReload(p, now);
  p.lastShot = now;
  p.shots++;
  p.protectUntil = 0;                                                      // shooting ends spawn protection
  const se = vec3(msg.se, 3000); if (se) p.se = se.map(r2);

  const target = msg.hit ? room.players.get(Number(msg.hit)) : null;
  if (!target || target === p || !target.alive || room.phase !== 'live' || !inRound(room, p) || !inRound(room, target)) return;
  if (room.mode === 'tdm' && target.team === p.team) return;              // no friendly fire
  if (now < target.protectUntil) return;
  const ex = p.s.p[0], ey = p.s.p[1] + 1.65, ez = p.s.p[2];
  const feet = target.s.p[1], tx = target.s.p[0], tz = target.s.p[2];
  const cy = Math.cos(p.s.pt);
  const ax = -Math.sin(p.s.yw) * cy, ay = Math.sin(p.s.pt), az = -Math.cos(p.s.yw) * cy;   // the shooter's own aim
  // how far along the aim ray the shot passes the target, and where on the target it lands
  const th = ((tx - ex) * ax + (tz - ez) * az) / Math.max(ax * ax + az * az, 1e-4);
  if (th <= 0 || th > w.range + 4) return;
  const px = ex + ax * th, py = ey + ay * th, pz = ez + az * th;
  const horiz = Math.hypot(px - tx, pz - tz), rise = py - feet;
  if (horiz > 0.4 || rise < -0.1 || rise > 1.9) return;                  // the aim isn't actually on the body: no hit (kills aimbot-less wallbangs/fake hits)
  // no wall between the shooter and where the shot lands
  const map = mapOf(room);
  if (MAPS.blocked(map, ex, ey, ez, px, py, pz)) return;
  const head = rise >= 1.5 && horiz <= 0.2;                              // the server decides headshots, not the client

  const dist = Math.hypot(tx - ex, feet + 1 - ey, tz - ez);
  let dmg = head ? w.head : w.body;
  if (w.falloffAt && dist > w.falloffAt) dmg = Math.round(dmg * w.falloff);
  target.hp -= dmg;
  target.lastHurtBy = p; target.lastHurtAt = now;
  const killed = target.hp <= 0;
  send(p, { t: 'hit', hd: head ? 1 : 0, k: killed ? 1 : 0 });
  send(target, { t: 'hurt', a: dmg, x: r2(ex), z: r2(ez) });
  if (killed) kill(room, target, p, wid, head, false);
}

function onVote(p, msg) {
  const room = p.room;
  if (!room || room.phase !== 'vote') return;
  if (MODES.includes(msg.mode)) p.voteMode = msg.mode;
  if (MAPS.MAP_LIST.includes(msg.map)) p.voteMap = msg.map;
}

/* ---------- server ---------- */
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  let players = 0; for (const r of rooms.values()) players += r.players.size;
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  if (DEV_TOKENS && req.url === '/stats') { res.end(JSON.stringify(Object.fromEntries(memStats))); return; }
  if (DEV_TOKENS && req.url === '/mod') { res.end(JSON.stringify(Object.fromEntries(modRec))); return; }
  const pub = rooms.get('PUBLIC');
  res.end(`Baseplate FPS game server is running. ${players} playing right now. Public match: ${MODE_NAMES[pub.mode]} on ${mapOf(pub).name} (${pub.phase}).\n`);
});
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });

wss.on('connection', ws => {
  const p = { id: nextId++, ws, uid: '', name: '', authed: false, room: null, loadout: WEAPON_LIST.slice(), cos: '',
    s: { p: [0, 0, 0], v: [0, 0, 0], yw: 0, pt: 0, g: true, sp: false, ad: false, rl: false, w: 'rifle' },
    hp: 100, alive: true, part: 0, team: -1, kills: 0, deaths: 0, shots: 0, se: [0, 0, 0], lastShot: 0, wSince: 0, zoneAcc: 0,
    respawnAt: 0, protectUntil: 0, lastHurtBy: null, lastHurtAt: 0, voteMode: '', voteMap: '',
    ammo: { rifle: 30, pistol: 12, sniper: 1 }, reloadUntil: 0, reloadWeapon: '',
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
    if (msg.t === 'tamper') { onTamper(p); return; }                        // DevTools opened on their page
    if (!p.room) return;
    if (msg.t === 'u') onUpdate(p, msg);
    else if (msg.t === 'f') onShot(p, msg);
    else if (msg.t === 'reload') onReload(p);
    else if (msg.t === 'vote') onVote(p, msg);
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
