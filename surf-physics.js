/* SwellSurf physics: the waves, the surfer, the moves and the scoring.
   The game page and the game server both run this exact file. The server rides every leaderboard and
   contest wave again from the controls that were pressed, so a score can't be faked.
   Only + - * / and Math.sqrt / floor / round / abs / min / max / imul are used in the simulation (they give
   identical results in every browser and on the server); sin, cos and exp are worked out by hand below. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.SURF = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const VERSION = 1;
const DT = 1 / 60, G = 9.81;
const PI = 3.141592653589793, TAU = 6.283185307179586;

/* ---------------- deterministic maths ---------------- */
const INV_HP = 0.6366197723675814, HP1 = 1.5707963267341256, HP2 = 6.077100506506192e-11;
const S3 = -1 / 6, S5 = 1 / 120, S7 = -1 / 5040, S9 = 1 / 362880, S11 = -1 / 39916800;
const C2 = -0.5, C4 = 1 / 24, C6 = -1 / 720, C8 = 1 / 40320, C10 = -1 / 3628800, C12 = 1 / 479001600;
function sc(x, q0) {
  const k = Math.round(x * INV_HP);
  const r = (x - k * HP1) - k * HP2, r2 = r * r;
  const q = (k + q0) & 3;
  if (q === 0 || q === 2) { const v = r + r * r2 * (S3 + r2 * (S5 + r2 * (S7 + r2 * (S9 + r2 * S11)))); return q === 0 ? v : -v; }
  const v = 1 + r2 * (C2 + r2 * (C4 + r2 * (C6 + r2 * (C8 + r2 * (C10 + r2 * C12))))); return q === 1 ? v : -v;
}
const fsin = x => sc(x, 0), fcos = x => sc(x, 1);
const LN2 = 0.6931471805599453, INV_LN2 = 1.4426950408889634;
function fexp(x) {
  if (x < -700) return 0; if (x > 700) x = 700;
  const k = Math.round(x * INV_LN2), r = x - k * LN2;
  const p = 1 + r * (1 + r * (1 / 2 + r * (1 / 6 + r * (1 / 24 + r * (1 / 120 + r * (1 / 720 + r * (1 / 5040 + r * (1 / 40320 + r * (1 / 362880 + r * (1 / 3628800 + r * (1 / 39916800)))))))))));
  let m = 1, kk = k < 0 ? -k : k;
  while (kk >= 30) { m *= 1073741824; kk -= 30; }
  m *= (1 << kk);
  return k < 0 ? p / m : p * m;
}
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const sstep = x => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };
const wrapA = a => a - TAU * Math.round(a / TAU);
const sgn = v => v < 0 ? -1 : 1;
function hash(a, b, c) {
  let h = Math.imul((a | 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul((b | 0) + 0x632BE5AB, 0xC2B2AE35) ^ Math.imul((c | 0) + 0x27D4EB2F, 0x165667B1);
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/* ---------------- spots, sizes and custom wave settings ---------------- */
// dir: the way the wave peels along the beach (+1 toward +x, -1 toward -x, 0 = A-frame, either way).
// Facing the beach (+z), +x is on your left: so dir +1 is a left-hander and dir -1 a right-hander.
const SPOTS = [
  { id: 'coral', coast: 'point', name: 'Coral Point', kind: 'Long left point', blurb: 'A long, perfect left peeling down a palm-lined point. The classic.', dir: 1, H: 1.55, c: 4.1, vp: 7.0, hollow: 0.55, len: 290, vari: 0.22, gap: 46, n: 4, per: 11, jit: 5, best: 'Shortboard',
    look: { water: '#16b3c4', deep: '#0b4f86', sand: '#f3e2b6', land: '#3f9a4a', hill: 1.0, palms: 1.0, rock: 0.2, isl: 0 } },
  { id: 'pit', coast: 'reef', name: 'The Pit', kind: 'Heavy right reef', blurb: 'A short, heavy right on a shallow reef that throws a big round barrel.', dir: -1, H: 1.75, c: 4.4, vp: 8.6, hollow: 1.0, len: 170, vari: 0.32, gap: 42, n: 4, per: 11, jit: 3, best: 'Shortboard',
    look: { water: '#12a9bd', deep: '#0a467c', sand: '#eedcae', land: '#4c8f3f', hill: 1.4, palms: 0.6, rock: 0.7, isl: 1 } },
  { id: 'lagoon', coast: 'reef', name: 'Lazy Lagoon', kind: 'Soft right', blurb: 'Soft, rolling rights in a turquoise lagoon. Perfect for longboards and learning.', dir: -1, H: 1.05, c: 3.5, vp: 5.0, hollow: 0.15, len: 300, vari: 0.14, gap: 40, n: 5, per: 10, jit: 6, best: 'Longboard',
    look: { water: '#2cc6c9', deep: '#0f6a96', sand: '#f7ead0', land: '#46a456', hill: 0.6, palms: 1.4, rock: 0.0, isl: 2 } },
  { id: 'peak', coast: 'beach', name: 'Palm Peak', kind: 'A-frame peak', blurb: 'An A-frame peak in front of the palms: some waves go left, some go right.', dir: 0, H: 1.5, c: 4.0, vp: 7.2, hollow: 0.6, len: 200, vari: 0.28, gap: 44, n: 4, per: 11, jit: 8, best: 'Twin fin',
    look: { water: '#18b6c2', deep: '#0b5187', sand: '#f5e4ba', land: '#3b9445', hill: 0.8, palms: 1.6, rock: 0.1, isl: 3 } },
  { id: 'bommie', coast: 'reef', name: 'The Bommie', kind: 'Big wave outer reef', blurb: 'An outer reef that only wakes up for big swell. Take the gun, or tow in with the jet ski (T).', dir: 1, H: 3.7, c: 5.6, vp: 9.8, hollow: 0.55, len: 240, vari: 0.24, gap: 56, n: 3, per: 14, jit: 6, best: 'Gun',
    look: { water: '#139fbb', deep: '#08396d', sand: '#e9d6a6', land: '#3b7f3c', hill: 1.8, palms: 0.5, rock: 1.0, isl: 4 } },
  { id: 'spit', coast: 'beach', name: 'Sand Spit', kind: 'Punchy beach break', blurb: 'A punchy beach break with shifting peaks, quick rides and lots of sections.', dir: 0, H: 1.4, c: 4.2, vp: 8.2, hollow: 0.75, len: 130, vari: 0.48, gap: 38, n: 5, per: 9, jit: 22, best: 'Fish',
    look: { water: '#27b9b9', deep: '#0d5a83', sand: '#f2deae', land: '#5b9b4a', hill: 0.4, palms: 0.8, rock: 0.0, isl: 5 } },
  { id: 'rocky', coast: 'point', name: 'Rocky Rights', kind: 'Fast right point', blurb: 'A fast right point with racy sections. Pump hard to make them.', dir: -1, H: 1.6, c: 4.3, vp: 8.4, hollow: 0.6, len: 260, vari: 0.52, gap: 46, n: 4, per: 11, jit: 5, best: 'Twin fin',
    look: { water: '#14a6bf', deep: '#0a4275', sand: '#dccba0', land: '#4a7d3b', hill: 1.6, palms: 0.4, rock: 1.2, isl: 6 } },
  { id: 'slab', coast: 'reef', name: 'Sunset Slab', kind: 'Hollow slab', blurb: 'A shallow slab: steep drops and the hollowest barrels on the island.', dir: 1, H: 1.9, c: 4.6, vp: 10.5, hollow: 1.25, len: 120, vari: 0.3, gap: 44, n: 4, per: 12, jit: 3, best: 'Bodyboard',
    look: { water: '#10a2b8', deep: '#083d71', sand: '#e6d1a0', land: '#43863e', hill: 1.2, palms: 0.7, rock: 0.9, isl: 7 } },
];
for (const sp of SPOTS) sp.zShore = Math.round(sp.c * (sp.len / sp.vp * 1.25 + 12) + 45);
// where the land starts at x (the beach line); nobody can paddle onto it
function coastZ(sp, x) {
  if (sp.coast === 'point') {
    const s = (sp.dir || 1) * x, tip = 72;
    const z = s >= -50 ? tip + (s + 50) * sp.c / sp.vp : tip + (-50 - s) * 0.15;
    return z < sp.zShore ? z : sp.zShore;
  }
  return sp.zShore + 8 * fsin(x * 0.013 + sp.zShore);
}
const SIZES = ['normal', 'extreme', 'custom'];
// custom wave settings (free surf only): h = wave height in metres, hol = hollowness, peel = peel speed (x the spot's),
// n = waves in a set, gap = seconds between sets, dir = 2 for the spot's way, or -1 / 0 / 1
const CUSTOM_DEFAULT = { h: 1.8, hol: 0.7, peel: 1, n: 4, gap: 44, dir: 2 };
function cleanCustom(c) {
  c = c && typeof c === 'object' ? c : {};
  const n = (v, lo, hi, d) => typeof v === 'number' && isFinite(v) ? clamp(v, lo, hi) : d;
  const out = { h: Math.round(n(c.h, 0.6, 7, 1.8) * 10) / 10, hol: Math.round(n(c.hol, 0, 1.5, 0.7) * 100) / 100, peel: Math.round(n(c.peel, 0.6, 1.6, 1) * 100) / 100,
    n: Math.round(n(c.n, 1, 7, 4)), gap: Math.round(n(c.gap, 25, 90, 44)), dir: [2, -1, 0, 1].includes(c.dir) ? c.dir : 2 };
  if (out.gap < out.n * 9 + 8) out.gap = out.n * 9 + 8;
  return out;
}
function waveConfig(sp, size, custom) {
  const k = { H: sp.H, c: sp.c, vp: sp.vp, hollow: sp.hollow, len: sp.len, vari: sp.vari, gap: sp.gap, n: sp.n, per: sp.per, jit: sp.jit, dir: sp.dir };
  if (size === 'extreme') { k.H *= 1.7; k.hollow *= 1.15; k.vp *= 1.1; k.c *= 1.15; k.per *= 1.12; k.gap = Math.max(k.gap, k.n * k.per + 12); }
  else if (size === 'custom') {
    const c = cleanCustom(custom);
    k.c *= clamp(Math.sqrt(c.h / sp.H), 0.7, 1.6); k.H = c.h; k.hollow = c.hol; k.vp *= c.peel; k.n = c.n; k.gap = c.gap; k.per = Math.min(k.per, (c.gap - 8) / c.n);
    if (c.dir !== 2) k.dir = c.dir;
  }
  return k;
}

/* ---------------- wave schedule ---------------- */
// Waves come in sets. Everything about every wave comes from the seed, so every player in a beach sees exactly the same waves.
const SEG = 25, FIRST = 14;
function makeSchedule(seed, spotId, size, custom) {
  const sp = SPOTS.find(s => s.id === spotId) || SPOTS[0];
  if (!SIZES.includes(size)) size = 'normal';
  return { seed: seed >>> 0, spot: sp, size, custom: size === 'custom' ? cleanCustom(custom) : null, cfg: waveConfig(sp, size, custom), sets: new Map(), act: [], actT: -1 };
}
function makeWave(sch, j, i) {
  const k = sch.cfg, r = n => hash(sch.seed, j, i * 97 + n);
  const tB = FIRST + j * k.gap + i * k.per + (r(0) - 0.5) * 2.2;
  let H = k.H * (0.84 + 0.3 * r(1)); if (i === 1 || i === 2) H *= 1.06;
  let dir = k.dir; if (dir === 0) dir = r(2) < 0.5 ? -1 : 1;
  const xPk = (r(3) - 0.5) * 2 * k.jit;
  const c = k.c * (0.95 + 0.1 * r(4));
  const hollow = k.hollow * (0.85 + 0.3 * r(5));
  const vp = k.vp * (0.92 + 0.16 * r(6));
  const ns = Math.ceil(k.len / SEG), segV = [], segT = [0];
  for (let s = 0; s < ns; s++) { segV.push(vp * (1 + k.vari * (2 * r(10 + s) - 1) * (s === 0 ? 0.3 : 1))); segT.push(segT[s] + SEG / segV[s]); }
  const len = ns * SEG;
  return { id: j * 16 + i, j, i, tB, H, dir, xPk, c, hollow, vp, ns, segV, segT, len, vEnd: vp * 5, tEnd: segT[ns] + 4 };
}
function setOf(sch, j) {
  let s = sch.sets.get(j);
  if (!s) {
    s = []; for (let i = 0; i < sch.cfg.n; i++) s.push(makeWave(sch, j, i));
    sch.sets.set(j, s);
    if (sch.sets.size > 24) { for (const key of sch.sets.keys()) { if (key < j - 6 || key > j + 6) sch.sets.delete(key); if (sch.sets.size <= 16) break; } }
  }
  return s;
}
// the waves in the water at time t (the same list for every point at that time)
function wavesAt(sch, t) {
  if (sch.actT === t) return sch.act;
  const k = sch.cfg, out = [];
  const j0 = Math.floor((t - FIRST - 140) / k.gap) - 1, j1 = Math.floor((t - FIRST + 40) / k.gap) + 1;
  for (let j = Math.max(0, j0); j <= j1; j++) for (const w of setOf(sch, j)) { const tau = t - w.tB; if (tau > -36 && tau < w.tEnd + 18) out.push(w); }
  sch.act = out; sch.actT = t;
  return out;
}
function waveById(sch, t, id) { for (const w of wavesAt(sch, t)) if (w.id === id) return w; return null; }
function peelT(w, s) {
  if (s < 0) return -s / (0.4 * w.vp);                      // the peak's whitewater spreads slowly into the channel
  const k = Math.floor(s / SEG);
  if (k >= w.ns) return w.segT[w.ns] + (s - w.ns * SEG) / w.vEnd;   // past the end of the reef it closes out
  return w.segT[k] + (s - k * SEG) / w.segV[k];
}
// next wave whose peak hasn't broken yet (for the coach and the tow-in)
function nextWave(sch, t) {
  let best = null;
  for (let j = Math.max(0, Math.floor((t - FIRST) / sch.cfg.gap) - 1), n = 0; n < 4; j++, n++) for (const w of setOf(sch, j)) if (w.tB > t + 0.5 && (!best || w.tB < best.tB)) best = w;
  return best;
}

/* ---------------- the wave shape ---------------- */
// Across the wave: u = distance in front of the crest (toward the beach). Along it: s = distance from the peak in the way it
// peels, and d = how far ahead of the breaking part this spot is (negative = already broken).
function frontP(s) {          // the face: rounded crest, steep upper face, flattening into a small trough
  if (s < 0.3) { const t = s / 0.3, t2 = t * t, t3 = t2 * t; return (2 * t3 - 3 * t2 + 1) + 0.72 * (3 * t2 - 2 * t3) - 0.555 * (t3 - t2); }
  if (s < 1) { const t = (s - 0.3) / 0.7, t2 = t * t, t3 = t2 * t; return 0.72 * (2 * t3 - 3 * t2 + 1) - 1.295 * (t3 - 2 * t2 + t) - 0.1 * (3 * t2 - 2 * t3); }
  if (s < 1.9) { const t = (s - 1) / 0.9, t2 = t * t; return -0.1 * (2 * t2 * t - 3 * t2 + 1); }
  return 0;
}
function backP(s) { return s >= 1 ? 0 : 1 - s * s * (3 - 2 * s); }
const WB = 3.2, FRONT = 1.9;
// one wave's height at (x, z, t). q (optional) gets the details.
function waveCore(w, x, z, t, q) {
  const tau = t - w.tB;
  if (tau < -36 || tau > w.tEnd + 18) { if (q) q.on = false; return 0; }
  const At = sstep((tau + 36) / 12) * (1 - sstep((tau - w.tEnd - 6) / 10));
  const s = w.dir * (x - w.xPk), u = z - w.c * tau, H = w.H, wb = WB * H;
  if (!q && (u < -wb || u > 5.4 * H)) return 0;
  let As = 1;
  if (s < 0) { const k = s / 26, k2 = k * k; As = 1 / (1 + k2 * k2); }
  else if (s > w.len + 30) { const k = (s - w.len - 30) / 30, k2 = k * k; As = 1 / (1 + k2 * k2); }
  const d = (peelT(w, s) - tau) * w.vp;
  const Dt = w.hollow * (1.1 + 0.85 * H) + 0.4;
  const b = d >= -0.55 * Dt ? 0 : sstep((-d - 0.55 * Dt) / (1.3 * Dt));
  const wf0 = H * (1.15 - 0.25 * (w.hollow < 1.2 ? w.hollow : 1.2));
  let wf, Hf;
  if (d > 0) { wf = wf0 + (2.8 * H - wf0) * (1 - fexp(-d / 22)); Hf = 0.72 + 0.28 * fexp(-d / 30); }
  else { wf = wf0 + (1.55 * H - wf0) * b; Hf = 1 - 0.48 * b; }
  const Hl = H * At * As * Hf;
  const p = u <= 0 ? backP(-u / wb) : frontP(u / wf);
  if (q) { q.on = u > -wb && u < FRONT * wf; q.w = w; q.id = w.id; q.u = u; q.s = s; q.d = d; q.wf = wf; q.wb = wb; q.Hl = Hl; q.H = H; q.b = b; q.p = p; q.Dt = Dt; q.At = At; q.As = As; q.tau = tau; q.c = w.c; q.dir = w.dir; q.vp = w.vp; q.hollow = w.hollow; }
  if (u <= -wb || u >= FRONT * wf) return 0;
  return Hl * p;
}
// how fast the water itself moves toward the beach there (the face draws up and forward, whitewater rushes in)
function flowOf(q) {
  if (!q.on) return 0;
  const pn = q.p < 0 ? 0 : q.p > 1 ? 1 : q.p, amp = q.At * q.As;
  let f = q.c * amp * pn * (1 - q.b) + q.c * amp * q.b * (pn * 2.2 + 0.2 < 1 ? pn * 2.2 + 0.2 : 1) * (q.u > -0.4 * q.wf && q.u < 2.2 * q.wf ? 1.1 : 0.4);
  if (q.d > -q.Dt && q.d < 1.2 * q.H && pn > 0.78 && q.u > -0.25 * q.wf) f += 0.45 * q.c * amp * (pn - 0.78) / 0.22;   // the lip throws forward
  return f;
}
function baseH(x, z, t) { return 0.08 * fsin(0.21 * z - 1.1 * t + 0.35 * fsin(0.047 * x)) + 0.05 * fsin(0.13 * x + 0.29 * z - 0.83 * t) + 0.03 * fsin(0.37 * x - 0.41 * z - 1.7 * t); }
function surfH(sch, x, z, t) {
  let h = baseH(x, z, t);
  for (const w of wavesAt(sch, t)) h += waveCore(w, x, z, t, null);
  return h;
}
const QT = {}, QF = {};
// height, slope, how fast the surface rises, the water's flow, and the details of one wave (wid) or the biggest one
function sample(sch, x, z, t, wid, o) {
  o = o || {};
  const ws = wavesAt(sch, t);
  let h = baseH(x, z, t), flow = 0, best = -1e9, got = null;
  for (const w of ws) {
    const hw = waveCore(w, x, z, t, QT);
    h += hw; flow += flowOf(QT);
    let rel;
    if (wid >= 0) rel = w.id === wid ? 1 : -1;
    else rel = QT.on ? QT.Hl * (QT.p > 0.05 ? QT.p : 0.05) : -1;
    if (rel > best && rel >= 0) { best = rel; got = w; Object.assign(QF, QT); }
  }
  const e = 0.04;
  const hx1 = surfH(sch, x + e, z, t), hx0 = surfH(sch, x - e, z, t), hz1 = surfH(sch, x, z + e, t), hz0 = surfH(sch, x, z - e, t);
  o.h = h; o.gx = (hx1 - hx0) / (2 * e); o.gz = (hz1 - hz0) / (2 * e); o.flow = flow;
  o.q = got ? Object.assign(o.q || {}, QF) : null;
  return o;
}

/* ---------------- boards ---------------- */
// fam: surf = stand-up boards, body = bodyboard (prone), bodysurf = no board
const BOARDS = [
  { id: 'short', name: 'Shortboard', fam: 'surf', len: 1.83, wid: 0.49, th: 0.062, nose: 0.12, tail: 'squash', fins: 3, rocker: 0.11, turn: 3.2, grip: 6.5, vane: 6, kl: 0.03, kq: 0.0105, pump: 2.7, vmax: 13, paddle: 1.0, catch: 1.0, air: 1.0, spin: 7.6, flip: 6.6, roll: 0, tip: 'Does everything: snaps, airs, barrels.' },
  { id: 'twin', name: 'Twin fin', fam: 'surf', len: 1.66, wid: 0.53, th: 0.064, nose: 0.2, tail: 'swallow', fins: 2, rocker: 0.09, turn: 3.6, grip: 4.7, vane: 4.4, kl: 0.028, kq: 0.0098, pump: 3.0, vmax: 13.6, paddle: 1.05, catch: 1.06, air: 1.05, spin: 8.2, flip: 6.8, roll: 0, tip: 'Looser: tail slides and reverses come easy.' },
  { id: 'fish', name: 'Fish', fam: 'surf', len: 1.6, wid: 0.55, th: 0.066, nose: 0.3, tail: 'swallow', fins: 2, rocker: 0.07, turn: 2.95, grip: 5.6, vane: 5.2, kl: 0.026, kq: 0.0094, pump: 3.3, vmax: 13.8, paddle: 1.12, catch: 1.15, air: 0.9, spin: 7.2, flip: 6.2, roll: 0, tip: 'Fast and flowy. Best in small waves.' },
  { id: 'gun', name: 'Gun', fam: 'surf', len: 2.36, wid: 0.48, th: 0.075, nose: 0.05, tail: 'pin', fins: 3, rocker: 0.13, turn: 2.1, grip: 8.2, vane: 8, kl: 0.026, kq: 0.0082, pump: 1.9, vmax: 16.5, paddle: 1.35, catch: 1.36, air: 0.6, spin: 5.6, flip: 5.2, roll: 0, tip: 'Long and stable for big waves and late drops.' },
  { id: 'long', name: 'Longboard', fam: 'surf', len: 2.85, wid: 0.57, th: 0.075, nose: 0.55, tail: 'square', fins: 1, rocker: 0.07, turn: 1.75, grip: 7, vane: 7, kl: 0.03, kq: 0.0105, pump: 1.4, vmax: 11.8, paddle: 1.45, catch: 1.5, air: 0.35, spin: 4.5, flip: 4, roll: 0, walk: true, tip: 'Hold Space to walk to the nose. Hang five, hang ten.' },
  { id: 'single', name: 'Single fin', fam: 'surf', len: 2.1, wid: 0.53, th: 0.068, nose: 0.14, tail: 'pin', fins: 1, rocker: 0.09, turn: 2.25, grip: 7.2, vane: 7.6, kl: 0.028, kq: 0.0096, pump: 1.8, vmax: 13.2, paddle: 1.2, catch: 1.2, air: 0.6, spin: 5.8, flip: 5.4, roll: 0, single: true, tip: 'Smooth lines and long trims. Turn too hard and it spins out.' },
  { id: 'alaia', name: 'Alaia', fam: 'surf', len: 1.92, wid: 0.46, th: 0.024, nose: 0.4, tail: 'square', fins: 0, rocker: 0.02, turn: 3.0, grip: 2.3, vane: 1.6, kl: 0.024, kq: 0.0092, pump: 2.0, vmax: 13.5, paddle: 0.8, catch: 0.86, air: 0.7, spin: 7, flip: 5.6, roll: 0, finless: true, tip: 'A finless wooden plank. It slides everywhere. Hard to catch waves.' },
  { id: 'body', name: 'Bodyboard', fam: 'body', len: 1.05, wid: 0.55, th: 0.06, nose: 1, tail: 'crescent', fins: 0, rocker: 0.04, turn: 3.6, grip: 4.6, vane: 3.2, kl: 0.03, kq: 0.0105, pump: 2.5, vmax: 12.4, paddle: 1.12, catch: 1.2, air: 1.12, spin: 8.4, flip: 7, roll: 7.2, prone: true, tip: 'Lie on it. X to drop knee. Up in the air rolls (El rollo).' },
  { id: 'bodysurf', name: 'Bodysurf', fam: 'bodysurf', len: 0, wid: 0, th: 0, nose: 0, tail: '', fins: 0, rocker: 0, turn: 2.6, grip: 3.6, vane: 2.4, kl: 0.05, kq: 0.016, pump: 1.3, vmax: 8.6, paddle: 0.85, catch: 1.04, air: 0.3, spin: 6, flip: 5, roll: 0, prone: true, tip: 'No board. G puts the handplane on for more speed. Best in soft waves.' },
];
const BOARD_IDS = BOARDS.map(b => b.id);

/* ---------------- moves and points ---------------- */
const MOVES = {
  'Late drop': 450, 'Bottom turn': 120, 'Carve': 220, 'Top turn': 240, 'Snap': 330, 'Tail slide': 460, 'Layback snap': 540, 'Cutback': 420, 'Roundhouse cutback': 720,
  'Reverse': 620, 'Floater': 460, 'Air': 420, 'Grab': 260, 'Air 360': 860, 'Alley-oop': 960, 'Air reverse': 760, 'Air 540': 1200, 'Air 720': 1500, 'Backflip': 1320, 'Double backflip': 2400, 'Rodeo flip': 1680, 'Invert': 820,
  'Barrel': 650, 'Hang five': 320, 'Hang ten': 660, 'Hang heels': 720, 'Cross step': 90, 'Drop-knee cutback': 560, 'Soul arch': 240, 'Head dip': 320, 'Spinner': 470, 'Switch': 110,
  'Pocket trim': 300, 'Spin-out': 180, 'Slide': 320, 'Alaia 360': 680, 'Arm drag': 210, 'Drop knee': 200, 'Drop-knee 360': 680, 'El rollo': 920, 'ARS': 1450,
  'Chest up': 220, 'Spin': 420, 'Reverse spin': 460, 'Kick out': 0,
};

/* ---------------- the surfer ---------------- */
const PADDLE = 0, RIDE = 1, AIR = 2, WIPE = 3, TOW = 4;
const K = { L: 1, R: 2, U: 4, D: 8, SP: 16, SH: 32, X: 64, H: 128, T: 256, G: 512 };
function newSurfer(board, stance) {
  const b = Math.max(0, BOARD_IDS.indexOf(board));
  return {
    v: VERSION, t: 0, mode: PADDLE, b, st: stance ? 1 : 0, x: 0, y: 0, z: -6, vx: 0, vy: 0, vz: 0, yaw: PI, pitch: 0, roll: 0, pin: 0,
    sph: 0, arm: 0, dk: 0, dcd: 0, wash: 0, ct0: 0, pop: 0, wid: -1, ff: 0, pph: 0, wk: 0, dkn: 0, hp: 0, sw: 0, idle: 0,
    tdir: 0, tang: 0, tT: 0, ta0: 0, tb0: 0, tp0: 0, td0: 0, tsh: 0, tsl: 0, tx: 0, cbT: -9,
    rel: 0, relM: 0, ft: 0, tt: 0, tdp: 0, ww: 0, slow: 0, rt: 0, nt: 0, hh: 0, hf: 0, ht: 0, sa: 0, trim: 0, slT: 0, adT: 0, dkT: 0, cuT: 0, ldp: 0,
    at: 0, as: 0, af: 0, ar: 0, ag: 0, ah: 0, ay0: 0, apm: 0, asd: 0, rev: 0,
    pts: 0, cp: 0, cn: 0, ctm: 0, mc: {}, ml: [], wt: 0, why: '', res: null, nr: 0,
    tw: 0, twid: -1, twt: 0, ev: [],
  };
}
// the parts of a surfer that a ride record may start from (it must be paddling or towing, with nothing scored yet)
function checkStart(s) {
  if (!s || typeof s !== 'object') return null;
  const f = newSurfer('short', 0);
  for (const k in f) {
    if (k === 'ev' || k === 'mc' || k === 'ml' || k === 'res' || k === 'why') continue;
    const v = s[k];
    if (typeof v !== 'number' || !isFinite(v)) return null;
    f[k] = v;
  }
  if (f.v !== VERSION || (f.mode !== PADDLE && f.mode !== TOW) || f.b < 0 || f.b >= BOARDS.length || (f.b | 0) !== f.b) return null;
  if (Math.hypot(f.vx, f.vz) > (f.mode === TOW ? 9 : 4.2) || Math.abs(f.vy) > 8 || Math.abs(f.x) > 700 || f.z < -320 || f.z > 400 || Math.abs(f.yaw) > 1e4) return null;
  if (f.pts || f.cp || f.cn || f.at || f.tt || f.pop > 0.0001) return null;
  if (f.t < 0 || (f.t | 0) !== f.t) return null;
  f.wid = -1; f.st = f.st ? 1 : 0; f.res = null; f.ml = []; f.mc = {}; f.why = '';
  return f;
}
const tmpO = {}, tmpO2 = {};
function step(s, sch, inp) {
  s.ev.length = 0;
  const t = s.t * DT;
  inp = inp | 0;
  if (s.mode === PADDLE) paddleStep(s, sch, inp, t);
  else if (s.mode === RIDE) rideStep(s, sch, inp, t);
  else if (s.mode === AIR) airStep(s, sch, inp, t);
  else if (s.mode === WIPE) wipeStep(s, sch, inp, t);
  else if (s.mode === TOW) towStep(s, sch, inp, t);
  // keep everyone inside the surf area
  if (s.x < -650) { s.x = -650; s.vx = Math.max(0, s.vx); } if (s.x > 650) { s.x = 650; s.vx = Math.min(0, s.vx); }
  if (s.z < -300) { s.z = -300; s.vz = Math.max(0, s.vz); } if (s.z > 380) { s.z = 380; s.vz = Math.min(0, s.vz); }
  s.pin = inp; s.t++;
}
const press = (s, inp, k) => (inp & k) && !(s.pin & k);

function paddleStep(s, sch, inp, t) {
  const B = BOARDS[s.b];
  const o = sample(sch, s.x, s.z, t, -1, tmpO), q = o.q;
  const turn = (inp & K.L ? 1 : 0) - (inp & K.R ? 1 : 0);
  s.yaw += turn * 1.9 * DT;
  const hx = fsin(s.yaw), hz = fcos(s.yaw);
  if ((inp & K.SH) && s.dk <= 0 && s.dcd <= 0) { s.dk = 1.0; s.dcd = 1.7; s.ev.push({ k: 'duck' }); }
  if (s.dk > 0) s.dk -= DT; if (s.dcd > 0) s.dcd -= DT;
  const duck = s.dk > 0;
  if (B.fam === 'bodysurf' && press(s, inp, K.G)) s.hp = s.hp ? 0 : 1;
  // strokes: hold Space to keep paddling; a stroke always finishes
  let thrust = 0;
  if ((inp & K.SP) || s.sph > 0) {
    s.sph += DT / 0.6;
    if (s.sph >= 1) { s.arm ^= 1; s.sph = (inp & K.SP) ? s.sph - 1 : 0; if (s.sph > 0) s.ev.push({ k: 'stroke', a: s.arm }); }
    if (s.sph > 0 && s.sph < 0.55 && !duck) thrust = 2.5 * B.paddle;
    s.idle = 0;
  } else s.idle += DT;
  if (press(s, inp, K.SP)) s.ev.push({ k: 'stroke', a: s.arm });
  const gg = 1 + o.gx * o.gx + o.gz * o.gz, gk = duck ? 0.2 : 0.85;
  s.vx += -G * o.gx / gg * gk * DT; s.vz += -G * o.gz / gg * gk * DT;
  const fl = duck ? o.flow * 0.15 : o.flow;
  const rx = s.vx, rz = s.vz - fl;
  let al = rx * hx + rz * hz, la = rx * hz - rz * hx;
  al += thrust * DT;
  const ad = Math.abs(al);
  al -= sgn(al) * Math.min(ad, (0.45 * ad + 0.12 * ad * ad + (duck ? 1.2 * ad : 0)) * DT);
  la *= fexp(-2.2 * DT);
  s.vx = al * hx + la * hz; s.vz = al * hz - la * hx + fl;
  s.x += s.vx * DT; s.z += s.vz * DT;
  s.y = duck ? o.h - 0.85 : o.h;
  s.vy = 0;
  const cz = coastZ(sch.spot, s.x) - 3; if (s.z > cz) { s.z = cz; if (s.vz > 0) s.vz = 0; }
  // whitewater or the lip landing on you pushes you back to the beach (duck dive under it)
  if (q && !duck && ((q.b > 0.35 && q.p > 0.12 && q.u > -0.3 * q.wf && q.u < 1.5 * q.wf) || (q.d < 0.4 && q.d > -q.Dt && q.p > 0.5 && q.u > -0.2 * q.wf && q.u < 0.9 * q.wf))) {
    if (s.wash <= 0) s.ev.push({ k: 'wash' });
    s.wash = 0.9; s.vz += (q.c * 1.05 - s.vz) * 3 * DT; s.vx *= 1 - 1.5 * DT;
  }
  if (s.wash > 0) s.wash -= DT;
  // catching a wave: on its face, facing the beach, paddling, and going about as fast as the wave
  const slope = Math.sqrt(o.gx * o.gx + o.gz * o.gz);
  const need = q ? q.c * 0.84 / B.catch : 99;
  if (!duck && q && q.on && q.u > 0.02 * q.wf && q.u < 0.95 * q.wf && q.b < 0.55 && slope > 0.3 && hz > 0.35 && s.vz > need && s.sph > 0 && s.wash <= 0.5) {
    s.ct0 += DT;
    if (s.ct0 >= 0.1) startRide(s, q, slope);
  } else s.ct0 = 0;
  // T: whistle for the jet ski
  if (press(s, inp, K.T) && B.fam === 'surf') { s.mode = TOW; s.tw = 1; s.twt = 0; s.twid = -1; s.ev.push({ k: 'tow' }); }
}
function resetRide(s) {
  s.pts = 0; s.cp = 0; s.cn = 0; s.ctm = 0; s.mc = {}; s.ml = []; s.res = null; s.why = '';
  s.tdir = 0; s.tang = 0; s.tT = 0; s.rel = 0; s.relM = 0; s.ft = 0; s.tt = 0; s.tdp = 0; s.ww = 0; s.slow = 0; s.rt = 0; s.nt = 0; s.hh = 0; s.hf = 0; s.ht = 0; s.sa = 0; s.trim = 0; s.slT = 0; s.adT = 0; s.dkT = 0; s.cuT = 0; s.cbT = -9;
  s.at = 0; s.as = 0; s.af = 0; s.ar = 0; s.ag = 0; s.ah = 0; s.apm = 0; s.rev = 0; s.ff = 0; s.pph = 0; s.wk = 0; s.sw = 0; s.pitch = 0; s.roll = 0;
}
function startRide(s, q, slope) {
  resetRide(s);
  s.mode = RIDE; s.pop = BOARDS[s.b].prone ? 0.22 : 0.45; s.wid = q.id; s.ct0 = 0; s.sph = 0;
  s.ldp = (q.d < 4 || slope > 1.25) && q.H > 1.2 ? 1 : 0;
  s.ev.push({ k: 'catch', late: s.ldp });
}

/* ---- scoring ---- */
function award(s, name, q, mult) {
  const base = MOVES[name] || 0;
  const n = s.mc[name] || 0; s.mc[name] = n + 1;
  const crit = q ? 1 + 0.9 * fexp(-(q.d > 0 ? q.d : 0) / 10) : 1;
  const size = q ? 0.78 + 0.24 * (q.H < 5 ? q.H : 5) : 1;
  const rep = n === 0 ? 1 : n === 1 ? 0.7 : n === 2 ? 0.5 : 0.35;
  const sw = s.sw ? 1.2 : 1;
  const p = Math.round(base * crit * size * rep * sw * (mult || 1));
  s.cp += p; s.cn++; s.ctm = 0;
  if (s.ml.length < 60) s.ml.push({ n: name, p });
  s.ev.push({ k: 'move', n: name, p, c: s.cn, crit: crit > 1.6 ? 1 : 0 });
  return p;
}
function bank(s) {
  if (s.cn) { const m = 1 + 0.15 * (s.cn - 1 < 8 ? s.cn - 1 : 8); const p = Math.round(s.cp * m); s.pts += p; s.ev.push({ k: 'bank', p, n: s.cn, m }); }
  s.cp = 0; s.cn = 0; s.ctm = 0;
}
function finish(s, ok, why) {
  if (ok) bank(s); else if (s.cn) { s.ev.push({ k: 'lost', p: s.cp }); s.cp = 0; s.cn = 0; }
  const pts = Math.round(s.pts);
  const sc = Math.round(1000 * (1 - fexp(-pts / 5200))) / 100;
  s.res = { ok: ok ? 1 : 0, why, pts, sc, n: s.ml.length, rt: Math.round(s.rt * 10) / 10, wid: s.wid, top: topMove(s) };
  s.nr++;
  s.ev.push({ k: 'end', ok: ok ? 1 : 0, why, pts, sc });
}
function topMove(s) { let b = '', bp = 0; for (const m of s.ml) if (m.p > bp) { bp = m.p; b = m.n; } return b; }
function wipe(s, why) {
  finish(s, false, why);
  s.mode = WIPE; s.wt = 2.4; s.why = why; s.ev.push({ k: 'wipe', why });
}
function endOk(s, why) {
  finish(s, true, why);
  s.mode = PADDLE; s.wid = -1; s.vx *= 0.35; s.vz *= 0.35; s.vy = 0; s.pitch = 0; s.roll = 0; s.sph = 0; s.dk = 0; s.idle = 0;
}

/* ---- riding ---- */
function rideStep(s, sch, inp, t) {
  const B = BOARDS[s.b];
  const o = sample(sch, s.x, s.z, t, s.wid, tmpO), q = o.q;
  if (!q || q.At < 0.2) return endOk(s, 'The wave faded out');
  s.rt += DT;
  const Lk = inp & K.L, Rk = inp & K.R, Up = inp & K.U, Dn = inp & K.D, SP = inp & K.SP, SH = inp & K.SH, Xk = inp & K.X, Hk = inp & K.H;
  let turn = (Lk ? 1 : 0) - (Rk ? 1 : 0);
  const popping = s.pop > 0, ctrl = popping ? 0.3 : 1;
  if (popping) s.pop = Math.max(0, s.pop - DT);
  // gravity down the face
  const gg = 1 + o.gx * o.gx + o.gz * o.gz;
  s.vx += -G * o.gx / gg * DT; s.vz += -G * o.gz / gg * DT;
  const fl = o.flow, slope = Math.sqrt(gg - 1);
  let rx = s.vx, rz = s.vz - fl;
  const hx = fsin(s.yaw), hz = fcos(s.yaw);
  let al = rx * hx + rz * hz, la = rx * hz - rz * hx;
  const sp = Math.sqrt(rx * rx + rz * rz);
  const onFace = q.on && q.u > -0.15 * q.wf && q.u < 1.6 * q.wf && slope > 0.12;
  const inWW = q.b > 0.5 && q.p > 0.05 && q.u > -0.35 * q.wf && q.u < FRONT * q.wf;
  const fam = B.fam;
  // board specials
  if (fam === 'body' && press(s, inp, K.X)) s.dkn = s.dkn ? 0 : 1;
  if (fam === 'bodysurf' && press(s, inp, K.G)) s.hp = s.hp ? 0 : 1;
  if (fam === 'surf' && !B.walk && press(s, inp, K.X) && !popping) { s.sw = s.sw ? 0 : 1; s.st = s.st ? 0 : 1; if (!s.mc.Switch) award(s, 'Switch', q); }
  if (B.walk) { if (SP && !popping) s.wk = Math.min(1, s.wk + DT * 0.55); else if (Dn) s.wk = Math.max(0, s.wk - DT * 0.75); }
  const nose = B.walk && s.wk > 0.85;
  // fins free: Shift + a hard turn high on the face lets the tail slide (alaia: always loose)
  const ffT = fam === 'surf' && SH && turn !== 0 && q.p > 0.5 && sp > 5 && !nose ? 1 : B.single && turn !== 0 && sp > 9.5 && q.p > 0.55 ? 0.8 : 0;
  s.ff += clamp(ffT - s.ff, -6 * DT, 6 * DT);
  const hpk = fam === 'bodysurf' && s.hp ? 1.25 : 1;
  const gk = B.grip * (1 - 0.78 * s.ff) * (inWW ? 0.6 : 1);
  const la2 = la * fexp(-gk * DT), eff = 0.92 - 0.6 * s.ff - (B.finless ? 0.25 : 0);
  let al2 = sgn(al) * Math.sqrt(al * al + (la * la - la2 * la2) * eff);
  const stall = SH && !popping && fam !== 'bodysurf' ? 1 : (fam === 'bodysurf' && SH ? 1.2 : 0);
  const kq = B.kq / hpk + stall * 0.085 + (inWW ? 0.05 : 0) + s.ff * 0.03;
  const aa = Math.abs(al2);
  al2 -= sgn(al2) * Math.min(aa, (B.kl * aa + kq * aa * aa) * DT);
  // pumping (Space) on the face; longboards walk instead
  if (SP && !popping && onFace && !B.walk) {
    s.pph += DT / 0.55; if (s.pph >= 1) s.pph -= 1;
    if (s.pph < 0.5) al2 += sgn(al2) * B.pump * hpk * Math.max(0, 1 - sp / (B.vmax * hpk)) * DT;
  } else s.pph = 0;
  if (Up && onFace && hz > 0.15 && fam === 'surf' && !B.walk) al2 += sgn(al2) * 0.6 * Math.max(0, 1 - sp / B.vmax) * DT;
  if (nose && onFace && q.p > 0.25 && q.p < 0.9) al2 += sgn(al2) * 0.85 * Math.max(0, 1 - sp / (B.vmax + 1)) * DT;
  rx = al2 * hx + la2 * hz; rz = al2 * hz - la2 * hx;
  s.vx = rx; s.vz = rz + fl;
  // steering, and the fins pulling the board back in line with where it's going
  const rate = B.turn * hpk * clamp(0.4 + sp / 9, 0.4, 1.25) * ctrl * (s.ff > 0.5 ? 1.25 : 1) * (nose ? 0.3 : 1) * (s.dkn ? 0.88 : 1);
  const yawD = turn * rate;
  const sinD = sp > 0.3 ? (rx * hz - rz * hx) / sp : 0, cosD = sp > 0.3 ? (rx * hx + rz * hz) / sp : 1;
  const vane = B.vane * (1 - 0.85 * s.ff) * (sp < 3 ? sp / 3 : 1) * sinD;
  const dyaw = (yawD + vane) * DT;
  const pvx = rx, pvz = rz;
  s.yaw += dyaw;
  // move, and stay on the water unless the surface drops away faster than gravity (that's an air)
  s.x += s.vx * DT; s.z += s.vz * DT;
  const h2 = surfH(sch, s.x, s.z, t + DT);
  const yb = s.y + s.vy * DT - 0.5 * G * DT * DT;
  if (!popping && yb > h2 + 0.05 && s.vy > 1.3) {
    s.mode = AIR; s.y = yb; s.vy = Math.min(s.vy - G * DT, 3.6 + 2.6 * B.air) + (SP && fam !== 'bodysurf' ? 1.0 * B.air : 0);
    endTurn(s, q, hx, hz); s.tdir = 0;
    s.at = 0; s.as = 0; s.af = 0; s.ar = 0; s.ag = 0; s.ah = 0; s.ay0 = s.y; s.apm = 0; s.asd = 0; s.rev = 0;
    s.ev.push({ k: 'air' });
    return;
  }
  s.vy = (h2 - s.y) / DT; s.y = h2;
  if (popping) return;

  /* ---- what the surfer is doing: moves ---- */
  const a = hx * q.dir, bdown = hz;               // heading: a = toward the open face (+) or the pocket (-), bdown = toward the beach
  // turns
  if (turn !== 0 && turn === s.tdir) { s.tang += dyaw * turn; s.tT += DT; if (SH) s.tsh = 1; if (Xk) s.tx = 1; const sl = la2 < 0 ? -la2 : la2; if (sl > s.tsl) s.tsl = sl; }
  else {
    if (s.tdir !== 0) endTurn(s, q, hx, hz);
    if (turn !== 0) { s.tdir = turn; s.tang = 0; s.tT = 0; s.ta0 = a; s.tb0 = bdown; s.tp0 = q.p; s.td0 = q.d; s.tsh = SH ? 1 : 0; s.tsl = 0; s.tx = Xk ? 1 : 0; }
    else s.tdir = 0;
  }
  // reverses and spinners: the board turning round while it keeps going the same way
  if (sp > 2) {
    const dv = (pvz * s.vx - pvx * (s.vz - fl)) / (sp * sp + 1e-9);
    s.rel += dyaw - (dv > 0.5 ? 0.5 : dv < -0.5 ? -0.5 : dv);
    const am = s.rel < 0 ? -s.rel : s.rel; if (am > s.relM) s.relM = am;
    if (cosD > 0.9) {
      if (s.relM >= 2.5) {
        const name = fam === 'body' ? (s.dkn ? 'Drop-knee 360' : 'Spinner') : fam === 'bodysurf' ? (s.rel * (hx * q.dir) > 0 ? 'Spin' : 'Reverse spin') : B.finless ? 'Alaia 360' : 'Reverse';
        award(s, name, q);
      } else if (s.relM >= 0.9 && B.single) award(s, 'Spin-out', q);
      s.rel = 0; s.relM = 0;
    }
  }
  // floater: riding along the top of the lip as it breaks
  const flo = q.p > 0.8 && q.u > -0.3 * q.wf && q.u < 0.35 * q.wf && q.d < 2.2 && q.d > -1.7 * q.Dt && s.vx * q.dir > 3;
  if (flo) s.ft += DT; else { if (s.ft >= 0.45) award(s, 'Floater', q); s.ft = 0; }
  // barrel: low on the face with the lip over you
  const tube = q.hollow > 0.25 && q.d < 0.35 * q.H && q.d > -q.Dt && q.p < 0.66 && q.u > 0.08 * q.wf && q.u < 1.15 * q.wf && q.b < 0.45;
  if (tube) { if (s.tt === 0) s.ev.push({ k: 'tube' }); s.tt += DT; const dp = clamp((0.35 * q.H - q.d) / (q.Dt + 0.35 * q.H), 0, 1); if (dp > s.tdp) s.tdp = dp; if (Up && fam === 'surf' && B.walk && !s.mc['Head dip']) award(s, 'Head dip', q); }
  else if (s.tt > 0) {
    if (s.tt >= 0.45 && q.d > -0.3) { award(s, 'Barrel', q, s.tt * (1 + 1.2 * s.tdp)); s.ev.push({ k: 'tubeout', t: Math.round(s.tt * 10) / 10 }); }
    s.tt = 0; s.tdp = 0;
  }
  // longboard nose riding
  if (B.walk) {
    if (nose) {
      s.nt += DT;
      if (s.nt >= 1 && !s.hf) { s.hf = 1; award(s, 'Hang five', q); }
      if (s.nt >= 2.6 && s.hf === 1) { s.hf = 2; award(s, 'Hang ten', q); }
      if (Hk) { s.ht += DT; if (s.ht >= 0.9 && !s.hh) { s.hh = 1; award(s, 'Hang heels', q); } } else s.ht = 0;
      if (s.cuT === 0) { s.cuT = 1; award(s, 'Cross step', q); }
    } else if (s.wk < 0.45) { s.nt = 0; s.hf = 0; s.hh = 0; s.ht = 0; s.cuT = 0; }
    if (Up && turn === 0 && s.wk < 0.6 && onFace) { s.sa += DT; if (s.sa >= 1 && s.sa - DT < 1) award(s, 'Soul arch', q); } else s.sa = 0;
    if (press(s, inp, K.X) && s.wk < 0.6) award(s, 'Spinner', q);
  }
  // trimming in the pocket
  if (turn === 0 && !SP && fam === 'surf' && q.d < 7 && q.d > -0.5 && q.p > 0.35 && q.p < 0.85) { s.trim += DT; if (s.trim >= 2.5 && s.trim - DT < 2.5) award(s, 'Pocket trim', q); } else s.trim = 0;
  // alaia slides
  if (B.finless) { const sl = la2 < 0 ? -la2 : la2; if (sl > 2.4) { s.slT += DT; if (s.slT >= 0.7 && s.slT - DT < 0.7) award(s, 'Slide', q); } else s.slT = 0; }
  // bodyboard and bodysurf moves
  if (fam === 'body') {
    if (SH && onFace && q.d < 5) { s.adT += DT; if (s.adT >= 0.8 && s.adT - DT < 0.8) award(s, 'Arm drag', q); } else s.adT = 0;
    if (s.dkn) { s.dkT += DT; if (s.dkT >= 2 && s.dkT - DT < 2) award(s, 'Drop knee', q); } else s.dkT = 0;
  }
  if (fam === 'bodysurf') { if (Up && turn === 0 && onFace) { s.sa += DT; if (s.sa >= 1 && s.sa - DT < 1) award(s, 'Chest up', q); } else s.sa = 0; }
  // late drop: made it to the bottom from a steep, late take-off
  if (s.ldp && q.p < 0.35 && s.rt < 2.5) { s.ldp = 0; award(s, 'Late drop', q); } else if (s.ldp && s.rt >= 2.5) s.ldp = 0;
  // the chain of moves banks after a moment with no new move
  if (s.cn) { s.ctm += DT; if (s.ctm > 2.6) bank(s); }

  /* ---- what can go wrong ---- */
  if (q.d > -q.Dt * 1.2 && q.d < 0.6 && q.p > 0.68 && q.u > -0.15 * q.wf && !flo && s.vx * q.dir < q.vp * 0.75) return wipe(s, 'Over the falls');
  if (q.d < -q.Dt * 1.08 && q.d > -q.Dt * 2.6 && q.u > -0.2 * q.wf && q.u < 1.3 * q.wf && q.p < 0.75 && q.p > 0.02) return wipe(s, 'The foam ball got you');
  if (inWW && !(q.p > 0.8 && s.ft > 0)) { s.ww += DT; if (s.ww > (fam !== 'surf' || B.walk ? 1.4 : 0.5)) return wipe(s, 'Caught by the whitewater'); }
  else s.ww = Math.max(0, s.ww - 2 * DT);
  if (sp < 1.2) { s.slow += DT; if (s.slow > 1) return endOk(s, 'Ran out of speed'); } else s.slow = 0;
  if (q.u < -0.45 * q.wb) return endOk(s, 'Kick out');
  if (q.u > 2.4 * q.wf && sp < 3.2) return endOk(s, 'Lost the wave');
  if (s.rt > 150) return endOk(s, 'Kick out');
}
function endTurn(s, q, hx, hz) {
  const ang = s.tang, a1 = hx * q.dir, b1 = hz, B = BOARDS[s.b], now = s.rt;
  s.tdir = 0;
  if (ang < 0.9) return;
  // roundhouse: a cutback, then straight away the rebound turn back the other way
  if (now - s.cbT < 1.8 && s.ta0 < -0.3 && a1 > 0.3 && ang > 1.3) { s.cbT = -9; award(s, 'Roundhouse cutback', q, 0.75); return; }
  if (s.ta0 > 0.3 && a1 < -0.3 && ang >= 2.3 && s.td0 > 5) { award(s, s.tx && B.fam === 'surf' ? 'Drop-knee cutback' : 'Cutback', q); s.cbT = now; return; }
  if (s.tp0 >= 0.55 && s.tb0 < 0.15 && b1 > 0.3 && ang >= 1.4) {
    if (s.tT > 0.7) return void award(s, 'Top turn', q);
    if (B.fam !== 'surf') return void award(s, 'Snap', q);
    if (s.tsh && s.tsl > 1.6) return void award(s, s.tsl > 3.2 ? 'Layback snap' : 'Tail slide', q);
    return void award(s, s.tsl > 3.4 ? 'Tail slide' : 'Snap', q);
  }
  if ((s.tp0 < 0.45) && s.tb0 > 0.2 && b1 < 0 && ang >= 1.0) return void award(s, 'Bottom turn', q);
  if (ang >= 1.7) award(s, 'Carve', q);
}

/* ---- in the air ---- */
function airStep(s, sch, inp, t) {
  const B = BOARDS[s.b];
  const turn = (inp & K.L ? 1 : 0) - (inp & K.R ? 1 : 0);
  s.vy -= G * DT;
  s.vx *= 1 - 0.03 * DT; s.vz *= 1 - 0.03 * DT;
  s.x += s.vx * DT; s.y += s.vy * DT; s.z += s.vz * DT;
  s.at += DT;
  const hsp = Math.sqrt(s.vx * s.vx + s.vz * s.vz) + 1e-9;
  let hx = fsin(s.yaw), hz = fcos(s.yaw);
  if (turn !== 0) { const d = turn * B.spin * DT; s.yaw += d; s.as += d; s.asd = turn; }
  else {      // let go and the board settles to the nearest way it can land: forwards or backwards
    const sinD = (s.vx * hz - s.vz * hx) / hsp, cosD = (s.vx * hx + s.vz * hz) / hsp;
    const rot = cosD >= 0 ? sinD : -sinD, d = clamp(rot * 7, -3.4, 3.4) * DT;
    s.yaw += d; s.as += d;
  }
  if (inp & K.D) { const d = B.flip * DT; s.pitch += d; s.af += d; }
  else { const tg = TAU * Math.round(s.pitch / TAU), e = tg - s.pitch, d = clamp(e * 6, -4.5, 4.5) * DT; s.pitch += d; s.af += d; }
  const pe = Math.abs(wrapA(s.pitch)); if (pe > s.apm) s.apm = pe;
  if ((inp & K.U) && B.roll) { const d = B.roll * DT; s.roll += d; s.ar += d; }
  else { const tg = TAU * Math.round(s.roll / TAU), e = tg - s.roll, d = clamp(e * 6, -4.5, 4.5) * DT; s.roll += d; s.ar += d; }
  if (inp & K.SH) s.ag += DT;
  if (s.y - s.ay0 > s.ah) s.ah = s.y - s.ay0;
  const h = surfH(sch, s.x, s.z, t + DT);
  if (s.y > h || s.vy > 0) { if (s.at > 6) wipe(s, 'Lost in the air'); return; }
  // landing
  const o = sample(sch, s.x, s.z, t + DT, s.wid, tmpO2), q = o.q;
  hx = fsin(s.yaw); hz = fcos(s.yaw);
  const cosD = (s.vx * hx + s.vz * hz) / hsp;
  const pe2 = Math.abs(wrapA(s.pitch)), re = Math.abs(wrapA(s.roll));
  const fwd = cosD > 0.62, back = cosD < -0.62;
  s.y = h;
  if (!q) return endOk(s, 'The wave faded out');
  if (pe2 > 0.8 || re > 0.85 || !(fwd || back)) return wipe(s, 'Bad landing');
  if (q.b > 0.6 && q.p > 0.1 && q.u > -0.3 * q.wf && q.u < 1.6 * q.wf && B.fam === 'surf' && !B.walk) return wipe(s, 'Landed in the whitewater');
  s.mode = RIDE; s.vy = 0; s.vx *= 0.87; s.vz *= 0.87;
  s.pitch = 0; s.roll = 0;
  s.ev.push({ k: 'land', back: back ? 1 : 0, at: s.at });
  // name the air
  const n180 = Math.round(Math.abs(s.as) / PI), nF = Math.round(Math.abs(s.af) / TAU), nR = Math.round(Math.abs(s.ar) / TAU);
  const hm = 1 + 0.35 * (s.at < 3 ? s.at : 3);
  if (s.at < 0.28 && n180 === 0 && nF === 0 && nR === 0) return;            // just a hop
  let name;
  if (B.fam === 'body') name = nR >= 1 ? (n180 >= 2 ? 'ARS' : 'El rollo') : nF >= 1 ? (nF >= 2 ? 'Double backflip' : 'Backflip') : s.apm > 1.3 ? 'Invert' : n180 >= 2 ? 'Air 360' : 'Air';
  else if (nF >= 1) name = n180 >= 1 ? 'Rodeo flip' : nF >= 2 ? 'Double backflip' : 'Backflip';
  else if (s.apm > 1.3) name = 'Invert';
  else if (n180 >= 4) name = 'Air 720';
  else if (n180 === 3) name = 'Air 540';
  else if (n180 === 2) name = s.as * s.vx < 0 ? 'Air 360' : 'Alley-oop';
  else if (n180 === 1) name = 'Air reverse';
  else name = 'Air';
  award(s, name, q, hm);
  if (s.ag >= 0.25) award(s, 'Grab', q);
}
function wipeStep(s, sch, inp, t) {
  const o = sample(sch, s.x, s.z, t, -1, tmpO);
  s.wt -= DT;
  s.vx *= 1 - 1.6 * DT; s.vz += (o.flow * 0.8 - s.vz) * 1.6 * DT;
  s.x += s.vx * DT; s.z += s.vz * DT;
  s.y = o.h - 1.1 * clamp(s.wt / 0.6, 0, 1);
  const cz = coastZ(sch.spot, s.x) - 3; if (s.z > cz) { s.z = cz; if (s.vz > 0) s.vz = 0; }
  if (s.wt <= 0) { s.mode = PADDLE; s.y = o.h; s.vx = 0; s.vz = 0; s.vy = 0; s.wid = -1; s.pitch = 0; s.roll = 0; s.sph = 0; s.dk = 0; s.dcd = 0; s.wash = 0; s.idle = 0; s.ev.push({ k: 'up' }); }
}
/* ---- tow-in: the jet ski drags you onto the face of the next wave ---- */
function towStep(s, sch, inp, t) {
  s.twt += DT;
  if (press(s, inp, K.T) || s.twt > 75) { s.mode = PADDLE; s.tw = 0; s.vx *= 0.3; s.vz *= 0.3; s.ev.push({ k: 'untow' }); return; }
  let w = s.twid >= 0 ? waveById(sch, t, s.twid) : null;
  if (!w || t - w.tB > 6) { w = nextWave(sch, t); s.twid = w ? w.id : -1; s.tw = 1; }
  const o = sample(sch, s.x, s.z, t, s.twid, tmpO), q = o.q;
  let tx, tz, spd;
  if (!w || !q) { tx = s.x; tz = s.z; spd = 0; }
  else if (s.tw === 1) {
    tx = w.xPk + w.dir * 7; tz = -12; spd = 7;
    if (q.u > -16 && q.u < -1) s.tw = 2;
  } else {
    tx = s.x + w.dir * 8; tz = s.z + 6; spd = w.c + 3.2;
    if (q.u < -0.6 * q.wb && q.tau > 2) s.tw = 1;
  }
  let dx = tx - s.x, dz = tz - s.z; const dl = Math.sqrt(dx * dx + dz * dz);
  if (dl < 2 && s.tw === 1) spd = 1.2;
  if (dl > 1e-6) { dx /= dl; dz /= dl; } else { dx = 0; dz = 1; }
  s.vx += (dx * spd - s.vx) * 1.6 * DT; s.vz += (dz * spd - s.vz) * 1.6 * DT;
  const sp = Math.sqrt(s.vx * s.vx + s.vz * s.vz);
  if (sp > 0.6) { const hx = fsin(s.yaw), hz = fcos(s.yaw), sinD = (s.vx * hz - s.vz * hx) / sp; s.yaw += clamp(sinD * 4, -2.5, 2.5) * DT; }
  s.x += s.vx * DT; s.z += s.vz * DT;
  s.y = o.h; s.vy = 0;
  // let go of the rope on the face of the wave
  if (s.tw === 2 && q && q.on && q.u > 0.1 * q.wf && q.u < 0.8 * q.wf && q.b < 0.5 && s.vz > q.c * 0.9) {
    resetRide(s); s.mode = RIDE; s.pop = 0; s.wid = q.id; s.tw = 0; s.ldp = 0;
    s.ev.push({ k: 'catch', tow: 1 });
  }
}

/* ---------------- records: a ride is checked by playing it again ---------------- */
function rle(arr) { const out = []; for (const v of arr) { if (out.length && out[out.length - 2] === v && out[out.length - 1] < 1e6) out[out.length - 1]++; else out.push(v, 1); } return out; }
function unrle(pairs, max) {
  if (!Array.isArray(pairs) || pairs.length % 2) return null;
  const out = []; for (let i = 0; i < pairs.length; i += 2) { const v = pairs[i] | 0, n = pairs[i + 1] | 0; if (n <= 0 || v < 0 || v > 1023 || out.length + n > max) return null; for (let k = 0; k < n; k++) out.push(v); }
  return out;
}
const MAX_RECORD = 60 * 200;
// play a record from its start: the result is what the server saves
function replay(sch, start, inputs) {
  const s = checkStart(start); if (!s) return null;
  let rode = false;
  for (let i = 0; i < inputs.length; i++) {
    step(s, sch, inputs[i]);
    if (s.mode === RIDE || s.mode === AIR) rode = true;
    if (s.res && rode) return { s, res: s.res, ticks: i + 1 };
  }
  return { s, res: null, ticks: inputs.length };
}

return {
  VERSION, DT, G, PI, TAU, SEG, FIRST, WB, FRONT, fsin, fcos, fexp, clamp, sstep, wrapA, hash,
  SPOTS, SIZES, coastZ, CUSTOM_DEFAULT, cleanCustom, waveConfig, makeSchedule, wavesAt, waveById, nextWave, peelT, frontP, backP, waveCore, flowOf, baseH, surfH, sample,
  BOARDS, BOARD_IDS, MOVES, PADDLE, RIDE, AIR, WIPE, TOW, K, newSurfer, checkStart, step, rle, unrle, replay, MAX_RECORD,
};
});
