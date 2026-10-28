// RockLeague physics. The same file runs on the game server and in every player's browser, so both sides
// simulate the cars and the ball identically (the browser predicts ahead, the server has the final say).
// Units are metres and seconds. x runs across the pitch, y is up, z runs between the goals.
// Blue (team 0) defends the -z goal and attacks +z; Orange (team 1) the other way round.
(function (root) {
  'use strict';
  const DT = 1 / 120;                        // fixed physics step
  const G = 6.5;                             // gravity
  const F = { hx: 40.96, hz: 51.2, h: 20.44, corner: 11.5, ramp: 2.6 };   // the pitch: half width, half length, height, corner and curve radii
  const GOAL = { hx: 8.93, h: 6.43, depth: 8.8 };
  const BALL = { r: 0.9275, maxV: 60, drag: 0.0305, rest: 0.6, maxW: 6, mu: 0.28 };
  const CAR = {
    hx: 0.42, hy: 0.18, hz: 0.59,            // hitbox half extents (x across, y up, z forward)
    ride: 0.38, reach: 0.14,                 // hitbox centre height above the road, and how far the wheels can reach down
    maxV: 23, superV: 22, boostAcc: 9.9167, boostUse: 33.33, airThrottle: 0.6667,
    brake: 35, coast: 5.25, jumpV: 2.92, jumpHold: 14.58, holdT: 0.2, comboT: 1.25,
    dodgeV: 5.0, backDodgeV: 5.33, flipT: 0.65, flipW: 10.6, maxW: 5.5,
    stick: 3.25, grip: 22, slideGrip: 2.5, align: 30,
    massRatio: 6,                            // a car is six times heavier than the ball
    powerV: 46,                              // top speed with the owner's super powers on
  };
  const INERTIA = [(CAR.hy * CAR.hy + CAR.hz * CAR.hz) / 3, (CAR.hx * CAR.hx + CAR.hz * CAR.hz) / 3, (CAR.hx * CAR.hx + CAR.hy * CAR.hy) / 3];
  const CORNERS = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) CORNERS.push([sx * CAR.hx, sy * CAR.hy, sz * CAR.hz]);

  /* ---------- small vector helpers (plain arrays, so state is easy to send and copy) ---------- */
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  const norm = a => { const l = len(a); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  function addTo(a, b, s) { a[0] += b[0] * s; a[1] += b[1] * s; a[2] += b[2] * s; }
  function rot(q, v) {                      // rotate v by unit quaternion q = [x, y, z, w]
    const [qx, qy, qz, qw] = q, [x, y, z] = v;
    const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
  }
  const inv = q => [-q[0], -q[1], -q[2], q[3]];
  function qNorm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l; return q; }
  function qIntegrate(q, w, dt) {           // q += 0.5 * (w, 0) * q * dt
    const [x, y, z, qw] = q, h = 0.5 * dt;
    q[0] = x + h * (w[0] * qw + w[1] * z - w[2] * y);
    q[1] = y + h * (w[1] * qw + w[2] * x - w[0] * z);
    q[2] = z + h * (w[2] * qw + w[0] * y - w[1] * x);
    q[3] = qw + h * (-w[0] * x - w[1] * y - w[2] * z);
    qNorm(q);
  }
  function qFromYaw(yaw) { return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]; }
  function invI(q, v) { const l = rot(inv(q), v); return rot(q, [l[0] / INERTIA[0], l[1] / INERTIA[1], l[2] / INERTIA[2]]); }

  /* ---------- the arena: how far a point is from the nearest wall (positive inside the pitch) ---------- */
  function inside(x, y, z) {
    const qx = Math.abs(x) - F.hx + F.corner, qz = Math.abs(z) - F.hz + F.corner;
    const d2 = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - F.corner;
    const dy = Math.abs(y - F.h / 2) - F.h / 2, r = F.ramp;
    const ax = d2 + r, ay = dy + r;
    let d = -(Math.hypot(Math.max(ax, 0), Math.max(ay, 0)) + Math.min(Math.max(ax, ay), 0) - r);
    // the goals: a box behind each end wall, starting a little in front of it so the mouth has a flat floor
    const gz = F.hz + GOAL.depth / 2 - 1.5, ghz = GOAL.depth / 2 + 1.5;
    const bx = Math.abs(x) - GOAL.hx, by = Math.abs(y - GOAL.h / 2) - GOAL.h / 2, bz = Math.abs(Math.abs(z) - gz) - ghz;
    const gd = -(Math.hypot(Math.max(bx, 0), Math.max(by, 0), Math.max(bz, 0)) + Math.min(Math.max(bx, by, bz), 0));
    return gd > d ? gd : d;
  }
  const EPS = 0.01;
  function normalAt(x, y, z) {
    return norm([inside(x + EPS, y, z) - inside(x - EPS, y, z), inside(x, y + EPS, z) - inside(x, y - EPS, z), inside(x, y, z + EPS) - inside(x, y, z - EPS)]);
  }

  /* ---------- boost pads and kickoff spots ---------- */
  const PADS = [];
  for (const [x, z] of [[-36, 0], [36, 0], [-30, -41], [30, -41], [-30, 41], [30, 41]]) PADS.push({ x, z, big: true });
  for (const [x, z] of [[0, -46], [0, 46], [0, -28], [0, 28], [-17, -38], [17, -38], [-17, 38], [17, 38], [-12, -12], [12, -12], [-12, 12], [12, 12],
    [-24, -24], [24, -24], [-24, 24], [24, 24], [0, -12], [0, 12], [-34, -22], [34, -22], [-34, 22], [34, 22], [-20, 0], [20, 0], [-7, -24], [7, -24], [-7, 24], [7, 24]]) PADS.push({ x, z, big: false });
  const KICKOFFS = [[-20.48, -25.6], [20.48, -25.6], [-2.56, -38.4], [2.56, -38.4], [0, -46.08]];   // for Blue; Orange is mirrored

  /* ---------- world state ---------- */
  function newCar(id, team) {
    return { id, team, p: [0, CAR.ride, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0], boost: 33.3,
      jumped: 0, jumpT: 0, holdT: 0, dj: 0, dodgeT: -1, dax: [0, 0, 0], airT: 0, lock: 0, prevJump: 0, demoT: 0, ground: 0, bodyT: 0, nrm: [0, 1, 0], pw: 0, fz: 0 };
  }
  function newWorld() {
    return { tick: 0, ball: { p: [0, BALL.r, 0], v: [0, 0, 0], w: [0, 0, 0] }, cars: [], pads: PADS.map(() => 0) };
  }
  function kickoffPlace(world, spotIndex) {        // spotIndex picks one of the five spots; the opponent gets the mirror
    world.ball = { p: [0, BALL.r, 0], v: [0, 0, 0], w: [0, 0, 0] };
    for (const c of world.cars) {
      const [sx, sz] = KICKOFFS[spotIndex % KICKOFFS.length];
      const x = c.team === 0 ? sx : -sx, z = c.team === 0 ? sz : -sz;
      const yaw = Math.atan2(-x, -z);             // face the ball
      Object.assign(c, newCar(c.id, c.team), { p: [x, CAR.ride, z], q: qFromYaw(yaw), boost: 33.3, pw: c.pw || 0, fz: c.fz || 0 });
    }
    world.pads = PADS.map(() => 0);
  }
  function respawn(c, tick) {
    const s = c.team === 0 ? -1 : 1, side = (tick | 0) % 2 ? -1 : 1;
    Object.assign(c, newCar(c.id, c.team), { p: [side * 24, CAR.ride, s * 46], q: qFromYaw(s < 0 ? 0 : Math.PI), boost: 33.3, pw: c.pw || 0, fz: c.fz || 0 });
  }

  /* ---------- one car for one step ---------- */
  const throttleAcc = s => s < 14 ? 16 - 14.4 * (s / 14) : s < 14.1 ? 1.6 * (14.1 - s) / 0.1 : 0;
  const CURVE = [[0, 0.69], [5, 0.398], [10, 0.235], [15, 0.1375], [17.5, 0.11], [23, 0.088]];
  function curvature(s) {
    for (let i = 1; i < CURVE.length; i++) if (s <= CURVE[i][0]) { const [s0, c0] = CURVE[i - 1], [s1, c1] = CURVE[i]; return c0 + (c1 - c0) * (s - s0) / (s1 - s0); }
    return CURVE[CURVE.length - 1][1];
  }
  // a rigid-body bounce at one point of the car (with friction), used when the body itself hits a wall
  function bodyImpulse(c, r, n, e, mu) {
    const vp = add(c.v, cross(c.w, r)), vn = dot(vp, n);
    if (vn >= 0) return;
    const irn = invI(c.q, cross(r, n));
    const jn = -(1 + e) * vn / (1 + dot(cross(irn, r), n));
    addTo(c.v, n, jn); addTo(c.w, irn, jn);
    const vp2 = add(c.v, cross(c.w, r)), vt = sub(vp2, mul(n, dot(vp2, n))), vtl = len(vt);
    if (vtl > 1e-5) {
      const t = mul(vt, -1 / vtl), irt = invI(c.q, cross(r, t));
      const jt = Math.min(vtl / (1 + dot(cross(irt, r), t)), mu * jn);
      addTo(c.v, t, jt); addTo(c.w, irt, jt);
    }
  }
  function stepCar(c, inp, dt, tick, events) {
    if (c.demoT > 0) { c.demoT -= dt; if (c.demoT <= 0) { respawn(c, tick); events.push({ t: 'respawn', id: c.id }); } return; }
    if (c.fz) { c.v = [0, 0, 0]; c.w = [0, 0, 0]; c.prevJump = inp.jump ? 1 : 0; return; }   // frozen solid by the owner: can't move at all
    const fwd = rot(c.q, [0, 0, 1]), up = rot(c.q, [0, 1, 0]), left = rot(c.q, [1, 0, 0]);
    const a = [0, -G, 0];
    const jumpPressed = inp.jump && !c.prevJump;
    c.prevJump = inp.jump ? 1 : 0;
    if (c.lock > 0) c.lock--;
    if (c.bodyT > 0) c.bodyT -= dt;
    // are the wheels on something? (the arena is one smooth surface, so the nearest point under the car is the road)
    const d = inside(c.p[0], c.p[1], c.p[2]), n = normalAt(c.p[0], c.p[1], c.p[2]);
    const grounded = c.lock <= 0 && d < CAR.ride + CAR.reach && dot(up, n) > 0.55 && dot(c.v, n) < 1.5;
    c.ground = grounded ? 1 : 0;
    // super powers (the owner only, switched on by the server): double speed, endless boost,
    // flying (hardly any gravity in the air) and as many jumps as you like
    const pw = c.pw === 1;
    if (pw) {
      c.boost = 100;
      if (!grounded) { a[1] += G * 0.88; c.dj = 0; c.jumpT = 0; c.airT = 0; }
    }
    if (grounded) {
      c.nrm = n;
      c.jumped = 0; c.dj = 0; c.dodgeT = -1; c.airT = 0; c.holdT = 0;
      const vn = dot(c.v, n);
      if (vn < 0) addTo(c.v, n, -vn);                // the road takes any speed into it (that is what lets cars ride up curves)
      if (d < CAR.ride) addTo(c.p, n, (CAR.ride - d) * 0.6);
      addTo(a, n, -CAR.stick);                       // stick to walls and ramps
      const fS = norm(sub(fwd, mul(n, dot(fwd, n))));
      const vf = dot(c.v, fS), sp = Math.abs(vf);
      if (Math.abs(inp.thr) > 0.01 && vf * inp.thr < -0.05) addTo(a, fS, -Math.sign(vf) * CAR.brake * Math.min(1, Math.abs(inp.thr)));
      else if (Math.abs(inp.thr) > 0.01) addTo(a, fS, (pw ? (sp < 32 ? 38 : 0) : throttleAcc(sp)) * inp.thr);
      else if (sp > 0.01) addTo(a, fS, -Math.sign(vf) * Math.min(CAR.coast, sp / dt));
      // tyres: kill sideways slip (much less when power-sliding)
      const lat = sub(sub(c.v, mul(n, dot(c.v, n))), mul(fS, vf));
      addTo(c.v, lat, -(1 - Math.exp(-(inp.slide ? CAR.slideGrip : CAR.grip) * dt)));
      // steering: a turn rate about the road normal that depends on speed
      const turn = -(inp.steer || 0) * curvature(sp) * vf * (inp.slide ? 1.35 : 1);
      const wn = dot(c.w, n), wn2 = wn + (turn - wn) * Math.min(1, 16 * dt);
      // lean the car onto the road just ahead, so it stays flat on it through curves
      const ahead = add(c.p, mul(sub(c.v, mul(n, dot(c.v, n))), 0.04)), na = normalAt(ahead[0], ahead[1], ahead[2]);
      const ax = cross(up, na), s = len(ax), ang = Math.atan2(s, dot(up, na));
      c.w = add(mul(n, wn2), s > 1e-7 ? mul(ax, ang / s * CAR.align) : [0, 0, 0]);
      // too slow on a wall or the ceiling: drop off it
      if (n[1] < 0.3 && len(c.v) < 3.5 && !inp.boost) { c.lock = 24; addTo(c.v, n, 1.2); }
    } else {
      c.airT += dt;
      // air control in the car's own frame: pitch about its left axis, yaw about up, roll about forward
      const wl = rot(inv(c.q), c.w);
      const dodging = c.dodgeT >= 0 && c.dodgeT < CAR.flipT;
      const pitch = dodging ? 0 : (inp.pitch || 0), yaw = dodging ? 0 : (inp.yaw || 0), roll = dodging ? 0 : (inp.roll || 0);
      const al = [12.46 * pitch - 2.798 * wl[0] * (1 - Math.abs(pitch)), -9.11 * yaw - 1.886 * wl[1] * (1 - Math.abs(yaw)), 38.34 * roll - 4.47 * wl[2]];
      if (!dodging) addTo(c.w, rot(c.q, al), dt * (pw ? 1.5 : 1));
      if (Math.abs(inp.thr) > 0.01) addTo(a, fwd, CAR.airThrottle * inp.thr);
    }
    // boost
    if (inp.boost && c.boost > 0) { addTo(a, fwd, CAR.boostAcc * (pw ? 3 : 1)); if (!pw) c.boost = Math.max(0, c.boost - CAR.boostUse * dt); }
    // jumping, double jumps, dodges, and getting back on your wheels
    if (c.jumped) { c.jumpT += dt; if (!inp.jump) c.holdT = CAR.holdT; }   // letting go of jump ends the high jump
    if (grounded && jumpPressed) {
      addTo(c.v, up, CAR.jumpV); c.jumped = 1; c.jumpT = 0; c.holdT = 0; c.lock = 8;
      events.push({ t: 'jump', id: c.id });
    } else if (c.jumped && inp.jump && c.holdT < CAR.holdT && c.dodgeT < 0 && !c.dj) {
      addTo(a, up, CAR.jumpHold); c.holdT += dt;
    } else if (!grounded && jumpPressed && c.bodyT > 0 && dot(up, c.nrm) < 0.55) {
      // stuck on your roof or side: a jump rolls you back over
      const sgn = dot(left, c.nrm) > 0 ? -1 : 1;
      addTo(c.v, c.nrm, 3.4); c.dax = [0, 0, sgn * 0.58]; c.dodgeT = 0; c.jumped = 1; c.dj = 1; c.jumpT = 0; c.holdT = CAR.holdT; c.bodyT = 0;
      events.push({ t: 'jump', id: c.id });
    } else if (!grounded && jumpPressed && !c.dj && (c.jumped ? c.jumpT < CAR.comboT : c.airT < CAR.comboT)) {
      const px = inp.pitch || 0, sx = inp.yaw || 0, mag = Math.hypot(px, sx);
      c.dj = 1;
      if (mag < 0.5) { addTo(c.v, up, CAR.jumpV); events.push({ t: 'jump', id: c.id }); }
      else {
        const fx = px / mag, sxn = sx / mag;      // pitch +1 is W (nose down, so a front flip), yaw +1 is D (right)
        const flatF = norm([fwd[0], 0, fwd[2]]), flatL = norm([left[0], 0, left[2]]);
        const imp = fx < -0.1 ? CAR.backDodgeV : CAR.dodgeV;
        const dir = norm(add(mul(flatF, fx), mul(flatL, -sxn)));
        addTo(c.v, dir, imp);
        if (c.v[1] < 0) c.v[1] = 0;                  // a dodge stops you falling for a moment
        c.dax = [fx, 0, sxn]; c.dodgeT = 0;
        events.push({ t: 'flip', id: c.id });
      }
    }
    if (c.dodgeT >= 0) {
      c.dodgeT += dt;
      if (c.dodgeT < CAR.flipT) {
        // spin hard for most of the dodge, then settle, so a flip off the ground comes round onto the wheels
        const sp = c.dodgeT < CAR.flipT - 0.12 ? CAR.flipW : 0;
        const wl = rot(inv(c.q), c.w), target = [c.dax[0] * sp, wl[1] * 0.5, c.dax[2] * sp];
        const k = Math.min(1, 30 * dt);
        c.w = rot(c.q, [wl[0] + (target[0] - wl[0]) * k, wl[1] + (target[1] - wl[1]) * k, wl[2] + (target[2] - wl[2]) * k]);
        if (c.v[1] < 0) c.v[1] *= 0.65;
      }
    }
    // integrate
    addTo(c.v, a, dt);
    const vMax = pw ? CAR.powerV : CAR.maxV, sp = len(c.v); if (sp > vMax) c.v = mul(c.v, vMax / sp);
    const wMax = c.dodgeT >= 0 && c.dodgeT < CAR.flipT ? CAR.flipW : CAR.maxW, ws = len(c.w); if (ws > wMax && !grounded) c.w = mul(c.w, wMax / ws);
    addTo(c.p, c.v, dt); qIntegrate(c.q, c.w, dt);
    // the body itself: keep every corner of the hitbox inside the arena, bouncing off like a solid box
    let deepest = 0, dn = null; const hits = [];
    for (const k of CORNERS) {
      const r = rot(c.q, k), pt = add(c.p, r), dd = inside(pt[0], pt[1], pt[2]);
      if (dd < 0.004) { const nn = normalAt(pt[0], pt[1], pt[2]); hits.push([r, nn]); if (dd < deepest) { deepest = dd; dn = nn; } }
    }
    if (dn) addTo(c.p, dn, -deepest);
    if (hits.length) {
      const fast = hits.some(([r, nn]) => dot(add(c.v, cross(c.w, r)), nn) < -1.5);
      for (let it = 0; it < 4; it++) for (const [r, nn] of hits) bodyImpulse(c, r, nn, fast ? 0.25 : 0, 0.6);
      if (!grounded) {
        c.bodyT = 0.25; c.nrm = hits[0][1];
        c.w = mul(c.w, 1 - 3 * dt);                  // scraping along on its side or roof soon stops it spinning
      }
    }
  }

  /* ---------- the ball ---------- */
  function stepBall(b, dt, events) {
    b.v[1] -= G * dt;
    const k = 1 - BALL.drag * dt; b.v = mul(b.v, k);
    const sp = len(b.v); if (sp > BALL.maxV) b.v = mul(b.v, BALL.maxV / sp);
    addTo(b.p, b.v, dt);
    const d = inside(b.p[0], b.p[1], b.p[2]);
    if (d < BALL.r) {
      const n = normalAt(b.p[0], b.p[1], b.p[2]);
      addTo(b.p, n, BALL.r - d);
      const vn = dot(b.v, n);
      if (vn < 0) {
        addTo(b.v, n, -vn * (1 + (-vn > 0.5 ? BALL.rest : 0)));
        // friction at the contact point turns sliding into rolling and spin into a kick
        const rc = mul(n, -BALL.r), slip = add(sub(b.v, mul(n, dot(b.v, n))), cross(b.w, rc));   // how fast the contact point slides: v + w x r
        const sl = len(slip);
        if (sl > 1e-4) {
          const j = Math.min(sl * 2 / 7, BALL.mu * (1 + BALL.rest) * -vn + 0.02);
          const dir = mul(slip, -1 / sl);
          addTo(b.v, dir, j);
          addTo(b.w, cross(rc, dir), j * 5 / (2 * BALL.r * BALL.r));
        }
        if (-vn > 3) events.push({ t: 'bounce', s: -vn });
      }
      // touching the ground or a wall: spin about the contact point (like a top) dies away instead of going on forever,
      // and a ball rolling on the floor slows down and comes to rest
      const tw = dot(b.w, n); addTo(b.w, n, -tw * Math.min(1, 3 * dt));
      if (n[1] > 0.6) {
        const vt = sub(b.v, mul(n, dot(b.v, n))), st = len(vt);
        if (st > 1e-6) addTo(b.v, vt, -Math.min(st, 0.6 * dt) / st);
        if (st < 0.05 && len(b.w) < 0.4) { b.v = mul(n, dot(b.v, n)); b.w = [0, 0, 0]; }
      }
    }
    b.w = mul(b.w, 1 - 0.04 * dt);                              // a little air drag on the spin too
    const ws = len(b.w); if (ws > BALL.maxW) b.w = mul(b.w, BALL.maxW / ws);
  }
  // a car hitting the ball: a solid bounce plus the extra push that makes shots fly
  const HIT = [[0, 0.65], [5, 0.65], [23, 0.55], [46, 0.3]];
  function hitScale(s) { for (let i = 1; i < HIT.length; i++) if (s <= HIT[i][0]) { const [s0, k0] = HIT[i - 1], [s1, k1] = HIT[i]; return k0 + (k1 - k0) * (s - s0) / (s1 - s0); } return 0.3; }
  function carBall(c, b, events) {
    if (c.demoT > 0) return;
    const l = rot(inv(c.q), sub(b.p, c.p));
    const cl = [clamp(l[0], -CAR.hx, CAR.hx), clamp(l[1], -CAR.hy, CAR.hy), clamp(l[2], -CAR.hz, CAR.hz)];
    const dl = sub(l, cl), dist = len(dl);
    if (dist >= BALL.r) return;
    let nl;
    if (dist > 1e-6) nl = mul(dl, 1 / dist);
    else { const ex = [CAR.hx - Math.abs(l[0]), CAR.hy - Math.abs(l[1]), CAR.hz - Math.abs(l[2])], i = ex.indexOf(Math.min(...ex)); nl = [0, 0, 0]; nl[i] = Math.sign(l[i]) || 1; }
    const n = rot(c.q, nl), pen = BALL.r - dist;
    if (c.fz) { addTo(b.p, n, pen); const vn0 = dot(b.v, n); if (vn0 < 0) { addTo(b.v, n, -vn0 * 1.6); events.push({ t: 'touch', id: c.id, s: -vn0, p: b.p.slice() }); } return; }   // a frozen car is a block of ice
    const m = CAR.massRatio;
    addTo(b.p, n, pen * m / (m + 1)); addTo(c.p, n, -pen / (m + 1));
    const rc = rot(c.q, cl), vcp = add(c.v, cross(c.w, rc));
    const vrel = sub(b.v, vcp), vn = dot(vrel, n);
    if (vn >= 0) return;
    const j = -(1 + 0.05) * vn / (1 + 1 / m);
    addTo(b.v, n, j); addTo(c.v, n, -j / m);
    // the extra push goes from the car's centre to the ball, flattened a little, and is bigger for gentle hits
    const s = Math.min(len(vrel), 46);
    const flat = sub(b.p, c.p); flat[1] *= 0.35;
    addTo(b.v, norm(flat), s * hitScale(s));
    events.push({ t: 'touch', id: c.id, s, p: b.p.slice() });
  }
  function carCar(a, b, events) {
    if (a.demoT > 0 || b.demoT > 0) return;
    const d = sub(b.p, a.p), dist = len(d), R = 1.05;
    if (dist >= R || dist < 1e-6) return;
    const n = mul(d, 1 / dist), pen = R - dist;
    addTo(a.p, n, -pen / 2); addTo(b.p, n, pen / 2);
    const vrel = dot(sub(b.v, a.v), n);
    // a supersonic car driving into another one demolishes it
    for (const [att, vic, dirn] of [[a, b, n], [b, a, mul(n, -1)]]) {
      if (att.team === vic.team) continue;
      const fwd = rot(att.q, [0, 0, 1]);
      if (len(att.v) >= CAR.superV && dot(fwd, dirn) > 0.6 && dot(att.v, dirn) > 10) {
        vic.demoT = 3; vic.v = [0, 0, 0]; vic.w = [0, 0, 0]; events.push({ t: 'demo', id: att.id, victim: vic.id, p: vic.p.slice() });
        return;
      }
    }
    if (vrel < 0) {
      const j = -1.4 * vrel / 2;
      addTo(a.v, n, -j); addTo(b.v, n, j);
      a.v[1] += 0.6; b.v[1] += 0.6;                   // a little hop on a bump
      events.push({ t: 'bump', id: a.id, other: b.id, s: -vrel });
    }
  }
  function stepPads(world, dt, events) {
    for (let i = 0; i < PADS.length; i++) {
      if (world.pads[i] > 0) { world.pads[i] = Math.max(0, world.pads[i] - dt); continue; }
      const pad = PADS[i], r = pad.big ? 2.08 : 1.44;
      for (const c of world.cars) {
        if (c.demoT > 0 || c.p[1] > 1.65 || c.boost >= 100) continue;
        if (Math.hypot(c.p[0] - pad.x, c.p[2] - pad.z) < r) {
          c.boost = pad.big ? 100 : Math.min(100, c.boost + 12);
          world.pads[i] = pad.big ? 10 : 4;
          events.push({ t: 'pad', id: c.id, pad: i });
          break;
        }
      }
    }
  }
  // which goal (if any) the ball is all the way inside: 0 = Blue scored (ball in the +z goal), 1 = Orange scored
  function goalCheck(b) {
    if (Math.abs(b.p[0]) > GOAL.hx || b.p[1] > GOAL.h) return -1;
    if (b.p[2] > F.hz + BALL.r) return 0;
    if (b.p[2] < -F.hz - BALL.r) return 1;
    return -1;
  }
  // where the ball will go with nobody touching it: returns the team that would score within secs, or -1
  function ballFuture(b, secs) {
    const c = { p: b.p.slice(), v: b.v.slice(), w: b.w.slice() }, ev = [];
    for (let i = 0, n = Math.round(secs / DT); i < n; i++) { stepBall(c, DT, ev); const g = goalCheck(c); if (g >= 0) return g; }
    return -1;
  }
  const IDLE = { thr: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, slide: false };
  // one physics step for the whole world; inputs is a map of car id -> input; frozen = kickoff countdown;
  // noBall = the ball is out of play (just after a goal), so only the cars move
  function step(world, inputs, frozen, noBall) {
    const events = [];
    for (const c of world.cars) {
      const inp = frozen ? IDLE : (inputs[c.id] || IDLE);
      if (frozen) { c.prevJump = inputs[c.id] && inputs[c.id].jump ? 1 : 0; continue; }
      stepCar(c, inp, DT, world.tick, events);
    }
    if (!frozen) {
      if (!noBall) {
        stepBall(world.ball, DT, events);
        for (const c of world.cars) carBall(c, world.ball, events);
      }
      for (let i = 0; i < world.cars.length; i++) for (let j = i + 1; j < world.cars.length; j++) carCar(world.cars[i], world.cars[j], events);
      stepPads(world, DT, events);
    }
    world.tick++;
    return events;
  }

  /* ---------- inputs and state, packed small for the network ---------- */
  const q8 = v => Math.round(clamp(+v || 0, -1, 1) * 100);
  function packInput(i) { return [q8(i.thr), q8(i.steer), q8(i.pitch), q8(i.yaw), q8(i.roll), (i.jump ? 1 : 0) | (i.boost ? 2 : 0) | (i.slide ? 4 : 0)]; }
  function unpackInput(a) {
    if (!Array.isArray(a) || a.length !== 6) return IDLE;
    const n = v => typeof v === 'number' && isFinite(v) ? clamp(Math.round(v) / 100, -1, 1) : 0;
    const f = a[5] | 0;
    return { thr: n(a[0]), steer: n(a[1]), pitch: n(a[2]), yaw: n(a[3]), roll: n(a[4]), jump: !!(f & 1), boost: !!(f & 2), slide: !!(f & 4) };
  }
  const R4 = v => Math.round(v * 10000) / 10000;
  function packCar(c) {
    return [c.id, c.team, ...c.p.map(R4), ...c.q.map(R4), ...c.v.map(R4), ...c.w.map(R4), R4(c.boost), c.jumped, R4(c.jumpT), R4(c.holdT), c.dj,
      R4(c.dodgeT), ...c.dax.map(R4), R4(c.airT), c.lock, c.prevJump, R4(c.demoT), c.ground, R4(c.bodyT), ...c.nrm.map(R4), c.pw ? 1 : 0, c.fz ? 1 : 0];
  }
  function unpackCar(a) {
    let i = 0; const g = () => a[i++];
    const c = newCar(g(), g());
    c.p = [g(), g(), g()]; c.q = [g(), g(), g(), g()]; c.v = [g(), g(), g()]; c.w = [g(), g(), g()]; c.boost = g();
    c.jumped = g(); c.jumpT = g(); c.holdT = g(); c.dj = g(); c.dodgeT = g(); c.dax = [g(), g(), g()]; c.airT = g(); c.lock = g(); c.prevJump = g(); c.demoT = g();
    c.ground = g(); c.bodyT = g(); c.nrm = [g(), g(), g()]; c.pw = g() === 1 ? 1 : 0; c.fz = g() === 1 ? 1 : 0;
    qNorm(c.q);
    return c;
  }
  const packBall = b => [...b.p.map(R4), ...b.v.map(R4), ...b.w.map(R4)];
  const unpackBall = a => ({ p: a.slice(0, 3), v: a.slice(3, 6), w: a.slice(6, 9) });
  function cloneWorld(w) {
    return { tick: w.tick, ball: { p: w.ball.p.slice(), v: w.ball.v.slice(), w: w.ball.w.slice() }, cars: w.cars.map(c => Object.assign({}, c, { p: c.p.slice(), q: c.q.slice(), v: c.v.slice(), w: c.w.slice(), dax: c.dax.slice(), nrm: c.nrm.slice() })), pads: w.pads.slice() };
  }

  const api = { DT, G, F, GOAL, BALL, CAR, PADS, KICKOFFS, inside, normalAt, newWorld, newCar, kickoffPlace, respawn, step, goalCheck, ballFuture,
    packInput, unpackInput, packCar, unpackCar, packBall, unpackBall, cloneWorld, rot, IDLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RLPhys = api;
})(typeof window !== 'undefined' ? window : this);
