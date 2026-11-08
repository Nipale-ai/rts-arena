// Deer at a herd node (render/herdpose.mjs): the pure state and pose functions that the renderer drives from the snapshot and a clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HUNT, ALERT_R, LIE_Y, rnd, herdSeed, newPose, makeGraze, grazeAt, phaseAt, planHunt, huntAt, carcassPose, carcassScale, carcassSink, alertOf, amountSeen, jumped, JUMP_TICKS } from '../render/herdpose.mjs';
import { Herd } from '../render/herd.mjs';

const G = makeGraze(herdSeed(40, 22), 41, 23, 1.2);
const finite = (p) => ['x', 'z', 'yaw', 'y', 'pitch', 'roll', 'n1', 'n2', 'hd', 'nr', 'hy'].every((k) => Number.isFinite(p[k])) && [...p.leg, ...p.splay].every(Number.isFinite);

test('seed: stable per node, differs between nodes, rnd in [0,1)', () => {
  assert.equal(herdSeed(3, 4), herdSeed(3, 4));
  assert.notEqual(herdSeed(3, 4), herdSeed(4, 3));
  for (let i = 0; i < 200; i++) { const v = rnd(herdSeed(i, 9), i, 3); assert.ok(v >= 0 && v < 1); }
});

test('graze: same time gives the same pose, stays near the node, no jumps, head goes down and up', () => {
  const a = grazeAt(G, 123.4), b = grazeAt(G, 123.4);
  assert.deepEqual([a.x, a.z, a.yaw, a.n1], [b.x, b.z, b.yaw, b.n1]);
  let px = null, pz = null, lo = 0, hi = 0;
  for (let t = 0; t < 120; t += 0.02) {
    const p = grazeAt(G, t);
    assert.ok(finite(p));
    assert.ok(Math.hypot(p.x - G.cx, p.z - G.cz) <= G.R + 1e-6, 'wanders at most R tiles from the node centre');
    if (px !== null) assert.ok(Math.hypot(p.x - px, p.z - pz) < 0.05, 'no teleport');
    px = p.x; pz = p.z; lo = Math.min(lo, p.n1); hi = Math.max(hi, p.n1);
  }
  assert.ok(lo < -0.9, 'head reaches the grass'); assert.ok(hi > -0.3, 'head comes up again');
});

test('graze: R = 0 keeps the deer on the spot', () => {
  const g = makeGraze(5, 10, 10, 0);
  for (let t = 0; t < 60; t += 0.5) { const p = grazeAt(g, t); assert.equal(p.x, 10); assert.equal(p.z, 10); }
});

test('graze: a unit close by makes the deer look up and turn toward it', () => {
  const calm = grazeAt(G, 20), seen = grazeAt(G, 20, { a: 1, bx: 3, bz: 0 });
  assert.ok(seen.n1 > calm.n1 - 1e-9 && seen.n1 > -0.3, 'head is up');
  assert.ok(Math.abs(Math.sin(seen.yaw) - 1) < Math.abs(Math.sin(calm.yaw) - 1) + 1e-9 || Math.abs(Math.sin(calm.yaw) - 1) < 0.05, 'turns toward +x');
  assert.equal(alertOf(ALERT_R + 1), 0); assert.equal(alertOf(0.5), 1); assert.ok(alertOf(ALERT_R - 0.8) > 0 && alertOf(ALERT_R - 0.8) < 1);
});

const hunter = { x: 38, z: 22 };
const from = grazeAt(G, 50, null, newPose());
const plan = planHunt(G, from, hunter, null);

test('phase: alive -> react -> run -> fall -> settle -> carcass, and alive without a plan', () => {
  assert.equal(phaseAt(null, 5), 'alive'); assert.equal(phaseAt(plan, -1), 'alive');
  const t1 = HUNT.react, t2 = t1 + plan.tRun, t3 = t2 + HUNT.fall;
  assert.equal(phaseAt(plan, 0), 'react'); assert.equal(phaseAt(plan, t1 - 0.01), 'react');
  assert.equal(phaseAt(plan, t1 + 0.01), 'run'); assert.equal(phaseAt(plan, t2 - 0.01), 'run');
  assert.equal(phaseAt(plan, t2 + 0.01), 'fall'); assert.equal(phaseAt(plan, t3 - 0.01), 'fall');
  assert.equal(phaseAt(plan, t3 + 0.01), 'settle'); assert.equal(phaseAt(plan, plan.total - 0.01), 'settle');
  assert.equal(phaseAt(plan, plan.total + 0.01), 'carcass');
});

test('hunt: bolts for 1 to 2 s, whole sequence is short, cry before the thud, both inside the fall', () => {
  assert.ok(plan.tRun > 0.9 && plan.tRun < 2.2, 'run lasts ' + plan.tRun);
  assert.ok(plan.total < 5);
  assert.ok(plan.tFall < plan.tCry && plan.tCry < plan.tThud && plan.tThud < plan.tFall + HUNT.fall);
});

test('hunt: starts exactly where the deer stood, ends exactly at the node centre, always continuous', () => {
  const p0 = huntAt(plan, 0);
  assert.ok(Math.hypot(p0.x - from.x, p0.z - from.z) < 1e-6);
  const end = huntAt(plan, plan.total + 5);
  assert.ok(Math.hypot(end.x - G.cx, end.z - G.cz) < 1e-3, 'carcass lies on the node position');
  let px = p0.x, pz = p0.z;
  for (let u = 0; u < plan.total + 1; u += 0.02) {
    const p = huntAt(plan, u); assert.ok(finite(p), 'finite at ' + u);
    assert.ok(Math.hypot(p.x - px, p.z - pz) < 0.2, 'no jump at ' + u); // 5.2 tiles/s * 0.02 s = 0.1
    px = p.x; pz = p.z;
  }
});

test('hunt: it runs away from the hunter first', () => {
  const p = huntAt(plan, HUNT.react + 0.5);
  assert.ok(Math.hypot(p.x - hunter.x, p.z - hunter.z) > Math.hypot(from.x - hunter.x, from.z - hunter.z));
});

test('hunt: a blocked area is avoided, a boxed-in deer still ends at the node', () => {
  const open = (x, z) => x > G.cx - 0.5; // nothing walkable west of the node
  const p2 = planHunt(G, from, { x: G.cx + 3, z: G.cz }, open);
  for (let i = 2; i < p2.pts.length; i += 2) assert.ok(open(p2.pts[i], p2.pts[i + 1]), 'path stays on walkable ground');
  const end = huntAt(p2, p2.total + 1); assert.ok(Math.hypot(end.x - G.cx, end.z - G.cz) < 1e-3);
  const boxed = planHunt(G, from, hunter, () => false);
  const e2 = huntAt(boxed, boxed.total + 1); assert.ok(finite(e2)); assert.ok(Math.hypot(e2.x - G.cx, e2.z - G.cz) < 1e-3);
});

test('hunt: the same inputs give the same plan (two viewers agree)', () => {
  const a = planHunt(G, from, hunter, null), b = planHunt(G, from, hunter, null);
  assert.equal(a.total, b.total); assert.equal(a.side, b.side);
  const pa = huntAt(a, 1.7), pb = huntAt(b, 1.7);
  assert.deepEqual([pa.x, pa.z, pa.yaw, pa.roll], [pb.x, pb.z, pb.yaw, pb.roll]);
});

test('carcass: lies on its flank on the node, same state as the end of a live hunt', () => {
  const c = carcassPose(G, null);
  assert.ok(finite(c));
  assert.ok(Math.hypot(c.x - G.cx, c.z - G.cz) < 1e-3);
  assert.equal(c.y, LIE_Y);
  assert.ok(Math.abs(c.roll) > 1.2, 'on its side');
  const live = huntAt(plan, plan.total + 3);
  assert.ok(Math.abs(live.roll) > 1.2 && live.y === LIE_Y && live.amp === 0);
});

test('carcass: shrinks and sinks monotonically with the food left', () => {
  let s = Infinity, k = -Infinity;
  for (let f = 1; f >= 0; f -= 0.05) { assert.ok(carcassScale(f) <= s); assert.ok(carcassSink(f) >= k); s = carcassScale(f); k = carcassSink(f); }
  assert.equal(carcassScale(1), 1); assert.equal(carcassSink(1), 0);
  assert.ok(carcassScale(0) > 0.3 && carcassScale(5) === 1 && carcassScale(-2) === carcassScale(0));
});

test('baseline: the first amount a viewer sees is a carcass if reduced, only a drop seen later is a hunt', () => {
  assert.equal(amountSeen('alive', false, 0.4), 'carcass'); // late join, parallel render chunk, cut
  assert.equal(amountSeen('alive', false, 1), 'none');
  assert.equal(amountSeen('alive', true, 0.9), 'hunt');
  assert.equal(amountSeen('alive', true, 1), 'none');
  assert.equal(amountSeen('hunt', true, 0.5), 'none'); assert.equal(amountSeen('carcass', true, 0.5), 'none'); assert.equal(amountSeen('gone', false, 0), 'none');
});

test('baseline: a jump in game time (first snapshot, going back, a long gap) starts it again; normal play does not', () => {
  assert.ok(jumped(null, 0)); assert.ok(jumped(500, 100)); assert.ok(jumped(100, 100 + JUMP_TICKS + 1));
  for (const gap of [0, 1, 2, 20, 21, JUMP_TICKS]) assert.ok(!jumped(100, 100 + gap), 'gap ' + gap);
});

test('chunked = serial: a viewer that starts late sees the same state as one that watched the whole hunt', () => {
  // serial: watched the drop -> hunt, then the bolt is over after plan.total
  const serial = amountSeen('alive', true, 0.9);
  assert.equal(serial, 'hunt');
  // chunk that starts after the hunt: baseline -> carcass, which is what the serial render shows once the plan has run out
  assert.equal(amountSeen('alive', false, 0.9), 'carcass');
  assert.equal(phaseAt(plan, plan.total + 0.01), 'carcass');
});

// Herd without a model (nothing is drawn): the deer state is stepped with a clock, buildings come and go in the terrain occupancy.
function world() {
  const size = 40, rows = Array(size).fill('.'.repeat(size)), occ = new Uint8Array(size * size);
  const pack = { map: { nodes: { herd: { states: [211] } } }, load: async () => null, fit: () => 1 };
  const herd = new Herd(null, pack, [[7, 'herd', 20, 20, 2, 350, 350]], { size, rows, nodes: [[7, 'herd', 20, 20, 2]] });
  herd.setBlockers([], occ);
  return { herd, occ, d: herd.deer.get(7) };
}
const built = (t) => t >= 20 && t < 40; // a building stands next to the node from 20 s to 40 s
function run(w, f0, f1) {
  const out = [];
  for (let f = f0; f <= f1; f++) {
    const t = f / 30;
    w.occ[21 * 40 + 22] = built(t) ? 1 : 0;
    const p = w.herd.step(w.d, t);
    out.push([p.x, p.z, w.d.g.R]);
  }
  return out;
}
test('chunked = serial: a chunk that starts mid-way shows the same deer position every frame, while a building comes and goes', () => {
  const a = world();
  const serial = run(a, 0, 1800);
  const b = world(); b.occ[21 * 40 + 22] = built(30) ? 1 : 0; b.herd.setBlockers([], b.occ); // the chunk starts at 30 s with the building standing
  const chunk = run(b, 900, 1800);
  for (let i = 0; i < chunk.length; i++) for (let k = 0; k < 3; k++) assert.ok(Math.abs(chunk[i][k] - serial[900 + i][k]) < 1e-9, `frame ${900 + i} value ${k}`);
  assert.equal(serial[10 * 30][2], 1.25, 'free before the building');
  assert.equal(serial[35 * 30][2], 0.45, 'tight while it stands');
  assert.equal(serial[50 * 30][2], 1.25, 'the wander area comes back when it is gone (no history)');
});
test('building next to the node: the deer glides, it does not pop', () => {
  const w = world(), pts = run(w, 0, 1800);
  let m = 0;
  for (let i = 1; i < pts.length; i++) m = Math.max(m, Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  assert.ok(m < 0.04, 'largest step per frame ' + m); // a walk is about 0.02 per frame
});
