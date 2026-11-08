import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadReplay } from '../tools/lib/replay.mjs';
import { scriptedReplay } from '../test-support/replays.mjs';
import { SoundDirector } from '../render/audio-core.mjs';
import { compareStills, runStillGolden, goldenFile } from '../tools/shots-replay-still.mjs';

// Pins of the CLASSIC look and sound of the shots. They were recorded on the ORIGINAL code (before the theme patch) and must stay as they are:
// the reskin tests compare the new code with itself (theme off against theme on), these two compare it with the old one.
//   sound: every trigger the SoundDirector makes in a whole scripted match (bow shot, arrow whoosh, javelin, arrow hit on flesh / wood / stone, tower shots ...)
//   picture: 27 frames of a scene with 33 archers and 27 arrows in the air (tools/shots-replay-still.mjs, needs Chrome, switched on with RTS_GOLDEN=check)
// If the sim, the bots or the sound table change on purpose, record the pins again ON THE OLD BUILD, never on the new one.

// ---- sound
const SOUND_PIN = { bots: ['rush', 'turtle'], seed: 3, ticks: 11040, triggers: 50522, sha: '6f1366f3d34e8ba5',
  counts: { bow_shot: 3353, arrow_whoosh: 565, javelin_throw: 519, arrow_hit_flesh: 2099, arrow_hit_wood: 887, arrow_hit_stone: 869 } };

async function soundOfMatch(opts = {}) {
  const { args, Match } = await import('../server/spectate.mjs');
  const rep = loadReplay(scriptedReplay(SOUND_PIN.bots, SOUND_PIN.seed));
  args.replay = rep.dir; const log = console.log; console.log = () => {};
  const h = crypto.createHash('sha256'), byId = {}; let n = 0, ticks = 0;
  try {
    const m = new Match(), d = new SoundDirector(m.initMsg(), opts);
    while (!m.game.over && ticks < 20000) {
      m.tick(); ticks++;
      for (const t of d.feed(m.snapshot()).triggers) { h.update(JSON.stringify(t) + '\n'); n++; byId[t.id] = (byId[t.id] || 0) + 1; }
    }
  } finally { console.log = log; }
  return { ticks, triggers: n, sha: h.digest('hex').slice(0, 16), byId };
}

test('classic pin, sound: the triggers of a whole match are the triggers of the original code (shots, whooshes, hits on flesh, wood and stone, tower shots)', async () => {
  const r = await soundOfMatch();
  assert.equal(r.ticks, SOUND_PIN.ticks);
  for (const [id, n] of Object.entries(SOUND_PIN.counts)) assert.equal(r.byId[id], n, `${id}: count of the original code`);
  assert.equal(r.triggers, SOUND_PIN.triggers);
  assert.equal(r.sha, SOUND_PIN.sha, 'every trigger (id, place, owner, entity, tick, volume) is byte-equal to the original');
});

// ---- picture
test('classic pin, picture: compare logic (pure, always runs)', () => {
  const rec = { frames: ['a', 'b', 'c'], env: { platform: 'darwin', arch: 'arm64', chrome: 'c1' } };
  assert.deepEqual(compareStills(rec, structuredClone(rec)), { ok: true, problems: [], envDiff: [] });
  const bad = structuredClone(rec); bad.frames[1] = 'z'; bad.env.chrome = 'c2';
  const r = compareStills(rec, bad);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /^1 of 3 frames differ \(first at frame 1: b != z/);
  assert.equal(r.envDiff.length, 1);
  const short = structuredClone(rec); short.frames.pop();
  assert.ok(!compareStills(rec, short).ok && /3 frames recorded, 2 now/.test(compareStills(rec, short).problems[0]));
  assert.equal(compareStills({ frames: [] }, { frames: [] }).ok, false, 'an empty record proves nothing');
});

const mode = process.env.RTS_GOLDEN;
test('classic pin, picture: 27 frames of archers shooting are pixel-identical to the original code', { skip: mode !== 'check' && 'set RTS_GOLDEN=check (needs Chrome and puppeteer-core)', timeout: 300000 }, async () => {
  const lines = [];
  const res = await runStillGolden('check', { file: goldenFile(), log: (l) => { lines.push(l); console.log(l); } });
  assert.ok(res.ok, lines.join('\n'));
});
