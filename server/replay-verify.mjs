// Replays a recorded match (log.jsonl: seed + commands with ticks) and compares the end state hash.
//   node server/replay-verify.mjs replays/<id>
import fs from 'node:fs';
import path from 'node:path';
import { simForReplay, loadSim, newGameOf } from '../sim-versions/lib.mjs';

export function readLog(dirOrFile) {
  let f = path.resolve(dirOrFile);
  if (fs.statSync(f).isDirectory()) f = path.join(f, 'log.jsonl');
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// opts.sim: a sim bundle to force (backfill tries candidates); otherwise the version stamped in the replay is used.
export function verifyReplay(dirOrFile, opts = {}) {
  const lines = readLog(dirOrFile);
  const start = lines.find((l) => l.type === 'start');
  const states = lines.filter((l) => l.type === 'state');
  const result = lines.find((l) => l.type === 'result');
  const cmds = lines.filter((l) => l.type === 'cmd');
  const sim = opts.sim || simForReplay(dirOrFile, start);
  const g = newGameOf(sim, start);
  const lastT = states.length ? Math.max(...states.map((s) => s.t)) : 0;
  let i = 0, firstBad = null, checked = 0;
  const stateAt = new Map(states.map((s) => [s.t, s.hash]));
  const endT = cmds.length ? Math.max(lastT, cmds[cmds.length - 1].t) : lastT;
  while (!g.over) {
    while (i < cmds.length && cmds[i].t === g.t) { g.command(cmds[i].p, cmds[i].cmd); i++; }
    if (g.t > endT + 20 && !result) break;
    if (result && g.t >= (result.tick ?? Infinity)) break;
    g.step();
    if (stateAt.has(g.t)) { checked++; if (g.hash() !== stateAt.get(g.t) && firstBad === null) { firstBad = g.t; if (opts.stopAtMismatch) break; } }
  }
  let expected = null;
  const resFile = path.join(fs.statSync(path.resolve(dirOrFile)).isDirectory() ? path.resolve(dirOrFile) : path.dirname(path.resolve(dirOrFile)), 'result.json');
  if (fs.existsSync(resFile)) expected = JSON.parse(fs.readFileSync(resFile, 'utf8'));
  const res = g.result();
  const ok = firstBad === null && (!expected || (expected.hash === g.hash() && expected.winnerTeam === res.winnerTeam));
  return { ok, simVersion: sim.id, hash: g.hash(), expectedHash: expected?.hash ?? null, winnerTeam: res.winnerTeam, expectedWinner: expected?.winnerTeam ?? null, ticks: g.t, statesChecked: checked, firstMismatchTick: firstBad, commands: cmds.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = verifyReplay(process.argv[2]);
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
