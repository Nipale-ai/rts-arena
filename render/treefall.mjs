// Trees that are chopped: a wobble at every axe hit, a fall when the wood of the tile runs out, a stump that stays. Pure maths, no three.js and no clock
// of its own: every pose is a function of the time that the caller passes in (output time of the broadcast render, wall clock of the page), of the hit times
// and of hashes of the tile and tree numbers. Nothing here uses Math.random.
//
// What a viewer can know: the tile of an axe hit (hit), the snapshot that says "the wood of this tile is gone" (tg), the tick of every snapshot.
// A viewer that starts late, or a parallel render chunk, sees old fells in its first snapshots: those are stumps at once (fellKind), never a replayed fall.
// Angles in radians, times in seconds.
import { rnd, jumped, JUMP_TICKS } from './herdpose.mjs';
export { rnd, jumped, JUMP_TICKS };

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- wobble: the tree shakes where the axe bites
export const HIT = { amp: 0.075, hz: 3.2, decay: 3.4, dur: 1.4, limit: 0.13 }; // peak tilt (rad), rocking frequency at scale 1, decay (1/s), s until it is over, clamp of several hits
// tilt (rad, signed) `age` seconds after one hit. A tall tree rocks slower (scale s = size of the tree); k = share of the blow it takes
export function wobbleAt(age, s = 1, k = 1) {
  if (!(age >= 0) || age >= HIT.dur) return 0;
  const w = TAU * HIT.hz / Math.sqrt(Math.max(0.4, s));
  return HIT.amp * k * Math.exp(-HIT.decay * age) * Math.sin(w * age);
}
// sum over the last hits (hit times, any order); a few blows in a row add up but stay below HIT.limit
export function wobbleSum(hits, t, s = 1, k = 1, delay = 0) {
  let a = 0;
  for (const h of hits) a += wobbleAt(t - h - delay, s, k);
  return clamp(a, -HIT.limit, HIT.limit);
}
export const hitsLeft = (hits, t) => hits.some((h) => t - h < HIT.dur); // still moving?

// ---------------------------------------------------------------- fall: creak, drop with gravity, rebound, lie, sink
export const FALL = { creak: 0.7, drop: 1.0, rebound: 0.5, lie: 1.0, sink: 0.9 };
export const FALL_TOTAL = FALL.creak + FALL.drop + FALL.rebound + FALL.lie + FALL.sink;
export const IMPACT = FALL.creak + FALL.drop; // the thud
export const LAY = 1.42; // rad: a fallen tree lies almost flat (the crown rests on the ground)
export const LEAN = 0.09; // rad: how far it has leaned when it starts to fall
export const MAX_DELAY = 0.35; // s: trees of one tile do not go all at once
export function newFall() { return { phase: 'stand', tilt: 0, shiver: 0, sink: 0, scale: 1, done: false }; }
// o: tilt (rad about the foot, towards the fall direction), shiver (small sideways quiver while it creaks), sink 0..1 (into the ground), scale (1 .. 0 at the end)
export function fallPose(age, o = newFall()) {
  o.shiver = 0; o.sink = 0; o.scale = 1; o.done = false;
  if (!(age > 0)) { o.phase = 'stand'; o.tilt = 0; return o; }
  if (age < FALL.creak) { // it gives a little, shivers and leans over
    const u = age / FALL.creak;
    o.phase = 'creak'; o.tilt = LEAN * u * u * (3 - 2 * u);
    o.shiver = 0.013 * Math.sin(age * 41) * Math.min(1, age / 0.15) * (1 - 0.4 * u);
    return o;
  }
  const a1 = age - FALL.creak;
  if (a1 < FALL.drop) { // gravity: slow at first, fast at the end
    const u = a1 / FALL.drop;
    o.phase = 'drop'; o.tilt = LEAN + (LAY - LEAN) * Math.pow(u, 2.2);
    return o;
  }
  const a2 = a1 - FALL.drop;
  if (a2 < FALL.rebound) { // hits the ground, lifts a little, settles
    const lift = a2 < 0.3 ? 0.1 * Math.sin(Math.PI * (a2 / 0.3)) : 0.03 * Math.sin(Math.PI * ((a2 - 0.3) / 0.2));
    o.phase = 'rebound'; o.tilt = LAY - lift;
    return o;
  }
  const a3 = a2 - FALL.rebound;
  o.tilt = LAY;
  if (a3 < FALL.lie) { o.phase = 'lie'; return o; }
  const a4 = a3 - FALL.lie;
  if (a4 < FALL.sink) { // sinks into the ground and shrinks
    const u = a4 / FALL.sink;
    o.phase = 'sink'; o.sink = smooth(u); o.scale = 1 - smooth((u - 0.25) / 0.75);
    return o;
  }
  o.phase = 'gone'; o.sink = 1; o.scale = 0; o.done = true;
  return o;
}
// heading of the fall (renderer yaw: direction = (sin yaw, cos yaw)). away = heading from the woodcutter to the tree (null: unknown) -> it falls away from him, a little
// off by a hash; otherwise the heading comes from the hash of the tile and the tree
export function fallYaw(tile, q, away = null) {
  const r = rnd(tile * 7 + 3, q, 21);
  return away == null ? r * TAU : away + (r - 0.5) * 0.7;
}
export const fallDelay = (tile, q) => rnd(tile * 7 + 3, q, 22) * MAX_DELAY;
// heading from a woodcutter at (wx, wz) to a tree at (x, z)
export const awayFrom = (wx, wz, x, z) => (Math.hypot(x - wx, z - wz) < 1e-6 ? null : Math.atan2(x - wx, z - wz));

// ---------------------------------------------------------------- what a viewer makes of a "wood gone" message
export const MEMORY = 2.4; // s: a woodcutter seen at work this long ago (or less) near the tile made the tree fall
// 'fall': the viewer has seen the work that ended it; 'stump': it fell before the viewer looked (late join, parallel render chunk, a cut) or nobody was seen at it.
// jump: the game time jumped with this snapshot (jumped()); since: seconds since a woodcutter was last seen at work on or next to the tile (null = never)
export function fellKind(jump, since) {
  if (jump || since == null || !(since <= MEMORY)) return 'stump';
  return 'fall';
}

// ---------------------------------------------------------------- stump
// trunkR = radius of the trunk at the foot (model units at scale 1), s = tree scale -> size of the stump in tiles
export function stumpOf(trunkR, s, tile, q) {
  const r = clamp(trunkR * s * 1.1, 0.07, 0.42);
  return { r, h: clamp(0.16 + 0.55 * r + 0.07 * rnd(tile * 7 + 3, q, 23), 0.14, 0.42), ry: rnd(tile * 7 + 3, q, 24) * TAU, tone: 0.82 + 0.3 * rnd(tile * 7 + 3, q, 25) };
}
