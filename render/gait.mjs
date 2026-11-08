// Gait of the rigged riders: which clip plays, how far one cycle of it carries the horse (no foot sliding) and when the hooves hit the ground.
// Pure and clock-free (no THREE, no DOM, no Math.random): render/anim.mjs (the animation) and render/audio-core.mjs (the hoof sounds) run
// the same model over the same snapshot stream, so a hoof sound falls on the frame in which the hoof lands. The phase is not a clock: it is the
// distance walked divided by the stride of the clip, so the legs always follow the ground speed.
import { variant } from './variants.mjs';

export const TICK_HZ = 10; // sim ticks per second (sim/util.mjs; the render folder cannot import the sim, test/gait.test.mjs keeps both equal)

// Per game unit: `walk` / `run` = how far one cycle of that clip carries the rider, in model units at ground contact (the hoof tracks of the baked clips,
// tools/gait-probe.mjs measures them and test/gait.test.mjs keeps them honest). World stride = model stride * scale of the unit on screen.
// The 'walk' clip of this rig is a diagonal-pair gait (two beats per cycle), the 'run' clip a gallop (one strong beat per cycle, all four legs land together).
// `mul` = unitMul of render/units3d.mjs.
export const GAITS = {
  light_cavalry: { key: 'reiter', walk: 1.28, run: 2.81, mul: 1, heavy: false },
  heavy_cavalry: { key: 'schwere-reiterei', walk: 1.4, run: 3.11, mul: 1, heavy: true },
  scout: { key: 'kundschafter', walk: 0.96, run: 2.18, mul: 1.4, heavy: false },
};
export const WALK = 0, GALLOP = 1;
export const CLIP = ['walk', 'run'];
// Ground contacts as fractions of one clip cycle: [phase, loudness, dust puff]. Measured on the hoof tracks (frame / clip length):
// walk clip: the diagonal pairs land at frames 6.5 and 18.2 of 24 (front a little ahead of the hind leg); run clip: hind legs about frame 6.3-7.7 of 20,
// front legs 7.8-9 (the strong beat), and a soft touch near frame 18.5.
export const BEATS = [
  [[0.265, 1, 1], [0.287, 0.7, 0], [0.76, 1, 1], [0.783, 0.7, 0]],
  [[0.31, 0.8, 0], [0.345, 0.9, 1], [0.39, 1, 0], [0.93, 0.4, 1]],
];
// A rider gallops when one run cycle per second is within reach: cadence = speed / run stride (cycles per second); hysteresis against flicker.
export const RUN_UP = 0.66, RUN_DOWN = 0.5;
export const MIN_SPEED = 0.4; // tiles per second: slower than this the horse stands (separation shuffles make no hoof sound)
export const BLEND_S = 0.22; // cross-fade between the two clips (seconds, render only)
const MAX_STEP = 0.5; // cycles one step may advance (a teleport must not spin the legs)

// Scale of a rigged rider on screen without the per-unit variant: UNIT_SCALE (anim.mjs) * 0.95 (cavalry) * RIG_K (app.mjs) * unitMul.
// The page passes its own function (the same numbers, also with ?variants=0); the sound tools use this one.
export const RIDER_BASE = 1.5 * 0.95 * 1.15;
export const riderScale = (name, id) => RIDER_BASE * GAITS[name].mul * variant(id).s;

const fract = (v) => v - Math.floor(v);
// start phases of a unit (cycles), from its id: the same in the animation and in the sound director
export const startWalk = (id) => fract(((id * 0.37) % 6.28) / 6.28);
export const startRun = (id) => fract(id * 0.618034);
export const newState = (id) => ({ gait: WALK, pw: startWalk(id), pr: startRun(id), from: 0 });

export const strideOf = (name, gait, scale) => GAITS[name][CLIP[gait]] * scale;
// gait for a ground speed (tiles / s), `prev` = the gait so far (hysteresis); a standing horse keeps its gait
export function pickGait(name, speed, scale, prev) {
  if (speed < MIN_SPEED) return prev;
  const cad = speed / strideOf(name, GALLOP, scale);
  return prev === GALLOP ? (cad > RUN_DOWN ? GALLOP : WALK) : (cad >= RUN_UP ? GALLOP : WALK);
}
// walk `dist` tiles: both clip phases advance by their own stride (so a cross-fade between the clips stays on the ground).
// Returns the cycles the phase of the current gait advanced (0..MAX_STEP); `g.from` = that phase before the step.
export function advance(g, name, scale, dist) {
  const w = Math.min(dist / strideOf(name, WALK, scale), MAX_STEP), r = Math.min(dist / strideOf(name, GALLOP, scale), MAX_STEP);
  g.from = g.gait === GALLOP ? g.pr : g.pw;
  g.pw = fract(g.pw + w); g.pr = fract(g.pr + r);
  return g.gait === GALLOP ? r : w;
}
// ground contacts passed while the phase of `gait` went from `from` (0..1) by `cycles`: fn(fraction of the step 0..1, loudness, dust puff, index of the beat in the cycle), in time order
export function beatsIn(gait, from, cycles, fn) {
  if (cycles <= 0) return;
  const list = BEATS[gait], to = from + cycles;
  for (let k = Math.floor(from); k <= Math.floor(to); k++) for (let j = 0; j < list.length; j++) {
    const at = k + list[j][0];
    if (at > from && at <= to) fn((at - from) / cycles, list[j][1], list[j][2], j);
  }
}
