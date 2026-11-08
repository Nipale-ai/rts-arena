import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../sim/game.mjs';
import { stepN } from '../test-support/helpers.mjs';

function stack(rules, n = 12) {
  const g = new Game({ seed: 4, rules });
  const W = g.W;
  const spots = [[23500, 23500], [W * 1000 - 23500, W * 1000 - 23500]]; // point mirrored
  for (let k = 0; k < n; k++) for (const pid of [1, 2]) g.addUnit(pid, 'spearman', spots[pid - 1][0], spots[pid - 1][1]);
  return g;
}
const soldiers = (g, pid) => [...g.units.values()].filter((u) => u.owner === pid && u.type === 'spearman');

test('separation: a stack of idle units settles apart smoothly, never jumps', () => {
  const g = stack('fast');
  let maxStep = 0;
  const last = new Map(soldiers(g, 1).map((u) => [u.id, [u.x, u.y]]));
  for (let t = 0; t < 120; t++) {
    g.step();
    for (const u of soldiers(g, 1)) { const l = last.get(u.id); maxStep = Math.max(maxStep, Math.hypot(u.x - l[0], u.y - l[1])); last.set(u.id, [u.x, u.y]); }
  }
  assert.ok(maxStep <= 30, `max step ${maxStep} milli per tick`);
  const us = soldiers(g, 1);
  let minD = Infinity;
  for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) minD = Math.min(minD, Math.hypot(us[i].x - us[j].x, us[i].y - us[j].y));
  assert.ok(minD >= 380, `closest pair ${minD} milli`);
  // settled: next 20 ticks hardly move
  const before = us.map((u) => [u.x, u.y]);
  stepN(g, 20);
  const moved = Math.max(...us.map((u, i) => Math.hypot(u.x - before[i][0], u.y - before[i][1])));
  assert.ok(moved < 60, `still moving ${moved}`);
});

test('separation: the mirrored seat settles into the exact mirror image', () => {
  const g = stack('fast');
  stepN(g, 150);
  const W = g.W * 1000, a = soldiers(g, 1), b = soldiers(g, 2);
  const A = a.map((u) => [u.x, u.y]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const B = b.map((u) => [W - u.x, W - u.y]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  assert.deepEqual(A, B);
});

test('separation is off in classic (old replays stay valid)', () => {
  const g = stack('classic', 6);
  stepN(g, 30);
  assert.ok(soldiers(g, 1).every((u) => u.x === 23500 && u.y === 23500));
});
