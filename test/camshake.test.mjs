// Camera shake (render/camshake.mjs): deterministic, decays to zero, weaker far away, switchable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CamShake } from '../render/camshake.mjs';

const mag = (o) => Math.hypot(o.x, o.y, o.z);
test('shake: same events and times give the same offsets; it decays to zero', () => {
  const a = new CamShake(), b = new CamShake();
  for (const s of [a, b]) s.hit(40, 50, 4, 10);
  for (const t of [10.02, 10.3, 10.9, 11.4]) assert.deepEqual(a.offset(t, 40, 50, 60), b.offset(t, 40, 50, 60));
  assert.ok(mag(a.offset(10.1, 40, 50, 60)) > 0.01);
  assert.equal(mag(a.offset(12, 40, 50, 60)), 0);
  assert.equal(mag(a.offset(9, 40, 50, 60)), 0);
});
test('shake: a far away collapse is much quieter than a near one; bigger buildings shake more; off switch', () => {
  const s = new CamShake(); s.hit(40, 50, 4, 5);
  const near = mag(s.offset(5.1, 40, 50, 60)), far = mag(s.offset(5.1, 120, 120, 60));
  assert.ok(far < near * 0.1, `${far} < ${near}`);
  const small = new CamShake(), big = new CamShake(); small.hit(40, 50, 1, 5); big.hit(40, 50, 6, 5);
  assert.ok(mag(big.offset(5.1, 40, 50, 60)) > mag(small.offset(5.1, 40, 50, 60)));
  s.on = false; assert.equal(mag(s.offset(5.1, 40, 50, 60)), 0);
});
test('shake: replaying the same collapse (re-render) does not stack', () => {
  const s = new CamShake(); s.hit(40, 50, 4, 5); const one = mag(s.offset(5.1, 40, 50, 60));
  s.hit(40, 50, 4, 5.2); assert.equal(mag(s.offset(5.1, 40, 50, 60)), one);
});

test("app.mjs: no local variable shadows the camera shake (a collapse threw a TDZ error in the broadcast render)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../render/app.mjs", import.meta.url), "utf8");
  assert.equal((src.match(/\b(const|let|var)\s+shake\b/g) || []).length, 1);
});
