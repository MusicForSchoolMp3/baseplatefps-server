/* Highway Bike shared simulation: the road layout (lanes, ramps) and the traffic drivers. Plain JavaScript, no graphics.
   The website uses it for solo rides, and the game server runs the very same traffic for the public highways, so
   everyone riding together sees the same cars. Keep the website's copy and the server's copy identical. */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.HBSim = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = 1;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v, rnd = (a, b) => a + Math.random() * (b - a);
  const damp = (a, b, k, dt) => b + (a - b) * Math.exp(-k * dt);

  /* ---------- the road: four lanes our way (drive on the left), the shoulder, the median ---------- */
  const LANE_W = 3.6, NL = 4, CH = 120;
  const laneD = i => -5.4 + LANE_W * i;                       // lane 0 = far left (slow) ... 3 = right (fast)
  const D_MIN = -10.25, D_MAX = 8.45;                         // where you can ride (left shoulder to the median barrier)
  function srng(seed) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  // ramps: a lane closed with cones and a kicker you can launch off. Fixed by the chunk number, so they're the same for everyone
  const ramps = new Map();
  function rampOf(ci) {
    if (ramps.has(ci)) return ramps.get(ci);
    const r = srng(ci * 7919 + 13);
    let ramp = null;
    if (ci > 2 && r() < 0.32) { const lane = Math.floor(r() * NL); ramp = { s: ci * CH + 30 + r() * 60, len: 7.5, h: 1.6, lane, d: laneD(lane), w: 3.0, cones: 38 }; }
    ramps.set(ci, ramp);
    if (ramps.size > 1200) for (const k of ramps.keys()) { ramps.delete(k); if (ramps.size < 900) break; }
    return ramp;
  }
  function rampsNear(s0, s1) { const out = []; for (let c = Math.floor(s0 / CH) - 1; c <= Math.floor(s1 / CH) + 1; c++) { const r = rampOf(c); if (r && r.s + r.len > s0 && r.s - r.cones < s1) out.push(r); } return out; }
  function groundH(s, d) {
    const r = rampOf(Math.floor(s / CH));
    if (r && s >= r.s && s <= r.s + r.len && Math.abs(d - r.d) < r.w / 2) return r.h * (s - r.s) / r.len;
    return 0;
  }

  /* ---------- vehicles ---------- */
  const CAR_COLS = ['#f2f2ef', '#c9ccd0', '#1b1d21', '#7a7f86', '#9a1b1b', '#1f3f7a', '#2e5e3a', '#c7a46a', '#3a4a5a', '#e4e2dc', '#5a1f2e', '#d9d4c7'];
  const TYPES = {
    sedan: { L: 4.7, W: 1.82, H: 1.45, v: [26, 33], a: 2.2, w: 6, horn: [440, 554], body: 'car' },
    hatch: { L: 4.15, W: 1.76, H: 1.48, v: [25, 31], a: 2.0, w: 6, horn: [470, 590], body: 'hatch' },
    suv: { L: 4.85, W: 1.92, H: 1.78, v: [25, 32], a: 1.9, w: 5, horn: [400, 500], body: 'suv' },
    ute: { L: 5.3, W: 1.88, H: 1.8, v: [25, 31], a: 1.9, w: 4, horn: [380, 480], body: 'ute' },
    van: { L: 5.2, W: 1.95, H: 2.2, v: [24, 29], a: 1.5, w: 3, horn: [360, 450], body: 'van' },
    sports: { L: 4.5, W: 1.95, H: 1.2, v: [31, 38], a: 3.4, w: 2, horn: [520, 660], body: 'sports' },
    taxi: { L: 4.7, W: 1.82, H: 1.45, v: [26, 32], a: 2.2, w: 2, horn: [440, 554], body: 'car', color: '#f2c315' },
    truck: { L: 7.6, W: 2.4, H: 3.3, v: [22, 27], a: 1.0, w: 3, horn: [196, 247], body: 'truck', air: true },
    semi: { L: 17, W: 2.5, H: 4.1, v: [22, 27], a: 0.75, w: 3, horn: [147, 185], body: 'semi', air: true },
    bus: { L: 12.2, W: 2.5, H: 3.3, v: [22, 27], a: 0.9, w: 1, horn: [262, 330], body: 'bus', air: true },
  };
  const TYPE_LIST = Object.keys(TYPES);
  const laneSpeed = lane => [25.5, 28, 30.5, 32.5][lane];       // the flow in each lane (110 limit, keep left unless overtaking)
  function pickType(lane) {
    let tot = 0; const ws = TYPE_LIST.map(k => { let w = TYPES[k].w; if (TYPES[k].air && lane >= 2) w *= 0.15; if (k === 'sports' && lane < 2) w *= 0.3; tot += w; return w; });
    let r = Math.random() * tot; for (let i = 0; i < ws.length; i++) { r -= ws[i]; if (r <= 0) return TYPE_LIST[i]; } return 'sedan';
  }

  /* ---------- the drivers ----------
     They follow the car in front (the intelligent driver model), change lanes to overtake and keep left, honk when a
     rider cuts in or sits in their way, stand on the brakes if one swerves in front, swerve round if they can, and
     crash for real: dents, smashed glass, spinning out, smoke and fire, and pile-ups when someone can't stop in time.
     hooks: spawn(car), remove(car), ev(kind, car, data) for honk / screech / dent / crash / wall. */
  function createTraffic(hooks) {
    hooks = hooks || {};
    const cars = [], byId = new Map(), obstacles = [], winAcc = new Map();
    let nextId = 1;
    const ev = (k, c, a) => { if (hooks.ev) hooks.ev(k, c, a); };
    function spawn(s, lane, v, type, color) {
      type = TYPES[type] ? type : pickType(lane); const T = TYPES[type];
      const v0 = Math.max(T.v[0], Math.min(T.v[1], laneSpeed(lane) + rnd(-2.5, 2.5)));
      const ci = color != null ? color : T.color ? -1 : Math.floor(Math.random() * CAR_COLS.length);
      const c = { id: nextId++, type, T, s, d: laneD(lane), lane, tl: lane, v: v == null ? v0 : v, v0, acc: 0, brake: 0, honkT: 0, blockT: 0, lcT: rnd(2, 8), sig: 0, stop: 0, hazard: 0, psi: 0,
        screechT: 0, emerg: false, ci, color: ci < 0 ? T.color : CAR_COLS[ci], wrecked: null, dmg: 0, vd: 0, spin: 0, roll: 0, fire: false, dents: [] };
      cars.push(c); byId.set(c.id, c); if (hooks.spawn) hooks.spawn(c);
      return c;
    }
    function removeAt(i) { const c = cars[i]; cars.splice(i, 1); byId.delete(c.id); if (hooks.remove) hooks.remove(c); }
    function clear() { while (cars.length) removeAt(cars.length - 1); }
    // keep the road full of cars around each rider. wins: [{ key, s, v }]
    function manage(wins, dt, dens) {
      dens = dens || 1;
      const ahead = 480, behind = 160;
      for (let i = cars.length - 1; i >= 0; i--) { const c = cars[i]; if (!wins.some(w => c.s > w.s - behind - 40 && c.s < w.s + ahead + 120)) removeAt(i); }
      const want = Math.round(34 * dens);
      for (const w of wins) {
        const acc = (winAcc.get(w.key) || 0) + dt; winAcc.set(w.key, acc);
        if (acc < 0.12) continue;
        let n = 0; for (const c of cars) if (c.s > w.s - behind && c.s < w.s + ahead) n++;
        if (n >= want) continue;
        winAcc.set(w.key, 0);
        const lane = Math.floor(Math.random() * NL), flow = laneSpeed(lane);
        const fromBehind = flow > w.v + 2 && Math.random() < 0.45;          // new cars appear far ahead, or come up from behind in lanes faster than you
        const s = fromBehind ? w.s - behind + rnd(0, 20) : w.s + ahead + rnd(0, 100);
        if (wins.some(o => o !== w && Math.abs(o.s - s) < 60)) continue;      // not right next to another rider
        if (cars.every(c => Math.abs(c.s - s) > 22 + c.T.L || Math.abs(c.d - laneD(lane)) > 2.5)) spawn(s, lane, flow);
      }
      if (winAcc.size > 200) for (const k of winAcc.keys()) { if (!wins.some(w => w.key === k)) winAcc.delete(k); }
    }
    // riders (and crashed riders, and the closed lanes) seen by the drivers. obs: [{ s, d, v, L, W, player }]
    // ranges: the stretches of road with riders on them, [[s0, s1], ...] (for the closed lanes)
    function step(dt, obs, ranges) {
      obstacles.length = 0;
      for (const o of obs) obstacles.push(o);
      for (const [s0, s1] of ranges) for (const r of rampsNear(s0, s1)) obstacles.push({ s: r.s - r.cones / 2, d: r.d, v: 0, L: r.cones + r.len, W: 3.2, fixed: true });
      for (const c of cars) {
        const T = c.T;
        if (c.wrecked) { stepWrecked(c, dt); continue; }
        let lead = null, gap = 1e9;
        const myW = T.W / 2;
        const near = (o, oW) => Math.abs(o.d - c.d) < myW + oW / 2 + 0.25 || (c.tl !== c.lane && Math.abs(o.d - laneD(c.tl)) < myW + oW / 2);
        for (const o of cars) { if (o === c || Math.abs(o.s - c.s) > 200) continue; const gp = (o.s - o.T.L / 2) - (c.s + T.L / 2); if (gp > -0.5 && gp < gap && near(o, o.T.W)) { gap = gp; lead = o; } }
        for (const o of obstacles) { const gp = (o.s - o.L / 2) - (c.s + T.L / 2); if (gp > -1.5 && gp < gap && near(o, o.W)) { gap = gp; lead = o; } }
        // intelligent driver model
        const a = T.a, b = 3, sMin = 2.5, Th = 1.25 + (T.air ? 0.4 : 0);
        let acc;
        if (c.stop > 0) { c.stop -= dt; acc = -8; c.hazard = 1; if (c.stop <= 0) c.hazard = 0; }
        else {
          const vl = lead ? lead.v : c.v0, sStar = sMin + Math.max(0, c.v * Th + c.v * (c.v - vl) / (2 * Math.sqrt(a * b)));
          acc = a * (1 - Math.pow(c.v / c.v0, 4) - (lead ? Math.pow(sStar / Math.max(gap, 0.2), 2) : 0));
        }
        acc = clamp(acc, -9.5, a);
        c.brake = acc < -1.5 ? clamp(-acc / 6, 0.3, 1) : 0;
        // a rider: honk if they cut in on us or sit in our way, screech if we have to stand on it, and get out of the way if there's room
        if (lead && lead.player) {
          if (acc < -2.5 && c.honkT <= 0) { ev('honk', c, acc < -5 ? 1.2 : 0.6); c.honkT = 2.8; }
          if (lead.v < c.v0 - 6 && gap < 25) { c.blockT += dt; if (c.blockT > 2.2 && c.honkT <= 0) { ev('honk', c, 0.9); c.honkT = 3.5; } } else c.blockT = Math.max(0, c.blockT - dt);
          if (acc < -6 && c.screechT <= 0) { ev('screech', c); c.screechT = 2; }
          if (gap < 30 && lead.v < c.v - 4 && c.tl === c.lane) tryLane(c, true);
        } else c.blockT = Math.max(0, c.blockT - dt);
        if (c.honkT > 0) c.honkT -= dt; if (c.screechT > 0) c.screechT -= dt;
        // ordinary lane changes: overtake slower traffic on the right, drift back left when it's clear
        c.lcT -= dt;
        if (c.lcT <= 0 && c.tl === c.lane && c.stop <= 0) {
          c.lcT = rnd(3, 9);
          if (lead && !lead.fixed && lead.v < c.v0 - 3 && gap < 70) tryLane(c, false, 1);
          else if (lead && lead.fixed && gap < 140) tryLane(c, true);
          else if (Math.random() < 0.4) tryLane(c, false, -1);
        }
        if (lead && (lead.fixed || lead.wrecked) && gap < 100 && c.tl === c.lane) tryLane(c, true);
        // move
        c.v = Math.max(0, c.v + acc * dt); c.acc = acc;
        if (lead && lead.T && gap < 0.05) { if (c.v - lead.v > 3.5) carCar(c, lead, c.v - lead.v); else c.v = Math.min(c.v, lead.v); }   // too fast and they hit
        else if (lead && gap < 0.2 && !lead.player) c.v = Math.min(c.v, lead.v);
        c.s += c.v * dt;
        const td = laneD(c.tl), lat = (c.emerg ? 3.2 : 1.3) * dt;
        const dd = clamp(td - c.d, -lat, lat); c.d += dd; c.psi = damp(c.psi, c.v > 1 ? Math.atan2(dd / dt, c.v) : 0, 6, dt);
        if (Math.abs(td - c.d) < 0.05) { c.lane = c.tl; c.sig = 0; c.emerg = false; }
      }
    }
    // try to move a lane: dir +1 = right (overtaking), -1 = left, 0 = whichever is free. Checks the gap in the new lane
    function tryLane(c, emergency, dir) {
      const opts = dir ? [dir] : (Math.random() < 0.5 ? [1, -1] : [-1, 1]);
      for (const dl of opts) {
        const nl = c.lane + dl; if (nl < 0 || nl >= NL) continue;
        const nd = laneD(nl);
        let ok = true;
        for (const o of cars) { if (o === c || Math.abs(o.d - nd) > 2.4) continue; const ahead = o.s - c.s; if (ahead > -(o.v * (emergency ? 0.6 : 1.2) + 6 + o.T.L) && ahead < c.v * (emergency ? 0.5 : 1) + 8 + c.T.L) { ok = false; break; } }
        for (const o of obstacles) { if (Math.abs(o.d - nd) > 2.2) continue; const ahead = o.s - c.s; if (ahead > -12 && ahead < c.v * 1.2 + 15 + o.L / 2) { ok = false; break; } }
        if (ok) { c.tl = nl; c.sig = dl; c.emerg = emergency; if (emergency) ev('honk', c, 0.5); return true; }
      }
      return false;
    }

    /* ---------- crashes ---------- */
    // a dent: a point in the car's own space (x right, y up, +z towards the back) and the way it's pushed in
    function dent(c, lx, ly, lz, nx, nz, sev) {
      const d = [+lx.toFixed(2), +ly.toFixed(2), +lz.toFixed(2), nx, nz, +Math.min(60, sev).toFixed(1)];
      c.dmg = Math.min(1, c.dmg + sev / 28);
      if (c.dents.length < 10) c.dents.push(d);
      ev('dent', c, d);
    }
    function wreck(c, sev, spin, vd) {
      const heavy = c.T.air ? 0.3 : 1;
      if (!c.wrecked) c.wrecked = { t: 0 };
      c.wrecked.t = 0; c.spin += spin * heavy; c.vd += vd * heavy; c.stop = 99; c.hazard = 1; c.brake = 1; c.sig = 0;
      if (sev > 26 && !c.T.air) c.fire = true;
    }
    // a rider hit a car (or it hit them). kind: 'rear' (into its back), 'hitfront' (it ran into you), 'side'
    function hit(c, kind, sev, pd, ps) {
      sev = clamp(+sev || 0, 0, 80);
      const l = c.T.L / 2, w = c.T.W / 2, side = pd > c.d ? 1 : -1;
      let at;
      if (kind === 'rear') { const x = clamp(pd - c.d, -w, w); dent(c, x, 0.75, l, 0, -1, sev); wreck(c, sev, rnd(-1, 1) * sev * 0.035, rnd(-1, 1) * sev * 0.05); c.v += sev * 0.12 * (c.T.air ? 0.2 : 1); at = [x, 0.8, l]; }
      else if (kind === 'hitfront') { const x = clamp(pd - c.d, -w, w); dent(c, x, 0.7, -l, 0, 1, sev); wreck(c, sev, rnd(-1, 1) * sev * 0.03, 0); at = [x, 0.8, -l]; }
      else { const z = clamp(c.s - ps, -l, l); dent(c, side * w, 0.8, z, -side, 0, sev); wreck(c, sev, -side * sev * 0.045, -side * sev * 0.12); c.roll = -side * Math.min(0.08, sev * 0.003); at = [side * w, 0.8, z]; }
      ev('crash', c, [at[0], at[1], at[2], sev]); ev('honk', c, 1.6);
    }
    // a rider brushed past it: a scrape on the side, a honk, and it swerves away
    function brush(c, sev, side, ps) {
      sev = clamp(+sev || 0, 0, 8); side = side > 0 ? 1 : -1;
      if (sev > 0.5) dent(c, side * c.T.W / 2, 0.7, clamp(c.s - ps, -c.T.L / 2, c.T.L / 2), -side, 0, sev * 0.6);
      if (c.honkT <= 0) { ev('honk', c, 1); c.honkT = 2.5; }
      if (!c.wrecked) { c.emerg = true; tryLane(c, true); }
    }
    // two cars: a (behind) runs into b (in front)
    function carCar(a, b, rel) {
      const sev = rel * 1.6, la = a.T.L / 2, lb = b.T.L / 2, off = clamp(b.d - a.d, -a.T.W / 2, a.T.W / 2);
      dent(a, off, 0.65, -la, 0, 1, sev); dent(b, -off, 0.75, lb, 0, -1, sev * (a.T.air ? 1.6 : 1));
      const vb = b.v + rel * (a.T.air && !b.T.air ? 0.85 : 0.45); a.v = Math.max(0, b.v + rel * 0.15); b.v = vb;
      wreck(a, sev, rnd(-1, 1) * sev * 0.03, rnd(-1, 1) * sev * 0.06); wreck(b, sev, rnd(-1, 1) * sev * 0.04, rnd(-1, 1) * sev * 0.06);
      a.s = Math.min(a.s, b.s - lb - la - 0.05);
      ev('crash', a, [off, 0.8, -la - 0.1, sev, 1]);
    }
    function stepWrecked(c, dt) {
      const W = c.wrecked; W.t += dt;
      c.v = Math.max(0, c.v - (W.t > 0.3 ? 7.5 : 2.5) * dt);                 // the driver stands on the brakes after a moment
      c.s += c.v * dt; c.d += c.vd * dt;
      c.vd *= Math.exp(-2.2 * dt); c.psi += c.spin * dt; c.spin *= Math.exp(-(c.v > 2 ? 1.4 : 4) * dt); c.roll *= Math.exp(-3 * dt);
      if (c.d < D_MIN + 0.4 || c.d > D_MAX - 0.4) {                            // the barriers
        const sd = c.d > 0 ? 1 : -1; c.d = clamp(c.d, D_MIN + 0.4, D_MAX - 0.4);
        if (Math.abs(c.vd) > 2) { const sev = Math.abs(c.vd) * 1.5; dent(c, sd * c.T.W / 2, 0.6, rnd(-1, 1), -sd, 0, sev); ev('wall', c, [sd * c.T.W / 2, 0.5, 0, sev]); }
        c.vd *= -0.25; c.spin *= 0.6;
      }
    }
    return { cars, byId, spawn, manage, step, hit, brush, clear, tryLane };
  }
  return { VERSION, clamp, LANE_W, NL, CH, laneD, D_MIN, D_MAX, srng, rampOf, rampsNear, groundH, CAR_COLS, TYPES, TYPE_LIST, laneSpeed, createTraffic };
});
