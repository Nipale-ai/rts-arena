import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PRESETS, FINAL_FRAG, FINAL_FRAG_ECO } from '../render/post.mjs';

// The broadcast look is pinned: a change here changes every rendered video. Do not edit these numbers to make the test pass.
const BROADCAST = { shadow: 4096, ao: true, aoScale: 1, bloom: true, bloomOccluded: true, tilt: true, samples: 4, bloomScale: 0.5 };
const LIVE_BASE = { shadow: 2048, ao: true, aoScale: 0.5, bloom: true, bloomOccluded: false, tilt: true, samples: 4, bloomScale: 0.5 };
const OFF = { shadow: 2048, ao: false, aoScale: 1, bloom: false, bloomOccluded: false, tilt: false, samples: 0, bloomScale: 0.5 };
const VIEWER_FLAGS = ['shadowOnce', 'tiltEco'];

test('PRESETS: broadcast is exactly today\'s values (no viewer flag)', () => {
  assert.deepEqual(PRESETS.broadcast, BROADCAST);
  assert.deepEqual(Object.keys(PRESETS.broadcast), Object.keys(BROADCAST));
});

test('PRESETS: only live carries the viewer flags; the rest of live and off are unchanged', () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), ['broadcast', 'live', 'off']);
  for (const name of Object.keys(PRESETS)) {
    for (const f of VIEWER_FLAGS) assert.equal(Object.hasOwn(PRESETS[name], f), name === 'live', `${name}.${f}`);
  }
  assert.equal(PRESETS.live.shadowOnce, true);
  assert.equal(PRESETS.live.tiltEco, true);
  const { shadowOnce, tiltEco, ...rest } = PRESETS.live;
  assert.deepEqual(rest, LIVE_BASE);
  assert.deepEqual(PRESETS.off, OFF);
});

test('PRESETS: frozen, so nothing can switch a flag on for broadcast at run time', () => {
  assert.ok(Object.isFrozen(PRESETS));
  for (const name of Object.keys(PRESETS)) assert.ok(Object.isFrozen(PRESETS[name]), name);
  assert.throws(() => { 'use strict'; PRESETS.broadcast.shadowOnce = true; }, TypeError);
});

test('final pass: FINAL_FRAG is byte-identical to the build the videos were made with; the eco variant differs in one line', () => {
  assert.equal(crypto.createHash('sha256').update(FINAL_FRAG).digest('hex'), '9f5be2f090ee4f87f80f98d5a9bf0331cce03be87f44d790b703b908fb17efab');
  const a = FINAL_FRAG.split('\n'), b = FINAL_FRAG_ECO.split('\n');
  assert.equal(a.length, b.length);
  const diff = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);
  assert.equal(diff.length, 1);
  assert.match(a[diff[0]], /if \(coc < 0\.35\)/);
  assert.match(b[diff[0]], /if \(coc < 1\.0\)/);
});
