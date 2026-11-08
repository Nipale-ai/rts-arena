// 'mid' shots of the story show must not cut an army through its outline (P10 checker, 05.11.: "army cut at the frame edge", 402 s, 432 s, 577 s).
// The camera looks for a centre and a distance (up to SHOW_FRAME.maxD) at which the group it stays with lies whole in the free part of the picture and the other group lies whole in it
// or wholly outside the frame. Node only, no Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Director, SHOW_FRAME, SHOW_MID } from '../tools/camera.mjs';

const mk = () => new Director({ size: 128, starts: [{ tx: 18, ty: 18 }, { tx: 106, ty: 106 }], aspect: 1.05, scenes: [{ id: 1, start: 0, end: 100, kind: 'first_contact', title: 'x', focus: { x: 60, y: 60, spread: 8 } }], timeline: { duration_s: 100, outAt: (t) => t, tickAt: (o) => o * 10 }, events: [] });
const units = (a, b) => [...a.map(([x, z], i) => [100 + i, 1, 1, x, z, 100, 4, 0, 0, 0]), ...b.map(([x, z], i) => [200 + i, 2, 1, x, z, 100, 4, 0, 0, 0])];
const part = () => ({ o0: 0, o1: 10, cam: { k: 'mid', a: { t: 'army', o: 1 }, b: { t: 'army', o: 2 }, side: 1, wide: true, weighted: true } });
const grid = (x0, z0, nx, nz, step) => Array.from({ length: nx * nz }, (_, i) => [x0 + (i % nx) * step, z0 + Math.floor(i / nx) * step]);
const ring = (g, r) => Array.from({ length: 12 }, (_, i) => [g[0] + Math.cos(i * Math.PI / 6) * r, g[1] + Math.sin(i * Math.PI / 6) * r]);

test('ndcOf: the looked-at point lies in the middle of the picture, a point nearer the camera lies lower', () => {
  const d = mk(), az = d.L, [c, near] = d.ndcOf(60, 60, 40, 26, az, [[60, 60], [60 + Math.sin(az) * 5, 60 + Math.cos(az) * 5]]);
  assert.ok(Math.abs(c[0]) < 1e-9 && Math.abs(c[1]) < 1e-9);
  assert.ok(near[1] < -0.05, `y ${near[1]}`);
});

test('two armies side by side: after the framing neither outline is cut by the picture edge', () => {
  const a = grid(54, 54, 5, 5, 1.6), b = grid(66, 62, 4, 3, 1.6); // a: 25 units, b: 12 units, about 12 tiles apart
  const dir = mk(), s = dir.showShot({ units: units(a, b), buildings: [] }, part(), 'k', 1);
  assert.ok(s.dist <= SHOW_FRAME.maxD + 1e-9, `dist ${s.dist}`);
  const az = dir.L + (s.o || 0) * Math.PI / 180, ga = [58.2, 58.2], gb = [68.4, 63.6];
  for (const [g, r] of [[ga, 4.5], [gb, 3.6]]) {
    const q = dir.ndcOf(s.x, s.z, s.dist, s.elev, az, ring(g, r));
    const inside = q.every((p) => Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1), outside = q.every((p) => Math.abs(p[0]) > 1 || Math.abs(p[1]) > 1);
    assert.ok(inside || outside, `an outline is cut by the frame: ${JSON.stringify(q.map((p) => p.map((v) => +v.toFixed(2))))}`);
  }
});

test('strays of the other side (fewer than minN units) do not pull the camera: same shot as before', () => {
  const a = grid(30, 30, 4, 3, 1.5), strays = [[60, 60], [61, 61]];
  const s = mk().showShot({ units: units(a, strays), buildings: [] }, part(), 'k', 1);
  assert.ok(s.dist <= SHOW_MID.cap + 1e-9, `dist ${s.dist}: without a second army the framing search is not used`);
  assert.ok(Math.hypot(s.x - 31, s.z - 31) < 14, `target ${s.x},${s.z} stays on the army`);
});
