#!/usr/bin/env node
// How do matches end? Table per preset, scripted bots and LLM matches apart.
//   node tools/end-reasons.mjs balance-a.json balance-b.json ... [--data <arena data dir>] [--no-resim] [--by-pair] [--json out.json]
// Inputs
//   balance --json files  (tools/balance.mjs): every game carries its end class (tools/lib/end-cause.mjs). Older files
//                         without it are classified from the result reason only (a "victory" after sudden death is then "unknown").
//   arena data dir        data/matches/*.json + replays/<id>/{result.json,log.jsonl}: finished matches are re-simulated with
//                         the sim version they were recorded with (exact cause); --no-resim reads the logs only.
// Classes: destroyed (elimination by attack), decay (the last building was killed by sudden-death decay), wonder, shrine,
// resign, mutual (mutual destruction), time (time limit), cutoff (run stopped before the end).
// The owner counts decay as "by time": time share = time limit + cutoff + decay.
import fs from 'node:fs';
import path from 'node:path';
import { classifyEnd, tallyEnds, trackEndCause, END_CLASSES, END_LABEL } from './lib/end-cause.mjs';
import { loadReplay, ReplaySim, newGame } from './lib/replay.mjs';
import { countsForRanking } from '../server/results.mjs';

const argv = process.argv.slice(2);
const files = [], flag = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    if (['no-resim', 'by-pair'].includes(k)) flag[k] = true; else flag[k] = argv[++i];
  } else files.push(argv[i]);
}

const groups = []; // { preset, kind: 'bots'|'LLM', label, rows: [{ end, pair, seconds }], notes: [] }

// ---- balance json ----
for (const f of files) {
  const { out, results } = JSON.parse(fs.readFileSync(f, 'utf8'));
  const base = path.basename(f, '.json');
  const meta = out?.meta || {};
  const preset = meta.preset || (/classic/.test(base) ? 'classic' : /fast/.test(base) ? 'fast' : 'unknown');
  const rows = results.filter(countsForRanking).map((r) => ({
    end: r.end || classifyEnd({ reason: r.reason, winnerTeam: r.winnerTeam, seconds: r.seconds }, null, { over: true, sdStartS: meta.suddenDeath || 0 }),
    pair: [...r.bots].sort().join(' vs '), mirror: r.bots[0] === r.bots[1], seconds: r.seconds,
  }));
  const withCause = results.filter((r) => r.end).length;
  groups.push({ preset, kind: 'bots', label: base + (meta.noMirror ? ' (no mirror)' : ''), rows, notes: withCause < results.length ? [`${results.length - withCause} of ${results.length} games have no per-kill info (old file)`] : [] });
}

// ---- arena data ----
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (flag.data) {
  const dir = path.resolve(flag.data), mdir = path.join(dir, 'matches');
  const byKind = new Map();
  for (const mf of fs.readdirSync(mdir).filter((x) => x.endsWith('.json')).sort()) {
    const m = JSON.parse(fs.readFileSync(path.join(mdir, mf), 'utf8'));
    if (m.status !== 'finished' || !countsForRanking(m)) continue;
    const rdir = path.join(dir, 'replays', m.id);
    if (!fs.existsSync(path.join(rdir, 'log.jsonl'))) continue;
    const lines = readJsonl(path.join(rdir, 'log.jsonl'));
    const start = lines.find((l) => l.type === 'start'), resLine = lines.find((l) => l.type === 'result');
    const kind = (m.players || []).some((p) => p.type === 'llm') ? 'LLM' : 'bots';
    const preset = m.rules?.preset || start?.rules?.preset || 'unknown';
    const sd = start?.rules?.suddenDeath || 0;
    let end, how, hashOk = null;
    if (!flag['no-resim']) {
      try {
        const rep = loadReplay(rdir);
        const g = newGame(rep), tr = trackEndCause(g), sim = new ReplaySim(rep, g);
        while (sim.step());
        end = classifyEnd(g.result(), tr.summary(), { over: g.over });
        let want = null;
        try { want = JSON.parse(fs.readFileSync(path.join(rdir, 'result.json'), 'utf8')).hash; } catch { /* no result.json */ }
        hashOk = want === null ? null : g.hash() === want;
        how = `resim ${rep.simVersion}${hashOk === false ? ' HASH MISMATCH (cause unreliable)' : hashOk ? ' hash ok' : ''}`;
      } catch (e) { how = `resim failed (${e.message.split('\n')[0]}), from logs`; }
    }
    if (!end) {
      const resigned = lines.some((l) => l.type === 'cmd' && l.cmd?.cmd === 'resign' && l.ok);
      end = classifyEnd(resLine || {}, null, { over: !!resLine?.over, resigned, sdStartS: sd });
      how = how || 'from logs';
    }
    const names = (m.players || []).map((p) => p.display || p.model).join(' vs ');
    const key = `${preset}|${kind}`;
    if (!byKind.has(key)) { byKind.set(key, { preset, kind, label: path.basename(dir), rows: [], notes: [] }); }
    const grp = byKind.get(key);
    grp.rows.push({ end, pair: names, mirror: false, seconds: resLine?.seconds ?? 0 });
    grp.notes.push(`${m.id.slice(0, 14)} ${names}: ${end.cls}${end.inferred ? ' (inferred)' : ''}, ${resLine?.reason || 'no result'}, ${resLine?.seconds ?? '?'} s, winner team ${resLine?.winnerTeam ?? '?'}; ${how}`);
  }
  groups.push(...byKind.values());
}

// ---- print ----
const pct = (x, n) => (n ? `${x} (${Math.round((100 * x) / n)}%)` : '-');
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function printTable(title, rowDefs) {
  const used = END_CLASSES.filter((k) => k !== 'unknown' || rowDefs.some((r) => r.t.counts[k]));
  const cols = ['source', 'games', ...used.map((k) => END_LABEL[k]), 'time share', '+mutual decay', 'avg len'];
  const lines = rowDefs.map((r) => [r.name, String(r.t.n), ...used.map((k) => pct(r.t.counts[k], r.t.n)), `${(100 * r.t.timeShare).toFixed(0)}%`, `${(100 * r.t.timeShareMutual).toFixed(0)}%`, fmtT(r.avg)]);
  const w = cols.map((c, i) => Math.max(c.length, ...lines.map((l) => l[i].length)));
  console.log(`\n${title}`);
  console.log(cols.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  '));
  for (const l of lines) console.log(l.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  '));
}
const jsonOut = [];
const presets = [...new Set(groups.map((g) => g.preset))];
for (const preset of presets) {
  for (const kind of ['bots', 'LLM']) {
    const gs = groups.filter((g) => g.preset === preset && g.kind === kind);
    if (!gs.length) continue;
    const defs = [];
    for (const g of gs) {
      const mk = (name, rows) => ({ name, t: tallyEnds(rows.map((r) => r.end)), avg: rows.length ? rows.reduce((a, r) => a + r.seconds, 0) / rows.length : 0 });
      const total = mk(g.label, g.rows);
      defs.push(total);
      if (flag['by-pair']) for (const p of [...new Set(g.rows.map((r) => r.pair))].sort()) defs.push(mk('  ' + p, g.rows.filter((r) => r.pair === p)));
      jsonOut.push({ preset, kind, source: g.label, ...total.t });
    }
    printTable(`preset ${preset}, ${kind === 'bots' ? 'scripted bots' : 'LLM matches'}`, defs);
    for (const g of gs) {
      const { decayMutual: dm, stranded } = tallyEnds(g.rows.map((r) => r.end));
      if (stranded) console.log(`  ${g.label}: ${stranded} of the "destroyed" ended with the town center still standing (no unit left, food below 50, nothing queued)`);
      if (dm) console.log(`  ${g.label}: ${dm} mutual destruction(s) caused by decay on both sides (not in "time share", added in "+mutual decay")`);
      for (const n of g.notes) console.log(`  ${g.label}: ${n}`);
    }
  }
}
console.log('\ntime share = time limit + cutoff + decay (owner decision: a base that falls to sudden-death decay counts as "by time"); +mutual decay also adds mutual destruction by decay.');
if (flag.json) fs.writeFileSync(flag.json, JSON.stringify(jsonOut, null, 1));
