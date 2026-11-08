#!/usr/bin/env node
// Freezes sim versions as immutable snapshots under sim-versions/<id>/ (exact files + meta.json + golden replays).
//   node tools/sim-freeze.mjs               freeze the sim/ directory as it is now (run this after every change of sim/)
//   node tools/sim-freeze.mjs --history     also freeze every state of sim/ found in the git history of all branches (backfill of old versions)
//   node tools/sim-freeze.mjs --rev <rev>   freeze sim/ as of one git revision
// A snapshot that already exists is never rewritten.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, SNAP_ROOT, CURRENT_DIR, hashSimDir, snapshotDir, bundleOf, recordGolden, verifyLines } from '../sim-versions/lib.mjs';
import { createBot } from '../agents/scripted/index.mjs';

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });

export function writeGoldens(id, dir) {
  const sim = bundleOf(dir, id);
  const gdir = path.join(snapshotDir(id), 'golden');
  fs.mkdirSync(gdir, { recursive: true });
  const names = [];
  const jobs = [['rush-boom-s3-classic', { seed: 3, preset: null }]];
  if (sim.PRESETS && sim.PRESETS.fast) jobs.push(['rush-boom-s5-fast', { seed: 5, preset: 'fast' }]);
  for (const [name, o] of jobs) {
    const lines = recordGolden(sim, createBot, { ...o, maxTicks: 3000 });
    const v = verifyLines(sim, lines);
    if (v.firstBad !== null) throw new Error(`golden ${name} of ${id} does not verify against itself (tick ${v.firstBad}); the sim is not deterministic`);
    fs.writeFileSync(path.join(gdir, name + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    names.push(name);
  }
  return names;
}

// copies `srcDir` into sim-versions/<id>/sim; `commits` and `date` describe where it came from
export function freezeDir(srcDir, { commits = [], date, note } = {}) {
  const id = hashSimDir(srcDir);
  const dst = snapshotDir(id);
  if (fs.existsSync(path.join(dst, 'meta.json'))) {
    const m0 = JSON.parse(fs.readFileSync(path.join(dst, 'meta.json'), 'utf8'));
    if (!m0.golden?.length) { // frozen by a recorder: add the golden replays now
      m0.golden = writeGoldens(id, path.join(dst, 'sim')); delete m0.note;
      fs.writeFileSync(path.join(dst, 'meta.json'), JSON.stringify(m0, null, 1) + '\n');
      return { id, created: true };
    }
    // already frozen: only remember additional commits that carry the same files
    const mp = path.join(dst, 'meta.json'), m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const seen = new Set(m.commits.map((c) => c.hash));
    const add = commits.filter((c) => !seen.has(c.hash));
    if (add.length) { m.commits.push(...add); fs.writeFileSync(mp, JSON.stringify(m, null, 1) + '\n'); }
    return { id, created: false };
  }
  fs.mkdirSync(path.join(dst, 'sim'), { recursive: true });
  for (const f of fs.readdirSync(srcDir)) if (/\.(mjs|js|json)$/.test(f)) fs.copyFileSync(path.join(srcDir, f), path.join(dst, 'sim', f));
  if (hashSimDir(path.join(dst, 'sim')) !== id) throw new Error('copy changed the hash (nested directories are not supported yet)');
  const golden = writeGoldens(id, path.join(dst, 'sim'));
  const meta = { id, date: date || new Date().toISOString(), commits, golden, ...(note ? { note } : {}) };
  fs.writeFileSync(path.join(dst, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');
  return { id, created: true };
}

function freezeRev(rev, tmpRoot) {
  const info = git('show', '-s', '--format=%H%n%cI%n%s', rev).trim().split('\n');
  const [hash, iso, subject] = info;
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'rev-'));
  for (const f of git('ls-tree', '--name-only', rev, 'sim/').split('\n').filter(Boolean)) {
    if (!/\.(mjs|js|json)$/.test(f)) continue;
    fs.writeFileSync(path.join(tmp, path.basename(f)), git('show', `${rev}:${f}`));
  }
  const r = freezeDir(tmp, { commits: [{ hash: hash.slice(0, 7), subject }], date: new Date(iso).toISOString() });
  return { ...r, hash: hash.slice(0, 7), subject };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-freeze-'));
  if (argv.includes('--history') || argv.includes('--rev')) {
    const revs = argv.includes('--rev') ? [argv[argv.indexOf('--rev') + 1]] : git('log', '--all', '--reverse', '--format=%H', '--', 'sim').split('\n').filter(Boolean);
    for (const rev of revs) { const r = freezeRev(rev, tmpRoot); console.log(`${r.created ? 'frozen ' : 'same   '} ${r.id}  ${r.hash} ${r.subject.slice(0, 80)}`); }
  }
  if (!argv.includes('--rev')) {
    let head = '';
    try { head = git('log', '-1', '--format=%h %s', '--', 'sim').trim(); } catch { /* not a git checkout */ }
    const dirty = (() => { try { return git('status', '--porcelain', '--', 'sim').trim().length > 0; } catch { return false; } })();
    const r = freezeDir(CURRENT_DIR, { commits: [], note: dirty ? `frozen from a working tree with uncommitted sim changes (last sim commit: ${head})` : undefined });
    console.log(`${r.created ? 'frozen ' : 'same   '} ${r.id}  current sim/${dirty ? ' (uncommitted changes)' : ''}`);
  }
}
