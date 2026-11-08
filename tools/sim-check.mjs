#!/usr/bin/env node
// CI-style check of the sim versioning. Exit code 1 and a list of problems when something is off.
//   node tools/sim-check.mjs                    snapshots + goldens + "is the current sim/ frozen?"
//   node tools/sim-check.mjs --replays <dir>    also: every replay in <dir> is stamped and re-simulates bit-exactly (slow)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CURRENT_DIR, currentSimVersion, hashSimDir, listSnapshots, snapshotDir, loadSim, readJsonl, verifyLines, stampedVersion } from '../sim-versions/lib.mjs';
import { verifyReplay } from '../server/replay-verify.mjs';

const fix = 'run: node tools/sim-freeze.mjs   (then commit sim-versions/)';

export function checkCurrentFrozen() {
  const id = currentSimVersion({ fresh: true });
  const dir = path.join(snapshotDir(id), 'sim');
  if (!fs.existsSync(dir)) return [`sim/ changed and version ${id} is not frozen: old replays of the previous version stay safe, but the new one has no snapshot yet. ${fix}`];
  return [];
}

export function checkSnapshots() {
  const problems = [];
  for (const s of listSnapshots()) {
    const dir = path.join(snapshotDir(s.id), 'sim');
    if (!fs.existsSync(dir)) { problems.push(`${s.id}: sim/ missing`); continue; }
    const got = hashSimDir(dir);
    if (got !== s.id) problems.push(`${s.id}: files were modified (hash ${got}); snapshots are immutable, restore them from git`);
  }
  return problems;
}

export function checkGoldens(ids) {
  const problems = [];
  for (const s of listSnapshots()) {
    if (ids && !ids.includes(s.id)) continue;
    if (!s.golden?.length) { problems.push(`${s.id}: no golden replay`); continue; }
    let sim; try { sim = loadSim(s.id); } catch (e) { problems.push(`${s.id}: cannot load: ${e.message}`); continue; }
    for (const name of s.golden) {
      const f = path.join(snapshotDir(s.id), 'golden', name + '.jsonl');
      if (!fs.existsSync(f)) { problems.push(`${s.id}/${name}: golden file missing`); continue; }
      try {
        const v = verifyLines(sim, readJsonl(f));
        if (v.firstBad !== null) problems.push(`${s.id}/${name}: golden replay diverges at tick ${v.firstBad} (is the sim, Node or a dependency no longer deterministic?)`);
      } catch (e) { problems.push(`${s.id}/${name}: ${e.message}`); }
    }
  }
  return problems;
}

// the sim must not import anything outside its own folder (data files, configs, agents): a frozen copy would not be self-contained
export function checkSimIsolated(dir = CURRENT_DIR) {
  const problems = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (spec.startsWith('node:')) { if (!/^node:(crypto|util|assert)$/.test(spec) && !/^node:(fs|path)$/.test(spec)) problems.push(`sim/${f}: imports ${spec}`); continue; }
      if (!/^\.\/[\w.-]+\.mjs$/.test(spec)) problems.push(`sim/${f}: imports ${spec} (only ./x.mjs inside sim/ is allowed)`);
    }
  }
  return problems;
}

export function checkReplays(replaysDir) {
  const problems = [];
  for (const d of fs.readdirSync(replaysDir).sort()) {
    const dir = path.join(replaysDir, d), log = path.join(dir, 'log.jsonl');
    if (!fs.existsSync(log)) continue;
    const start = readJsonl(log).find((l) => l.type === 'start');
    if (!stampedVersion(dir, start)) { problems.push(`${d}: no sim version stamp (run tools/sim-backfill.mjs)`); continue; }
    try { const r = verifyReplay(dir, { stopAtMismatch: true }); if (!r.ok) problems.push(`${d}: stamped ${r.simVersion} but does not verify (first mismatch tick ${r.firstMismatchTick})`); } catch (e) { problems.push(`${d}: ${e.message}`); }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const rd = argv.includes('--replays') ? path.resolve(argv[argv.indexOf('--replays') + 1]) : null;
  const problems = [...checkSimIsolated(), ...checkCurrentFrozen(), ...checkSnapshots(), ...checkGoldens(), ...(rd ? checkReplays(rd) : [])];
  console.log(`sim ${currentSimVersion({ fresh: true })}, ${listSnapshots().length} frozen versions${rd ? `, replays in ${rd}` : ''}`);
  for (const p of problems) console.log('PROBLEM ' + p);
  console.log(problems.length ? `FAILED (${problems.length})` : 'OK');
  process.exit(problems.length ? 1 : 0);
}
