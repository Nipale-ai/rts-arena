import test from 'node:test';
import assert from 'node:assert/strict';
import { Pacer } from '../server/clock.mjs';

test('pacer: ticks come from the clock, late callers catch up, no drift', () => {
  let t = 0;
  const p = new Pacer({ now: () => t });
  let total = 0;
  // irregular, late timer calls: 50 ms nominal, sometimes 400 ms late
  for (let i = 0; i < 6000; i++) { t += i % 50 === 0 ? 450 : 50 + (i % 7) * 3; total += p.take(1); }
  assert.ok(Math.abs(total - Math.floor((t / 1000) * 10)) <= 1, `${total} vs ${(t / 1000) * 10}`);
  assert.equal(p.dropped, 0);
});

test('pacer: speed change, pause (hold) and a huge stall', () => {
  let t = 0;
  const p = new Pacer({ now: () => t });
  t += 1000; assert.equal(p.take(1), 10);
  t += 1000; assert.equal(p.take(4), 0, 'a speed change rebases: nothing is due at that moment');
  t += 1000; assert.equal(p.take(4), 40);
  p.hold(); t += 5000; p.hold(); assert.equal(p.take(4), 0);
  t += 600000; const n = p.take(4);
  assert.equal(n, 50, 'burst capped at 5 s of game time');
  assert.ok(p.dropped > 1000);
});
