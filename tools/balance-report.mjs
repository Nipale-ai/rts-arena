#!/usr/bin/env node
// Summary of a tools/balance.mjs --json file against the balance goals.
// node tools/balance-report.mjs out.json
import fs from 'node:fs';
const { results } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const names = [...new Set(results.flatMap((r) => r.bots))].sort();
const p = (x, n) => (n ? (100 * x / n).toFixed(1).padStart(5) + '%' : '    - ');
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const nm = results.filter((r) => r.bots[0] !== r.bots[1]);
console.log(`${results.length} games (${nm.length} non-mirror)`);
console.log('strategy win rate over non-mirror games (draws count as not won; second number: draws excluded):');
let ok = true;
for (const n of names) {
  let w = 0, g = 0, d = 0;
  for (const r of nm) {
    const s = r.bots.indexOf(n);
    if (s < 0) continue;
    g++;
    if (!r.winnerTeam) d++;
    else if (r.winnerTeam === s + 1) w++;
  }
  const rate = w / g;
  if (rate > 0.6 || rate < 0.4) ok = false;
  console.log(`  ${n.padEnd(8)} ${p(w, g)}  ${p(w, g - d)}  (${w}/${g}, draws ${d})`);
}
const s1 = results.filter((r) => r.winnerTeam === 1).length, s2 = results.filter((r) => r.winnerTeam === 2).length;
const s1nm = nm.filter((r) => r.winnerTeam === 1).length, s2nm = nm.filter((r) => r.winnerTeam === 2).length;
console.log(`seat 1 vs seat 2: all games ${p(s1, s1 + s2)} / ${p(s2, s1 + s2)};  non-mirror ${p(s1nm, s1nm + s2nm)} / ${p(s2nm, s1nm + s2nm)}`);
const fell = (a) => a.filter((r) => !r.reason.startsWith('time') && r.winnerTeam).length;
console.log(`median length all ${fmtT(med(results.map((r) => r.seconds)))}, non-mirror ${fmtT(med(nm.map((r) => r.seconds)))}; base fell all ${p(fell(results), results.length)}, non-mirror ${p(fell(nm), nm.length)}`);
const mir = results.filter((r) => r.bots[0] === r.bots[1]);
console.log(`draws: all ${p(results.filter((r) => !r.winnerTeam).length, results.length)}, mirror ${p(mir.filter((r) => !r.winnerTeam).length, mir.length)}, non-mirror ${p(nm.filter((r) => !r.winnerTeam).length, nm.length)}`);
console.log(`goal check (win rates 40-60): ${ok ? 'OK' : 'FAIL'}`);
console.log('\npairing                 n   A wins  B wins  draw   base fell  median');
const pairs = [...new Set(results.map((r) => r.pair))];
for (const pr of pairs) {
  const rs = results.filter((r) => r.pair === pr);
  const [a, b] = pr.split(' vs ');
  let aw = 0, bw = 0, dr = 0;
  for (const r of rs) {
    if (!r.winnerTeam) dr++;
    else if (a === b) (r.winnerTeam === 1 ? aw++ : bw++);
    else if (r.bots[r.winnerTeam - 1] === a) aw++;
    else bw++;
  }
  console.log(`${(a === b ? a + ' (s1/s2)' : pr).padEnd(22)}${String(rs.length).padStart(4)}  ${p(aw, rs.length)} ${p(bw, rs.length)} ${p(dr, rs.length)}  ${p(fell(rs), rs.length)}  ${fmtT(med(rs.map((r) => r.seconds)))}`);
}

// ---- content 2: how matches end, and how often each strategy used the new content ----
{
  const kinds = { 'base fell': 0, wonder: 0, shrines: 0, 'time limit': 0, other: 0 };
  for (const r of nm) { const k = r.reason === 'wonder' ? 'wonder' : r.reason === 'shrines' ? 'shrines' : r.reason.startsWith('time') ? 'time limit' : r.winnerTeam ? 'base fell' : 'other'; kinds[k]++; }
  console.log('\nhow non-mirror games end: ' + Object.entries(kinds).map(([k, v]) => `${k} ${p(v, nm.length).trim()}`).join(', '));
  console.log('strategy       market  castle  outpost  wonder started  wonder won  shrine win  avg shrine flips');
  for (const n of names) {
    let g = 0, mk = 0, ca = 0, op = 0, ws = 0, ww = 0, sw = 0, flips = 0;
    for (const r of nm) {
      const seat = r.bots.indexOf(n);
      if (seat < 0 || !r.extra) continue;
      g++;
      const b = r.extra.built[seat];
      if (b.market) mk++; if (b.castle) ca++; if (b.outpost) op++;
      if (r.extra.wonders.includes(seat + 1)) ws++;
      if (r.winnerTeam === seat + 1 && r.reason === 'wonder') ww++;
      if (r.winnerTeam === seat + 1 && r.reason === 'shrines') sw++;
      flips += r.extra.flips;
    }
    console.log(`${n.padEnd(14)} ${p(mk, g)} ${p(ca, g)} ${p(op, g)}  ${p(ws, g).padStart(12)}  ${p(ww, g).padStart(9)}  ${p(sw, g).padStart(9)}   ${(flips / Math.max(1, g)).toFixed(1)}`);
  }
}
