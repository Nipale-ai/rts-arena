import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { groupOutline, GROUP_MIN } from '../render/mark-hull.mjs';
import { overlap } from '../render/layout-faults.mjs';
import { spokenNames } from '../tools/overlay.mjs';
import { pillText } from '../render/markers.mjs';
import { spreadLabels } from '../render/layout-faults.mjs';
import { labelSpot } from '../tools/story-show.mjs';

test('a group of units gets one outline, a few units keep their rings', () => {
  assert.equal(groupOutline([[0, 0], [10, 0], [0, 10]]), null);
  const grid = []; for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) grid.push([100 + x * 20, 100 + y * 20]);
  const h = groupOutline(grid);
  assert.ok(h.length >= 3 && h.length <= 8, 'the outline has a few corners, not one per unit');
  const xs = h.map((p) => p[0]), ys = h.map((p) => p[1]);
  assert.ok(Math.min(...xs) < 100 && Math.max(...xs) > 200 && Math.min(...ys) < 100 && Math.max(...ys) > 200, 'every unit lies inside');
});

test('one straggler far away does not stretch the outline', () => {
  const grid = []; for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) grid.push([100 + x * 20, 100 + y * 20]);
  const h = groupOutline([...grid, [900, 900]]);
  assert.ok(Math.max(...h.map((p) => p[0])) < 300);
  assert.ok(GROUP_MIN >= 3);
});

test('names in the picture are what the casters say; two models of one brand stay apart', () => {
  assert.deepEqual(spokenNames(['Qwen3.8-27B NVFP4+MTP3 (QuartzRT)', "DeepSeek-V4.1-Flash (Bob's TensorFold Metal recipe)"]), ['Qwen', 'DeepSeek']);
  assert.deepEqual(spokenNames(['Qwen3.8-27B NVFP4+MTP3 (QuartzRT)', 'Qwen3.8-27B EXL3 (Zoe kit TP2)']), ['QuartzRT', 'Zoe kit TP2']);
  assert.deepEqual(spokenNames(['Probe A (mock)', 'Probe B (mock)']), ['Probe A', 'Probe B']);
});

test('layout check: boxes that touch count as overlap, boxes apart do not', () => {
  assert.equal(overlap({ left: 0, right: 100, top: 0, bottom: 50 }, { left: 90, right: 200, top: 10, bottom: 40 }), true);
  assert.equal(overlap({ left: 0, right: 100, top: 0, bottom: 50 }, { left: 100, right: 200, top: 10, bottom: 40 }), false);
});

test('every render asks the page for layout faults and fails loud when it finds one', () => {
  const src = fs.readFileSync(new URL('../tools/render-broadcast.mjs', import.meta.url), 'utf8');
  assert.match(src, /window\.__bc\.faults\(\)/);
  assert.match(src, /LAYOUT FAULT/);
});

test('the text of the markers goes on the label layer: there no label covers another or leaves the frame', () => {
  assert.equal(pillText('attack', 'ATTACK', 43), 'ATTACK 43');
  assert.equal(pillText('scout', 'SCOUT', 1), 'SCOUT');
  assert.equal(pillText('ghost', 'BARRACKS', 1), 'BARRACKS');
  assert.equal(pillText('work', 'axe', 5), null);
  assert.equal(pillText('rally', '', 1), null);
  const bc = fs.readFileSync(new URL('../render/broadcast.mjs', import.meta.url), 'utf8');
  assert.match(bc, /H\.markerText\(false\)/);
  assert.match(bc, /pills = H\.markerLabels\(\)/);
  const m = fs.readFileSync(new URL('../render/markers.mjs', import.meta.url), 'utf8');
  assert.match(m, /it\.spr\.visible = !\(textOff && pillText\(kind, label, n\)\)/);
});

test('the end card stands alone: tag, panel, rings and markers of the show leave as it comes in', () => {
  const bc = fs.readFileSync(new URL('../render/broadcast.mjs', import.meta.url), 'utf8');
  assert.match(bc, /tag\.style\.opacity = sh\.a \* free/);
  assert.match(bc, /vs\.style\.opacity = sh\.a \* free/);
  assert.match(bc, /\(1 - winnerBanner\(ui\)\) \* \(1 - endA\(ui\)\)/);
  assert.match(bc, /winnerBanner\(f\.ui\) > 0 \|\| !!f\.ui\.end/);
});

test('a label with no free place is left out, never half behind a card', () => {
  const [free] = spreadLabels([{ x: 50, y: 100, w: 100, h: 40 }], 4, [{ x: 0, y: 90, w: 300, h: 60 }]);
  assert.equal(free.blocked, false);
  const [none] = spreadLabels([{ x: 50, y: 20, w: 100, h: 40 }], 4, [{ x: 0, y: 0, w: 300, h: 70 }, { x: 0, y: 70, w: 300, h: 200 }]);
  assert.equal(none.blocked, true);
  assert.match(fs.readFileSync(new URL('../render/broadcast.mjs', import.meta.url), 'utf8'), /if \(b\.blocked\) continue;/);
});

test('the name of a split army stands on its biggest part', () => {
  const u = (x, z) => [1, 1, 0, x, z];
  const [x, z] = labelSpot([u(33, 64), u(34, 64), u(33, 63), u(34, 63), u(33, 65), u(34, 65), u(60, 45), u(60, 45), u(60, 44), u(30, 27)]);
  assert.ok(Math.abs(x - 33.5) < 1 && Math.abs(z - 64) < 1.5, `label at ${x}, ${z}`);
});
