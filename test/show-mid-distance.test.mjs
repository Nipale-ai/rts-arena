// The wide "mid" shot of the story show (owner feedback on game 9 at 7:27: "ultra pixelated"): units must be readable. The camera holds two groups only while that fits
// within SHOW_MID.far tiles and never stands closer than SHOW_MID.near; further apart it stays with the bigger group at SHOW_MID.focus. Node only, no Chrome.
// Also: --lod0 of tools/render-story.mjs and the lodk parameter of render/scatter.mjs (video only; without the flag nothing changes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Director, SHOW_MID } from '../tools/camera.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mk = () => new Director({ size: 128, starts: [{ tx: 18, ty: 18 }, { tx: 106, ty: 106 }], aspect: 0.8, scenes: [{ id: 1, start: 0, end: 100, kind: 'first_contact', title: 'x', focus: { x: 60, y: 60, spread: 8 } }], timeline: { duration_s: 100, outAt: (t) => t, tickAt: (o) => o * 10 }, events: [] });
const units = (a, b) => [...a.map(([x, z], i) => [100 + i, 1, 1, x, z, 100, 4, 0, 0, 0]), ...b.map(([x, z], i) => [200 + i, 2, 1, x, z, 100, 4, 0, 0, 0])];
const part = (extra = {}) => ({ o0: 0, o1: 10, cam: { k: 'mid', a: { t: 'army', o: 1 }, b: { t: 'army', o: 2 }, side: 1, wide: true, ...extra } });
const shot = (snap, p = part()) => mk().showShot(snap, p, 'k', 1);

test('SHOW_MID: near <= focus <= far', () => {
  assert.ok(SHOW_MID.near >= 20 && SHOW_MID.near <= SHOW_MID.focus && SHOW_MID.focus <= SHOW_MID.far && SHOW_MID.far <= 50);
});

test('two groups close together: both held, distance between near and far', () => {
  const s = shot({ units: units([[60, 60], [61, 61], [60, 62]], [[66, 62], [67, 63], [66, 64]]), buildings: [] });
  assert.ok(s.dist >= SHOW_MID.near && s.dist <= SHOW_MID.far, `dist ${s.dist}`);
});

test('two groups far apart: the camera stays with the bigger group at the focus distance (no 100+ tile views)', () => {
  const big = Array.from({ length: 8 }, (_, i) => [30 + (i % 4), 30 + (i >> 2)]);
  const s = shot({ units: units(big, [[100, 100], [101, 100]]), buildings: [] });
  assert.equal(s.dist, SHOW_MID.focus);
  assert.ok(Math.hypot(s.x - 31.5, s.z - 30.5) < 14, `target ${s.x},${s.z} should be on the bigger group`);
});

test('no mid shot is ever further away than SHOW_MID.far', () => {
  for (const gap of [0, 5, 10, 20, 40, 80]) {
    const s = shot({ units: units([[40, 40], [41, 40]], [[40 + gap, 40], [41 + gap, 40]]), buildings: [] });
    assert.ok(s.dist <= SHOW_MID.far, `gap ${gap}: dist ${s.dist}`);
  }
});

test('--lod0 sets riglod=0 and lodk=8 for the page; the scatter reads lodk; without them nothing changes', () => {
  const story = fs.readFileSync(path.join(ROOT, 'tools/render-story.mjs'), 'utf8');
  assert.match(story, /if \(A\.lod0 && !\/\(\^\|&\)riglod=\/\.test\(process\.env\.RTS_QUERY \|\| ''\)\) process\.env\.RTS_QUERY = \[process\.env\.RTS_QUERY, 'riglod=0', 'lodk=8'\]/);
  const sc = fs.readFileSync(path.join(ROOT, 'render/scatter.mjs'), 'utf8');
  assert.match(sc, /const LODK = typeof location === 'undefined' \? 1 : \(\+new URLSearchParams\(location\.search\)\.get\('lodk'\) \|\| 1\);/);
  assert.match(sc, /this\.dist = \(opts\.dist \|\| \[60, 120\]\)\.map\(\(d\) => d \* LODK\);/);
  const u3 = fs.readFileSync(path.join(ROOT, 'render/units3d.mjs'), 'utf8');
  assert.match(u3, /get\('riglod'\) \?\? -1/);
});
