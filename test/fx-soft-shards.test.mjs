// Video (Fx.soft): the larger shards (collapse rubble, stone hits, banner scraps, death pieces) are soft dust clods, never cubes; the tiny chips and the live game stay as they were. Node only, no Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fx } from '../render/fx.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// the Fx constructor needs a browser (canvas textures): the methods under test run on a stand-in that records what they emit
const mk = (soft) => { const f = { soft, kinds: [], pal: { collapse_dust: 1, rubble_wood: 2, rubble_stone: 3 }, emit(kind) { this.kinds.push(kind); }, cloud() {}, smoke() {}, _d() {} }; f.shards = Fx.prototype.shards; f.collapse = Fx.prototype.collapse; return f; };

test('soft: a collapse and big shards make puffs only (no debris cubes)', () => {
  const f = mk(true); f.shards(0, 0, 0, 0x8a6a3a, 20, 3.4, 0.22, 1.3); f.collapse(5, 5, 4, 0);
  assert.ok(f.kinds.length >= 20);
  assert.ok(f.kinds.every((k) => k === 'puff'), [...new Set(f.kinds)].join());
});

test('soft: tiny chips stay as they were; not soft: shards stay cubes', () => {
  const a = mk(true); a.shards(0, 0, 0, 0xffffff, 6, 2.2, 0.09, 0.8);
  assert.ok(a.kinds.length === 6 && a.kinds.every((k) => k === 'debris'));
  const b = mk(false); b.shards(0, 0, 0, 0xffffff, 6, 3.4, 0.22, 1.3);
  assert.ok(b.kinds.length === 6 && b.kinds.every((k) => k === 'debris'));
});

test('the soft flag is set only for a video (BC) in app.mjs, and the death sparks as well', () => {
  const app = fs.readFileSync(path.join(ROOT, 'render/app.mjs'), 'utf8');
  assert.match(app, /f\.soft = BC;/);
  assert.match(app, /if \(BC\) fx\.softSparks\(/);
  const fx = fs.readFileSync(path.join(ROOT, 'render/fx.mjs'), 'utf8');
  assert.equal((fx.match(/^  sparks\(/gm) || []).length, 1, 'one sparks(): the sapper fuse; the death sparks are softSparks()');
  assert.equal((fx.match(/^  softSparks\(/gm) || []).length, 1);
});
