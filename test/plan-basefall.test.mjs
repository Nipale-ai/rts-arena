import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, timelineOf } from '../tools/plan.mjs';
import { TICK_HZ } from '../sim/util.mjs';

// A long match: the base falls late, many higher ranked scenes compete for the time. The fall must not run at 32x (real case: match 5).
const ticks = 10000;
const scene = (id, rank, kind, start, end) => ({ id, rank, kind, start, end, title: kind, focus: null, score: 20 - rank });
const hl = { scenes: [scene(1, 1, 'battle', 1000, 1400), scene(2, 2, 'battle', 3000, 3400), scene(3, 3, 'battle', 5000, 5400), scene(4, 9, 'base_destroyed', 8000, 8400), scene(5, 4, 'victory', 9700, 10000)] };
const ev = { replay: 'x', ticks, events: [] };

test('the highlight cut shows the first seconds of a falling base at 1x', () => {
  const plan = buildPlan(ev, hl, { mode: 'highlight', target_s: [40, 70] });
  const tl = timelineOf(plan);
  assert.ok(tl.duration_s <= 70.5, `cut ${tl.duration_s} s`);
  for (let t = 8000 + 2 * TICK_HZ; t < 8000 + 8 * TICK_HZ; t += TICK_HZ) assert.equal(tl.speedAtOut(tl.outAt(t)), 1, `tick ${t}`);
  assert.ok(plan.selected_scenes.includes(4));
});
