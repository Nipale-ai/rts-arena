// Video: a building that gets the look of a higher tier does not pop (dust, the old look shrinks away, the new one grows); the live game and the classic pins stay as they were. Node only, no Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the old look stays in the group only when the video asks for it (crossfade is off by default)', () => {
  const b = src('render/buildings3d.mjs');
  assert.match(b, /this\.crossfade = false;/);
  assert.match(b, /if \(o\.inner\) \{ if \(this\.crossfade\) \{ if \(o\.prev\) o\.grp\.remove\(o\.prev\); o\.prev = o\.inner; o\.prevT = null; \} else o\.grp\.remove\(o\.inner\); \}/);
  assert.match(src('render/app.mjs'), /world\.bld3d\.crossfade = BC;/);
});

test('the tier-up effect runs only in a video, only for a finished building whose look really changed to a higher tier', () => {
  const a = src('render/app.mjs');
  assert.match(a, /if \(BC\) \{ const tn = ownerTier\(o\.owner\); if \(swapped && o\.vTier !== undefined && tn > o\.vTier && done && !fogBldHidden\(o\)\) o\.tierT = time;/);
  assert.match(a, /if \(o\.tierT === time && o\.tierT !== o\.tierDone\)/);
  assert.match(a, /if \(u >= 1\) \{ o\.grp\.remove\(o\.prev\); o\.prev = null; \}/);
});
