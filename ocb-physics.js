// othercolourbike physics and trails. The same file runs in every player's browser and on the game server.
// It is fully deterministic: it only uses + - * / sqrt and floor (no Math.sin, atan2, hypot or pow, which can
// differ between browsers), so the server can replay anyone's run from their controls and get the exact same
// result. That is how leaderboard times and scores are checked: you can't just claim a time.
// Side-on world: x runs along the trail (riding direction), y is up. Units are metres and seconds.
(function (root) {
  'use strict';
  const DT = 1 / 120, G = 9.8, PI = 3.141592653589793, TAU = 6.283185307179586, HALF = 1.5707963267948966;
  function dsin(x) {
    x = x - TAU * Math.floor(x / TAU + 0.5);
    if (x > HALF) x = PI - x; else if (x < -HALF) x = -PI - x;
    const x2 = x * x;
    return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 / 6227020800))))));
  }
  const dcos = x => dsin(x + HALF);
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const sqrt = Math.sqrt;

  /* ---------- the bike: a long, slack, very silly prototype ---------- */
  const BIKE = {
    wb: 0.74, R: 0.37, comX: -0.02, comY: 0.62, I: 0.3,
    k: 115, c: 13, travel: 0.17,
    pedalA: 6.2, pedalV: 8.6, brakeA: 9.5, roll: 0.22, drag: 0.004,
    pumpG: 8.5, hop: 3.1, tapT: 22,
    airAlpha: 21, airW: 7.6, airDamp: 4.5, maxV: 33,
    spinRate: TAU / 0.72, hardLand: 15,
  };
  // points on the bike, relative to the centre of mass, in the bike's own frame (x forward, y up)
  const HUB_R = [-BIKE.wb - BIKE.comX, -BIKE.comY], HUB_F = [BIKE.wb - BIKE.comX, -BIKE.comY];
  const HEAD = [-0.06, 1.02], CHEST = [0.04, 0.62], BB = [0.02, -BIKE.comY - 0.05];

  const TRICKS = [null,
    { id: 'superman', name: 'Superman', pts: 300 }, { id: 'xup', name: 'X-Up', pts: 200 }, { id: 'whip', name: 'Tail Whip', pts: 260 },
    { id: 'nohander', name: 'No-Hander', pts: 220 }, { id: 'table', name: 'Table Top', pts: 180 }, { id: 'seatgrab', name: 'Seat Grab', pts: 160 },
    { id: 'cancan', name: 'Can-Can', pts: 200 }, { id: 'nacnac', name: 'Nac-Nac', pts: 230 }];
  const PTS = { hold: 250, back: 600, front: 750, spin: 400, air: 60, perfect: 150, manual: 50 };
  // controls are packed into one small number per physics step, so a whole run is cheap to send and replay
  const IN = { PUMP: 1, BACK: 2, FWD: 4, PEDAL: 8, BRAKE: 16, SPINL: 32, SPINR: 64 };
  const trickDir = b => (b >> 7) & 15;

  /* ---------- building a trail from a list of features ---------- */
  function hash(i) { let h = (i * 374761393 + 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function build(def) {
    const P = [[-40, 0], [0, 0]], deco = [], zones = [];
    let x = 0, y = 0, g = 0, seed = 1;
    const push = (nx, ny) => { if (nx <= P[P.length - 1][0] + 1e-6) nx = P[P.length - 1][0] + 0.02; P.push([nx, ny]); x = nx; y = ny; };
    const ease = (L, g1) => { const n = Math.max(1, Math.ceil(L / 0.5)), g0 = g; for (let i = 1; i <= n; i++) { const t = i / n, gm = g0 + (g1 - g0) * (t - 0.5 / n); push(x + L / n, y + gm * L / n); } g = g1; };
    const line = (L, g1) => { g = g1; const n = Math.max(1, Math.ceil(L / 4)); for (let i = 0; i < n; i++) push(x + L / n, y + g1 * L / n); };
    const kicker = (h, gr) => { const L = Math.max(1.2, 2 * h / Math.max(0.15, g + gr)); ease(L, gr); return [x, y]; };
    // a gap jump: kicker, a pit, then a landing that starts dh above (or below) the lip
    const gapJump = (kh, kg, gap, dh, lg, ll, pit) => {
      const y0 = y; const [lx, ly] = kicker(kh, kg);
      const floor = Math.min(y0, ly + dh) - (pit === undefined ? 1.2 : pit), top = ly + dh;
      push(lx + 0.6, floor + 0.3); push(lx + 1.2, floor);
      const backX = lx + gap - 0.9;
      push(Math.max(x + 0.5, backX - (top - floor) * 0.55), floor);
      push(backX, top - 0.15); push(lx + gap, top); g = 0;
      ease(0.8, -lg * 0.6); line(ll, -lg); ease(Math.max(2, ll * 0.35), def.run || -0.05);
      deco.push({ t: 'jump', lip: lx, land: lx + gap, fi: curF, kh });
    };
    let curF = -1;
    for (const f of def.f) {
      curF++;
      const [k, a = 0, b = 0, c = 0, d = 0, e = 0, h = 0, i] = f;
      if (k === 'flat') line(a, 0);
      else if (k === 'line') line(a, b);
      else if (k === 'ease') ease(a, b);
      else if (k === 'roll') { // a rollers of height b, length c each
        const base = g;
        for (let r = 0; r < a; r++) { const n = Math.ceil(c / 0.4); const x0 = x, y0 = y; for (let j = 1; j <= n; j++) { const t = j / n; push(x0 + c * t, y0 + base * c * t + b * 0.5 * (1 - dcos(TAU * t))); } }
        g = base;
      }
      else if (k === 'table') { const [lx] = kicker(a, b); line(c, 0); ease(0.8, -d * 0.6); line(e, -d); ease(Math.max(2, e * 0.35), def.run || -0.05); deco.push({ t: 'table', lip: lx, land: lx + c, fi: curF, kh: a }); }
      else if (k === 'jump') gapJump(a, b, c, d, e, h, i);
      else if (k === 'drop') { // a ledge of height a, landing at grade b for length c
        const dx0 = x; push(x + 0.1, y - a); g = -b; line(c, -b); ease(Math.max(2.5, c * 0.4), def.run || -0.05); deco.push({ t: 'drop', x: dx0, h: a, lip: dx0, fi: curF });
      }
      else if (k === 'rocks') { const x0 = x, n = Math.ceil(a / 0.6), y0 = y; for (let j = 1; j <= n; j++) { const off = (hash(seed++) - 0.5) * 2 * b; push(x0 + j * a / n, y0 + g * a * j / n + (j < n ? off : 0)); if (hash(seed++) < 0.45) deco.push({ t: 'rock', x: x, y: y, s: 0.3 + hash(seed++) * b * 2.4 }); } }
      else if (k === 'shore') deco.push({ t: 'shore', x0: x, x1: x + a });
      else if (k === 'zone') zones.push({ id: a, x0: x, x1: x + (b || 30) });
      else if (k === 'sign') deco.push({ t: 'sign', x, text: a });
    }
    const finish = x;
    line(45, 0);
    // a lookup grid so the physics can find the ground under any x quickly
    const segs = [];
    for (let j = 0; j < P.length - 1; j++) {
      const [x0, y0] = P[j], [x1, y1] = P[j + 1], dx = x1 - x0, dy = y1 - y0, l = sqrt(dx * dx + dy * dy);
      segs.push({ x0, y0, x1, y1, dx, dy, l, nx: -dy / l, ny: dx / l });
    }
    const gx0 = P[0][0], cell = 1, cells = [];
    for (let j = 0; j < segs.length; j++) { const s = segs[j]; for (let c = Math.floor((s.x0 - gx0) / cell); c <= Math.floor((s.x1 - gx0) / cell); c++) (cells[c] = cells[c] || []).push(j); }
    return { def, P, segs, cells, gx0, cell, finish, deco, zones, start: 2, minY: Math.min(...P.map(p => p[1])) };
  }
  function segIndexAt(L, x) {
    const c = L.cells[Math.floor((x - L.gx0) / L.cell)];
    if (c) for (const j of c) { const s = L.segs[j]; if (x >= s.x0 && x <= s.x1) return j; }
    return x < L.gx0 ? 0 : L.segs.length - 1;
  }
  function surfY(L, x) { const s = L.segs[segIndexAt(L, x)]; const t = s.dx > 0 ? clamp((x - s.x0) / s.dx, 0, 1) : 0; return s.y0 + s.dy * t; }
  function surfN(L, x) { const s = L.segs[segIndexAt(L, x)]; return [s.nx, s.ny]; }
  // a wheel (circle) against the ground: how deep it is pressed in and which way the ground pushes back
  function wheelHit(L, cx, cy, R) {
    const sy = surfY(L, cx);
    if (cy < sy) { const n = surfN(L, cx); return [R + (sy - cy) * n[1], n[0], n[1]]; }
    let best = R * R, bx = 0, by = 0, found = false;
    const c0 = Math.floor((cx - R - L.gx0) / L.cell), c1 = Math.floor((cx + R - L.gx0) / L.cell);
    for (let c = c0; c <= c1; c++) {
      const list = L.cells[c]; if (!list) continue;
      for (const j of list) {
        const s = L.segs[j];
        let t = ((cx - s.x0) * s.dx + (cy - s.y0) * s.dy) / (s.l * s.l); t = clamp(t, 0, 1);
        const px = s.x0 + s.dx * t, py = s.y0 + s.dy * t, ex = cx - px, ey = cy - py, d2 = ex * ex + ey * ey;
        if (d2 < best) { best = d2; bx = px; by = py; found = true; }
      }
    }
    if (!found) return null;
    const d = sqrt(best);
    if (d < 1e-6) { const n = surfN(L, cx); return [R, n[0], n[1]]; }
    return [R - d, (cx - bx) / d, (cy - by) / d];
  }

  /* ---------- a run ---------- */
  function newRun(L, startX) {
    const sx = startX === undefined ? L.start : startX;
    const s = { tick: 0, x: sx, y: 0, a: 0, vx: 0, vy: 0, w: 0, gw: 0, air: 0, gnd: 0, lnx: 0, lny: 1, pumpT: 0, pumpPrev: 0, popArmed: 1,
      tid: 0, tph: 0, tst: 0, tholdT: 0, tdirPrev: 0, sAng: 0, sDir: 0, sAct: 0, rot: 0, takeoffX: 0, airT: 0,
      cPts: 0, cN: 0, cNames: [], score: 0, manT: 0, manD: 0, manKind: 0,
      crashed: 0, why: '', finished: 0, finishTick: 0,
      st: { tricks: 0, trickIds: 0, back: 0, front: 0, spins: 0, spinFlip: 0, maxAir: 0, maxCombo: 0, manual: 0, pedal: 0, brake: 0, maxV: 0, zones: {}, perfect: 0, flips: 0 } };
    // sit the bike on the ground at the start
    s.y = surfY(L, sx) + BIKE.R + BIKE.comY - 0.04;
    return s;
  }
  const local = (s, c, sn, p) => [p[0] * c - p[1] * sn, p[0] * sn + p[1] * c];
  function comboAdd(s, pts, name) { s.cPts += pts; s.cN++; s.cNames.push(name); }
  function crash(s, why, ev) { if (s.crashed) return; s.crashed = 1; s.why = why; s.cPts = 0; s.cN = 0; s.cNames = []; ev.push({ t: 'crash', why }); }
  function bankManual(s, ev) {
    if (s.manD >= 2) { const p = Math.round(s.manD * PTS.manual); s.score += p; s.st.manual = Math.max(s.st.manual, s.manD); ev.push({ t: 'manual', d: s.manD, pts: p, nose: s.manKind === 2 }); }
    s.manT = 0; s.manD = 0; s.manKind = 0;
  }
  // one physics step. b = the packed controls for this step. Returns what happened (for sounds, text and effects).
  function step(L, s, b) {
    const ev = [];
    s.tick++;
    if (s.crashed || s.finished) return ev;
    const B = BIKE, c = dcos(s.a), sn = dsin(s.a);
    const pump = b & IN.PUMP, back = b & IN.BACK, fwd = b & IN.FWD;
    // --- wheels on the ground: suspension springs ---
    let fx = 0, fy = 0, tq = 0, gnd = 0, nAvgX = 0, nAvgY = 0, rn = null;
    for (let wi = 0; wi < 2; wi++) {
      const r = local(s, c, sn, wi ? HUB_F : HUB_R), hit = wheelHit(L, s.x + r[0], s.y + r[1], B.R);
      if (!hit || hit[0] <= 0) continue;
      const [pen, nx, ny] = hit; gnd |= wi ? 2 : 1; nAvgX += nx; nAvgY += ny; if (!wi) rn = [nx, ny];
      const vhx = s.vx - s.w * r[1], vhy = s.vy + s.w * r[0], vn = vhx * nx + vhy * ny;
      const f = B.k * Math.min(pen, B.travel) - B.c * vn;
      if (f > 0) { fx += f * nx; fy += f * ny; tq += r[0] * f * ny - r[1] * f * nx; }
    }
    const grounded = gnd !== 0;
    if (grounded) {
      const l = sqrt(nAvgX * nAvgX + nAvgY * nAvgY) || 1, nnx = nAvgX / l, nny = nAvgY / l;
      s.gw = gnd === 3 && s.gw !== undefined ? s.gw * 0.7 + 0.3 * ((s.lnx * nny - s.lny * nnx) / DT) : 0;
      s.lnx = nnx; s.lny = nny;
    } else s.gw = 0;
    // --- pedalling, braking, rolling ---
    let ax = 0, ay = -G - (pump ? B.pumpG : 0), alpha = 0;
    const nx = s.lnx, ny = s.lny, tx = ny, ty = -nx, vt = s.vx * tx + s.vy * ty;
    if (grounded) {
      if ((b & IN.PEDAL) && (gnd & 1) && !(b & IN.BRAKE)) { const acc = B.pedalA * Math.max(0, 1 - vt / B.pedalV); ax += tx * acc; ay += ty * acc; s.st.pedal = 1; }
      if (b & IN.BRAKE) { const dv = Math.min(B.brakeA * DT, Math.abs(vt)) * (vt > 0 ? 1 : -1); s.vx -= tx * dv; s.vy -= ty * dv; s.st.brake = 1; }
      else if (Math.abs(vt) > 0.01) { const dv = Math.min(B.roll * DT, Math.abs(vt)) * (vt > 0 ? 1 : -1); s.vx -= tx * dv; s.vy -= ty * dv; }
    }
    // --- leaning: manuals on the ground, flips in the air ---
    if (grounded) {
      const ux = -sn, uy = c, cr = nx * uy - ny * ux;            // how far the bike is tipped back from the ground (sine of the angle)
      if (back && !fwd) alpha = 75 * (0.36 - cr) - 9 * s.w;
      else if (fwd && !back) alpha = 75 * (-0.3 - cr) - 9 * s.w;
      else if (gnd === 3) alpha = -55 * cr - 4 * (s.w - s.gw);      // both wheels down: the bike follows the ground through dips and up kickers
    } else {
      if (back && !fwd) alpha = B.airAlpha; else if (fwd && !back) alpha = -B.airAlpha; else alpha = -B.airDamp * s.w;
    }
    // --- a quick tap of pump is a bunny hop; holding it pumps (and letting go just stops pumping) ---
    if (s.pumpPrev && !pump && s.popArmed && (grounded || s.air < 8) && s.pumpT <= B.tapT) {
      const v = B.hop; s.vx += s.lnx * v; s.vy += s.lny * v; s.popArmed = 0; ev.push({ t: 'pop', v });
    }
    s.pumpT = pump ? s.pumpT + 1 : 0; s.pumpPrev = pump ? 1 : 0;
    if (grounded && !pump) s.popArmed = 1;
    // --- move ---
    s.vx += (fx + ax) * DT; s.vy += (fy + ay) * DT; s.w += (tq / B.I + alpha) * DT;
    s.w = clamp(s.w, -B.airW * 1.3, B.airW * 1.3);
    if (!grounded) s.w = clamp(s.w, -B.airW, B.airW);
    const sp2 = s.vx * s.vx + s.vy * s.vy, sp = sqrt(sp2);
    if (sp > 0.01) { const k = Math.max(0, 1 - B.drag * sp * DT); s.vx *= k; s.vy *= k; }
    if (sp > B.maxV) { s.vx *= B.maxV / sp; s.vy *= B.maxV / sp; }
    s.x += s.vx * DT; s.y += s.vy * DT; s.a += s.w * DT;
    if (sp > s.st.maxV) s.st.maxV = sp;
    // --- hard contacts: a bottomed-out wheel, or the frame, can't go into the ground ---
    const c2 = dcos(s.a), sn2 = dsin(s.a);
    let impact = 0;
    for (const p of [HUB_R, HUB_F, BB]) {
      const isBB = p === BB, r = local(s, c2, sn2, p);
      const hit = isBB ? (() => { const py = surfY(L, s.x + r[0]); const d = s.y + r[1] - py; return d < 0 ? [-d, ...surfN(L, s.x + r[0])] : null; })() : wheelHit(L, s.x + r[0], s.y + r[1], B.R);
      if (!hit) continue;
      const over = isBB ? hit[0] : hit[0] - B.travel;
      if (over <= 0) continue;
      const [, hx, hy] = hit;
      s.x += hx * over; s.y += hy * over;
      const vhx = s.vx - s.w * r[1], vhy = s.vy + s.w * r[0], vn = vhx * hx + vhy * hy;
      if (vn < 0) {
        const rc = r[0] * hy - r[1] * hx, j = -vn / (1 + rc * rc / B.I);
        s.vx += j * hx; s.vy += j * hy; s.w += rc * j / B.I;
        impact = Math.max(impact, -vn);
      }
    }
    // --- the rider: head or body in the dirt is a crash ---
    for (const p of [HEAD, CHEST]) { const r = local(s, c2, sn2, p); if (s.y + r[1] < surfY(L, s.x + r[0])) { crash(s, p === HEAD ? 'head' : 'body', ev); return ev; } }
    if (grounded && c2 < -0.2) { crash(s, 'upside', ev); return ev; }              // on your back
    if (s.y < L.minY - 60) { crash(s, 'fell', ev); return ev; }
    // --- tricks (arrow keys / right stick, in the air only) ---
    const dir = trickDir(b);
    if (s.tst === 0 && dir && !grounded && s.air > 6 && dir !== s.tdirPrev) { s.tid = dir; s.tst = 1; s.tph = 0; s.tholdT = 0; ev.push({ t: 'trick', id: TRICKS[dir].id }); }
    else if (s.tst === 1) { s.tph += DT / 0.17; if (s.tph >= 1) { s.tph = 1; s.tst = 2; } }
    else if (s.tst === 2) { if (dir === s.tid) s.tholdT += DT; else s.tst = 3; }
    else if (s.tst === 3) { s.tph -= DT / 0.15; if (s.tph <= 0) { s.tph = 0; s.tst = 0; const T = TRICKS[s.tid]; comboAdd(s, Math.round(T.pts + s.tholdT * PTS.hold), T.name); s.st.tricks++; s.st.trickIds |= 1 << s.tid; s.tid = 0; } }
    s.tdirPrev = dir;
    // --- spins (Q / E) ---
    const spinIn = (b & IN.SPINL) ? 1 : (b & IN.SPINR) ? -1 : 0;
    if (!grounded && s.air > 6) {
      if (spinIn && !s.sAct) { s.sAct = 1; s.sDir = spinIn; }
      if (s.sAct) {
        const before = s.sAng; s.sAng += s.sDir * B.spinRate * DT;
        const kb = Math.floor(before * s.sDir / TAU + 1e-9), ka = Math.floor(s.sAng * s.sDir / TAU + 1e-9);
        if (ka > kb) { comboAdd(s, PTS.spin, (ka * 360) + ''); s.st.spinsThisAir = (s.st.spinsThisAir || 0) + 1; if (!(spinIn === s.sDir)) { s.sAng = s.sDir * ka * TAU; s.sAct = 0; } }
      }
    }
    // --- air time, take-off and landing ---
    if (!grounded) {
      if (s.air === 0) { s.rot = 0; s.takeoffX = s.x; s.st.spinsThisAir = 0; ev.push({ t: 'takeoff' }); if (s.manT) bankManual(s, ev); }
      s.air++; s.rot += s.w * DT;
    } else {
      if (s.air > 14) land(L, s, ev, c2, sn2, impact);
      else if (s.tst !== 0 && s.air > 0) { crash(s, 'trick', ev); return ev; }
      s.air = 0;
      // manuals: riding on one wheel
      const kind = gnd === 1 ? 1 : gnd === 2 ? 2 : 0;
      if (kind && sp > 1) { if (s.manKind !== kind) { if (s.manT) bankManual(s, ev); s.manKind = kind; } s.manT++; if (s.manT > 18) s.manD += sp * DT; }
      else if (s.manT) bankManual(s, ev);
    }
    if (s.crashed) return ev;
    if (s.x >= L.finish) { if (s.manT) bankManual(s, ev); s.finished = 1; s.finishTick = s.tick; ev.push({ t: 'finish', time: s.tick * DT, score: s.score }); }
    return ev;
  }
  function land(L, s, ev, c, sn, impact) {
    const ux = -sn, uy = c, dot = ux * s.lnx + uy * s.lny;
    if (s.tst !== 0) { crash(s, 'trick', ev); return; }
    if (s.sAct) {                                         // still spinning: only fine if you're nearly round
      const rem = s.sAng - s.sDir * Math.round(s.sAng * s.sDir / TAU) * TAU;
      if (Math.abs(rem) > 0.5) { crash(s, 'spin', ev); return; }
      s.sAct = 0;
    }
    s.sAng = 0;
    if (dot < 0.42) { crash(s, 'angle', ev); return; }
    if (impact > BIKE.hardLand) { crash(s, 'hard', ev); return; }
    const airT = s.air * DT;
    s.st.maxAir = Math.max(s.st.maxAir, airT);
    const flips = Math.round(s.rot / TAU);
    if (flips > 0) { for (let i = 0; i < flips; i++) comboAdd(s, PTS.back, 'Backflip'); s.st.back = Math.max(s.st.back, flips); }
    if (flips < 0) { for (let i = 0; i < -flips; i++) comboAdd(s, PTS.front, 'Frontflip'); s.st.front = Math.max(s.st.front, -flips); }
    if (flips) s.st.flips += Math.abs(flips);
    const spins = s.st.spinsThisAir || 0;
    if (spins) { s.st.spins = Math.max(s.st.spins, spins); if (flips > 0) s.st.spinFlip = 1; }
    const z = L.zones.find(zn => s.takeoffX >= zn.x0 && s.takeoffX <= zn.x1);
    if (z) { const zs = s.st.zones[z.id] || (s.st.zones[z.id] = { back: 0, front: 0, tricks: 0, spins: 0, clean: 0 }); zs.clean = 1; zs.back = Math.max(zs.back, Math.max(0, flips)); zs.front = Math.max(zs.front, Math.max(0, -flips)); zs.spins = Math.max(zs.spins, spins); zs.tricks = Math.max(zs.tricks, s.cNames.filter(n => TRICKS.some(t => t && t.name === n)).length); }
    let perfect = 0;
    if (dot > 0.985 && airT > 0.4) { perfect = 1; s.st.perfect++; }
    if (s.cN > 0 || airT > 0.6) {
      const base = s.cPts + Math.round(airT * PTS.air) + (perfect ? PTS.perfect : 0), mult = s.cN > 0 ? 1 + 0.5 * (s.cN - 1) : 1, pts = Math.round(base * mult);
      s.score += pts; s.st.maxCombo = Math.max(s.st.maxCombo, pts);
      ev.push({ t: 'land', pts, mult, names: s.cNames.slice(), perfect, air: airT });
    } else if (perfect) ev.push({ t: 'land', pts: 0, mult: 1, names: [], perfect, air: airT });
    s.cPts = 0; s.cN = 0; s.cNames = [];
  }

  /* ---------- challenges: checked from what the run did ---------- */
  function challengeDone(ch, s) {
    const st = s.st, fin = !!s.finished, time = s.finishTick * DT;
    switch (ch.t) {
      case 'finish': return fin;
      case 'time': return fin && time <= ch.s;
      case 'score': return fin && s.score >= ch.n;
      case 'combo': return st.maxCombo >= ch.n;
      case 'back': return ch.zone ? ((st.zones[ch.zone] || {}).back || 0) >= ch.n : st.back >= ch.n;
      case 'front': return ch.zone ? ((st.zones[ch.zone] || {}).front || 0) >= ch.n : st.front >= ch.n;
      case 'spin': return ch.zone ? ((st.zones[ch.zone] || {}).spins || 0) >= ch.n : st.spins >= ch.n;
      case 'spinflip': return !!st.spinFlip;
      case 'clear': return !!((st.zones[ch.zone] || {}).clean);
      case 'trick': return !!(st.trickIds & (1 << TRICKS.findIndex(t => t && t.id === ch.id)));
      case 'tricks': return st.tricks >= ch.n;
      case 'manual': return st.manual >= ch.m;
      case 'nopedal': return fin && !st.pedal;
      case 'nobrake': return fin && !st.brake;
      case 'air': return st.maxAir >= ch.s;
      case 'speed': return st.maxV * 3.6 >= ch.kmh;
      case 'perfect': return st.perfect >= ch.n;
    }
    return false;
  }
  function challengeText(ch) {
    const z = ch.zoneName ? ' ' + ch.zoneName : '';
    switch (ch.t) {
      case 'finish': return 'Finish the trail';
      case 'time': return `Finish in under ${ch.s} seconds`;
      case 'score': return `Finish with ${ch.n.toLocaleString('en')} points`;
      case 'combo': return `Land a ${ch.n.toLocaleString('en')} point combo`;
      case 'back': return ch.n > 1 ? `Double backflip${z}` : `Backflip${z}`;
      case 'front': return `Frontflip${z}`;
      case 'spin': return `360${z}`;
      case 'spinflip': return '360 backflip';
      case 'clear': return `Clear${z}`;
      case 'trick': return `Land a ${TRICKS.find(t => t && t.id === ch.id).name}`;
      case 'tricks': return `Land ${ch.n} tricks`;
      case 'manual': return `Manual ${ch.m} metres`;
      case 'nopedal': return 'Finish without pedalling';
      case 'nobrake': return 'Finish without braking';
      case 'air': return `Get ${ch.s} seconds of air`;
      case 'speed': return `Hit ${ch.kmh} km/h`;
      case 'perfect': return ch.n > 1 ? `${ch.n} perfect landings` : 'A perfect landing';
    }
    return '';
  }

  /* ---------- the trails ---------- */
  // features: flat L | line L grade | ease L grade | roll n h len | table h grade top landGrade landLen
  //   jump kickH kickGrade gap landDeck(dh) landGrade landLen [pitDepth] | drop h landGrade landLen | rocks L size | zone id len | shore L | sign text
  // @@LEVELS-START (jump sizes are tuned by ocbtests/calibrate.js so a normal run lands on the slope)
  const LEVELS = [
    {"id":"bunny","name":"Bunny Slope","blurb":"Learn to pump, pop and land.","scene":"forest","need":0,"f":[["sign","Hold PUMP going down, let go going up"],["flat",12],["ease",6,-0.18],["line",16,-0.18],["ease",6,-0.04],["roll",4,0.8,7],["sign","Tap PUMP to hop"],["flat",8],["table",1.1,0.5,3.5,0.45,5],["flat",8],["zone","first",20],["table",1.4,0.6,3.06,0.5,6],["line",14,-0.12],["roll",3,0.9,7.5],["table",1.5,0.62,3.96,0.5,6],["line",14,-0.1],["sign","Hold A or D in the air to flip"],["ease",4,0],["table",1.6,0.65,4.32,0.5,7],["line",12,-0.12],["roll",3,0.9,7],["table",1.6,0.62,5,0.5,7],["line",18,-0.06]],"ch":[{"t":"finish"},{"t":"clear","zone":"first","zoneName":"the second table"},{"t":"manual","m":6},{"t":"nobrake"}]},
    {"id":"pump","name":"Pump It Up","blurb":"A pump track. No pedalling needed if your timing is good.","scene":"forest","need":1,"run":0,"f":[["ease",6,-0.25],["line",8,-0.25],["ease",4,0],["roll",6,0.9,6.5],["table",1.3,0.65,3,0.65,4],["roll",5,0.95,6.5],["zone","gapz",16],["jump",0.8,0.6,4,-0.1,0.6,5,0.5],["roll",6,1,6.2],["table",1.4,0.7,3,0.7,4],["roll",5,1,6.5],["table",0.9,0.6,2.5,0.6,4],["roll",6,1,6.4],["table",1.4,0.7,3.5,0.7,4.5],["roll",4,0.95,6.5],["flat",10]],"ch":[{"t":"finish"},{"t":"nopedal"},{"t":"clear","zone":"gapz","zoneName":"the pump track gap"},{"t":"tricks","n":2},{"t":"time","s":41}]},
    {"id":"loam","name":"Loam Ranger","blurb":"Flowy forest dirt with tables and little drops.","scene":"forest","need":3,"f":[["ease",6,-0.22],["line",20,-0.22],["ease",4,-0.05],["table",1.4,0.55,3.42,0.5,6],["line",12,-0.2],["ease",3,-0.05],["drop",1.2,0.45,12.8],["line",16,-0.18],["ease",4,-0.03],["zone","bigtab",25],["table",1.8,0.65,4.78,0.55,7],["line",10,-0.2],["roll",3,0.7,6],["ease",3,-0.05],["drop",1.6,0.5,15.36],["line",14,-0.16],["ease",4,-0.03],["table",1.6,0.62,4.29,0.55,6],["line",14,-0.18],["roll",4,0.7,6.5],["ease",4,-0.03],["table",1.7,0.62,4.57,0.55,7],["line",12,-0.15],["ease",3,-0.05],["drop",1.4,0.5,15.36],["line",18,-0.1]],"ch":[{"t":"finish"},{"t":"back","n":1,"zone":"bigtab","zoneName":"the big table"},{"t":"trick","id":"whip"},{"t":"score","n":3000},{"t":"time","s":33}]},
    {"id":"roots","name":"Rooty Tooty","blurb":"Roots, rocks and step-downs. Hang on.","scene":"forest","need":6,"f":[["ease",6,-0.28],["rocks",14,0.12],["line",10,-0.3],["ease",3,-0.05],["drop",1.4,0.55,12.8],["rocks",16,0.15],["line",10,-0.25],["ease",4,-0.02],["zone","step",25],["jump",1.4,0.55,7,-1.4,0.55,7],["rocks",12,0.14],["line",12,-0.22],["ease",3,-0.05],["drop",2,0.6,15.36],["rocks",18,0.13],["ease",4,-0.03],["table",1.5,0.6,3.22,0.55,9.600000000000001],["line",10,-0.2],["rocks",16,0.14],["line",8,-0.25],["ease",4,-0.02],["jump",1.4,0.55,7,-1.2,0.55,7],["rocks",12,0.12],["line",18,-0.1]],"ch":[{"t":"finish"},{"t":"clear","zone":"step","zoneName":"the step-down"},{"t":"manual","m":10},{"t":"nopedal"},{"t":"time","s":28}]},
    {"id":"shore","name":"Shore Thing","blurb":"Old-school wooden North Shore. Skinnies, ladders and drops.","scene":"shore","need":9,"f":[["ease",6,-0.2],["line",12,-0.2],["shore",40],["line",12,-0.12],["ease",3,-0.03],["drop",1.5,0.55,12.8],["line",8,-0.12],["ease",3,0],["table",1.3,0.6,3.5,0.6,5],["line",8,-0.15],["line",12,-0.18],["shore",45],["ease",4,-0.02],["zone","ladder",20],["jump",1.3,0.6,7,-1.6,0.55,7],["line",10,-0.15],["ease",3,-0.03],["drop",2.4,0.6,17.92],["line",12,-0.15],["shore",40],["ease",4,-0.02],["table",1.6,0.65,4.4,0.6,6],["line",10,-0.15],["ease",3,-0.03],["drop",2,0.6,15.36],["line",18,-0.1]],"ch":[{"t":"finish"},{"t":"clear","zone":"ladder","zoneName":"the ladder gap"},{"t":"trick","id":"nohander"},{"t":"perfect","n":2},{"t":"time","s":28}]},
    {"id":"doubles","name":"Double Trouble","blurb":"A dirt jump line. Pump between the doubles or come up short.","scene":"dirt","need":12,"run":-0.02,"f":[["ease",6,-0.25],["line",8,-0.25],["ease",6,0],["flat",6],["zone","d1",12],["jump",1.6,0.85,6.06,0,0.7,5],["jump",1.7,0.85,7,0,0.7,5],["zone","d3",12],["jump",1.8,0.9,7.5,0,0.72,5],["jump",1.8,0.9,7.5,0,0.72,5],["flat",6],["ease",4,-0.12],["line",6,-0.12],["ease",4,0],["jump",2,0.9,8.5,0,0.75,6],["jump",1.9,0.9,6.19,0,0.72,9.600000000000001],["flat",5],["ease",4,-0.12],["line",6,-0.12],["ease",4,0],["jump",2.2,0.95,8.56,0,0.75,7],["flat",10]],"ch":[{"t":"finish"},{"t":"trick","id":"superman"},{"t":"combo","n":1500},{"t":"tricks","n":5},{"t":"nopedal"}]},
    {"id":"slab","name":"Slab Happy","blurb":"Steep granite rolls and big drops.","scene":"alpine","need":16,"f":[["ease",6,-0.35],["line",16,-0.45],["ease",6,-0.08],["drop",2.2,0.6,18],["line",8,-0.4],["rocks",10,0.12],["line",10,-0.5],["ease",8,-0.05],["zone","slabjump",25],["table",2,0.7,7.54,0.65,18],["line",8,-0.3],["ease",4,-0.05],["drop",3,0.65,18],["line",12,-0.3],["ease",6,-0.05],["table",1.8,0.7,7.09,0.6,12.8],["line",10,-0.45],["rocks",10,0.12],["ease",6,-0.05],["drop",2.6,0.65,18],["line",18,-0.1]],"ch":[{"t":"finish"},{"t":"speed","kmh":50},{"t":"front","n":1},{"t":"air","s":1.5},{"t":"time","s":24}]},
    {"id":"huck","name":"Huck Finn","blurb":"Drops. Big ones. Land on the slope, not the flat.","scene":"alpine","need":20,"f":[["ease",6,-0.25],["line",12,-0.25],["ease",4,-0.03],["drop",2,0.55,18],["line",8,-0.2],["ease",4,-0.03],["drop",3,0.65,18],["line",10,-0.22],["zone","cliff",18],["ease",4,-0.03],["drop",4.5,0.75,18],["line",12,-0.2],["ease",4,-0.02],["jump",1.4,0.55,8,-2.5,0.65,9],["line",10,-0.18],["ease",4,-0.03],["drop",3.5,0.7,18],["line",10,-0.2],["ease",4,-0.03],["drop",5,0.8,18],["line",18,-0.1]],"ch":[{"t":"finish"},{"t":"back","n":1,"zone":"cliff","zoneName":"off the cliff drop"},{"t":"trick","id":"cancan"},{"t":"perfect","n":3},{"t":"time","s":27}]},
    {"id":"send","name":"Send Hill","blurb":"Slopestyle: big kickers made for flips and spins.","scene":"dirt","need":25,"f":[["ease",8,-0.25],["line",14,-0.28],["ease",6,0],["zone","k1",15],["jump",2.4,0.95,10.56,-0.6,0.65,12],["line",6,-0.2],["ease",4,0],["zone","k2",15],["jump",2.6,1,10.26,-0.8,0.7,12],["line",6,-0.2],["ease",4,-0.03],["drop",2.5,0.6,18],["line",8,-0.2],["ease",4,0],["zone","k3",15],["jump",2.8,1.05,10.97,-1,0.72,13],["line",6,-0.2],["ease",4,0],["jump",2.6,1,10.58,-0.8,0.7,12],["line",18,-0.08]],"ch":[{"t":"finish"},{"t":"spin","n":1},{"t":"back","n":2},{"t":"spinflip"},{"t":"score","n":8000}]},
    {"id":"wolf","name":"Big Bad Wolf","blurb":"The whole mountain, top to bottom. Everything you have learned.","scene":"alpine","need":30,"f":[["ease",6,-0.3],["line",16,-0.32],["rocks",12,0.14],["ease",4,-0.05],["drop",2.5,0.6,18],["line",10,-0.28],["ease",4,-0.03],["table",1.8,0.65,5.69,0.6,12.8],["line",8,-0.22],["shore",30],["line",8,-0.2],["ease",4,-0.03],["drop",3.2,0.65,18],["line",10,-0.25],["ease",6,0],["jump",1.8,0.9,9.22,0,0.72,9.600000000000001],["jump",1.9,0.9,6.31,0,0.72,9.600000000000001],["line",10,-0.3],["rocks",14,0.15],["line",8,-0.3],["ease",6,-0.02],["zone","wolfgap",20],["jump",2.6,1,11.39,-1,0.7,13],["line",8,-0.28],["ease",4,-0.03],["drop",4,0.72,18],["line",12,-0.2],["ease",4,-0.02],["table",2,0.7,5.59,0.65,9],["line",10,-0.3],["rocks",12,0.14],["ease",6,-0.02],["jump",2.8,1.05,11.14,-1.2,0.72,14],["line",20,-0.08]],"ch":[{"t":"finish"},{"t":"clear","zone":"wolfgap","zoneName":"the wolf gap"},{"t":"score","n":10000},{"t":"nobrake"},{"t":"time","s":42}]},
  ];
  const PARK = {"id":"park","name":"Othercolour Bike Park","blurb":"Ride with your friends.","scene":"park","f":[["sign","Welcome to the park"],["ease",8,-0.22],["line",12,-0.22],["ease",4,0],["sign","Pump track"],["roll",6,0.9,6.5],["table",1.3,0.65,3,0.65,4],["roll",4,0.95,6.5],["ease",6,-0.22],["line",8,-0.22],["ease",6,0],["sign","Dirt jumps"],["jump",1.6,0.85,6.5,0,0.7,5],["jump",1.7,0.85,7,0,0.7,5],["jump",1.8,0.9,6.35,0,0.72,8],["line",8,-0.2],["sign","North Shore"],["shore",36],["line",10,-0.15],["ease",3,-0.03],["drop",1.8,0.6,17.92],["line",10,-0.18],["rocks",14,0.12],["line",8,-0.25],["ease",6,0],["sign","Slopestyle"],["jump",2.4,0.95,10.36,-0.6,0.65,12],["line",6,-0.2],["ease",4,0],["jump",2.6,1,10.73,-0.8,0.7,12],["line",6,-0.2],["ease",4,-0.03],["drop",3,0.65,18],["line",10,-0.2],["ease",4,-0.02],["table",2,0.7,6,0.65,9],["line",14,-0.06],["sign","Lift back to the top"]]};
  // @@LEVELS-END
  const TRAILS = {};
  function trail(id) { if (!TRAILS[id]) { const d = id === 'park' ? PARK : LEVELS.find(l => l.id === id); if (!d) return null; TRAILS[id] = build(d); } return TRAILS[id]; }
  // medal times (seconds): gold, silver, bronze. Filled in from test runs of each trail.
  // @@MEDALS-START
  const MEDALS = {"bunny":[28,32,38],"pump":[41,46,55],"loam":[33,37,45],"roots":[28,31,38],"shore":[28,32,39],"doubles":[26,30,36],"slab":[24,28,33],"huck":[27,31,37],"send":[26,29,35],"wolf":[42,48,58],"park":[46,52,62]};
  // @@MEDALS-END

  // replays: controls are stored as [value, how many steps] pairs
  function rle(arr) { const out = []; for (const v of arr) { if (out.length && out[out.length - 2] === v && out[out.length - 1] < 1e6) out[out.length - 1]++; else out.push(v, 1); } return out; }
  function unrle(pairs, max) {
    if (!Array.isArray(pairs) || pairs.length % 2) return null;
    const out = []; for (let i = 0; i < pairs.length; i += 2) { const v = pairs[i] | 0, n = pairs[i + 1] | 0; if (n <= 0 || v < 0 || v > 4095 || out.length + n > max) return null; for (let k = 0; k < n; k++) out.push(v); }
    return out;
  }
  // play a whole run from its controls, exactly as it happened
  function replay(id, inputs, startX) {
    const L = trail(id); if (!L) return null;
    const s = newRun(L, startX);
    for (let i = 0; i < inputs.length && !s.crashed && !s.finished; i++) step(L, s, inputs[i]);
    return s;
  }

  const api = { DT, G, BIKE, HUB_R, HUB_F, HEAD, CHEST, BB, TRICKS, PTS, IN, LEVELS, PARK, MEDALS, dsin, dcos, build, trail, surfY, surfN, wheelHit,
    newRun, step, challengeDone, challengeText, rle, unrle, replay, trickDir };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OCB = api;
})(typeof window !== 'undefined' ? window : this);
