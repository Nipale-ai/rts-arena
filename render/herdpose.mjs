// Deer at a herd node: grazing, the bolt when it is hunted, the carcass. Pure maths, no three.js and no clock of its own: every pose is a
// function of the node seed, the time that the caller passes in and (for the bolt) the time the hunt began, so two viewers see the same deer.
// Angles in radians. A pose is {x, z, yaw (renderer heading: forward = (sin yaw, cos yaw)), y (body lift, model units), pitch (nose up),
// roll (about the long axis), n1 n2 hd (neck, upper neck, head: + raises the head), nr (neck tilt to one flank), hy (head turn), leg[8] (hip, knee per leg:
// front left, front right, hind left, hind right; + swings forward / the knee bends with -), splay[4] (leg out to the side)}.
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const wrap = (a) => { a %= TAU; return a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a; };
const lerpAng = (a, b, t) => a + wrap(b - a) * t;
const fract = (v) => v - Math.floor(v);

export const WALK_V = 0.55, WALK_STRIDE = 0.55; // tiles per second, tiles per leg cycle
export const RUN_V = 5.2, RUN_STRIDE = 2.4;
export const HUNT = { react: 0.3, accel: 0.35, fall: 0.75, settle: 1.1, slide: 1.0 }; // seconds; slide = tiles the body skids after the legs give way
export const ALERT_R = 4.2, HUNTER_R = 2.2; // tiles: the deer looks at a unit this close; a worker this close that works on the node is the hunter
export const LIE_Y = -0.235; // body centre of a deer lying on its flank (model units, standing = 0): half the body width above the ground

// stable pseudo random number in [0,1) from the node seed and two small integers
export function rnd(seed, a = 0, b = 0) {
  let h = (seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export const herdSeed = (tx, ty) => (Math.imul(tx + 1, 73856093) ^ Math.imul(ty + 1, 19349663)) >>> 0;

export function newPose() {
  return { x: 0, z: 0, yaw: 0, y: 0, pitch: 0, roll: 0, n1: 0, n2: 0, hd: 0, nr: 0, hy: 0, leg: new Float32Array(8), splay: new Float32Array(4), amp: 0, ph: 0, speed: 0 };
}
const copyPose = (a, b) => { for (const k of ['x', 'z', 'yaw', 'y', 'pitch', 'roll', 'n1', 'n2', 'hd', 'nr', 'hy', 'amp', 'ph', 'speed']) b[k] = a[k]; b.leg.set(a.leg); b.splay.set(a.splay); return b; };
// head carried low (d = 1: nose in the grass) .. 0: neutral, alert .. negative: raised
export function setHead(p, d) { p.n1 = -1.15 * d; p.n2 = -0.65 * d; p.hd = -0.45 * d; return p; }

// ---------------------------------------------------------------- alive: graze, look up, walk a few steps
// R = how far from the node centre the deer may wander (tiles; 0 = it stays on the spot)
export function makeGraze(seed, cx, cz, R) {
  return { seed, cx, cz, R, L: 11 + 6 * rnd(seed, 1), off: rnd(seed, 2), tg: 6.5 + 3.5 * rnd(seed, 3), tgOff: rnd(seed, 4), ph0: rnd(seed, 5) * TAU };
}
const spotOf = (g, k) => {
  if (g.R < 0.05) return [g.cx, g.cz];
  const a = TAU * rnd(g.seed, k, 10), r = g.R * Math.sqrt(rnd(g.seed, k, 11));
  return [g.cx + Math.sin(a) * r, g.cz + Math.cos(a) * r];
};
const headingOf = (g, k) => { // direction of the walk from spot k to spot k+1 (a turn on the spot when they are close)
  const A = spotOf(g, k), B = spotOf(g, k + 1), dx = B[0] - A[0], dz = B[1] - A[1];
  return Math.hypot(dx, dz) < 0.15 ? TAU * rnd(g.seed, k, 12) : Math.atan2(dx, dz);
};
// walking legs: lateral sequence (hind left, front left, hind right, front right a quarter cycle apart)
function walkLegs(o, amp, ph) {
  const set = (i, psi) => { o.leg[i * 2] = 0.3 * amp * Math.sin(psi); o.leg[i * 2 + 1] = -0.65 * amp * Math.max(0, Math.cos(psi)); };
  set(2, ph); set(0, ph + 0.25 * TAU); set(3, ph + 0.5 * TAU); set(1, ph + 0.75 * TAU);
}
// look = {a: 0..1 how much it has noticed a unit, bx, bz: vector to that unit} or null
export function grazeAt(g, t, look = null, o = newPose()) {
  const q = t / g.L + g.off, k = Math.floor(q), u = (q - k) * g.L; // k = cycle, u = seconds into it
  const A = spotOf(g, k), B = spotOf(g, k + 1), dx = B[0] - A[0], dz = B[1] - A[1], dist = Math.hypot(dx, dz);
  const W = dist < 0.15 ? 1 : Math.min(dist / WALK_V + 0.8, g.L * 0.45); // the cycle ends with the turn and the walk to the next spot
  const tw = g.L - W;
  const turn = smooth((u - tw) / 0.7), env = smooth(u / 1) * (1 - smooth((u - tw) / 0.5));
  let yaw = lerpAng(headingOf(g, k - 1), headingOf(g, k), turn) + 0.14 * Math.sin(t * 0.43 + g.ph0) * env;
  const wd = Math.max(W - 0.3, 0.3), p = clamp((u - tw - 0.3) / wd, 0, 1), s = smooth(p);
  o.x = A[0] + dx * s; o.z = A[1] + dz * s;
  o.speed = (dist / wd) * 6 * p * (1 - p);
  o.amp = clamp(o.speed / WALK_V, 0, 1.3);
  o.ph = g.ph0 + (TAU * dist * s) / WALK_STRIDE;
  // head: down in the grass for most of the rhythm, up to look around for a moment; low while it walks
  const gu = fract(t / g.tg + g.tgOff);
  const dg = smooth((gu - 0.1) / 0.12) * (1 - smooth((gu - 0.84) / 0.12));
  const wb = u < tw ? 1 - smooth(u / 0.8) : smooth((u - tw) / 0.4);
  let d = dg + (0.3 - dg) * wb + 0.05 * Math.sin(t * 4.6 + g.ph0) * dg * (1 - wb);
  o.hy = Math.sin(t * 0.9 + g.ph0) * 0.55 * (1 - dg) * (1 - wb);
  if (look && look.a > 0) { // a unit comes near: head up, turn toward it
    const a = look.a;
    d = d * (1 - a) - 0.12 * a; o.hy *= 1 - a;
    yaw = lerpAng(yaw, Math.atan2(look.bx, look.bz), 0.8 * a * a);
  }
  o.yaw = yaw;
  setHead(o, d);
  o.nr = 0; o.roll = 0; o.splay.fill(0); o.leg.fill(0);
  o.pitch = -0.07 * d;
  o.y = 0.006 * o.amp * Math.sin(2 * o.ph);
  walkLegs(o, o.amp, o.ph);
  return o;
}

// ---------------------------------------------------------------- the hunt
// state of the deer from the time the hunt began (null = not hunted): alive, react (it has noticed), run, fall, settle (twitching), carcass
export function phaseAt(plan, u) {
  if (!plan) return 'alive';
  if (u < 0) return 'alive';
  if (u < HUNT.react) return 'react';
  if (u < HUNT.react + plan.tRun) return 'run';
  if (u < HUNT.react + plan.tRun + HUNT.fall) return 'fall';
  if (u < plan.total) return 'settle';
  return 'carcass';
}

const cr = (p0, p1, p2, p3, t) => 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
// the run path: a loop that starts away from the hunter and bends back to the node, then the body skids the last tiles to the node centre
function loopPoints(from, N, f, sg, k) {
  const sx = -f[1] * sg, sz = f[0] * sg;
  const at = (a, b) => [N[0] + (f[0] * a + sx * b) * k, N[1] + (f[1] * a + sz * b) * k];
  const p1 = at(1.9, 0), p2 = at(3.1, 0.7), p3 = at(2.8, 2.0), p4 = at(1.2, 2.5);
  const dx = N[0] - p4[0], dz = N[1] - p4[1], dd = Math.hypot(dx, dz) || 1;
  const sl = Math.min(HUNT.slide, dd * 0.5);
  const Q = [N[0] - (dx / dd) * sl, N[1] - (dz / dd) * sl];
  return [[from.x, from.z], p1, p2, p3, p4, Q];
}
function sampleSpline(P) {
  const pts = [P[0][0], P[0][1]];
  const n = P.length, ext = [[2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]], ...P, [2 * P[n - 1][0] - P[n - 2][0], 2 * P[n - 1][1] - P[n - 2][1]]];
  for (let i = 1; i < ext.length - 2; i++) for (let j = 1; j <= 10; j++) { const t = j / 10; pts.push(cr(ext[i - 1][0], ext[i][0], ext[i + 1][0], ext[i + 2][0], t), cr(ext[i - 1][1], ext[i][1], ext[i + 1][1], ext[i + 2][1], t)); }
  return pts;
}
function polyLen(pts) {
  const len = new Float32Array(pts.length / 2);
  for (let i = 1; i < len.length; i++) len[i] = len[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  return len;
}
// from: the pose on screen when the hunt began; hunter: {x, z} of the unit it runs from (or null); free(x, z): may a deer stand there (or null: everywhere)
export function planHunt(g, from, hunter, free = null) {
  const N = [g.cx, g.cz];
  let fx, fz;
  if (hunter && Math.hypot(from.x - hunter.x, from.z - hunter.z) > 0.05) { fx = from.x - hunter.x; fz = from.z - hunter.z; } else { const a = TAU * rnd(g.seed, 99); fx = Math.sin(a); fz = Math.cos(a); }
  const fl = Math.hypot(fx, fz) || 1, f = [fx / fl, fz / fl];
  const sg0 = rnd(g.seed, 98) < 0.5 ? 1 : -1;
  const side = sg0 * (rnd(g.seed, 97) < 0.5 ? 1 : -1); // which flank it falls on
  let pts = null;
  const tries = [[sg0, 0.85], [-sg0, 0.85], [sg0, 0.6], [-sg0, 0.6], [sg0, 0.35], [-sg0, 0.35]];
  for (const [sg, k] of tries) {
    const P = loopPoints(from, N, f, sg, k), s = sampleSpline(P);
    let ok = true;
    if (free) for (let i = 0; i < s.length; i += 2) if (!free(s[i], s[i + 1])) { ok = false; break; }
    if (ok) { pts = s; break; }
  }
  if (!pts) { // boxed in: a short dash straight to the node
    const dx = N[0] - from.x, dz = N[1] - from.z, dd = Math.hypot(dx, dz), sl = Math.min(HUNT.slide, dd);
    pts = dd > 0.05 ? [from.x, from.z, from.x + (dx / dd) * (dd - sl), from.z + (dz / dd) * (dd - sl)] : [from.x, from.z];
  }
  const len = polyLen(pts), n = len.length, L = len[n - 1];
  const Q = [pts[n * 2 - 2], pts[n * 2 - 1]], sx = N[0] - Q[0], sz = N[1] - Q[1], sd = Math.hypot(sx, sz);
  const acc = HUNT.accel, tRun = L <= (RUN_V * acc) / 2 ? Math.sqrt((2 * L * acc) / RUN_V) : acc / 2 + L / RUN_V;
  const plan = { g, side, from: copyPose(from, newPose()), pts, len, L, tRun, slide: sd, sdx: sd > 1e-6 ? sx / sd : 0, sdz: sd > 1e-6 ? sz / sd : 0, total: HUNT.react + tRun + HUNT.fall + HUNT.settle };
  plan.yawEnd = pathHeading(plan, L, from.yaw);
  plan.tFall = HUNT.react + tRun; // the legs give way
  plan.tCry = plan.tFall + 0.15;
  plan.tThud = plan.tFall + 0.45; // the body hits the ground
  return plan;
}
function pathAt(plan, s, out) { // position at arc length s
  const { pts, len } = plan, n = len.length;
  if (s <= 0 || n < 2) { out.x = pts[0]; out.z = pts[1]; return out; }
  if (s >= len[n - 1]) { out.x = pts[n * 2 - 2]; out.z = pts[n * 2 - 1]; return out; }
  let i = 1; while (i < n - 1 && len[i] < s) i++;
  const w = (s - len[i - 1]) / ((len[i] - len[i - 1]) || 1);
  out.x = pts[i * 2 - 2] + (pts[i * 2] - pts[i * 2 - 2]) * w; out.z = pts[i * 2 - 1] + (pts[i * 2 + 1] - pts[i * 2 - 1]) * w;
  return out;
}
const _a = { x: 0, z: 0 }, _b = { x: 0, z: 0 };
function pathHeading(plan, s, dflt) { // direction of travel, looking a little ahead so the turns are smooth
  if (plan.len.length < 2) return dflt;
  pathAt(plan, s - 0.1, _a); pathAt(plan, s + 0.45, _b);
  const dx = _b.x - _a.x, dz = _b.z - _a.z;
  return Math.hypot(dx, dz) < 1e-4 ? dflt : Math.atan2(dx, dz);
}
// final pose on the ground: on its flank, legs bent, neck laid out; small differences per deer
function lying(plan, o) {
  const sd = plan.side, r = (i) => (rnd(plan.g.seed, i, 40) - 0.5) * 0.2;
  o.roll = sd * (1.42 + r(0) * 0.5); o.pitch = 0.04 + r(1) * 0.3; o.y = LIE_Y;
  o.n1 = -0.3 + r(2); o.n2 = -0.2 + r(3); o.hd = -0.35 + r(4); o.nr = sd * (0.5 + r(5)); o.hy = sd * (0.25 + r(6));
  const hip = [0.55 + r(7), 0.3 + r(8), -0.15 + r(9), -0.35 + r(10)], knee = [-0.85 + r(11), -0.6 + r(12), -0.55 + r(13), -0.75 + r(14)];
  for (let i = 0; i < 4; i++) { o.leg[i * 2] = hip[i]; o.leg[i * 2 + 1] = knee[i]; o.splay[i] = -sd * (0.45 + r(15 + i) * 0.5); }
  o.amp = 0; o.speed = 0;
  return o;
}
const mixPose = (a, b, w, o) => { // blend all joint angles of two poses (x, z, yaw stay as set by the caller)
  for (const k of ['y', 'pitch', 'roll', 'n1', 'n2', 'hd', 'nr', 'hy']) o[k] = a[k] + (b[k] - a[k]) * w;
  for (let i = 0; i < 8; i++) o.leg[i] = a.leg[i] + (b.leg[i] - a.leg[i]) * w;
  for (let i = 0; i < 4; i++) o.splay[i] = a.splay[i] + (b.splay[i] - a.splay[i]) * w;
  return o;
};
// gallop: front legs reach, hind legs push, the body rocks and leaves the ground
function gallop(o, amp, ph) {
  const L = o.leg, set = (i, psi, A, B) => { L[i * 2] = A * amp * Math.sin(psi) + 0.1 * amp; L[i * 2 + 1] = -B * amp * Math.max(0, Math.cos(psi)); };
  set(0, ph, 0.8, 1.2); set(1, ph + 0.3, 0.8, 1.2); set(2, ph + 0.62 * TAU, 0.75, 1.0); set(3, ph + 0.62 * TAU + 0.3, 0.75, 1.0);
  o.pitch = 0.11 * amp * Math.sin(ph + 1.2);
  o.y = 0.07 * amp * Math.max(0, Math.sin(ph + 0.4));
}
const _g = newPose(), _l = newPose(), _p = { x: 0, z: 0 };
// pose u seconds after the hunt began (u >= 0)
export function huntAt(plan, u, o = newPose()) {
  const F = plan.from, ph = phaseAt(plan, u), side = plan.side;
  o.x = F.x; o.z = F.z; o.yaw = F.yaw; o.splay.fill(0); o.leg.fill(0); o.roll = 0; o.nr = 0; o.pitch = 0; o.y = 0; o.amp = 0; o.speed = 0; o.ph = F.ph;
  const h0 = plan.len.length > 1 ? pathHeading(plan, 0.3, F.yaw) : F.yaw;
  if (ph === 'alive' || ph === 'react') {
    const w = smooth(u / 0.12), e = smooth(u / HUNT.react);
    o.yaw = lerpAng(F.yaw, h0, smooth(u / 0.24));
    setHead(o, 0); o.n1 = F.n1 + (0.2 - F.n1) * w; o.n2 = F.n2 + (0.1 - F.n2) * w; o.hd = F.hd + (0.1 - F.hd) * w;
    o.hy = F.hy * (1 - w);
    o.y = -0.03 * Math.sin(Math.PI * clamp(u / 0.2, 0, 1)); o.pitch = 0.1 * e; // crouch, then spring
    o.leg[0] = o.leg[2] = 0.35 * e; o.leg[1] = o.leg[3] = 0.25 * e;
    return o;
  }
  const tr = u - HUNT.react;
  const runPose = (s, v, out) => { // out = gallop pose at arc length s and speed v
    pathAt(plan, s, _p); out.x = _p.x; out.z = _p.z;
    out.yaw = pathHeading(plan, s, F.yaw);
    out.speed = v; out.amp = smooth(v / RUN_V) * 1; out.ph = (TAU * s) / RUN_STRIDE;
    out.leg.fill(0); out.splay.fill(0);
    gallop(out, out.amp, out.ph);
    out.roll = clamp(wrap(pathHeading(plan, s + 0.6, out.yaw) - pathHeading(plan, s - 0.1, out.yaw)) * 0.28, -0.3, 0.3); // lean into the turn
    setHead(out, 0.15); out.hy = 0; out.nr = 0;
    return out;
  };
  const runS = (t) => { const a = HUNT.accel; return clamp(t < a ? (RUN_V * t * t) / (2 * a) : (RUN_V * a) / 2 + RUN_V * (t - a), 0, plan.L); };
  if (ph === 'run') {
    const v = tr < HUNT.accel ? RUN_V * (tr / HUNT.accel) : RUN_V;
    runPose(runS(tr), v, o);
    // the first strides blend out of the startle crouch
    return o;
  }
  // the legs give way: the body skids on to the node centre and falls onto its flank
  const tf = u - HUNT.react - plan.tRun, Ff = HUNT.fall;
  const vEnd = plan.tRun > 0 ? RUN_V * (plan.tRun < HUNT.accel ? plan.tRun / HUNT.accel : 1) : 0;
  runPose(plan.L, vEnd, _g);
  lying(plan, _l);
  const k = clamp(tf / Ff, 0, 1);
  const ex = 1 - (1 - k) * (1 - k); // skid: fast, then stop
  o.x = _g.x + plan.sdx * plan.slide * ex; o.z = _g.z + plan.sdz * plan.slide * ex;
  o.yaw = plan.yawEnd + side * 0.5 * smooth(k * 1.3);
  o.ph = _g.ph;
  const wl = smooth(k * 1.15); // roll onto the flank, legs go limp
  mixPose(_g, _l, wl, o);
  o.amp = 0; o.speed = 0;
  // front first: the nose dips, then the hind end follows; one bounce when it lands
  o.pitch += -0.35 * Math.sin(Math.PI * clamp(k * 1.6, 0, 1)) * (1 - wl);
  o.y = _g.y + (LIE_Y - _g.y) * smooth((k - 0.1) / 0.9) + 0.05 * Math.sin(Math.PI * clamp((k - 0.55) / 0.45, 0, 1)) * 0.8;
  if (ph === 'fall') return o;
  // settle: the last kicks die away
  const ts = u - HUNT.react - plan.tRun - Ff, e = Math.exp(-ts * 3) * (1 - smooth(ts / HUNT.settle));
  lying(plan, o);
  o.x = _g.x + plan.sdx * plan.slide; o.z = _g.z + plan.sdz * plan.slide; o.yaw = plan.yawEnd + side * 0.5;
  for (let i = 0; i < 4; i++) { o.leg[i * 2] += 0.35 * e * Math.sin(ts * 21 + i * 1.7); o.leg[i * 2 + 1] += 0.3 * e * Math.max(0, Math.sin(ts * 21 + i * 1.7 + 1)); }
  o.hd += 0.1 * e * Math.sin(ts * 14); o.n1 += 0.05 * e * Math.sin(ts * 11);
  o.roll += side * 0.06 * e * Math.sin(ts * 9);
  return o;
}
// a carcass that was there before we looked (late join, replay): the final pose of a hunt that never moved
export function carcassPose(g, hunter = null, o = newPose()) {
  const plan = planHunt(g, { ...newPose(), x: g.cx, z: g.cz, yaw: TAU * rnd(g.seed, 7) }, hunter, null);
  return huntAt(plan, plan.total + 1, o);
}
// what is left of the carcass: it shrinks and sinks into the ground as the food is eaten (frac = amount left / full amount)
export const carcassScale = (frac) => 0.55 + 0.45 * clamp(frac, 0, 1);
export const carcassSink = (frac) => 0.09 * (1 - clamp(frac, 0, 1)); // model units
// ---------------------------------------------------------------- what a viewer makes of the node amounts it sees
// A viewer cannot tell when a node was hunted, only that its amount is below full. The first amount it sees after it starts (or after the game time jumped, e.g.
// a cut or a parallel render chunk) is a baseline: an eaten deer lies at once, no bolt. Only a drop it sees happen starts the hunt. So chunked = serial.
export const JUMP_TICKS = 60; // snapshots this far apart (or going back) are a jump in game time
export const jumped = (prev, tick) => prev == null || tick < prev || tick - prev > JUMP_TICKS;
// mode of the deer, known = it has seen an amount since the start / the last jump, frac = amount left / full amount -> 'carcass' (lie at once), 'hunt', or 'none'
export function amountSeen(mode, known, frac) {
  if (mode !== 'alive' || frac >= 0.999) return 'none';
  return known ? 'hunt' : 'carcass';
}
// how much the deer has noticed a unit at distance d (tiles)
export const alertOf = (d) => smooth((ALERT_R - d) / 1.7);
