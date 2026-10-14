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


  /* ---------- Manor: a grand old house at golden hour, with hedge mazes, a fountain courtyard and a pond ---------- */
  // a straight wall from a0 to a1 along one axis, with openings (doors and windows) cut out of it
  function wallWith(box, axis, fixed, a0, a1, T, H, k, holes) {
    const cuts = [a0, a1];
    for (const h of holes) cuts.push(h[0] - h[1] / 2, h[0] + h[1] / 2);
    const xs = [...new Set(cuts.map(v => Math.round(v * 1000) / 1000))].filter(v => v >= a0 && v <= a1).sort((p, q) => p - q);
    let run = null;
    const flush = () => {
      if (!run) return;
      for (const [y0, y1] of run.ys) {
        const c = (run.s + run.e) / 2, len = run.e - run.s;
        if (axis === 'x') box(c, fixed, len, T, y1 - y0, k, y0); else box(fixed, c, T, len, y1 - y0, k, y0);
      }
      run = null;
    };
    for (let i = 0; i < xs.length - 1; i++) {
      const s = xs[i], e = xs[i + 1], mid = (s + e) / 2;
      let ys = [[0, H]];
      for (const h of holes) if (mid > h[0] - h[1] / 2 && mid < h[0] + h[1] / 2) {
        const out = [];
        for (const [y0, y1] of ys) { if (h[2] > y0) out.push([y0, Math.min(y1, h[2])]); if (h[3] < y1) out.push([Math.max(y0, h[3]), y1]); }
        ys = out.filter(r => r[1] - r[0] > 0.01);
      }
      const key = JSON.stringify(ys);
      if (run && run.key === key) run.e = e; else { flush(); run = { s, e, ys, key }; }
    }
    flush();
  }
  function manor() {
    const { boxes, box } = makeBuilder();
    const H = 70;
    let seed = 20240611;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

    // perimeter: a stone garden wall with pillars, and an iron gate at the south
    box(0, -H - 0.5, 2 * H + 2, 1, 3.2, 'stone'); box(0, H + 0.5, 2 * H + 2, 1, 3.2, 'stone');
    box(-H - 0.5, 0, 1, 2 * H, 3.2, 'stone'); box(H + 0.5, 0, 1, 2 * H, 3.2, 'stone');
    for (let v = -H; v <= H; v += 14) for (const [x, z] of [[v, -H - 0.5], [v, H + 0.5], [-H - 0.5, v], [H + 0.5, v]]) box(x, z, 1.5, 1.5, 3.8, 'stone');

    /* the house: 36 x 24 m, two floors. Ground floor 0-3.6 m, upper floor at 4 m, roof at 7.4 m */
    const X = 18, ZF = 6, ZB = -18, T = 0.4, TOP = 7.4, F2 = 4, SLAB = 3.6;
    const door = (c, w = 1.8) => [c, w, 0, 2.7], win = (c, w = 1.6) => [c, w, 1.0, 2.6];
    const updoor = (c, w = 1.6) => [c, w, F2, F2 + 2.5], upwin = (c, w = 1.6) => [c, w, F2 + 1.0, F2 + 2.6];
    wallWith(box, 'x', ZF, -X, X, T, TOP, 'brick', [door(0, 3.2), win(-15), win(-9), win(9), win(15), upwin(-15), updoor(-11), upwin(-3), upwin(3), updoor(11), upwin(15)]);
    wallWith(box, 'x', ZB, -X, X, T, TOP, 'brick', [door(0, 3.2), win(-14), win(-9), win(9), win(14), upwin(-14), upwin(-9), upwin(-3), upwin(3), upwin(9), upwin(14)]);
    for (const s of [-1, 1]) wallWith(box, 'z', s * X, ZB, ZF, T, TOP, 'brick', [door(-2.5, 2.4), win(2.5), win(-13), upwin(2.5), upwin(-2.5), upwin(-13)]);
    // the grand hall in the middle: double height at the front, a gallery over the back half
    for (const s of [-1, 1]) wallWith(box, 'z', s * 6, ZB, ZF, T, TOP, 'plaster', [door(0, 1.8), door(-12, 1.8), [0, 2.4, F2 + 1.0, F2 + 2.4], updoor(-12)]);
    // the wings: a cross wall on each floor splits front and back rooms
    for (const s of [-1, 1]) wallWith(box, 'x', -6, s > 0 ? 6 : -X, s > 0 ? X : -6, T, TOP, 'plaster', [door(s * 12, 1.8), updoor(s * 12, 1.8)]);
    // upper floors: both wings, and the gallery over the back of the hall
    box(-12, -6, 12, 24, 0.4, 'floor', SLAB); box(12, -6, 12, 24, 0.4, 'floor', SLAB);
    box(0, -12, 12, 12, 0.4, 'floor', SLAB);
    box(0, -6.1, 8.2, 0.15, 1.0, 'railing', F2);                                  // gallery railing between the stairs
    box(0, -6, 2 * X + 0.6, 2 * (ZF - ZB) / 2 + 0.6, 0.4, 'slate', TOP);          // roof
    box(0, -6, 2 * X + 1.4, 2 * (ZF - ZB) / 2 + 1.4, 0.25, 'slate', TOP + 0.4);
    box(0, -6, 2 * X - 4, 2 * (ZF - ZB) / 2 - 4, 0.6, 'slate', TOP + 0.65);
    for (const s of [-1, 1]) for (const z of [-14, 2]) box(s * 13, z, 1.2, 1.2, 2.2, 'brick', TOP + 1.25);   // chimneys
    // twin staircases up the sides of the hall, climbing from the front to the gallery
    for (const s of [-1, 1]) for (let k = 1; k <= 16; k++) box(s * 5, 0.4 - (k - 0.5) * 0.4, 1.6, 0.4, k * 0.25, 'floor');
    box(-3, -1, 0.9, 0.9, SLAB, 'marble'); box(3, -1, 0.9, 0.9, SLAB, 'marble');   // pillars under the gallery edge
    box(0, -12, 3, 1.4, 0.8, 'furniture');                                           // a long table under the gallery
    // ground floor, west: dining room (front) and kitchen (back)
    box(-12, 0.5, 6, 1.6, 0.8, 'furniture'); box(-17.4, 3, 0.7, 4, 1.0, 'furniture');
    for (const x of [-14.2, -12, -9.8]) for (const z of [-0.8, 1.8]) box(x, z, 0.55, 0.55, 1.0, 'fabric');
    box(-17.45, -12, 0.7, 9, 0.95, 'counter'); box(-12, -17.45, 9, 0.7, 0.95, 'counter'); box(-12, -11, 3, 1.3, 0.95, 'counter');
    // ground floor, east: library (front) and lounge with a fireplace (back)
    box(17.5, 2.6, 0.6, 4.8, 2.8, 'books'); box(12, 5.5, 7, 0.6, 2.8, 'books'); box(10, -1.5, 0.6, 4, 2.0, 'books'); box(14, -1.5, 0.6, 4, 2.0, 'books');
    box(12, 2.2, 1.8, 1.0, 0.8, 'furniture');
    box(17.4, -12, 0.8, 2.4, 1.6, 'stone'); box(12, -9.5, 3, 0.9, 0.8, 'fabric'); box(12, -14.5, 3, 0.9, 0.8, 'fabric'); box(8.8, -12, 1.4, 1.4, 1.0, 'furniture');
    // upper floor: bedrooms at the front (with balconies), a study and an attic room at the back
    for (const s of [-1, 1]) {
      box(s * 13.5, 3, 2.2, 2.4, 0.6, 'fabric', F2); box(s * 13.5, 4.35, 2.4, 0.3, 1.4, 'furniture', F2);
      box(s * 17.5, -2.5, 0.8, 2.2, 2.2, 'furniture', F2);
      box(s * 11, 7.5, 5, 2.6, 0.4, 'floor', SLAB);                                 // balcony
      box(s * 11, 8.7, 5, 0.15, 1.0, 'railing', F2); box(s * 13.45, 7.5, 0.15, 2.6, 1.0, 'railing', F2); box(s * 8.55, 7.5, 0.15, 2.6, 1.0, 'railing', F2);
      for (const x of [8.8, 13.2]) box(s * x, 8.55, 0.35, 0.35, SLAB, 'marble');
    }
    box(-12, -14, 3, 1.2, 0.8, 'furniture', F2); box(-17.5, -12, 0.6, 6, 2.4, 'books', F2);
    for (const [x, z, h] of [[12, -15, 1.2], [13.3, -15.2, 0.8], [15.5, -10, 1.2], [9.5, -12, 1.0]]) box(x, z, 1.2, 1.2, h, 'trunk', F2);
    // the front: a columned porch over the door, and steps
    for (const x of [-4, -2.2, 2.2, 4]) box(x, 9.6, 0.5, 0.5, 6.6, 'marble', 0.3);
    box(0, 8.2, 9.2, 4.4, 0.3, 'stone'); box(0, 10.9, 6, 1, 0.15, 'stone');
    box(0, 8.2, 9.6, 4.6, 0.4, 'slate', 6.9);
    // the back: a raised stone terrace with a balustrade and steps down to the garden
    box(0, -21.2, 32, 6.4, 0.4, 'stone');
    box(-9.5, -24.3, 13, 0.4, 1.0, 'stone', 0.4); box(9.5, -24.3, 13, 0.4, 1.0, 'stone', 0.4);
    box(-15.8, -21.2, 0.4, 6.4, 1.0, 'stone', 0.4); box(15.8, -21.2, 0.4, 6.4, 1.0, 'stone', 0.4);
    box(0, -25, 6, 1, 0.2, 'stone');
    for (const x of [-9, 9]) box(x, -21.5, 1.2, 1.2, 0.8, 'planter', 0.4);

    /* the front courtyard: a round drive, a fountain, statues and clipped hedges */
    const F = [0, 32];
    box(F[0], F[1] - 4, 8.5, 0.5, 0.7, 'marble'); box(F[0], F[1] + 4, 8.5, 0.5, 0.7, 'marble');
    box(F[0] - 4, F[1], 0.5, 7.5, 0.7, 'marble'); box(F[0] + 4, F[1], 0.5, 7.5, 0.7, 'marble');
    box(F[0], F[1], 1.4, 1.4, 1.2, 'marble'); box(F[0], F[1], 2.8, 2.8, 0.3, 'marble', 1.2); box(F[0], F[1], 0.7, 0.7, 1.5, 'statue', 1.5);
    for (const s of [-1, 1]) {
      for (const [z0, z1] of [[12, 20], [44, 62]]) box(s * 4.5, (z0 + z1) / 2, 0.9, z1 - z0, 1.1, 'hedge');
      for (const z of [16, 26, 38, 54]) { box(s * 14, z, 1.2, 1.2, 1.0, 'stone'); box(s * 14, z, 0.6, 0.6, 1.6, 'statue', 1.0); }
      box(s * 22, 12, 1.6, 1.6, 2.4, 'hedge'); box(s * 22, 12, 0.9, 0.9, 1.0, 'hedge', 2.4);
      for (const z of [22, 42]) box(s * 9.5, z, 2, 0.5, 0.5, 'furniture');           // benches
    }
    box(8, 52, 4.4, 1.9, 1.15, 'car'); box(8.3, 52, 2.2, 1.6, 0.6, 'car', 1.15);   // a parked old car on the drive
    // hedge mazes in both front corners (the same maze, mirrored)
    const CW = 4, NX = 7, NZ = 8, MX0 = 34, MZ0 = 24, MT = 0.7, MH = 2.6;
    const vis = [], hW = [], vW = [];
    for (let i = 0; i < NX; i++) { vis.push([]); for (let j = 0; j < NZ; j++) vis[i].push(false); }
    for (let i = 0; i <= NX; i++) { vW.push([]); for (let j = 0; j < NZ; j++) vW[i].push(true); }
    for (let i = 0; i < NX; i++) { hW.push([]); for (let j = 0; j <= NZ; j++) hW[i].push(true); }
    const stack = [[3, 4]]; vis[3][4] = true;
    while (stack.length) {
      const [ci, cj] = stack[stack.length - 1];
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => [ci + dx, cj + dz, dx, dz]).filter(([a, b]) => a >= 0 && b >= 0 && a < NX && b < NZ && !vis[a][b]);
      if (!nb.length) { stack.pop(); continue; }
      const [ni, nj, dx, dz] = nb[Math.floor(rnd() * nb.length)];
      if (dx) vW[Math.max(ci, ni)][cj] = false; else hW[ci][Math.max(cj, nj)] = false;
      vis[ni][nj] = true; stack.push([ni, nj]);
    }
    for (let i = 1; i < NX; i++) for (let j = 0; j < NZ; j++) if (rnd() < 0.22) vW[i][j] = false;      // a few loops, so it's not a dead-end trap
    for (let i = 0; i < NX; i++) for (let j = 1; j < NZ; j++) if (rnd() < 0.22) hW[i][j] = false;
    for (const [i, j] of [[2, 3], [3, 3], [4, 3], [2, 4], [3, 4], [4, 4]]) {                       // a clearing in the middle
      if (i > 2) vW[i][j] = false; if (j > 3) hW[i][j] = false;
    }
    vW[0][2] = vW[0][6] = vW[NX][2] = vW[NX][5] = false; hW[1][0] = hW[5][0] = hW[3][NZ] = hW[6][NZ] = false;   // ways in
    for (const s of [-1, 1]) {
      const mx = c => s * (MX0 + c);
      for (let i = 0; i <= NX; i++) {          // walls running along z, merged where they line up
        let j = 0;
        while (j < NZ) {
          if (!vW[i][j]) { j++; continue; }
          let e = j; while (e < NZ && vW[i][e]) e++;
          box(mx(i * CW), MZ0 + (j + e) / 2 * CW, MT, (e - j) * CW + MT, MH, 'hedge'); j = e;
        }
      }
      for (let j = 0; j <= NZ; j++) {
        let i = 0;
        while (i < NX) {
          if (!hW[i][j]) { i++; continue; }
          let e = i; while (e < NX && hW[e][j]) e++;
          box(s * (MX0 + (i + e) / 2 * CW), MZ0 + j * CW, (e - i) * CW + MT, MT, MH, 'hedge'); i = e;
        }
      }
      box(mx(3.5 * CW), MZ0 + 4 * CW, 1.2, 1.2, 1.0, 'stone'); box(mx(3.5 * CW), MZ0 + 4 * CW, 0.6, 0.6, 1.7, 'statue', 1.0);
    }

    /* the sides: carriage houses facing the house, rose beds and topiary */
    for (const s of [-1, 1]) {
      const cx = s * 54, cz = -4, hx = 5, hz = 7;
      wallWith(box, 'z', cx - s * hx, cz - hz, cz + hz, 0.4, 4, 'brick', [[cz, 6.5, 0, 3.4]]);
      wallWith(box, 'z', cx + s * hx, cz - hz, cz + hz, 0.4, 4, 'brick', [[cz - 3, 1.4, 1.2, 2.4], [cz + 3, 1.4, 1.2, 2.4]]);
      wallWith(box, 'x', cz - hz, cx - hx, cx + hx, 0.4, 4, 'brick', [[cx, 1.2, 0, 2.4]]);
      wallWith(box, 'x', cz + hz, cx - hx, cx + hx, 0.4, 4, 'brick', [[cx, 1.4, 1.2, 2.4]]);
      box(cx, cz, 2 * hx + 1, 2 * hz + 1, 0.35, 'slate', 4); box(cx, cz, 2 * hx - 2, 2 * hz - 2, 0.6, 'slate', 4.35);
      box(cx + s * 1, cz - 2.5, 4.4, 1.9, 1.15, 'car'); box(cx + s * 1.3, cz - 2.5, 2.2, 1.6, 0.6, 'car', 1.15);
      box(cx + s * 3.6, cz + 4, 1.2, 4, 1.0, 'furniture'); box(cx - s * 1, cz + 4.5, 1.2, 1.2, 1.2, 'trunk'); box(cx - s * 2.4, cz + 4.6, 1.0, 1.0, 1.0, 'trunk');
      for (const z of [-14, -2, 10]) for (let r = 0; r < 2; r++) box(s * (24 + r * 4), z, 0.9, 6, 0.9, 'hedge');
      for (const [x, z] of [[30, 2], [30, -12], [40, 14], [40, -20], [62, -26], [62, 16], [44, -32]]) { box(s * x, z, 1.4, 1.4, 1.6, 'hedge'); box(s * x, z, 0.8, 0.8, 0.9, 'hedge', 1.6); }
    }

    /* the back garden: an ornamental pond with an island, a gazebo and a greenhouse */
    const PZ = -46;
    box(0, PZ - 7, 28.6, 0.6, 0.45, 'stone'); box(0, PZ + 7, 28.6, 0.6, 0.45, 'stone');
    box(-14, PZ, 0.6, 14, 0.45, 'stone'); box(14, PZ, 0.6, 14, 0.45, 'stone');
    box(0, PZ, 3.4, 3.4, 0.45, 'stone'); box(0, PZ, 0.8, 0.8, 1.8, 'statue', 0.45);
    for (const x of [-7, 7]) box(x, PZ, 1.8, 0.6, 0.5, 'stone');                   // stepping stones over the water
    // gazebo
    const GX = -40, GZ = -48;
    box(GX, GZ, 7, 7, 0.35, 'stone');
    for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3], [0, -3], [0, 3], [-3, 0], [3, 0]]) box(GX + dx, GZ + dz, 0.35, 0.35, 3.0, 'marble', 0.35);
    for (const [dx, dz, w, d] of [[-1.5, -3, 2.6, 0.2], [1.5, -3, 2.6, 0.2], [-3, -1.5, 0.2, 2.6], [-3, 1.5, 0.2, 2.6], [3, -1.5, 0.2, 2.6], [3, 1.5, 0.2, 2.6]]) box(GX + dx, GZ + dz, w, d, 0.9, 'railing', 0.35);
    box(GX, GZ, 8, 8, 0.3, 'slate', 3.35); box(GX, GZ, 6, 6, 0.4, 'slate', 3.65); box(GX, GZ, 4, 4, 0.4, 'slate', 4.05); box(GX, GZ, 1.6, 1.6, 0.6, 'slate', 4.45);
    box(GX, GZ, 1.3, 1.3, 0.8, 'furniture', 0.35);
    // greenhouse: low brick walls, a white iron frame and planting beds (open between the frames)
    const HX = 40, HZ = -48, hx2 = 6, hz2 = 4;
    wallWith(box, 'x', HZ - hz2, HX - hx2, HX + hx2, 0.3, 0.9, 'brick', []);
    wallWith(box, 'x', HZ + hz2, HX - hx2, HX + hx2, 0.3, 0.9, 'brick', [[HX + 1.5, 1.8, 0, 0.9]]);
    wallWith(box, 'z', HX - hx2, HZ - hz2, HZ + hz2, 0.3, 0.9, 'brick', [[HZ + 2, 1.8, 0, 0.9]]);
    wallWith(box, 'z', HX + hx2, HZ - hz2, HZ + hz2, 0.3, 0.9, 'brick', []);
    for (let x = -hx2; x <= hx2; x += 3) for (const z of [-hz2, hz2]) box(HX + x, HZ + z, 0.18, 0.18, 3.2, 'frame', 0.9);
    for (const x of [-hx2, hx2]) box(HX + x, HZ, 0.18, 0.18, 3.2, 'frame', 0.9);
    for (const z of [-hz2, 0, hz2]) box(HX, HZ + z, 2 * hx2 + 0.2, 0.16, 0.16, 'frame', 4.1);
    for (let x = -hx2; x <= hx2; x += 3) box(HX + x, HZ, 0.16, 2 * hz2, 0.16, 'frame', 4.1);
    box(HX - 2.5, HZ, 5, 1.2, 0.8, 'planter'); box(HX + 3.2, HZ - 1.6, 3.4, 1.2, 0.8, 'planter'); box(HX + 3.2, HZ + 1.6, 3.4, 1.2, 0.8, 'planter');
    // garden hedges and box trees around the back
    for (const s of [-1, 1]) {
      for (const z of [-30, -62]) box(s * 20, z, 14, 0.9, 1.2, 'hedge');
      for (const [x, z] of [[26, -36], [26, -56], [56, -40], [56, -58], [10, -62], [30, -66]]) { box(s * x, z, 1.4, 1.4, 1.8, 'hedge'); box(s * x, z, 0.8, 0.8, 1.0, 'hedge', 1.8); }
      box(s * 60, -50, 6, 0.9, 1.2, 'hedge'); box(s * 48, -26, 0.9, 6, 1.2, 'hedge');
    }

    const spawns = [
      [-24, 64], [24, 64], [-15, 50], [15, 50], [0, 64], [-27, 15], [27, 15], [0, 17], [-10, 26], [10, 40],
      [-30, -62], [30, -62], [0, -64], [-24, -33], [24, -33], [-58, -62], [58, -62], [-50, -36], [50, -36],
      [-63, -22], [63, -22], [-63, 12], [63, 12], [-7.8, 3.6], [8, 3.6], [-14.5, -14.6], [15, -8.6], [-44, 40], [44, 40],
    ];
    const teamSpawns = [
      [[-64, -60], [-66, -53], [-64, -40], [-64, -30], [-64, -20], [-64, -14], [-64, 8], [-64, 16], [-58, -34], [-60, 12]],
      [[64, -60], [66, -53], [64, -40], [64, -30], [64, -20], [64, -14], [64, 8], [64, 16], [58, -34], [60, 12]],
    ];
    const patches = [
      [-3, 11.4, 3, H, 'gravel'], [-11, 22, 11, 42, 'gravel'], [-X, ZB, X, ZF, 'parquet'], [-2.5, -16, 2.5, 4.8, 'rug'],
      [-16, -24.4, 16, -18, 'terrace'], [-13.7, PZ - 6.7, 13.7, PZ + 6.7, 'water'], [-3.6, 28.4, 3.6, 35.6, 'water'],
      [GX - 3.5, GZ - 3.5, GX + 3.5, GZ + 3.5, 'terrace'], [HX - hx2, HZ - hz2, HX + hx2, HZ + hz2, 'terrace'],
      [-59, -11, -49, 3, 'terrace'], [49, -11, 59, 3, 'terrace'], [-3, -70, 3, -25.4, 'gravel'],
    ];
    return {
      id: 'manor', name: 'Manor', blurb: 'A grand old house at golden hour: two floors of rooms, twin staircases, hedge mazes and a fountain courtyard.',
      half: H, boxes, spawns, teamSpawns, roads: [], pads: [], patches,
      zone: { r0: 110, r1: 8, centre: 25 },
      showcase: { x: 9, z: 15.5 },
      overview: { x: -58, y: 24, z: 66, lx: 0, ly: 3, lz: -4 },
      theme: {
        ground: 'lawn', sky: ['#5b84c2', '#f2c9a0', '#f6dcc0'], haze: '#efd3b3', fog: [55, 320],
        sun: '#ffcf9e', sunI: 1.55, sunDir: [0.62, 0.5, 0.6], hemi: ['#ffe6cc', '#566a3f', 0.66], decor: 'oaks',
      },
    };
  }

  const MAPS = { outpost: outpost(), manor: manor() };
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

  // --- server anti-cheat checks (cheap point tests, no movement sim) ---
  // is this point well inside a solid box? (used to catch standing inside / phasing through a wall)
  function pointInSolid(map, x, y, z) {
    const m = 0.06;
    for (const b of map.boxes) if (x > b.x0 + m && x < b.x1 - m && z > b.z0 + m && z < b.z1 - m && y > b.y0 + m && y < b.y1 - m) return true;
    return false;
  }
  // highest surface at or just below a point: the floor you could be standing or jumping from
  function floorBelow(map, x, z, y) {
    let f = 0;
    for (const b of map.boxes) if (b.y1 <= y + 0.35 && b.y1 > f && x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) f = b.y1;
    return f;
  }
  // true if a player at (x,y,z) is in a position they could not legitimately reach (inside a wall, or floating too high)
  function illegalStand(map, x, y, z) {
    if (y > floorBelow(map, x, z, y) + 2.9) return true;                 // a jump peaks under ~0.9 m; well above any surface = flying
    return pointInSolid(map, x, y + 0.9, z) || pointInSolid(map, x, y + 1.6, z);
  }
  // does the horizontal segment a->b (as a body of radius r) pass through a box's footprint?
  function segHitsBoxXZ(ax, az, bx, bz, b, r) {
    const dx = bx - ax, dz = bz - az;
    let t0 = 0, t1 = 1;
    const slabs = [[ax, dx, b.x0 - r, b.x1 + r], [az, dz, b.z0 - r, b.z1 + r]];
    for (const [o, d, lo, hi] of slabs) {
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return false; continue; }
      let s = (lo - o) / d, e = (hi - o) / d; if (s > e) { const t = s; s = e; e = t; }
      if (s > t0) t0 = s; if (e < t1) t1 = e; if (t0 > t1) return false;
    }
    return true;
  }
  // true if walking from (ax,az) to (bx,bz) would cross a wall (a solid taller than a step, not above your head)
  function crossedWall(map, ax, az, bx, bz, y) {
    const r = R - 0.03;
    for (const b of map.boxes) {
      if (b.y1 <= y + STEP || b.y0 >= y + HGT) continue;
      if (segHitsBoxXZ(ax, az, bx, bz, b, r)) return true;
    }
    return false;
  }

  const api = { MAPS, MAP_LIST, rayBox, rayMap, blocked, move, clearAt, groundUnder, pointInSolid, floorBelow, illegalStand, crossedWall, BODY: { R, HGT, STEP } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BPMaps = api;
})(typeof window !== 'undefined' ? window : this);
