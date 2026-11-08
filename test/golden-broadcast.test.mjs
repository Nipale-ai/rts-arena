import test from 'node:test';
import assert from 'node:assert/strict';
import { compareGolden, runGolden, goldenFile } from '../tools/golden-broadcast.mjs';

// Golden check of the broadcast pictures. Skipped in the normal suite; switch it on with an env var:
//   RTS_GOLDEN=record node --test test/golden-broadcast.test.mjs    on the old build (af30cf3), writes the framemd5 list
//   RTS_GOLDEN=check  node --test test/golden-broadcast.test.mjs    on the new build, same machine: every frame must be identical
// Heavy (Chrome, GPU, ffmpeg). Details and the file location: tools/golden-broadcast.mjs.
const mode = process.env.RTS_GOLDEN;

test('golden broadcast: compare logic (pure, always runs)', () => {
  const rec = { cuts: { x: ['a', 'b', 'c'], yt: ['d', 'e'] }, env: { platform: 'darwin', arch: 'arm64', ffmpeg: 'f1', chrome: 'c1' } };
  assert.deepEqual(compareGolden(rec, structuredClone(rec)), { ok: true, problems: [], envDiff: [] });
  const bad = structuredClone(rec); bad.cuts.x[1] = 'z'; bad.env.chrome = 'c2';
  const r = compareGolden(rec, bad);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /^x: 1 of 3 frames differ \(first at frame 1: b != z/);
  assert.equal(r.envDiff.length, 1);
  const short = structuredClone(rec); short.cuts.yt.pop(); delete short.cuts.x;
  const s = compareGolden(rec, short);
  assert.ok(!s.ok && s.problems.some((p) => /yt: 2 frames recorded, 1 now/.test(p)) && s.problems.some((p) => /x: missing in new render/.test(p)));
  assert.equal(compareGolden({ cuts: {} }, { cuts: {} }).ok, false);
});

test('golden broadcast: x and yt cuts are pixel-identical to the recorded ones', { skip: !(mode === 'record' || mode === 'check') && 'set RTS_GOLDEN=record|check (needs Chrome, puppeteer-core, ffmpeg)', timeout: 600000 }, async () => {
  assert.ok(mode === 'record' || mode === 'check', `RTS_GOLDEN must be record or check, got "${mode}"`);
  const lines = [];
  const res = await runGolden(mode, { file: goldenFile(), log: (l) => { lines.push(l); console.log(l); } });
  assert.ok(res.ok, lines.join('\n'));
});
