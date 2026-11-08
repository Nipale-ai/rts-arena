// Sim versioning (sim-versions/): changing sim/ without freezing the new version, editing a snapshot, or breaking a
// frozen sim's determinism must fail here. Fix for the first one: node tools/sim-freeze.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentSimVersion, hashSimDir, listSnapshots, loadSim, snapshotDir, CURRENT_DIR, isSimVersion } from '../sim-versions/lib.mjs';
import { checkCurrentFrozen, checkSnapshots, checkGoldens, checkSimIsolated } from '../tools/sim-check.mjs';
import { verifyReplay } from '../server/replay-verify.mjs';
import { loadReplay } from '../tools/lib/replay.mjs';
import { runMatch } from '../tools/run-match.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rts-simver-'));

test('the current sim/ is frozen as a snapshot (fails when sim/ changed without tools/sim-freeze.mjs)', () => {
  assert.deepEqual(checkCurrentFrozen(), []);
  const id = currentSimVersion({ fresh: true });
  assert.match(id, /^sim-[0-9a-f]{12}$/);
  const snap = path.join(snapshotDir(id), 'sim');
  for (const f of fs.readdirSync(CURRENT_DIR)) assert.equal(fs.readFileSync(path.join(snap, f), 'utf8'), fs.readFileSync(path.join(CURRENT_DIR, f), 'utf8'), f);
});

test('snapshots are immutable and complete', () => {
  assert.deepEqual(checkSnapshots(), []);
  assert.ok(listSnapshots().length >= 20, 'history snapshots present');
  for (const s of listSnapshots()) assert.ok(isSimVersion(s.id) && s.golden.length >= 1, s.id);
});

test('golden replay of every frozen version re-simulates bit-exactly with its own snapshot', () => {
  assert.deepEqual(checkGoldens(), []);
});

test('sim/ only imports inside sim/ (snapshots stay self-contained)', () => {
  assert.deepEqual(checkSimIsolated(), []);
});

test('version id: content based, sensitive to every byte, not to line endings', () => {
  const d = tmp();
  for (const f of fs.readdirSync(CURRENT_DIR)) fs.copyFileSync(path.join(CURRENT_DIR, f), path.join(d, f));
  assert.equal(hashSimDir(d), currentSimVersion({ fresh: true }));
  const g = path.join(d, 'rules.mjs'), src = fs.readFileSync(g, 'utf8');
  fs.writeFileSync(g, src.replace(/\n/g, '\r\n'));
  assert.equal(hashSimDir(d), currentSimVersion());
  fs.writeFileSync(g, src + '\n// x\n');
  assert.notEqual(hashSimDir(d), currentSimVersion());
});

test('a modified snapshot is refused by the loader', () => {
  const s = listSnapshots()[0];
  const sim = loadSim(s.id);
  assert.equal(sim.id, s.id);
  assert.throws(() => loadSim('sim-000000000000'), /not frozen/);
  assert.throws(() => loadSim('nonsense'), /not a sim version/);
});

test('new recordings carry the sim version and verify; an old version replays next to the current one', () => {
  const dir = tmp(), log = path.join(dir, 'log.jsonl');
  runMatch({ seed: 3, bots: ['rush', 'boom'], log });
  const rep = loadReplay(dir);
  assert.equal(rep.start.sim_version, currentSimVersion());
  assert.equal(verifyReplay(dir).ok, true);
  // the same log stamped with an older frozen version runs on that version (and differs from the current one)
  const old = listSnapshots().find((s) => s.id !== currentSimVersion());
  const d2 = tmp();
  fs.copyFileSync(path.join(snapshotDir(old.id), 'golden', old.golden[0] + '.jsonl'), path.join(d2, 'log.jsonl'));
  const r = verifyReplay(d2);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.simVersion, old.id);
  assert.equal(loadReplay(d2).sim.id, old.id);
});

test('an unstamped replay is refused with a pointer to the backfill tool', () => {
  const d = tmp(), lines = ['{"type":"start","seed":1,"bots":["rush","boom"],"teams":[1,2]}'];
  fs.writeFileSync(path.join(d, 'log.jsonl'), lines.join('\n') + '\n');
  assert.throws(() => verifyReplay(d), /sim-backfill/);
});
