// Baseplate FPS maps. This one file is used by both the website and the game server,
// so walls block players and bullets the same way everywhere.
// Units are metres. x runs east, z runs south, y is up. Every solid is an axis-aligned box.
(function (root) {
  'use strict';

  function makeBuilder() {
    const boxes = [];
    const box = (cx, cz, w, d, h, k, y0 = 0) => {
      boxes.push({ x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2, y0, y1: y0 + h, k });
    };
    return { boxes, box };
  }

  /* ---------- Outpost: a walled supply depot with a warehouse, container yards and two sniper towers ---------- */
  function outpost() {
    const { boxes, box } = makeBuilder();
    const H = 80;                                                   // the playable area is 160 x 160 m

    // perimeter wall
    box(0, -H - 0.5, 2 * H + 2, 1, 4, 'wall');
    box(0, H + 0.5, 2 * H + 2, 1, 4, 'wall');
    box(-H - 0.5, 0, 1, 2 * H, 4, 'wall');
    box(H + 0.5, 0, 1, 2 * H, 4, 'wall');

    // central warehouse: 26 x 18 m, a 4 m doorway in the middle of every wall, roofed
    const WX = 13, WZ = 9, WH = 6, T = 0.5, DOOR = 2;
    box(-(WX + DOOR) / 2, -WZ, WX - DOOR, T, WH, 'concrete'); box((WX + DOOR) / 2, -WZ, WX - DOOR, T, WH, 'concrete');
    box(-(WX + DOOR) / 2, WZ, WX - DOOR, T, WH, 'concrete');  box((WX + DOOR) / 2, WZ, WX - DOOR, T, WH, 'concrete');
    box(-WX, -(WZ + DOOR) / 2, T, WZ - DOOR, WH, 'concrete'); box(-WX, (WZ + DOOR) / 2, T, WZ - DOOR, WH, 'concrete');
    box(WX, -(WZ + DOOR) / 2, T, WZ - DOOR, WH, 'concrete');  box(WX, (WZ + DOOR) / 2, T, WZ - DOOR, WH, 'concrete');
    box(-WX + 1.25, -WZ + 1.25, 2, 2, WH, 'concrete');                 // corner pillars inside
    box(WX - 1.25, WZ - 1.25, 2, 2, WH, 'concrete');
    box(0, 0, 2 * WX + 0.6, 2 * WZ + 0.6, 0.35, 'roof', WH);
    // inside: shelving rows and crates
    box(-5, -4.5, 7, 1.1, 2.4, 'metal'); box(5, 4.5, 7, 1.1, 2.4, 'metal');
    box(-6.5, 3.2, 1.2, 1.2, 1.2, 'crate'); box(-5.2, 3.4, 1.2, 1.2, 1.2, 'crate'); box(-6.5, 3.2, 1.2, 1.2, 1.2, 'crate', 1.2);
    box(6.4, -3.3, 1.2, 1.2, 1.2, 'crate'); box(6.4, -2.0, 0.8, 0.8, 0.8, 'crate');
    box(0, 0, 1.6, 1.6, 1.0, 'crate');

    // shipping containers (2.5 x 6.1 x 2.6)
    const CL = 6.1, CW = 2.5, CH = 2.6;
    const cont = (cx, cz, along, k, level = 0) => along === 'x' ? box(cx, cz, CL, CW, CH, k, level * CH) : box(cx, cz, CW, CL, CH, k, level * CH);
    // north yard
    cont(-22, -38, 'x', 'cont_red'); cont(-22, -35.3, 'x', 'cont_blue'); cont(-22, -38, 'x', 'cont_green', 1);
    cont(-8, -46, 'z', 'cont_tan'); cont(-5.3, -46, 'z', 'cont_red');
    cont(6, -38, 'x', 'cont_green'); cont(6, -38, 'x', 'cont_blue', 1);
    cont(20, -48, 'z', 'cont_blue'); cont(23, -48, 'z', 'cont_tan');
    cont(32, -33, 'x', 'cont_red');
    // south yard (the north yard turned around)
    cont(22, 38, 'x', 'cont_blue'); cont(22, 35.3, 'x', 'cont_tan'); cont(22, 38, 'x', 'cont_red', 1);
    cont(8, 46, 'z', 'cont_green'); cont(5.3, 46, 'z', 'cont_blue');
    cont(-6, 38, 'x', 'cont_red'); cont(-6, 38, 'x', 'cont_tan', 1);
    cont(-20, 48, 'z', 'cont_red'); cont(-23, 48, 'z', 'cont_green');
    cont(-32, 33, 'x', 'cont_blue');
    // east and west fields
    cont(46, -20, 'x', 'cont_tan'); cont(66, 46, 'z', 'cont_green'); cont(38, 62, 'x', 'cont_red');
    cont(-46, 20, 'x', 'cont_green'); cont(-66, -46, 'z', 'cont_red'); cont(-38, -62, 'x', 'cont_blue');

    // sheds
    box(48, 12, 7, 5, 3.2, 'shed'); box(60, -8, 5, 7, 3.2, 'shed');
    box(-48, -12, 7, 5, 3.2, 'shed'); box(-60, 8, 5, 7, 3.2, 'shed');
    box(48, 12, 7.6, 5.6, 0.25, 'roof', 3.2); box(60, -8, 5.6, 7.6, 0.25, 'roof', 3.2);
    box(-48, -12, 7.6, 5.6, 0.25, 'roof', 3.2); box(-60, 8, 5.6, 7.6, 0.25, 'roof', 3.2);

    // crate clusters: a big crate, a small one beside it, and sometimes one stacked
    const crates = (cx, cz, stack) => {
      box(cx, cz, 1.2, 1.2, 1.2, 'crate');
      box(cx + 1.15, cz + 0.25, 0.8, 0.8, 0.8, 'crate');
      box(cx - 0.1, cz + 1.25, 1.2, 1.2, 1.2, 'crate');
      if (stack) box(cx, cz, 1.2, 1.2, 1.2, 'crate', 1.2);
    };
    crates(-30, -10, true); crates(30, 10, true); crates(-14, 24, false); crates(14, -24, false);
    crates(-40, 52, true); crates(40, -52, true); crates(-62, 30, false); crates(62, -30, false);
    crates(10, 62, false); crates(-10, -62, false); crates(25, -3, false); crates(-25, 3, false);
    crates(-52, -32, false); crates(52, 32, false);

    // concrete barriers along the roads into the warehouse
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      box(sx * 5.5, sz * 17, 3, 0.6, 1.1, 'barrier'); box(sx * 9, sz * 17, 3, 0.6, 1.1, 'barrier');
      box(sx * 20, sz * 5.5, 0.6, 3, 1.1, 'barrier'); box(sx * 20, sz * 9, 0.6, 3, 1.1, 'barrier');
    }

    // sandbag positions (U-shaped, waist high)
    const bags = (cx, cz, facing) => {
      if (facing === 'n' || facing === 's') {
        const f = facing === 'n' ? -1 : 1;
        box(cx, cz + f * 1.2, 4.4, 0.8, 1.1, 'sandbag'); box(cx - 2.2, cz, 0.8, 2.4, 1.1, 'sandbag'); box(cx + 2.2, cz, 0.8, 2.4, 1.1, 'sandbag');
      } else {
        const f = facing === 'w' ? -1 : 1;
        box(cx + f * 1.2, cz, 0.8, 4.4, 1.1, 'sandbag'); box(cx, cz - 2.2, 2.4, 0.8, 1.1, 'sandbag'); box(cx, cz + 2.2, 2.4, 0.8, 1.1, 'sandbag');
      }
    };
    bags(-60, -22, 'e'); bags(60, 22, 'w'); bags(-22, 62, 'n'); bags(22, -62, 's');
    bags(-38, 0, 'e'); bags(38, 0, 'w');

    // two sniper towers: a 5 x 5 m deck 3.2 m up, posts underneath, railings, and stairs
    const tower = (tx, tz, dir) => {
      const P = 2.5, TOP = 3.2, RISE = 0.29, RUN = 0.45, STEPS = 11, SW = 1.4;
      box(tx, tz, 2 * P, 2 * P, 0.2, 'wood', TOP - 0.2);
      for (const px of [-1, 1]) for (const pz of [-1, 1]) box(tx + px * (P - 0.2), tz + pz * (P - 0.2), 0.3, 0.3, TOP - 0.2, 'wood');
      const r = (cx, cz, w, d) => box(cx, cz, w, d, 1.0, 'wood', TOP);
      const stairX = tx - 1.1;                                      // the stairs meet the deck near one corner
      r(tx, tz - dir * P, 2 * P, 0.15);                             // back railing
      r(tx - P, tz, 0.15, 2 * P); r(tx + P, tz, 0.15, 2 * P);       // side railings
      const gap0 = stairX - SW / 2, gap1 = stairX + SW / 2;         // front railing, with a gap at the top of the stairs
      r((tx - P + gap0) / 2, tz + dir * P, gap0 - (tx - P), 0.15);
      r((gap1 + tx + P) / 2, tz + dir * P, tx + P - gap1, 0.15);
      for (let k = 1; k <= STEPS; k++) {
        const zc = tz + dir * (P + (STEPS - k + 0.5) * RUN);
        box(stairX, zc, SW, RUN, k * RISE, 'wood');
      }
    };
    tower(-58, -58, 1);    // stairs come down toward the south
    tower(58, 58, -1);     // stairs come down toward the north

    // spawn points for free for all and last man standing: open ground around the depot
    const spawns = [
      [-70, -30], [-70, 30], [70, -30], [70, 30], [-30, -70], [30, -70], [-30, 70], [30, 70],
      [-45, -2], [45, 2], [-2, 56], [2, -56], [-36, 36], [36, -36], [-48, -42], [48, 42],
      [0, -27], [0, 27], [-36, -24], [36, 24], [-70, 0], [70, 0], [-14, -70], [14, 70],
    ];
    // team deathmatch: Blue starts on the west edge, Red on the east edge
    const teamSpawns = [
      [[-72, -36], [-72, -24], [-72, -12], [-72, 0], [-72, 12], [-72, 24], [-72, 36], [-66, -6], [-66, 6], [-66, 18]],
      [[72, -36], [72, -24], [72, -12], [72, 0], [72, 12], [72, 24], [72, 36], [66, -6], [66, 6], [66, -18]],
    ];
    const roads = [
      [-H, -2.6, -WX - 4, 2.6], [WX + 4, -2.6, H, 2.6], [-2.6, -H, 2.6, -WZ - 4], [-2.6, WZ + 4, 2.6, H],
    ];
    const pads = [[-WX - 4, -WZ - 4, WX + 4, WZ + 4]];
    return {
      id: 'outpost', name: 'Outpost', blurb: 'Walled supply depot with a warehouse, container yards and two sniper towers.',
      half: H, boxes, spawns, teamSpawns, roads, pads,
      zone: { r0: 120, r1: 8, centre: 35 },
      showcase: { x: 34, z: 16 },
      overview: { x: -70, y: 16, z: 72, lx: 0, ly: 2, lz: 0 },
    };
  }

  const MAPS = { outpost: outpost() };
  const MAP_LIST = Object.keys(MAPS);

  /* ---------- geometry helpers shared by the page and the server ---------- */
  // distance along a ray to the first box it enters, or Infinity
  function rayBox(ox, oy, oz, dx, dy, dz, b, maxT) {
    let t0 = 0, t1 = maxT;
    const axes = [[ox, dx, b.x0, b.x1], [oy, dy, b.y0, b.y1], [oz, dz, b.z0, b.z1]];
    for (const [o, d, lo, hi] of axes) {
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return Infinity; continue; }
      let a = (lo - o) / d, c = (hi - o) / d;
      if (a > c) { const s = a; a = c; c = s; }
      if (a > t0) t0 = a;
      if (c < t1) t1 = c;
      if (t0 > t1) return Infinity;
    }
    return t0;
  }
  function rayMap(map, ox, oy, oz, dx, dy, dz, maxT) {
    let best = maxT;
    for (const b of map.boxes) { const t = rayBox(ox, oy, oz, dx, dy, dz, b, best); if (t < best) best = t; }
    if (dy < -1e-6) { const tg = -oy / dy; if (tg >= 0 && tg < best) best = tg; }
    return best;
  }
  // is the straight line between two points blocked by a wall?
  function blocked(map, ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return false;
    const t = rayMap(map, ax, ay, az, dx / len, dy / len, dz / len, len);
    return t < len - 0.05;
  }

  /* ---------- walking: a 0.64 m wide, 1.8 m tall body that slides along walls and climbs low steps ---------- */
  const R = 0.32, HGT = 1.8, STEP = 0.5;
  function overlapsXZ(b, x, z) { return x + R > b.x0 && x - R < b.x1 && z + R > b.z0 && z - R < b.z1; }
  function groundUnder(map, x, z, feet) {
    let g = 0;
    for (const b of map.boxes) if (b.y1 <= feet + STEP && b.y1 > g && overlapsXZ(b, x, z)) g = b.y1;
    return g;
  }
  function pushAxis(map, pos, axis, moved) {
    for (const b of map.boxes) {
      if (!overlapsXZ(b, pos.x, pos.z)) continue;
      if (b.y1 <= pos.y + STEP || b.y0 >= pos.y + HGT) continue;   // a step you can climb, or above your head
      if (axis === 'x') {
        if (moved > 0) pos.x = b.x0 - R - 1e-4;
        else if (moved < 0) pos.x = b.x1 + R + 1e-4;
        else pos.x = (pos.x - b.x0 < b.x1 - pos.x) ? b.x0 - R - 1e-4 : b.x1 + R + 1e-4;
      } else {
        if (moved > 0) pos.z = b.z0 - R - 1e-4;
        else if (moved < 0) pos.z = b.z1 + R + 1e-4;
        else pos.z = (pos.z - b.z0 < b.z1 - pos.z) ? b.z0 - R - 1e-4 : b.z1 + R + 1e-4;
      }
    }
  }
  // moves pos by vel * dt; returns { onGround, landed (fall speed if just landed) }
  function move(map, pos, vel, dt, wasOnGround) {
    const lim = map.half - R - 0.05;
    const dx = vel.x * dt, dz = vel.z * dt;
    pos.x = Math.max(-lim, Math.min(lim, pos.x + dx)); pushAxis(map, pos, 'x', dx);
    pos.z = Math.max(-lim, Math.min(lim, pos.z + dz)); pushAxis(map, pos, 'z', dz);
    const oldY = pos.y;
    pos.y += vel.y * dt;
    // head bump
    if (vel.y > 0) {
      for (const b of map.boxes) {
        if (overlapsXZ(b, pos.x, pos.z) && b.y0 >= oldY + HGT - 0.02 && pos.y + HGT > b.y0) { pos.y = b.y0 - HGT; vel.y = 0; }
      }
    }
    const g = groundUnder(map, pos.x, pos.z, Math.max(pos.y, oldY));
    let onGround = false, landed = 0;
    if (pos.y <= g) {
      if (!wasOnGround) landed = -vel.y;
      pos.y = g; vel.y = 0; onGround = true;
    } else if (wasOnGround && vel.y <= 0 && pos.y - g <= STEP) {
      pos.y = g; vel.y = 0; onGround = true;                         // walk down steps instead of hopping
    }
    return { onGround, landed };
  }
  function clearAt(map, x, z, r) {
    for (const b of map.boxes) if (b.y0 < HGT && x + r > b.x0 && x - r < b.x1 && z + r > b.z0 && z - r < b.z1) return false;
    return Math.abs(x) < map.half - r && Math.abs(z) < map.half - r;
  }

  const api = { MAPS, MAP_LIST, rayBox, rayMap, blocked, move, clearAt, groundUnder, BODY: { R, HGT, STEP } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BPMaps = api;
})(typeof window !== 'undefined' ? window : this);
