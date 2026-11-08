#!/usr/bin/env node
// Finds the sim version of replays that have no stamp, by trying the frozen versions (newest first) until the
// recorded state hashes verify, and stamps the result: replays/<id>/sim-version.json (the raw log.jsonl is never edited)
// and, when given, sim_version in data/matches/<id>.json.
//   node tools/sim-backfill.mjs --replays <dir> [--data <dir>] [--dry] [--all]
// --all re-checks replays that already carry a stamp too (reports stamps that no longer verify).
import fs from 'node:fs';
import path from 'node:path';
import { listSnapshots, loadSim, currentSimVersion, readJsonl, stampedVersion, STAMP_FILE, ROOT } from '../sim-versions/lib.mjs';
import { verifyReplay } from '../server/replay-verify.mjs';

const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const replays = path.resolve(opt('--replays') || path.join(ROOT, 'replays')), dataDir = opt('--data') ? path.resolve(opt('--data')) : null;
const dry = argv.includes('--dry'), all = argv.includes('--all');

export function detect(dir) {
  const cands = [...new Set([currentSimVersion(), ...listSnapshots().map((s) => s.id).reverse()])];
  for (const id of cands) {
    let sim; try { sim = loadSim(id); } catch { continue; }
    let r; try { r = verifyReplay(dir, { sim, stopAtMismatch: true }); } catch { continue; }
    if (r.ok) return { id, r };
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = [];
  for (const d of fs.readdirSync(replays).sort()) {
    const dir = path.join(replays, d);
    const log = path.join(dir, 'log.jsonl');
    if (!fs.existsSync(log)) continue;
    const start = readJsonl(log).find((l) => l.type === 'start');
    const had = stampedVersion(dir, start);
    if (had && !all) { rows.push({ d, id: had, how: 'stamped' }); continue; }
    const f = had ? { id: had, r: verifyReplay(dir, { sim: loadSim(had) }) } : detect(dir);
    if (!f || (had && !f.r.ok)) { rows.push({ d, id: null, how: had ? `stamp ${had} does not verify` : 'NO VERSION VERIFIES' }); continue; }
    rows.push({ d, id: f.id, how: had ? 'stamp verified' : 'detected', ticks: f.r.ticks, checked: f.r.statesChecked });
    if (dry || had) continue;
    fs.writeFileSync(path.join(dir, STAMP_FILE), JSON.stringify({ sim_version: f.id, method: 'backfill: first frozen version (newest first) whose re-simulation matches every recorded state hash and the result hash', states_checked: f.r.statesChecked, ticks: f.r.ticks, stamped: new Date().toISOString() }, null, 1) + '\n');
    const mf = dataDir && path.join(dataDir, 'matches', d + '.json');
    if (mf && fs.existsSync(mf)) {
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
      if (!m.sim_version) { m.sim_version = f.id; fs.writeFileSync(mf, JSON.stringify(m, null, 1) + '\n'); }
    }
  }
  for (const r of rows) console.log(`${(r.id || '-').padEnd(17)} ${r.how.padEnd(11)} ${r.d}`);
  const by = {}; for (const r of rows) by[r.id || 'unmatched'] = (by[r.id || 'unmatched'] || 0) + 1;
  console.log('\nsummary', JSON.stringify(by));
  process.exit(rows.some((r) => !r.id) ? 1 : 0);
}
