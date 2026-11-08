// The "mid" shot of the story show, second part (Partie 9 check 04.11.): a big army stays whole in the picture (outline not cut), the army stands clear of the HUD cards
// (portrait x preset: cards on the left), and a following target does not fly off when the biggest group of its selection flips for a few frames. Node only, no Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Director, SHOW_MID } from '../tools/camera.mjs';

const mk = (aspect = 0.8) => new Director({ size: 128, starts: [{ tx: 18, ty: 18 }, { tx: 106, ty: 106 }], aspect, scenes: [{ id: 1, start: 0, end: 100, kind: 'first_contact', title: 'x', focus: { x: 60, y: 60, spread: 8 } }], timeline: { duration_s: 100, outAt: (t) => t, tickAt: (o) => o * 10 }, events: [] });
const rowsOf = (pts, owner, id0) => pts.map(([x, z], i) => [id0 + i, owner, 1, x, z, 100, 4, 0, 0, 0]);
const ring = (cx, cz, r, n) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos(i * 6.2832 / n), cz + r * Math.sin(i * 6.2832 / n)]);
const part = (extra = {}) => ({ o0: 0, o1: 10, cam: { k: 'mid', a: { t: 'army', o: 1 }, b: { t: 'army', o: 2 }, side: 1, wide: true, ...extra } });

test('SHOW_MID: cap, fit and slew are set; cap reaches the old minimum of the wide view', () => {
  assert.ok(SHOW_MID.cap >= SHOW_MID.far && SHOW_MID.cap <= 60);
  assert.ok(SHOW_MID.fit > 0.1 && SHOW_MID.fit < 0.4);
  assert.ok(SHOW_MID.slew >= 8 && SHOW_MID.slew <= 40);
});

test('a big army (radius about 11) far from the enemy: the distance grows to fit it, never beyond the cap', () => {
  const big = ring(40, 40, 11, 60), small = ring(40, 40, 3, 8);
  const sBig = mk().showShot({ units: [...rowsOf(big, 1, 100), ...rowsOf([[110, 110], [111, 110]], 2, 300)], buildings: [] }, part(), 'k', 1);
  const sSmall = mk().showShot({ units: [...rowsOf(small, 1, 100), ...rowsOf([[110, 110], [111, 110]], 2, 300)], buildings: [] }, part(), 'k', 1);
  assert.equal(sSmall.dist, SHOW_MID.focus);
  assert.ok(sBig.dist > SHOW_MID.focus && sBig.dist <= SHOW_MID.cap, `dist ${sBig.dist}`);
});

test('portrait: the target lies to the left of the army, landscape: to the right (the cards of the x preset stand on the left)', () => {
  const snap = { units: [...rowsOf(ring(40, 40, 3, 8), 1, 100), ...rowsOf([[110, 110], [111, 110]], 2, 300)], buildings: [] };
  const side = (s, d) => { const a = d.L + 10 * Math.PI / 180; return (s.x - 40) * Math.cos(a) - (s.z - 40) * Math.sin(a); };
  const dp = mk(0.8), dl = mk(1.78);
  const sp = dp.showShot(snap, part(), 'k', 1), sl = dl.showShot(snap, part(), 'k', 1);
  assert.ok(side(sp, dp) < 0 && side(sl, dl) > 0, `portrait ${side(sp, dp).toFixed(2)}, landscape ${side(sl, dl).toFixed(2)}`);
});

test('a following target moves at most SHOW_MID.slew tiles per second', () => {
  const d = mk();
  const pt = part({ b: { t: 'army', o: 1 } });
  const s1 = d.showShot({ units: rowsOf(ring(40, 40, 2, 8), 1, 100), buildings: [] }, pt, 'k', 1.0);
  const s2 = d.showShot({ units: rowsOf(ring(90, 40, 2, 8), 1, 100), buildings: [] }, pt, 'k', 1.1);
  assert.ok(Math.hypot(s2.x - s1.x, s2.z - s1.z) <= SHOW_MID.slew * 0.1 + 1e-6, `moved ${Math.hypot(s2.x - s1.x, s2.z - s1.z).toFixed(2)}`);
  const s3 = d.showShot({ units: rowsOf(ring(90, 40, 2, 8), 1, 100), buildings: [] }, pt, 'k', 6.0);
  assert.ok(Math.hypot(s3.x - 90, s3.z - 40) < 8, 'after enough time the camera is at the new group');
});
