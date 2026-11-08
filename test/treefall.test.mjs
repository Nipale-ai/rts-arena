// Chopped trees: wobble at every axe hit, fall when the wood runs out, stump stays (render/treefall.mjs: pure maths; render/chopped.mjs: applies it to the forest).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../render/vendor/three.module.js';
import { HIT, FALL, FALL_TOTAL, IMPACT, LAY, LEAN, MEMORY, MAX_DELAY, wobbleAt, wobbleSum, hitsLeft, fallPose, fallYaw, fallDelay, awayFrom, fellKind, stumpOf, jumped, JUMP_TICKS } from '../render/treefall.mjs';
import { Chopped } from '../render/chopped.mjs';
import { SoundDirector } from '../render/audio-core.mjs';

// ---------------------------------------------------------------- pure maths
test('wobble: nothing before the hit or after it is over, a push first, then it rocks and dies away', () => {
  assert.equal(wobbleAt(-0.1), 0); assert.equal(wobbleAt(HIT.dur), 0); assert.equal(wobbleAt(HIT.dur + 5), 0); assert.equal(wobbleAt(NaN), 0);
  assert.equal(wobbleAt(0), 0);
  assert.ok(wobbleAt(0.07) > 0.05, 'the first swing goes one way: ' + wobbleAt(0.07));
  let peak = [0, 0, 0]; // peaks of the three swings after the hit
  for (let i = 0; i <= 1400; i++) { const a = i / 1000, v = Math.abs(wobbleAt(a)); const k = Math.min(2, Math.floor(a / 0.3)); peak[k] = Math.max(peak[k], v); }
  assert.ok(peak[0] > peak[1] && peak[1] > peak[2], 'dies away ' + peak);
  for (let i = 0; i <= 1400; i++) assert.ok(Math.abs(wobbleAt(i / 1000)) <= HIT.amp + 1e-12);
  assert.ok(Math.abs(wobbleAt(0.05, 1.5)) > 0 && wobbleAt(0.1, 1, 0.5) === 0.5 * wobbleAt(0.1, 1, 1), 'a share of the blow scales it');
  assert.notEqual(wobbleAt(0.2, 1), wobbleAt(0.2, 2), 'a tall tree rocks slower');
});
test('wobble: blows in a row add up, never beyond the limit; the end of the shaking is exact', () => {
  const hits = [0, 0.05, 0.1, 0.15, 0.2];
  for (let i = 0; i < 400; i++) assert.ok(Math.abs(wobbleSum(hits, i / 100)) <= HIT.limit + 1e-12);
  assert.equal(wobbleSum([1], 0.5), 0, 'a hit that has not happened yet');
  assert.ok(hitsLeft([10], 10.5) && !hitsLeft([10], 10 + HIT.dur));
  assert.equal(wobbleSum([10], 10 + HIT.dur + 1), 0);
  assert.equal(wobbleSum([], 3), 0);
  assert.ok(Math.abs(wobbleSum([5], 5.2, 1, 1, 0.04) - wobbleAt(0.16)) < 1e-12, 'delay: the neighbours of the tree start a moment later');
});
test('fall: creak, then gravity (slow, then fast), a thud at the end of the drop, a small rebound, it lies, it sinks and is gone', () => {
  const p = fallPose(0); assert.equal(p.phase, 'stand'); assert.equal(p.tilt, 0);
  assert.equal(fallPose(-3).phase, 'stand');
  let last = -1;
  for (let a = 0; a <= IMPACT; a += 0.01) { const t = fallPose(a).tilt; assert.ok(t >= last - 1e-12, 'tilt only grows until the thud: ' + a); last = t; }
  assert.ok(Math.abs(fallPose(IMPACT).tilt - LAY) < 1e-9, 'lies at LAY when the thud comes');
  assert.ok(Math.abs(fallPose(FALL.creak).tilt - LEAN) < 1e-9, 'creak ends where the drop begins');
  assert.equal(fallPose(0.3).phase, 'creak'); assert.ok(fallPose(0.3).shiver !== 0);
  assert.equal(fallPose(FALL.creak + 0.5).phase, 'drop');
  const v1 = fallPose(FALL.creak + 0.2).tilt - fallPose(FALL.creak + 0.1).tilt, v2 = fallPose(IMPACT - 0.1).tilt - fallPose(IMPACT - 0.2).tilt;
  assert.ok(v2 > 4 * v1, 'it speeds up: ' + v1 + ' -> ' + v2);
  for (let a = IMPACT; a < IMPACT + FALL.rebound; a += 0.01) { const t = fallPose(a).tilt; assert.ok(t <= LAY + 1e-12 && t > LAY - 0.11, 'rebound is small: ' + t); }
  const lie = fallPose(IMPACT + FALL.rebound + 0.2); assert.equal(lie.phase, 'lie'); assert.equal(lie.tilt, LAY); assert.equal(lie.sink, 0); assert.equal(lie.scale, 1);
  let sink = -1, scale = 2;
  for (let a = IMPACT + FALL.rebound + FALL.lie; a < FALL_TOTAL; a += 0.01) { const q = fallPose(a); assert.ok(q.sink >= sink && q.scale <= scale && !q.done); sink = q.sink; scale = q.scale; }
  const end = fallPose(FALL_TOTAL); assert.ok(end.done && end.scale === 0 && end.sink === 1);
  assert.ok(fallPose(FALL_TOTAL + 100).done);
  assert.ok(FALL_TOTAL < 6 && IMPACT > 1 && IMPACT < 3, 'a short fall, not a slow one');
});
test('fall: a function of the age only (same age, same pose), no state left in the result object', () => {
  const o = fallPose(1.2), a = { ...o }, b = { ...fallPose(1.2) };
  assert.deepEqual(a, b);
  fallPose(3, o); fallPose(1.2, o); assert.deepEqual({ ...o }, a);
});
test('fall direction and delay: from a hash of tile and tree, or away from the woodcutter; no random numbers', () => {
  for (let tile = 0; tile < 300; tile += 7) for (let q = 0; q < 3; q++) {
    const y = fallYaw(tile, q), d = fallDelay(tile, q);
    assert.equal(y, fallYaw(tile, q)); assert.equal(d, fallDelay(tile, q));
    assert.ok(y >= 0 && y < Math.PI * 2 && d >= 0 && d < MAX_DELAY);
    const away = awayFrom(10, 10, 12, 10); // woodcutter west of the tree: it falls east
    assert.ok(Math.abs(fallYaw(tile, q, away) - away) <= 0.35 + 1e-12);
  }
  assert.ok(new Set(Array.from({ length: 40 }, (_, t) => fallYaw(t, 0).toFixed(3))).size > 30, 'directions differ from tile to tile');
  assert.equal(awayFrom(5, 5, 5, 5), null);
  assert.ok(Math.abs(awayFrom(0, 0, 0, 3)) < 1e-12 && Math.abs(awayFrom(0, 0, 3, 0) - Math.PI / 2) < 1e-12);
});
test('baseline: a fell the viewer did not see happen is a stump at once; a fell after work it saw is a fall', () => {
  assert.equal(fellKind(false, 0.4), 'fall'); assert.equal(fellKind(false, MEMORY), 'fall');
  assert.equal(fellKind(false, MEMORY + 0.01), 'stump', 'the woodcutter was seen long ago');
  assert.equal(fellKind(false, null), 'stump', 'nobody was seen at it (late join, parallel render chunk)');
  assert.equal(fellKind(true, 0.1), 'stump', 'a jump in game time: baseline');
  assert.ok(jumped(null, 0) && jumped(500, 100) && jumped(100, 100 + JUMP_TICKS + 1) && !jumped(100, 105));
});
test('stump: size follows the trunk and the tree, within limits; a hash decides the rest', () => {
  for (const [r, s] of [[0.05, 1.1], [0.15, 1.3], [0.4, 1.55], [0.01, 1]]) {
    const d = stumpOf(r, s, 123, 1);
    assert.ok(d.r >= 0.07 && d.r <= 0.42 && d.h >= 0.14 && d.h <= 0.42 && d.tone > 0.8 && d.tone < 1.2);
    assert.deepEqual(d, stumpOf(r, s, 123, 1));
  }
  assert.ok(stumpOf(0.3, 1.5, 9, 0).r > stumpOf(0.1, 1.5, 9, 0).r);
});

// ---------------------------------------------------------------- the forest side, with a stand-in for the scatter (no GPU)
const SIZE = 30;
function forest(tiles = [[10, 10]], per = 3, pack = { peek: () => null }) { // trees on the given tiles
  const alive = [], mats = [], setQ = [], items = [], index = new Map();
  const f = { pos: new Float32Array(tiles.length * per * 3), boxR: 1.1, setQ(i, x, y, z, q, s) { mats[i] = { x, y, z, q: q.clone(), s }; setQ.push(i); }, setAlive(i, on) { alive[i] = on; } };
  let n = 0;
  for (const [tx, ty] of tiles) for (let q = 0; q < per; q++) {
    const i = n++, t = { id: 6, s: 1.2 + 0.1 * q, ry: 0.5 * q, tx, ty };
    f.pos.set([tx + 0.2 + 0.3 * q, 0, ty + 0.3 + 0.2 * q], i * 3); alive[i] = true;
    items.push([f, i, tx + 0.2 + 0.3 * q, ty + 0.3 + 0.2 * q, t]);
    const key = ty * SIZE + tx; if (!index.has(key)) index.set(key, []); index.get(key).push(i);
  }
  const dust = [];
  const scene = { add() {}, remove() {} };
  const c = new Chopped(scene, pack, SIZE, items, index, { dust: (...a) => dust.push(a) });
  return { c, f, alive, mats, setQ, items, index, dust, tile: (tx, ty) => ty * SIZE + tx };
}
const standing = (m, t) => Math.abs(m.q.y - Math.sin(t.ry / 2)) < 1e-9 && Math.abs(m.q.w - Math.cos(t.ry / 2)) < 1e-9 && Math.abs(m.q.x) < 1e-9 && Math.abs(m.q.z) < 1e-9 && m.s === t.s;

test('trees: an axe hit tilts the tree for a moment, then the exact standing matrix is back', () => {
  const w = forest();
  w.c.sync(0);
  w.c.see(10.5, 10.5, 9.4, 10.5, 5); w.c.hit(10.5, 10.5, 5, 9.4, 10.5);
  let moved = 0;
  for (let t = 5; t < 5 + HIT.dur + 0.5; t += 1 / 60) { w.c.see(10.5, 10.5, 9.4, 10.5, t); w.c.frame(t); }
  for (const m of w.mats) if (m) moved++;
  assert.equal(moved, 3, 'the three trees of the tile were all touched');
  assert.ok(w.setQ.length > 60);
  w.c.frame(5 + HIT.dur + 0.6);
  w.items.forEach((it, k) => assert.ok(standing(w.mats[k], it[4]), 'tree ' + k + ' stands again, exactly'));
  assert.equal(w.c.wob.size, 0);
  assert.ok(w.alive.every(Boolean));
});
test('trees: during the wobble the tree that is nearest to the woodcutter moves most, and it leans away from him', () => {
  const w = forest([[10, 10]], 3);
  w.c.see(10.5, 10.5, 8, 10.5, 1); w.c.hit(10.5, 10.5, 1, 8, 10.5);
  w.c.frame(1.07);
  const lean = (k) => { const m = w.mats[k], v = new THREE.Vector3(0, 1, 0).applyQuaternion(m.q); return v; };
  const near = w.items.map((it, k) => [Math.hypot(it[2] - 8, it[3] - 10.5), k]).sort((a, b) => a[0] - b[0])[0][1];
  assert.ok(lean(near).x > 0.03, 'leans east, away from a woodcutter in the west: ' + lean(near).x);
  for (let k = 0; k < 3; k++) if (k !== near) assert.ok(Math.abs(lean(k).x) < Math.abs(lean(near).x) + 1e-9);
});
test('trees: wood gone after the woodcutter was seen -> the trees fall away from him, a stump stays, the thud puffs dust once per tree', () => {
  const w = forest();
  w.c.sync(0);
  for (let t = 0; t < 3; t += 1 / 30) { w.c.see(10.5, 10.5, 9.2, 10.5, t); w.c.frame(t); }
  w.c.sync(30); w.c.fell(w.tile(10, 10)); // the message comes with the next snapshot
  const t0 = 3;
  w.c.frame(t0 + 0.001);
  assert.equal(w.c.falls.length, 3); assert.equal(w.c.n, 3, 'the stump slots are reserved at once'); assert.ok(w.c.stumps.every((s) => s.hidden), 'but a stump stays hidden while its tree stands');
  for (const f of w.c.falls) assert.ok(Math.abs(f.yaw - Math.PI / 2) <= 0.35 + 1e-9, 'falls east: ' + f.yaw);
  assert.equal(w.index.has(w.tile(10, 10)), false);
  let seenTilt = 0;
  for (let t = t0 + 0.001; t < t0 + FALL_TOTAL + MAX_DELAY + 0.2; t += 1 / 60) {
    w.c.see(10.5, 10.5, 9.2, 10.5, t); w.c.frame(t);
    for (let k = 0; k < 3; k++) if (w.mats[k]) { const up = new THREE.Vector3(0, 1, 0).applyQuaternion(w.mats[k].q); seenTilt = Math.max(seenTilt, Math.acos(Math.min(1, up.y))); }
  }
  assert.ok(seenTilt > 1.3, 'they lay down: ' + seenTilt);
  assert.equal(w.c.falls.length, 0); assert.ok(w.alive.every((a) => a === false), 'the trees are gone, the stumps stay');
  assert.ok(w.c.stumps.every((s) => !s.hidden), 'every stump shows at the end');
  assert.equal(w.dust.length, 3);
  const st = w.c.stats(); delete st.sees; assert.deepEqual(st, { falls: 3, stumps: 0, hits: 0, standing: 0, falling: 0, stumpsDrawn: 3 });
});
test('trees: nobody was seen at the tile (or far from it, or long ago) -> stump at once, no fall', () => {
  for (const setup of [(c) => {}, (c) => c.see(15.5, 10.5, 14, 10.5, 2.9), (c) => c.see(11.5, 10.5, 12.5, 10.5, 0)]) {
    const w = forest();
    setup(w.c);
    w.c.sync(5); w.c.sync(10); w.c.fell(w.tile(10, 10));
    w.c.frame(3);
    assert.equal(w.c.falls.length, 0); assert.equal(w.c.n, 3); assert.ok(w.alive.every((a) => a === false));
    assert.equal(w.dust.length, 0);
  }
  // next to the tile (8 neighbours count): falls
  const w = forest(); w.c.see(11.5, 11.5, 12, 12, 2.5); w.c.sync(1); w.c.sync(5); w.c.fell(w.tile(10, 10)); w.c.frame(3);
  assert.equal(w.c.falls.length, 3);
});
test('trees: chunked = serial. A render that starts after the fall shows the same stumps at once, with no fall', () => {
  const trees = [[10, 10], [11, 10]];
  const serial = forest(trees);
  serial.c.sync(0);
  for (let t = 0; t < 4; t += 1 / 30) { serial.c.see(10.5, 10.5, 9.2, 10.5, t); if (Math.abs(t % 0.95) < 1 / 30) serial.c.hit(10.5, 10.5, t, 9.2, 10.5); serial.c.frame(t); if (Math.abs(t - 3) < 1 / 60) { serial.c.sync(30); serial.c.fell(serial.tile(10, 10)); } }
  for (let t = 4; t < 12; t += 1 / 30) serial.c.frame(t); // long after the fall
  // the chunk renders from game time 60 on: its first snapshot lists the tile (a jump), the page knows no woodcutter
  const chunk = forest(trees);
  chunk.c.sync(600); chunk.c.fell(chunk.tile(10, 10));
  chunk.c.frame(10.0);
  assert.equal(chunk.c.falls.length, 0, 'no replayed fall');
  assert.equal(chunk.c.n, 3);
  for (let t = 10; t < 12; t += 1 / 30) chunk.c.frame(t);
  assert.equal(serial.c.n, chunk.c.n);
  assert.deepEqual([...serial.c.body.instanceMatrix.array.slice(0, 3 * 16)], [...chunk.c.body.instanceMatrix.array.slice(0, 3 * 16)], 'same stumps (position, size, turn)');
  assert.deepEqual([...serial.c.body.instanceColor.array.slice(0, 9)], [...chunk.c.body.instanceColor.array.slice(0, 9)]);
  assert.deepEqual(serial.alive, chunk.alive.map((a, k) => a), 'same trees standing');
  // the other tile still stands in both
  assert.ok(serial.index.has(serial.tile(11, 10)) && chunk.index.has(chunk.tile(11, 10)));
});
test('trees: a whole run is deterministic (same calls, same matrices)', () => {
  const run = () => {
    const w = forest(); const out = [];
    w.c.sync(0);
    for (let t = 0; t < 8; t += 1 / 30) {
      w.c.see(10.5, 10.5, 9.2, 10.5, t); if (Math.floor(t * 30) % 28 === 0) w.c.hit(10.5, 10.5, t, 9.2, 10.5);
      if (Math.abs(t - 3) < 1 / 60) { w.c.sync(30); w.c.fell(w.tile(10, 10)); }
      w.c.frame(t);
      out.push(w.mats.map((m) => m && [m.x, m.y, m.z, m.q.x, m.q.y, m.q.z, m.q.w, m.s]));
    }
    return JSON.stringify(out);
  };
  assert.equal(run(), run());
});
test('trees: the clock going back (a cut) forgets what was seen and puts the trees on their feet', () => {
  const w = forest(); w.c.see(10.5, 10.5, 9, 10.5, 1); w.c.hit(10.5, 10.5, 1, 9, 10.5); w.c.frame(1.05);
  assert.ok(w.c.wob.size > 0);
  w.c.frame(0.2);
  assert.equal(w.c.wob.size, 0); assert.equal(w.c.chop.size, 0);
  w.items.forEach((it, k) => assert.ok(standing(w.mats[k], it[4])));
});
test('trees: the clock going back while a tree falls ends the fall as a stump (the tile has left the index for good: it cannot stand up again)', () => {
  const w = forest(); w.c.sync(0);
  for (let t = 0; t < 3; t += 1 / 30) { w.c.see(10.5, 10.5, 9, 10.5, t); w.c.frame(t); }
  w.c.sync(30); w.c.fell(w.tile(10, 10)); w.c.frame(3.05);
  assert.equal(w.c.falls.length, 3); assert.ok(w.c.stumps.every((x) => x.hidden));
  w.c.frame(3.6); w.c.frame(1.0); // a cut: the clock goes back
  assert.equal(w.c.falls.length, 0); assert.ok(w.alive.every((a) => a === false), 'the trees are gone');
  assert.ok(w.c.stumps.length === 3 && w.c.stumps.every((x) => !x.hidden), 'the stumps show');
  assert.equal(w.index.has(w.tile(10, 10)), false);
  w.c.frame(1.1); w.c.frame(5);
  assert.equal(w.c.n, 3, 'nothing new, nothing falls again');
});
test('trees: fells that the init message lists (a viewer who joined late) are stumps at once, whatever is seen later', () => {
  const w = forest([[10, 10], [12, 10]]);
  w.c.see(10.5, 10.5, 9, 10.5, 0); // a woodcutter at work is no reason to let an old fell fall
  w.c.fell(w.tile(10, 10)); w.c.fell(w.tile(12, 10)); // app.mjs: init.fells -> trees.remove, before the first snapshot
  w.c.sync(900); w.c.fell(w.tile(10, 10)); // the first snapshot lists them again (tg flush): no second stump
  w.c.frame(0.1);
  assert.equal(w.c.falls.length, 0); assert.equal(w.c.n, 6); assert.ok(w.alive.every((a) => a === false));
  assert.ok(w.c.stumps.every((x) => !x.hidden));
  w.c.frame(0.2); assert.equal(w.c.n, 6);
});
test('trees: a building on the tile hides the stump, it comes back when the building is gone; chunked = serial', () => {
  const size = (c, n) => { // sum of the column lengths of the stump matrix: 0 when it is not drawn
    const a = c.body.instanceMatrix.array, o = n * 16; return Math.hypot(a[o], a[o + 1], a[o + 2]) + Math.hypot(a[o + 4], a[o + 5], a[o + 6]) + Math.hypot(a[o + 8], a[o + 9], a[o + 10]); };
  const tiles = [[10, 10], [14, 10]];
  const serial = forest(tiles, 1), chunk = forest(tiles, 1);
  serial.c.sync(0);
  for (let t = 0; t < 2; t += 1 / 30) serial.c.frame(t);
  serial.c.sync(30); serial.c.fell(serial.tile(10, 10)); serial.c.fell(serial.tile(14, 10)); serial.c.frame(2.0);
  assert.equal(serial.c.n, 2); assert.ok(size(serial.c, 0) > 0.1 && size(serial.c, 1) > 0.1, 'both stumps show');
  serial.c.cover([[9, 9, 3]]); // a 3x3 building from (9,9): covers tile (10,10)
  assert.equal(size(serial.c, 0), 0, 'the stump under the building is not drawn'); assert.ok(size(serial.c, 1) > 0.1, 'the other one is');
  serial.c.cover([[9, 9, 3]]); assert.equal(size(serial.c, 0), 0);
  // a stump that is made while the building stands starts hidden
  const late = forest([[10, 10]], 1); late.c.sync(0); late.c.cover([[10, 10, 1]]); late.c.fell(late.tile(10, 10)); late.c.sync(5); late.c.frame(1);
  assert.equal(late.c.n, 1); assert.equal(size(late.c, 0), 0);
  // chunk: sees the building and the old fell in its first snapshot: the same picture as the serial render at the end
  chunk.c.sync(600); chunk.c.cover([[9, 9, 3]]); chunk.c.fell(chunk.tile(10, 10)); chunk.c.fell(chunk.tile(14, 10)); chunk.c.frame(10);
  serial.c.frame(12);
  assert.deepEqual([...chunk.c.body.instanceMatrix.array.slice(0, 32)], [...serial.c.body.instanceMatrix.array.slice(0, 32)], 'same stumps hidden and shown');
  // the building is destroyed: the stump is back (in both)
  serial.c.cover([]); chunk.c.cover([]);
  assert.ok(size(serial.c, 0) > 0.1); assert.deepEqual([...chunk.c.body.instanceMatrix.array.slice(0, 32)], [...serial.c.body.instanceMatrix.array.slice(0, 32)]);
  assert.ok(serial.c.top.instanceMatrix.array.slice(0, 16).some((v) => v !== 0), 'the cut top is back as well');
});
test('trees: stumps made before their model is loaded get the real trunk size and colour as soon as it is (live page, first frames); same result as with the model there from the start', () => {
  // a model with a trunk ring of radius 0.3 at the foot (render/chopped.mjs trunkOf: foot vertices below 8% of the height)
  const pos = []; for (let j = 0; j < 8; j++) { const a = (j / 8) * Math.PI * 2; pos.push(Math.sin(a) * 0.3, 0, Math.cos(a) * 0.3, Math.sin(a) * 0.2, 3, Math.cos(a) * 0.2); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const model = { parts: [{ geo, mat: {} }], box: { max: { y: 3 } } };
  const state = { on: false };
  const run = (loadedFromStart) => {
    const st = loadedFromStart ? { on: true } : state; // the page that has to wait for its models, and the one that has them from the start
    const w = forest([[10, 10], [12, 10]], 2, { peek: () => (st.on ? model : null) });
    w.c.sync(900); w.c.fell(w.tile(10, 10)); w.c.fell(w.tile(12, 10)); // the init message lists them: stumps at once, before anything is loaded
    w.c.frame(0.1);
    return w;
  };
  const early = run(false), ref = run(true);
  const radii = (w) => w.c.stumps.map((s) => s.r);
  assert.equal(early.c.n, 4); assert.equal(early.c.fallback.length, 4, 'all four were made with the fallback trunk');
  assert.ok(radii(early).every((r, k) => r < radii(ref)[k]), 'fallback stumps are slimmer than the real ones: ' + radii(early) + ' vs ' + radii(ref));
  early.c.frame(0.2); assert.equal(early.c.fallback.length, 4, 'still not loaded: nothing changes, nothing breaks');
  state.on = true; early.c.frame(0.3);
  assert.equal(early.c.fallback.length, 0);
  assert.deepEqual(radii(early), radii(ref), 'real radii');
  assert.deepEqual([...early.c.body.instanceMatrix.array.slice(0, 64)], [...ref.c.body.instanceMatrix.array.slice(0, 64)], 'same matrices as a page that had the model from the start');
  assert.deepEqual([...early.c.body.instanceColor.array.slice(0, 12)], [...ref.c.body.instanceColor.array.slice(0, 12)], 'same colours');
  assert.equal(ref.c.fallback.length, 0);
  early.c.frame(0.4); assert.deepEqual(radii(early), radii(ref));
});
test('trees: a tile without trees, a tile off the map and a second message do nothing', () => {
  const w = forest();
  w.c.fell(5 * SIZE + 5); w.c.frame(1); assert.equal(w.c.n, 0);
  w.c.hit(-3, 4, 1, 0, 0); w.c.see(99, 99, 0, 0, 1); assert.equal(w.c.chop.size, 0);
  w.c.sync(0); w.c.fell(w.tile(10, 10)); w.c.fell(w.tile(10, 10)); w.c.frame(1);
  w.c.fell(w.tile(10, 10)); w.c.frame(2);
  assert.equal(w.c.n, 3);
});

// ---------------------------------------------------------------- sound
test('audio: a felled tree makes the fall sound where it stood; old news (first snapshot, a jump, a long list) makes none', () => {
  const init = { size: 32, terrain: Array.from({ length: 32 }, () => '.'.repeat(32)), nodes: [], units: ['worker'], buildings: ['house'], buildingDefs: { house: { size: 2 } }, unitDefs: { worker: { cls: 'worker' } } };
  const snap = (t, extra = {}) => ({ t, units: [], buildings: [], dead: [], ev: [], players: [], proj: [], speed: 1, ...extra });
  const d = new SoundDirector(init);
  assert.equal(d.feed(snap(10, { tg: [5 * 32 + 6] })).triggers.filter((x) => x.id === 'tree_falls').length, 0, 'first snapshot');
  const worker = (x, y, act = 2) => [7, 1, 0, x, y, 100, act, 0, 0, 0]; // id, owner, type, x, y, hp, act (2 = gathering), ...
  const nobody = d.feed(snap(12, { tg: [9 * 32 + 9] })).triggers.filter((x) => x.id === 'tree_falls');
  assert.equal(nobody.length, 0, 'nobody at work near the tile: the renderer shows a stump at once, so no fall sound');
  assert.equal(d.feed(snap(13, { units: [worker(20, 20)], tg: [9 * 32 + 9] })).triggers.filter((x) => x.id === 'tree_falls').length, 0, 'a worker far away');
  assert.equal(d.feed(snap(14, { units: [worker(9.5, 9.5, 0)], tg: [9 * 32 + 9] })).triggers.filter((x) => x.id === 'tree_falls').length, 0, 'an idle worker');
  const r = d.feed(snap(15, { units: [worker(5.2, 5.5)], tg: [5 * 32 + 6] })).triggers.filter((x) => x.id === 'tree_falls');
  assert.equal(r.length, 1); assert.equal(r[0].x, 6.5); assert.equal(r[0].y, 5.5);
  assert.equal(d.feed(snap(16, { units: [], tg: [5 * 32 + 7] })).triggers.filter((x) => x.id === 'tree_falls').length, 1, 'the worker was in the snapshot before: still counts');

  assert.equal(d.feed(snap(20, { units: [worker(3, 0.5)], tg: [1, 2, 3, 4, 5] })).triggers.filter((x) => x.id === 'tree_falls').length, 0, 'a long list');
  assert.equal(d.feed(snap(200, { units: [worker(7.5, 0.5)], tg: [7] })).triggers.filter((x) => x.id === 'tree_falls').length, 0, 'a jump in game time');
  assert.equal(d.feed(snap(205)).triggers.filter((x) => x.id === 'tree_falls').length, 0);
});

// ---------------------------------------------------------------- what the server tells about fallen trees
test('server: the first snapshot of a viewer lists every tree that went before it, even between two scan ticks', async () => {
  const { args, Match } = await import('../server/spectate.mjs');
  Object.assign(args, { p1: 'turtle', p2: 'turtle', seed: 3, 'no-record': true });
  const log = console.log; console.log = () => {};
  try {
    const m = new Match(), g = m.game;
    let tile = -1;
    for (let i = 0; i < g.W * g.H; i++) if (m.treeAlive[i]) { tile = i; break; }
    assert.ok(tile >= 0);
    for (let i = 0; i < 7; i++) m.tick();
    assert.notEqual(g.t % 5, 0);
    g.wood[tile] = 0;
    const s = m.snapshot();
    assert.ok(s.tg && s.tg.includes(tile), 'listed in the first snapshot');
    assert.equal(m.snapshot().tg, undefined, 'only once');
  } finally { console.log = log; }
});

test('server: a viewer who joins late gets the earlier fells in the init message (forest tiles again + a list), the same list every time, never in the snapshots', async () => {
  const { args, Match } = await import('../server/spectate.mjs');
  Object.assign(args, { p1: 'turtle', p2: 'turtle', seed: 3, 'no-record': true });
  const log = console.log; console.log = () => {};
  try {
    const m = new Match(), g = m.game;
    assert.equal(m.initMsg().fells, undefined, 'a fresh match has none');
    const tiles = [];
    for (let i = 0; i < g.W * g.H && tiles.length < 3; i++) if (m.treeAlive[i] && g.terrain[i] === 1) tiles.push(i);
    assert.equal(tiles.length, 3);
    for (let i = 0; i < 7; i++) m.tick();
    m.snapshot(); // an earlier viewer: the scan has run
    for (const i of tiles) { g.wood[i] = 0; g.terrain[i] = 0; } // what sim/logic.mjs does when the wood of a tile is gone
    const a = m.initMsg(), b = m.initMsg();
    assert.deepEqual(a.fells, tiles); assert.deepEqual(b.fells, tiles, 'the same list every time');
    for (const i of tiles) assert.equal(a.terrain[Math.floor(i / g.W)][i % g.W], 'f', 'the tile is forest again, the renderer fells it');
    for (let k = 0; k < 12; k++) { m.tick(); const s = m.snapshot(); assert.ok(!('fells' in s)); }
    assert.equal(m.initMsg().fells.length, 3, 'does not grow');
    // later fells are added, once
    let more = -1;
    for (let i = 0; i < g.W * g.H; i++) if (m.treeAlive[i] && g.wood[i] > 0 && g.terrain[i] === 1) { more = i; break; }
    g.wood[more] = 0; g.terrain[more] = 0;
    assert.equal(m.initMsg().fells.length, 4);
  } finally { console.log = log; }
});
// ---------------------------------------------------------------- the drawn forest is thinner than the sim forest: a stand-in tree shows the tile
test('trees: a forest tile without a tree of its own gets the nearest tree as a stand-in; it wobbles at the axe and falls when the tile is gone', () => {
  const w = forest([[10, 10]], 3); // trees near (10..11, 10..11); the tile (12,10) has none
  const empty = w.tile(12, 10);
  w.c.adopt([empty, w.tile(10, 10)]);
  assert.equal(w.c.proxy.size, 1, 'only the empty tile needs a stand-in');
  const k = w.c.proxy.get(empty); assert.ok(k >= 0 && k < 3);
  w.c.sync(0);
  for (let t = 0; t < 3; t += 1 / 30) { w.c.see(12.5, 10.5, 13.5, 10.5, t); if (Math.floor(t * 30) % 28 === 0) w.c.hit(12.5, 10.5, t, 13.5, 10.5); w.c.frame(t); }
  assert.ok(w.c.wob.has(k), 'the stand-in wobbles');
  w.c.sync(30); w.c.fell(empty); w.c.frame(3.05);
  assert.equal(w.c.falls.length, 1, 'one tree falls');
  assert.equal(w.c.falls[0].k, k);
  assert.equal(w.c.proxy.has(empty), false); assert.equal(w.c.gone.has(k), true);
  // the tile of the tree itself still has its other two trees, and the felled one does not come back
  assert.equal(w.c.treesOf(w.tile(10, 10)).length, 2);
  w.c.fell(w.tile(10, 10)); w.c.frame(3.1);
  assert.equal(w.c.falls.length, 1, 'the stand-in is the only one that falls (no cutter at the other tile)');
  assert.equal(w.c.n, 3, 'three trees, three stumps: the stand-in is not made into a stump twice');
  assert.equal(w.c.gone.size, 3);
});
test('trees: a stand-in that is gone is not taken twice; empty tiles in a clearing take different trees first', () => {
  const w = forest([[10, 10]], 3);
  const a = w.tile(12, 10), b = w.tile(12, 11);
  w.c.adopt([a, b]);
  assert.notEqual(w.c.proxy.get(a), w.c.proxy.get(b), 'two empty tiles take two trees');
  w.c.adopt([a, b]); // twice: no change
  assert.equal(w.c.proxy.size, 2);
  const far = w.tile(25, 25); w.c.adopt([far]); assert.equal(w.c.proxy.has(far), false, 'no tree within reach: no stand-in');
});
test('trees: the stump does not depend on which tile triggered it (chunked = serial with a stand-in)', () => {
  const run = (chunk) => {
    const w = forest([[10, 10]], 3), empty = w.tile(12, 10);
    w.c.adopt([empty]);
    if (chunk) { w.c.sync(600); w.c.fell(empty); w.c.frame(10); for (let t = 10; t < 12; t += 1 / 30) w.c.frame(t); }
    else {
      w.c.sync(0);
      for (let t = 0; t < 3; t += 1 / 30) { w.c.see(12.5, 10.5, 13.5, 10.5, t); w.c.frame(t); }
      w.c.sync(30); w.c.fell(empty);
      for (let t = 3; t < 12; t += 1 / 30) w.c.frame(t);
    }
    return w;
  };
  const s = run(false), c = run(true);
  assert.equal(s.c.n, 1); assert.equal(c.c.n, 1);
  assert.equal(c.c.falls.length, 0); assert.equal(s.c.falls.length, 0);
  assert.deepEqual([...s.c.body.instanceMatrix.array.slice(0, 16)], [...c.c.body.instanceMatrix.array.slice(0, 16)], 'same stump (position, size, turn)');
  assert.deepEqual(s.alive, c.alive, 'same trees standing');
});
// ---------------------------------------------------------------- what the server tells about the work of a unit
test('server: a gather row carries what the worker works on (kind and node centre); other rows have 10 numbers', async () => {
  const { args, Match, WORK_KINDS } = await import('../server/spectate.mjs');
  Object.assign(args, { p1: 'turtle', p2: 'turtle', seed: 3, 'no-record': true });
  const log = console.log; console.log = () => {};
  try {
    const m = new Match(), g = m.game;
    for (let i = 0; i < 5; i++) m.tick();
    const u = [...g.units.values()].find((x) => x.type === 'worker' && !x.dead && !x.boarded);
    assert.ok(u);
    const mk = (kind, st, x0, y0, x1, y1) => { u.ord = { t: 'gather', res: 'food', node: { k: 'e', id: 1, cx: 5, cy: 5 }, kind, st, x0, y0, x1, y1 }; return m.snapshot().units.find((r) => r[0] === u.id); };
    for (const [kind, code] of [['berries', 2], ['farm', 4], ['wood', 1]]) {
      const r = mk(kind, 'work', 29500, 19500, 29500, 19500);
      assert.equal(WORK_KINDS.indexOf(kind) + 1, code);
      assert.equal(r.length, 13, kind); assert.equal(r[10], code); assert.equal(r[11], 29.5); assert.equal(r[12], 19.5);
    }
    const r2 = mk('berries', 'go', 0, 0, 0, 0); assert.equal(r2.length, 11); assert.equal(r2[10], 0, 'walking to work: nothing to bend over yet');
    const r3 = mk('berries', 'ret', 0, 0, 0, 0); assert.equal(r3[10], 0);
    u.ord = { t: 'idle' };
    const r4 = m.snapshot().units.find((r) => r[0] === u.id); assert.equal(r4.length, 10, 'no order data: the renderer falls back to its own guess');
  } finally { console.log = log; }
});
// ---------------------------------------------------------------- the stand-in of an empty tile is the tree on the side where the woodcutter stands (plan only, never what he did)
// trees at (10.2, 10.3) and (14.2, 10.3); the tile (12, 10) is empty, its centre is nearer to the east tree. The block x 12..14, y 9..11 is forest: its west edge is open ground.
const BLOCK = (w) => { const t = []; for (let x = 12; x <= 14; x++) for (let y = 9; y <= 11; y++) t.push(w.tile(x, y)); return t; };
test('adopt: an empty tile on the edge of a grove takes the tree on the open side (where the woodcutter walks in), an interior or lone tile the tree nearest to its centre', () => {
  const w = forest([[10, 10], [14, 10]], 1), empty = w.tile(12, 10);
  w.c.adopt(BLOCK(w));
  assert.equal(w.c.proxy.get(empty), 0, 'open ground in the west: the west tree');
  const side = w.c.axeSide(empty, new Set(BLOCK(w)));
  assert.ok(side[0] < -0.8 && Math.abs(side[1]) < 1e-9, 'the axe side points west: ' + side);
  const lone = forest([[10, 10], [14, 10]], 1); lone.c.adopt([empty]);
  assert.equal(lone.c.proxy.get(empty), 1, 'open on all sides: the tree nearest to the centre, as before');
  assert.deepEqual(lone.c.axeSide(empty, new Set([empty])), [0, 0]);
  const east = forest([[10, 10], [14, 10]], 1); // the same block, open to the east instead: x 10..12
  const blockE = []; for (let x = 10; x <= 12; x++) for (let y = 9; y <= 11; y++) blockE.push(east.tile(x, y));
  east.c.adopt(blockE);
  assert.equal(east.c.proxy.get(empty), 1, 'open ground in the east: the east tree');
  assert.equal(w.c.axeSide(w.tile(0, 0), new Set([w.tile(0, 0), w.tile(1, 0), w.tile(0, 1)]))[0] > 0, true, 'the map border counts as forest: open ground is inside');
});
test('trees: chunked = serial for an empty tile with two candidate trees (the stump is on the same tree, the same tree stands)', () => {
  const trees = [[10, 10], [14, 10]];
  for (const open of ['west', 'lone']) {
    const serial = forest(trees, 1), chunk = forest(trees, 1), e = serial.tile(12, 10);
    const tiles = open === 'west' ? BLOCK(serial) : [e];
    serial.c.adopt(tiles); chunk.c.adopt(tiles);
    serial.c.sync(0);
    for (let t = 0; t < 3; t += 1 / 30) { serial.c.see(12.5, 10.5, 11.2, 10.5, t); if (Math.floor(t * 30) % 28 === 0) serial.c.hit(12.5, 10.5, t, 11.2, 10.5); serial.c.frame(t); }
    serial.c.sync(30); serial.c.fell(e); serial.c.frame(3.05);
    assert.equal(serial.c.falls.length, 1, 'serial: the tree falls');
    for (let t = 3.05; t < 12; t += 1 / 30) serial.c.frame(t);
    chunk.c.sync(600); chunk.c.fell(e); chunk.c.frame(10);
    assert.equal(chunk.c.falls.length, 0, 'chunk: stump at once');
    for (let t = 10; t < 12; t += 1 / 30) chunk.c.frame(t);
    assert.deepEqual(serial.c.stumps.map((s) => s.k), chunk.c.stumps.map((s) => s.k), open + ': same stump tree');
    assert.deepEqual(serial.alive, chunk.alive, open + ': same trees standing');
    assert.deepEqual([...serial.c.body.instanceMatrix.array.slice(0, 16)], [...chunk.c.body.instanceMatrix.array.slice(0, 16)], open + ': same stump matrix');
    assert.deepEqual([...serial.c.gone], [...chunk.c.gone]);
  }
});
test('trees: the stand-in that wobbles is the one that falls, wherever the woodcutter stands', () => {
  for (const cutter of [[11.2, 10.5], [13.4, 10.5]]) {
    const w = forest([[10, 10], [14, 10]], 1), empty = w.tile(12, 10);
    w.c.adopt(BLOCK(w)); w.c.sync(0);
    const pick = w.c.proxy.get(empty);
    for (let t = 0; t < 2; t += 1 / 30) { w.c.see(12.5, 10.5, cutter[0], cutter[1], t); if (Math.floor(t * 30) % 28 === 0) w.c.hit(12.5, 10.5, t, cutter[0], cutter[1]); w.c.frame(t); }
    assert.deepEqual([...w.c.wob], [pick], 'only the stand-in takes the blows');
    w.c.sync(30); w.c.fell(empty); w.c.frame(2.05);
    assert.deepEqual(w.c.falls.map((f) => f.k), [pick]);
  }
});
test('adopt: deterministic, and two empty tiles of one clearing take two trees', () => {
  const run = () => { const w = forest([[10, 10], [14, 10]], 2); w.c.adopt(BLOCK(w)); return JSON.stringify([...w.c.proxy]); };
  assert.equal(run(), run());
  const w = forest([[10, 10], [14, 10]], 1); w.c.adopt(BLOCK(w));
  const a = w.c.proxy.get(w.tile(12, 10)), b = w.c.proxy.get(w.tile(12, 11));
  assert.notEqual(a, undefined); assert.notEqual(b, undefined); assert.notEqual(a, b, 'a tree is not taken twice while another is free');
});
