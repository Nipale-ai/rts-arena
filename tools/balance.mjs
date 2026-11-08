#!/usr/bin/env node
// Balance harness: scripted bots vs each other on random seeds, both seat orders.
// node tools/balance.mjs --games 300 [--seed0 1000] [--threads 6] [--bots rush,boom,turtle] [--json out.json]
// Run it niced: nice -n 10 node tools/balance.mjs ...
// Every game records why it ended (tools/lib/end-cause.mjs); tools/end-reasons.mjs reads the --json files.
// World options: --map-type meadow|forest|desert|winter|coast, --weather off|auto|<kind>, --caravans true|false, --no-mirror 1 (skip bot-vs-itself pairs)
import { countsForRanking } from '../server/results.mjs';
import os from 'node:os';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { STYLE_BOT_NAMES } from '../agents/scripted/index.mjs';
import { UNITS } from '../sim/data.mjs';
import { resolveRules } from '../sim/rules.mjs';
import { tallyLine } from './lib/end-cause.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const games = +(args.games ?? 100);
const seed0 = +(args.seed0 ?? 1000);
const threads = +(args.threads ?? Math.max(1, Math.min(6, os.cpus().length - 2)));
const preset = args.preset || 'classic';
const SET = args.set ? Object.fromEntries(args.set.split(',').map((kv) => { const [k, v] = kv.split('='); return [k, v === 'true' ? true : v === 'false' ? false : +v]; })) : null; // --set shrineTarget=2000,wonderSecs=420,wonder=false: rule switches for tuning runs
const rules = args['map-type'] || args.weather || args.caravans || SET ? { preset, ...(args['map-type'] ? { mapType: args['map-type'] } : {}), ...(args.weather ? { weather: args.weather } : {}), ...(args.caravans ? { caravans: args.caravans === 'true' } : {}), ...(SET || {}) } : preset;
const names = args.bots ? args.bots.split(',') : STYLE_BOT_NAMES; // the four style bots; idle (solo level 0) only with an explicit --bots

const pairs = [];
for (let i = 0; i < names.length; i++) for (let j = args['no-mirror'] ? i + 1 : i; j < names.length; j++) pairs.push([names[i], names[j]]);
const jobs = [];
let id = 0;
for (const [a, b] of pairs)
  for (let g = 0; g < games; g++) jobs.push({ id: id++, seed: seed0 + g, bots: g % 2 === 0 ? [a, b] : [b, a], pair: `${a} vs ${b}`, rules });

const results = [];
let next = 0, done = 0;
const t0 = Date.now();
await new Promise((resolve) => {
  const workers = [];
  const feed = (w) => {
    if (next >= jobs.length) return;
    const j = jobs[next++];
    w.postMessage(j);
  };
  for (let i = 0; i < threads; i++) {
    const w = new Worker(new URL('./balance-worker.mjs', import.meta.url));
    w.on('message', (m) => {
      m.pair = jobs[m.id].pair;
      if (countsForRanking(m)) results.push(m); // a match with God mode interventions never counts
      done++;
      if (done % 50 === 0) process.stderr.write(`  ${done}/${jobs.length} games, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
      if (done === jobs.length) {
        for (const x of workers) x.terminate();
        resolve();
      } else feed(w);
    });
    workers.push(w);
    feed(w);
  }
});

const pct = (x, n) => (n ? ((100 * x) / n).toFixed(0).padStart(3) + '%' : '  - ');
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const out = { matchups: [], units: {}, meta: { preset, games, seed0, threads, noMirror: !!args['no-mirror'], set: args.set || null, suddenDeath: resolveRules(rules).suddenDeath || 0 } };
console.log(`\n${results.length} games, ${((Date.now() - t0) / 1000).toFixed(0)}s wall, ${threads} threads\n`);
console.log('matchup               A wins  B wins  draws  avg len   first fight   len<12m  len>35m  timeouts');
for (const [a, b] of pairs) {
  const rs = results.filter((r) => r.pair === `${a} vs ${b}`);
  let aw = 0, bw = 0, dr = 0;
  for (const r of rs) {
    if (!r.winnerTeam) dr++;
    else if (r.bots[r.winnerTeam - 1] === a && (a !== b || r.winnerTeam === 1)) aw++;
    else bw++;
  }
  if (a === b) {
    // mirror: report seat 1 vs seat 2 instead
    aw = rs.filter((r) => r.winnerTeam === 1).length;
    bw = rs.filter((r) => r.winnerTeam === 2).length;
  }
  const len = rs.map((r) => r.seconds);
  const fa = rs.map((r) => r.firstAttack).filter((x) => x != null);
  const short = rs.filter((r) => r.seconds < 720).length, long = rs.filter((r) => r.seconds > 2100).length;
  const to = rs.filter((r) => r.reason.startsWith('time')).length;
  const label = (a === b ? `${a} (seat1 vs seat2)` : `${a} vs ${b}`).padEnd(22);
  console.log(`${label}${pct(aw, rs.length)}     ${pct(bw, rs.length)}     ${pct(dr, rs.length)}   ${fmtT(mean(len)).padStart(6)}   ${fmtT(mean(fa)).padStart(8)}      ${pct(short, rs.length)}     ${pct(long, rs.length)}     ${to}`);
  out.matchups.push({ a, b, games: rs.length, aWins: aw, bWins: bw, draws: dr, avgLenS: mean(len), avgFirstFightS: mean(fa), timeouts: to });
}
// overall length and decisiveness
{
  const L = results.map((r) => r.seconds).sort((x, y) => x - y);
  const med = L.length ? L[Math.floor(L.length / 2)] : 0;
  const fell = results.filter((r) => !r.reason.startsWith('time') && r.winnerTeam).length;
  console.log(`\noverall (${preset}${args['map-type'] ? ' ' + args['map-type'] : ''}${args.set ? ' ' + args.set : ''}): ${results.length} games, median length ${fmtT(med)}, mean ${fmtT(mean(L))}, base fell in ${pct(fell, results.length).trim()} (time-limit decisions ${results.filter((r) => r.reason.startsWith('time')).length})`);
  const NM = results.filter((r) => r.bots[0] !== r.bots[1]).map((r) => r.seconds).sort((x, y) => x - y);
  const nmFell = results.filter((r) => r.bots[0] !== r.bots[1] && !r.reason.startsWith('time') && r.winnerTeam).length;
  console.log(`non-mirror pairs only: ${NM.length} games, median length ${fmtT(NM[Math.floor(NM.length / 2)] || 0)}, base fell in ${pct(nmFell, NM.length).trim()}`);
  out.overall = { games: results.length, medianS: med, meanS: mean(L), baseFellShare: fell / results.length };
  // "base fell" above also counts wonder, shrine and resign wins; this is the real split (tools/end-reasons.mjs for tables)
  console.log(tallyLine(results.filter((r) => r.end).map((r) => r.end)));
}
// overall strategy win rates
console.log('\nstrategy win rate over all non-mirror games:');
for (const n of names) {
  let w = 0, g = 0;
  for (const r of results) {
    if (r.bots[0] === r.bots[1]) continue;
    const seat = r.bots.indexOf(n);
    if (seat < 0) continue;
    g++;
    if (r.winnerTeam === seat + 1) w++;
  }
  console.log(`  ${n.padEnd(8)} ${pct(w, g)} (${w}/${g})`);
}
// unit usage and efficiency
const U = {};
for (const t of Object.keys(UNITS)) U[t] = { games: 0, built: 0, dmg: 0, kills: 0, killValue: 0, lost: 0, lostValue: 0, withBuilt: 0, withWins: 0, vsNone: 0, vsNoneWins: 0, total: 0 };
let totalPlayers = 0;
for (const r of results) {
  for (const p of r.players) {
    totalPlayers++;
    const opp = r.players.find((q) => q.id !== p.id);
    const won = r.winnerTeam === p.id;
    for (const t of Object.keys(UNITS)) {
      const n = p.trained[t] || 0;
      const u = U[t];
      u.total++;
      if (n > 0) u.games++;
      u.built += n;
      const us = p.unitStats[t];
      if (us) { u.dmg += us.dmg; u.kills += us.kills; u.killValue += us.killValue; u.lost += us.lost; u.lostValue += us.lostValue; }
      if (n >= 5 && !((opp.trained[t] || 0) >= 5)) { u.withBuilt++; if (won) u.withWins++; }
    }
  }
}
console.log('\nunit               in games  avg built  kill value  lost value  efficiency  win% when >=5 and enemy <5   flag');
for (const [t, u] of Object.entries(U)) {
  if (t === 'worker') continue;
  const eff = u.lostValue ? u.killValue / u.lostValue : u.killValue ? 9.99 : 0;
  const share = u.games / u.total;
  const wr = u.withBuilt >= 20 ? u.withWins / u.withBuilt : null;
  let flag = '';
  if (share < 0.05) flag = 'NEVER USED';
  else if (u.lostValue > 300 && eff < 0.5) flag = 'WEAK (efficiency < 0.5)';
  else if (u.lostValue > 300 && eff > 2.5) flag = 'DOMINANT (efficiency > 2.5)';
  else if (share < 0.15) flag = 'RARE (< 15% of games)';
  console.log(`${t.padEnd(16)}${pct(u.games, u.total).padStart(8)}   ${(u.built / u.total).toFixed(1).padStart(8)}  ${String(u.killValue).padStart(10)}  ${String(u.lostValue).padStart(10)}  ${eff.toFixed(2).padStart(10)}  ${wr === null ? '       n/a' : pct(u.withWins, u.withBuilt).padStart(10) + ` (n=${u.withBuilt})`}   ${flag}`);
  out.units[t] = { inGamesShare: share, avgBuilt: u.built / u.total, efficiency: eff, winWhenMass: wr, flag };
}
if (args.json) fs.writeFileSync(args.json, JSON.stringify({ out, results }, null, 1));
