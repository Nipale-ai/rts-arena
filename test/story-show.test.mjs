import fs from 'node:fs';
// "Show what is said": selections of units (the highlights and the camera of the story cut read the same function)
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectUnits, UN, showFog } from '../tools/story-show.mjs';

const W = UN.indexOf('worker'), SP = UN.indexOf('spearman'), RAM = UN.indexOf('ram'), SC = UN.indexOf('scout');
// unit rows of a snapshot: [id, owner, type index, x, z, hp, act]
const snap = { units: [[1, 1, W, 10, 10, 100, 2], [2, 1, SP, 12, 10, 100, 0], [3, 2, RAM, 40, 40, 100, 4], [4, 2, SP, 41, 40, 100, 4], [5, 1, SC, 30, 30, 100, 1]] };

test('selectUnits: army excludes workers and scouts, near and ids narrow the choice', () => {
  assert.deepEqual(selectUnits(snap, { t: 'army', o: 1 }).map((u) => u[0]), [2]);
  assert.deepEqual(selectUnits(snap, { t: 'army', o: 2 }).map((u) => u[0]), [3, 4]);
  assert.deepEqual(selectUnits(snap, { t: 'type', o: 2, ty: 'ram', near: [40, 40, 5] }).map((u) => u[0]), [3]);
  assert.deepEqual(selectUnits(snap, { t: 'type', o: 2, ty: 'ram', near: [10, 10, 5] }), []);
  assert.deepEqual(selectUnits(snap, { ids: [5, 1] }).map((u) => u[0]), [1, 5]);
  assert.deepEqual(selectUnits(snap, { t: 'workers', o: 1 }).map((u) => u[0]), [1]);
  assert.deepEqual(selectUnits(snap, { ids: [] }), []);
});

test('whole map: two lines in a row stay one picture, the game view does not flash up between them', async () => {
  const { Show } = await import('../tools/story-show.mjs');
  const fake = { pre: { insets: {} }, partAt: Show.prototype.partAt, parts: [
    { line: 'L1', o0: 0, o1: 5, clean: true, fog: 1, cam: { k: 'map' } },
    { line: 'L2', o0: 5, o1: 10, clean: true, fog: 2, cam: { k: 'map' } },
    { line: 'L3', o0: 10, o1: 15, cam: { k: 'grp' } },
    { line: 'L4', o0: 15, o1: 20, cam: { k: 'grp' } },
  ] };
  const at = (t) => Show.prototype.at.call(fake, t, {});
  assert.equal(at(4.999).a, 1, 'end of the first map line');
  assert.equal(at(5).a, 1, 'start of the second map line');
  assert.ok(at(5).fog.a < 0.05, 'a new player: only the fog fades');
  assert.ok(at(9.999).a < 0.05, 'the last map line still fades out into the game view');
  assert.ok(at(10).a < 0.05, 'and the game view fades its own overlays in');
  assert.ok(at(14.999).a < 0.05, 'two lines in the game view keep their fade');
});

test('story video: fog only from the spoken line, nothing comes through between two lines', () => {
  assert.equal(showFog(null), null); // the gap between two lines
  assert.equal(showFog({ fog: null }), null);
  assert.equal(showFog({ fog: { p: 1, a: 0 } }), null);
  assert.deepEqual(showFog({ fog: { p: 2, a: 0.5 } }), { p: 2, a: 0.5 });
  const src = fs.readFileSync(new URL('../tools/render-broadcast.mjs', import.meta.url), 'utf8');
  assert.match(src, /ui\.fog = showFog\(sh\)/);
  assert.doesNotMatch(src, /if \(sh\) ui\.fog/);
});
