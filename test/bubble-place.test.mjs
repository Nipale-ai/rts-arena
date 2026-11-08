import test from 'node:test';
import assert from 'node:assert/strict';
import { bubbleCenter, bubbleFit, topBelowCards } from '../render/bubble-place.mjs';

const box = (a, c) => ({ left: a.px - c.cx * a.dx, right: a.px + (1 - c.cx) * a.dx, low: a.py - c.cy * a.dy, high: a.py + (1 - c.cy) * a.dy });
const BASE = { dx: 0.6, dy: 0.3, margin: 0.03, top: 0.22, bottom: 0.3 };
const EPS = 1e-9;

test('speech bubble: in the middle of the frame the tail stays on the town centre', () => {
  assert.deepEqual(bubbleCenter({ ...BASE, px: 0, py: 0 }), { cx: 0.5, cy: 0 });
});

test('speech bubble: 16:9 never behind the side columns (player panel, decision card, feed), at any spot and height', () => {
  const side = { left: -0.508, right: 0.508, below: -Infinity };
  for (let px = -0.99; px <= 0.99; px += 0.03) for (let py = -0.99; py <= 0.7; py += 0.03) {
    const a = { ...BASE, px, py, side }, b = box(a, bubbleCenter(a));
    assert.ok(b.left >= side.left - EPS, `left ${b.left} at ${px},${py}`);
    assert.ok(b.right <= side.right + EPS, `right ${b.right} at ${px},${py}`);
  }
});

test('speech bubble: 4:5 stays beside the action feed at its height, uses the full width below it', () => {
  const side = { left: -0.28, right: 0.97, below: 0.45 };
  const hi = { ...BASE, px: -0.8, py: 0.3, side }, bh = box(hi, bubbleCenter(hi));
  assert.ok(bh.high > side.below && bh.left >= side.left - EPS, 'beside the feed');
  const lo = { ...BASE, px: -0.8, py: -0.2, side }, bl = box(lo, bubbleCenter(lo));
  assert.ok(bl.high <= side.below && bl.left < side.left, 'below the feed the frame edge counts');
  assert.ok(bl.left >= -1 + BASE.margin - EPS);
});

test('speech bubble: keeps clear of the captions at the bottom and of the top bar', () => {
  for (const py of [-0.99, -0.9, -0.8, -0.71]) { const a = { ...BASE, px: 0, py }, b = box(a, bubbleCenter(a)); assert.ok(b.low >= -1 + BASE.bottom - EPS, `low ${b.low} at ${py}`); }
  for (const py of [0.5, 0.6, 0.7]) { const a = { ...BASE, px: 0, py }, b = box(a, bubbleCenter(a)); assert.ok(b.high <= 1 - BASE.top + EPS, `high ${b.high} at ${py}`); }
});

test('speech bubble: 4:5 stays below the plan cards at the top of the picture', () => {
  // a picture from page y 100 to 900, cards down to y 300: the limit lies 25.75 % of the height (2 * 208 / 800 in NDC) below the top
  const top = topBelowCards({ viewTop: 100, viewHeight: 800, bottoms: [300, 280], base: 0.02 });
  assert.equal(top, 0.52);
  const c = bubbleCenter({ px: 0.3, py: 0.7, dx: 0.5, dy: 0.2, margin: 0.02, top });
  assert.ok(0.7 + (1 - c.cy) * 0.2 <= 1 - top + 1e-9, 'the top edge of the bubble stays under the cards');
  assert.equal(topBelowCards({ viewTop: 100, viewHeight: 800, bottoms: [0, undefined], base: 0.02 }), 0.02);
});

test('speech bubble: a bubble wider than the free span beside a wide feed shrinks to fit it and stays inside the frame', () => {
  const side = { left: 0.2, right: 0.97, below: 0.45 }; // a theme feed line up to 640 px wide leaves 0.77 of the NDC width
  const a = { ...BASE, dx: 1.1, dy: 0.5, px: 0.6, py: 0.7, side };
  const k = bubbleFit(a);
  assert.ok(k < 1 && k >= 0.5, `factor ${k}`);
  const b = { ...a, dx: a.dx * k, dy: a.dy * k }, bx = box(b, bubbleCenter(b));
  assert.ok(bx.left >= side.left - EPS && bx.right <= side.right + EPS, `box ${bx.left} .. ${bx.right}`);
  assert.equal(bubbleFit({ ...BASE, px: 0, py: 0 }), 1, 'a bubble that fits is not touched');
  assert.equal(bubbleFit({ ...BASE, dx: 9, px: 0, py: 0 }), 0.5, 'never smaller than half');
});
