'use strict';
// Baseplate FPS anti-cheat. It runs only here on the game server, on what each player's game sends (where they are,
// where they look, every shot), so nothing a cheater runs in their browser can switch it off.
//
// It never tells the player anything: no kick, no ban, no message. When something looks like cheating it quietly
// saves a flag for the owner: who, when, what it thinks they were doing and why, and the last 10 seconds of the match
// around them (where everyone was, where the suspect was looking, every shot). The owner approves (ban) or rejects it
// from the arcade. Flags are kept in the database until then (ac/flags, which no player can read or write).
//
// What it looks for:
//   silent aim     - bullets leaving well away from where the player's camera points (the hack steers shots to people)
//   view mismatch  - the camera the shot reports disagrees with the camera the player says they have
//   aim snaps      - the view jumping very fast and landing exactly on someone, again and again, right as they shoot
//   aim lock       - the view glued to a moving player's body while turning (aimbots track perfectly, people wobble)
//   wallhack (ESP) - the view following players who are behind walls for a long time, or shooting at them there
//   headshots      - far more headshots than a person lands with these guns
//   rapid fire     - shots faster than the gun can fire, over and over
//   fake hits      - claiming hits that were impossible (through walls, at the wrong place, from the wrong place)
//   movement       - moving faster than a sprint, teleporting, or going through walls, over and over
//   DevTools       - the browser's developer tools opened during a match (reported by the page)
//   modified game  - the page's own regular check-in stops while the player keeps playing
//   injected code  - the page finds the connection or frame loop hooked, or scripts added that aren't ours (Tampermonkey etc.)
//   odd messages   - messages the real game never sends (hack tools trying things on the server, e.g. stats)

const REPLAY_MS = 10000, KEEP_MS = 13000, MAX_FLAGS = 300;
const D2R = Math.PI / 180;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
const viewDir = (yw, pt) => { const c = Math.cos(pt); return [-Math.sin(yw) * c, Math.sin(pt), -Math.cos(yw) * c]; };
const ang = (a, b) => { const la = Math.hypot(a[0], a[1], a[2]) || 1, lb = Math.hypot(b[0], b[1], b[2]) || 1; return Math.acos(clamp((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb), -1, 1)); };
const deg = r => Math.round(r / D2R);
const trim = (arr, now, ms) => { while (arr.length && now - (Array.isArray(arr[0]) ? arr[0][0] : arr[0]) > ms) arr.shift(); };

module.exports = function createAntiCheat(ctx) {
  const { MAPS, mapOf, getDb, admin, enabled } = ctx;
  const flags = new Map();                       // id -> flag (waiting for the owner)
  let loaded = false;
  // flags survive restarts: they live in the database until approved or rejected
  function load() {
    const db = getDb(); if (!db || loaded) return; loaded = true;
    db.ref('ac/flags').once('value').then(s => { const v = s.val() || {}; for (const id in v) if (v[id] && v[id].uid) flags.set(id, v[id]); console.log(`anti-cheat: ${flags.size} flags waiting`); }).catch(e => console.warn('anti-cheat: could not load flags', e.message));
  }
  setTimeout(load, 3000);
  const save = f => { const db = getDb(); if (db) db.ref('ac/flags/' + f.id).set(f).catch(e => console.warn('anti-cheat: flag not saved', e.message)); };
  const saveCount = f => { const db = getDb(); if (db) db.ref('ac/flags/' + f.id).update({ count: f.count, lastAt: f.lastAt }).catch(() => {}); };

  function st(p) {
    if (!p.ac) p.ac = { pend: [], lockRun: 0, views: [], shots: [], hits: [], silent: [], mism: [], snaps: [], lockT: [], wallT: [], wallShots: [], rapid: [], fake: [], claims: [], moves: [], odd: 0, oddTypes: new Set(), hbAt: 0, joinedAt: Date.now(), tampered: false };
    return p.ac;
  }
  const eye = p => [p.s.p[0], p.s.p[1] + 1.65 - (p.s.cr ? 0.45 : 0), p.s.p[2]];
  const chest = q => [q.s.p[0], q.s.p[1] + 1.2 - (q.s.cr ? 0.4 : 0), q.s.p[2]];
  const enemies = (room, p) => [...room.players.values()].filter(q => q !== p && q.alive && (room.mode !== 'tdm' || q.team !== p.team));

  /* ---------- the flag itself: description, evidence and the replay ---------- */
  function flag(p, kind, title, desc, extra) {
    if (!enabled() || !p.uid) return;
    const now = Date.now();
    for (const f of flags.values()) if (f.uid === p.uid && f.kind === kind) {          // already waiting: just count it again
      f.count = (f.count || 1) + 1; f.lastAt = now; if (now - (f.savedAt || 0) > 10000) { f.savedAt = now; saveCount(f); }
      return;
    }
    if (flags.size >= MAX_FLAGS) return;
    const id = 'f' + now.toString(36) + Math.random().toString(36).slice(2, 6);
    const f = { id, uid: p.uid, name: p.name, kind, title, desc, at: now, lastAt: now, count: 1, room: p.room ? (p.room.isPublic ? 'Public match' : 'Match ' + p.room.code) : '', map: p.room ? p.room.map : '', replay: replay(p, now, extra) };
    flags.set(id, f); save(f);
    console.log(`anti-cheat: flagged ${p.name} (${kind})`);
  }
  function replay(p, now, extra) {
    const room = p.room, a = st(p), t0 = now - REPLAY_MS;
    if (!room || !room.acFrames) return null;
    // everyone who came within 70 m of the suspect, so the replay stays small
    const near = new Set([p.id]);
    for (const fr of room.acFrames) { if (fr[0] < t0) continue; const me = fr[1].find(e => e[0] === p.id); if (!me) continue; for (const e of fr[1]) if (Math.hypot(e[1] - me[1], e[2] - me[2]) < 70) near.add(e[0]); }
    const names = {}; for (const q of room.players.values()) if (near.has(q.id)) names[q.id] = q.name;
    return {
      t0, me: p.id, names, mode: room.mode, team: p.team,
      frames: room.acFrames.filter(fr => fr[0] >= t0).map(fr => [fr[0] - t0, fr[1].filter(e => near.has(e[0]))]),
      views: a.views.filter(v => v[0] >= t0).map(v => [v[0] - t0, r3(v[1]), r3(v[2])]),
      shots: a.shots.filter(s => s[0] >= t0).map(s => [s[0] - t0, ...s.slice(1)]),
      marks: (extra || []).filter(m => m[0] >= t0).map(m => [m[0] - t0, m[1]]),
    };
  }

  /* ---------- what each player sends ---------- */
  // every position update (20 a second): where they look, and what they're looking at
  function onUpdate(p, now) {
    if (!enabled() || !p.room || !p.alive) return;
    const a = st(p), prev = a.views[a.views.length - 1];
    a.views.push([now, p.s.yw, p.s.pt]); trim(a.views, now, KEEP_MS);
    if (!prev || now - prev[0] > 200) { a.pend.length = 0; return; }
    const dt = (now - prev[0]) / 1000, vNow = viewDir(p.s.yw, p.s.pt), vPrev = viewDir(prev[1], prev[2]), turn = ang(vNow, vPrev) / Math.max(dt, 0.02);
    // the camera each shot reported has to sit between the views before and after it (the real game sends both from the same place)
    for (const c of a.pend) if (Math.min(ang(c[1], vPrev), ang(c[1], vNow)) > 0.6) a.mism.push([c[0]]);
    a.pend.length = 0;
    const e = eye(p), map = mapOf(p.room);
    let lockedNow = false;
    for (const q of enemies(p.room, p)) {
      const c = chest(q), to = [c[0] - e[0], c[1] - e[1], c[2] - e[2]], dist = Math.hypot(to[0], to[1], to[2]);
      if (dist < 3 || dist > 120) continue;
      const off = ang(vNow, to);
      // aim lock: glued within a degree of someone's body while the view swings round to follow them
      if (off < 1.0 * D2R && turn > 20 * D2R) lockedNow = true;
      // wallhack: following someone the walls hide (cheap angle test first, the wall test only when it's close)
      if (off < 4 * D2R && dist > 8 && MAPS.blocked(map, e[0], e[1], e[2], c[0], c[1], c[2]) && MAPS.blocked(map, e[0], e[1], e[2], q.s.p[0], q.s.p[1] + 1.66, q.s.p[2])) {
        const moving = Math.hypot(q.s.v[0], q.s.v[2]) > 1.5;
        if (moving) a.wallT.push([now, dt]);
      }
    }
    // only unbroken stretches of half a second or more count: people's aim drifts off and back, an aimbot's never does
    if (lockedNow) a.lockRun += dt; else { if (a.lockRun >= 0.5) a.lockT.push([now, a.lockRun]); a.lockRun = 0; }
    trim(a.lockT, now, 20000); trim(a.wallT, now, 30000);
    const lockS = a.lockT.reduce((s, x) => s + x[1], 0) + (a.lockRun >= 0.5 ? a.lockRun : 0), wallS = a.wallT.reduce((s, x) => s + x[1], 0);
    if (lockS > 2.5) { flag(p, 'lock', 'Aim lock', `For ${lockS.toFixed(1)} seconds in the last 20 their aim stayed glued within 1° of a moving player's body, in unbroken stretches of half a second or more, while turning to follow them. People's aim drifts off and back; an aimbot locked onto someone tracks perfectly like this.`, a.lockT.map(x => [x[0], 'locked on for ' + x[1].toFixed(1) + ' s'])); a.lockT.length = 0; a.lockRun = 0; }
    if (wallS > 5) { flag(p, 'esp', 'Wallhack (seeing through walls)', `For ${wallS.toFixed(1)} seconds in the last 30 their aim followed players who were completely hidden behind walls. You can only do that if your game shows you where everyone is through walls (ESP).`, a.wallT.map(x => [x[0], 'aiming at someone behind a wall'])); a.wallT.length = 0; }
  }
  // every shot, with what the server decided about it. r: 'ok' (hit counted), 'miss' (no hit claimed), or why a claimed hit was refused
  function onShot(p, msg, now, r, target, head) {
    if (!enabled() || !p.room) return;
    const a = st(p), map = mapOf(p.room), w = p.s.w;
    const d = Array.isArray(msg.d) && msg.d.length === 3 ? msg.d.map(Number) : null, o = Array.isArray(msg.o) && msg.o.length === 3 ? msg.o.map(Number) : eye(p);
    const cam = typeof msg.vy === 'number' && typeof msg.vp === 'number' ? viewDir(msg.vy, msg.vp) : null;
    a.shots.push([now, r2(o[0]), r2(o[2]), d ? r3(d[0]) : 0, d ? r3(d[2]) : 0, target ? target.id : 0, r === 'ok' ? 1 : r === 'miss' ? 0 : -1, head ? 1 : 0]);
    trim(a.shots, now, KEEP_MS);
    if (d && d.every(Number.isFinite)) {
      // silent aim: the bullet left far from where their own camera pointed (spread and recoil stay well under 15°)
      if (cam) {
        const dev = ang(d, cam);
        if (dev > 0.35) { a.silent.push([now, dev, target && r === 'ok' ? 1 : 0]); }
        // the camera in the shot and the camera in their updates should agree (checked at their next update)
        a.pend.push([now, cam]); if (a.pend.length > 20) a.pend.shift();
      } else a.odd++;
      // aim snap: a huge, instant turn that lands exactly on someone, right as the shot goes
      if (target && r === 'ok') {
        // the turn between their last two updates (one twentieth of a second apart), and how exactly it landed
        const V = a.views, v1 = V[V.length - 1], v0 = V[V.length - 2];
        if (v0 && v1 && cam && v1[0] - v0[0] <= 70 && now - v1[0] <= 80) {
          const e = eye(p), c = chest(target), hd = [target.s.p[0], target.s.p[1] + 1.66 - (target.s.cr ? 0.45 : 0), target.s.p[2]];
          const flick = ang(viewDir(v0[1], v0[2]), viewDir(v1[1], v1[2]));
          const land = Math.min(ang(cam, [c[0] - e[0], c[1] - e[1], c[2] - e[2]]), ang(cam, [hd[0] - e[0], hd[1] - e[1], hd[2] - e[2]]));
          if (flick > 30 * D2R && land < 0.7 * D2R) a.snaps.push([now, flick]);
        }
        a.hits.push([now, head ? 1 : 0]); if (a.hits.length > 40) a.hits.shift();
      }
      // shooting at someone hidden behind a wall (the server never counts these as hits)
      if (target && r === 'wall') a.wallShots.push([now]);
    }
    if (r === 'fast') a.rapid.push([now]);
    if (target && r !== 'ok' && r !== 'miss' && r !== 'fast') a.fake.push([now, r]);
    if (target) a.claims.push([now]);
    for (const k of ['silent', 'mism', 'snaps', 'wallShots', 'fake', 'claims']) trim(a[k], now, 30000);
    trim(a.rapid, now, 10000);
    const marks = list => list.map(x => [x[0], typeof x[1] === 'string' ? x[1] : 'suspicious shot']);
    const silent20 = a.silent.filter(x => now - x[0] < 20000);
    if (silent20.length >= 3 && silent20.some(x => x[2])) flag(p, 'silent', 'Silent aim', `${silent20.length} shots in 20 seconds left the gun up to ${deg(Math.max(...silent20.map(x => x[1])))}° away from where their camera was pointing, and still hit people. A real shot can only drift about 13°. This is "silent aim": the hack sends bullets at players the cheater isn't even looking at.`, silent20.map(x => [x[0], 'bullet ' + deg(x[1]) + '° off their view']));
    if (a.mism.length >= 6) { flag(p, 'mismatch', 'Faked aim data', `${a.mism.length} times in 30 seconds the direction their shots said the camera faced didn't match the direction their game was reporting. The real game sends both from the same place; a cheat that fakes where it looks gets them out of step.`, marks(a.mism)); a.mism.length = 0; }
    if (a.snaps.length >= 4) { flag(p, 'snap', 'Aimbot snapping', `${a.snaps.length} times in 30 seconds their aim jumped ${deg(Math.min(...a.snaps.map(x => x[1])))}° or more in a twentieth of a second, landed dead on someone's head or chest (under 1°) and shot them straight away. That's how an aimbot flicks onto targets; people's fast flicks overshoot or land a little off and need correcting.`, a.snaps.map(x => [x[0], 'snapped ' + deg(x[1]) + '° onto a player'])); a.snaps.length = 0; }
    if (a.wallShots.length >= 4) { flag(p, 'wallshot', 'Shooting at players through walls', `${a.wallShots.length} times in 30 seconds they shot straight at a player hidden behind a wall (those shots never hurt anyone). Doing that again and again means their game shows where people are through walls.`, marks(a.wallShots)); a.wallShots.length = 0; }
    if (a.rapid.length >= 15) { flag(p, 'rapid', 'Rapid fire', `${a.rapid.length} shots in 10 seconds came faster than the ${w} can fire. The server ignored them, but the real game never sends shots that fast.`, marks(a.rapid)); a.rapid.length = 0; }
    if (a.fake.length >= 8 && a.fake.length >= a.claims.length * 0.5) { const why = [...new Set(a.fake.map(x => x[1]))].join(', '); flag(p, 'fakehit', 'Impossible hits', `${a.fake.length} of their ${a.claims.length} claimed hits in 30 seconds were impossible (${why}). Lag causes the odd one; this many means the game is lying about its shots.`, a.fake.map(x => [x[0], 'impossible hit: ' + x[1]])); a.fake.length = 0; }
    if (a.hits.length >= 25) { const hs = a.hits.filter(x => x[1]).length / a.hits.length; if (hs >= 0.8) { flag(p, 'headshots', 'Almost all headshots', `${Math.round(hs * 100)}% of their last ${a.hits.length} hits were headshots. With these guns even very good players land far fewer; aimbots aim straight at the head.`, a.hits.filter(x => x[1]).map(x => [x[0], 'headshot'])); a.hits.length = 0; } }
    void map;
  }
  // the server had to put them back: too fast, inside a wall, floating, or through a wall
  function onBadMove(p, now, why) {
    if (!enabled() || !p.room) return;
    const a = st(p); a.moves.push([now, why]); trim(a.moves, now, 20000);
    if (a.moves.length >= 10) { const kinds = [...new Set(a.moves.map(x => x[1]))].join(', '); flag(p, 'move', 'Speed / teleport / noclip hack', `The server had to put them back ${a.moves.length} times in 20 seconds (${kinds}). Lag can cause one or two; this many means they're moving in ways the game doesn't allow.`, a.moves.map(x => [x[0], x[1]])); a.moves.length = 0; }
  }
  function onTamper(p) {
    const a = st(p); if (a.tampered) return; a.tampered = true;
    flag(p, 'devtools', 'Opened DevTools', `Their game reported that the browser's developer tools (DevTools) were opened while they were playing. On its own that isn't proof, but it's what you use to run cheat code or change the game.`, [[Date.now(), 'DevTools opened']]);
  }
  // the page's check-in, every 5 seconds. It also says if anything was hooked into the game (injected scripts)
  function onHeartbeat(p, msg) {
    const a = st(p); a.hbAt = Date.now();
    const x = msg && Array.isArray(msg.x) ? msg.x.filter(v => typeof v === 'string').map(v => v.replace(/[^\x20-\x7e]/g, '').slice(0, 100)).slice(0, 6) : [];
    if (x.length) flag(p, 'inject', 'Script injected into the game', `Their game found code that isn't part of Baseplate FPS hooked into it: ${x.join('; ')}. That's how hack clients (for example Tampermonkey scripts or hack extensions) read the game and fake shots. Some ordinary browser extensions add scripts too, so check the replay before banning.`, [[Date.now(), 'injected script found']]);
  }
  function onOdd(p, t) {
    if (!p.authed) return;
    const a = st(p); a.odd++; if (typeof t === 'string') a.oddTypes.add(t.slice(0, 20));
    if (a.odd >= 3) { flag(p, 'odd', 'Hack tool messages', `Their connection sent ${a.odd} messages the real game never sends${a.oddTypes.size ? ' (' + [...a.oddTypes].join(', ') + ')' : ''}. That's a hack tool trying things on the server, like changing stats or giving itself items. The server ignored them.`, [[Date.now(), 'odd message']]); a.odd = 0; }
  }
  // once a second: record the match for replays, and notice games whose check-in stopped
  function tickRoom(room, now) {
    room.acFrames = room.acFrames || [];
    if (!room.acLast || now - room.acLast >= 66) {
      room.acLast = now;
      const fr = [now, []];
      for (const q of room.players.values()) fr[1].push([q.id, r2(q.s.p[0]), r2(q.s.p[2]), r2(q.s.p[1]), r3(q.s.yw), r3(q.s.pt), q.alive ? 1 : 0, q.team]);
      room.acFrames.push(fr);
      while (room.acFrames.length && now - room.acFrames[0][0] > KEEP_MS) room.acFrames.shift();
    }
    if (!enabled()) return;
    if (!room.acHbCheck || now - room.acHbCheck > 5000) {
      room.acHbCheck = now;
      for (const q of room.players.values()) {
        const a = st(q);
        if (now - a.joinedAt > 40000 && now - (q.lastPosAt || 0) < 3000 && now - (a.hbAt || a.joinedAt) > 30000) flag(q, 'modified', 'Game code changed', `They kept playing, but their game stopped doing its regular anti-cheat check-in over 30 seconds ago. The real game always does it, so their copy of the game has been changed or part of it blocked.`, [[now, 'check-in missing']]);
      }
    }
  }
  return {
    onUpdate, onShot, onBadMove, onTamper, onHeartbeat, onOdd, tickRoom,
    list() { return [...flags.values()].sort((x, y) => y.at - x.at).map(f => ({ id: f.id, uid: f.uid, name: f.name, kind: f.kind, title: f.title, desc: f.desc, at: f.at, lastAt: f.lastAt, count: f.count, room: f.room, map: f.map, hasReplay: !!f.replay })); },
    get(id) { return flags.get(id) || null; },
    resolve(id) { const f = flags.get(id); if (!f) return null; flags.delete(id); const db = getDb(); if (db) db.ref('ac/flags/' + id).remove().catch(() => {}); return f; },
    dropFor(uid) { for (const [id, f] of flags) if (f.uid === uid) { flags.delete(id); const db = getDb(); if (db) db.ref('ac/flags/' + id).remove().catch(() => {}); } },
  };
};
