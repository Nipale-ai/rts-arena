// Projectile flight arcs (render/shots.mjs): ballistic shape, same landing time as the straight sim shot, deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Shots, shotKind, launchHeight, arc, hash32, ARROW, STONE, SHELL, BALL } from '../render/shots.mjs';

const flat = () => 0;
// a shot of the sim along +x: speed (hundredths of a tile per second), age in ticks, remaining distance rem
const row = (x, tx, speed, age, splash = 0) => [x, 10, tx, 10, 1, speed, splash, 3, 77, age];

test('shots: kinds', () => {
  assert.equal(shotKind([0, 0, 1, 1, 1, 1400, 0], 'archer'), ARROW);
  assert.equal(shotKind([0, 0, 1, 1, 1, 1400, 0], ''), ARROW);
  assert.equal(shotKind([0, 0, 1, 1, 1, 800, 1], 'catapult'), STONE);
  assert.equal(shotKind([0, 0, 1, 1, 1, 600, 1], 'mortar'), SHELL);
  assert.equal(shotKind([0, 0, 1, 1, 1, 1000, 0], 'war_boat'), BALL);
});

test('shots: arc starts at the bow, ends on the target, rises then falls', () => {
  const a0 = arc(1.3, 0.9, 1, 0, 8), a1 = arc(1.3, 0.9, 1, 1, 8), am = arc(1.3, 0.9, 1, 0.5, 8);
  assert.equal(a0.y, 1.3); assert.ok(Math.abs(a1.y - 0.9) < 1e-9);
  assert.ok(am.y > 1.3 && a0.slope > 0 && a1.slope < 0 && Math.abs(am.slope + 0.4 / 8) < 1e-9);
});

test('shots: the arc grows with the distance and heavy shots fly higher', () => {
  const peakAt = (kind, D) => { const S = new Shots(flat); S.begin(); let best = 0; for (let i = 0; i <= 20; i++) { const P = S.pose([10, 10, 10 + D, 10, 1, 1400, 0, 3, 77, 0], 5, (D / 14) * (i / 20), kind, 1.3); best = Math.max(best, P.y); } return best; };
  assert.ok(peakAt(ARROW, 9) > peakAt(ARROW, 4) * 1.2);
  assert.ok(peakAt(STONE, 9) > peakAt(ARROW, 9) * 1.2);
  assert.ok(peakAt(SHELL, 12) > peakAt(STONE, 9));
});

test('shots: the position on the ground line is the straight sim shot (landing time unchanged)', () => {
  const S = new Shots(flat); S.begin();
  const q = row(11.4, 18, 1400, 1);
  for (const el of [0, 0.1, 0.25, 0.4, 0.6, 1]) {
    const P = S.pose(q, 5, el, ARROW, 1.3);
    assert.ok(Math.abs(P.x - Math.min(18, 11.4 + 14 * el)) < 1e-9); assert.equal(P.z, 10);
  }
  const L = S.pose(q, 5, 5, ARROW, 1.3); // arrived
  assert.ok(Math.abs(L.y - 0.9) < 1e-9 && L.s === 1);
});

test('shots: nose follows the flight path (up at the start, down at the end) and the arrow starts at the shooter', () => {
  const S = new Shots(flat); S.begin();
  const q = row(11.4, 18, 1400, 1); // fired from x = 10
  const a = S.pose(q, 5, 0, ARROW, 1.3), y0 = a.y, d0 = a.dy;
  const b = S.pose(q, 5, 0.46, ARROW, 1.3);
  assert.ok(y0 > 1.3 && y0 < 2.2); // just left the bow, already climbing
  assert.ok(d0 > 0 && b.dy < 0);
  assert.ok(Math.abs(Math.hypot(a.dx, a.dy, a.dz) - 1) < 1e-9);
  assert.ok(Math.abs(S.rec.get(77 * 100003 + 4).ox - 10) < 1e-9);
});

test('shots: deterministic, seeds come from ids, finished shots are forgotten', () => {
  const run = () => { const S = new Shots(flat); S.begin(); return [0, 0.2, 0.4].map((el) => S.pose(row(12, 19, 1400, 2), 9, el, ARROW, 1.3).y); };
  assert.deepEqual(run(), run());
  assert.notEqual(hash32(1, 2), hash32(2, 1));
  const S = new Shots(flat); S.begin(); S.pose(row(12, 19, 1400, 2), 9, 0, ARROW, 1.3); S.end(); assert.equal(S.rec.size, 1);
  S.begin(); S.end(); assert.equal(S.rec.size, 0);
});

test('shots: the arc never dips through the ground', () => {
  const hill = (x) => (x > 14 && x < 15 ? 3 : 0);
  const S = new Shots(hill); S.begin();
  for (let el = 0; el < 0.6; el += 0.05) assert.ok(S.pose(row(11.4, 18, 1400, 1), 5, el, ARROW, 1.3).y >= hill(11.4 + 14 * el) + 0.12 - 1e-9);
});

test('shots: launch height of units and buildings', () => {
  assert.ok(launchHeight('archer') > 1 && launchHeight('mortar') < launchHeight('archer'));
  assert.ok(launchHeight('', 3) > launchHeight('', 1.5));
});
