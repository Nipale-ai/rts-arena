import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Game } from '../sim/game.mjs';
import { runMatch } from '../tools/run-match.mjs';
import { trackEndCause, classifyEnd, tallyEnds, tallyLine } from '../tools/lib/end-cause.mjs';
import { loadReplay, ReplaySim, newGame } from '../tools/lib/replay.mjs';
import { currentSimVersion, listSnapshots, snapshotDir } from '../sim-versions/lib.mjs';

// short sudden-death schedule (see test/rules.test.mjs): decay from 30 s, every untouched base is gone after ~407 s
const SD = { preset: 'fast', suddenDeath: 30, timeLimitS: 600 };
const tcOf = (g, pid) => [...g.buildings.values()].find((b) => b.owner === pid && b.type === 'town_center');
const runOut = (g) => { while (!g.over && g.t < 6500) g.step(); return g; };
const endOf = (g, tr) => classifyEnd(g.result(), tr.summary(), { over: g.over });

// ---------- the wrapper must not change the game ----------
test('end-cause tracking: the same seed gives the same hashes with and without the wrapper (bots, full game)', () => {
  for (const [seed, bots] of [[3, ['boom', 'turtle']], [9, ['rush', 'towers']]]) {
    const hs = { on: [], off: [] };
    const on = runMatch({ seed, bots, rules: 'fast', trackEnd: true, onTick: (g) => { if (g.t % 500 === 0) hs.on.push(g.hash()); } });
    const off = runMatch({ seed, bots, rules: 'fast', trackEnd: false, onTick: (g) => { if (g.t % 500 === 0) hs.off.push(g.hash()); } });
    assert.ok(on.end && on.endCause, 'tracking on: an end class is reported');
    assert.equal(off.end, null);
    assert.deepEqual(hs.on, hs.off);
    assert.equal(on.game.hash(), off.game.hash());
    assert.equal(on.ticks, off.ticks);
    assert.deepEqual(on.result, off.result);
  }
});

test('end-cause tracking: also identical on a frozen older sim version (golden replay re-simulated with its own sim)', () => {
  const cur = currentSimVersion();
  const snap = listSnapshots().filter((s) => s.id !== cur).map((s) => {
    const gd = path.join(snapshotDir(s.id), 'golden');
    const f = fs.existsSync(gd) ? fs.readdirSync(gd).filter((x) => x.endsWith('.jsonl')).sort()[0] : null;
    return f ? path.join(gd, f) : null;
  }).find(Boolean);
  assert.ok(snap, 'a golden replay of a frozen older version exists');
  const rep = loadReplay(snap);
  assert.notEqual(rep.simVersion, cur, 'it runs on the old sim, not the current one');
  const run = (track) => {
    const g = newGame(rep), tr = track ? trackEndCause(g) : null, sim = new ReplaySim(rep, g), hs = [];
    while (sim.step()) if (g.t % 200 === 0) hs.push(g.hash());
    return { hs, hash: g.hash(), t: g.t, res: g.result(), tr };
  };
  const a = run(true), b = run(false);
  assert.deepEqual(a.hs, b.hs);
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.res, b.res);
  assert.ok(a.hs.length > 0);
});

// ---------- classification ----------
test('classifyEnd: decay (the weaker base crumbles first), destroyed, resign, mutual-by-decay', () => {
  // player 1 starts the decay with a battered town center: it falls first, killed by nobody
  let g = new Game({ seed: 4, rules: SD });
  let tr = trackEndCause(g);
  tcOf(g, 1).hp = 400;
  runOut(g);
  assert.equal(g.endReason, 'victory');
  assert.equal(endOf(g, tr).cls, 'decay');
  const last = tr.summary().elims[0];
  assert.equal(last.p, 1);
  assert.equal(last.last.killer, 0);

  // killed by the enemy before sudden death: destroyed
  g = new Game({ seed: 4, rules: SD });
  tr = trackEndCause(g);
  for (const b of [...g.buildings.values()]) if (b.owner === 2) g.kill(b, 1, 'spearman');
  runOut(g);
  assert.equal(g.winnerTeam, 1);
  assert.equal(endOf(g, tr).cls, 'destroyed');
  assert.equal(g.players[1].kills, 2);

  // the town center shot by the enemy during the decay, house crumbled: the last critical building decides
  g = new Game({ seed: 4, rules: SD });
  tr = trackEndCause(g);
  g.kill(tcOf(g, 2), 1, 'archer');
  runOut(g);
  assert.equal(endOf(g, tr).cls, 'destroyed');

  // resignation
  g = new Game({ seed: 4, rules: SD });
  tr = trackEndCause(g);
  assert.equal(g.command(2, { cmd: 'resign' }).ok, true);
  runOut(g);
  assert.equal(g.winnerTeam, 1);
  assert.equal(endOf(g, tr).cls, 'resign');

  // identical bases decay in the same tick: mutual destruction, caused by decay on both sides
  g = new Game({ seed: 4, rules: SD });
  tr = trackEndCause(g);
  runOut(g);
  const e = endOf(g, tr);
  assert.equal(e.cls, 'mutual');
  assert.equal(e.decayMutual, true);
});

test('classifyEnd: wonder, shrine, time limit, cutoff and the inference without per-kill data', () => {
  assert.equal(classifyEnd({ reason: 'wonder', winnerTeam: 1 }, null).cls, 'wonder');
  assert.equal(classifyEnd({ reason: 'shrines', winnerTeam: 1 }, null).cls, 'shrine');
  assert.equal(classifyEnd({ reason: 'time limit (score)', winnerTeam: 1 }, null).cls, 'time');
  assert.equal(classifyEnd({ reason: 'time limit (tie-break)', winnerTeam: 2 }, null).cls, 'time');
  assert.equal(classifyEnd({ reason: '', winnerTeam: 0 }, null, { over: false }).cls, 'cutoff');
  // from logs only: a "victory" before sudden death is an attack, after it the cause is unknown, a resign command is a resign
  assert.deepEqual(classifyEnd({ reason: 'victory', winnerTeam: 1, seconds: 900 }, null, { over: true, sdStartS: 1320 }), { cls: 'destroyed', inferred: true });
  assert.equal(classifyEnd({ reason: 'victory', winnerTeam: 1, seconds: 1500 }, null, { over: true, sdStartS: 1320 }).cls, 'unknown');
  assert.equal(classifyEnd({ reason: 'victory', winnerTeam: 1, seconds: 100 }, null, { over: true, resigned: true }).cls, 'resign');
});

test('tallyEnds: time share = time limit + cutoff + decay; mutual destruction by decay is added only in the second figure', () => {
  const list = [{ cls: 'destroyed' }, { cls: 'decay' }, { cls: 'time' }, { cls: 'cutoff' }, { cls: 'wonder' }, { cls: 'mutual', decayMutual: true }, { cls: 'mutual', decayMutual: false }, { cls: 'resign' }];
  const t = tallyEnds(list);
  assert.equal(t.n, 8);
  assert.equal(t.timeShare, 3 / 8);
  assert.equal(t.timeShareMutual, 4 / 8);
  assert.equal(t.counts.mutual, 2);
  assert.match(tallyLine(list), /decay 13%.*time share \(time limit \+ cutoff \+ decay\) 38%/);
  // an economy wipe-out (town center left, no units) is an elimination by attack
  const w = tallyEnds([{ cls: 'destroyed', stranded: true }, { cls: 'stranded' }, { cls: 'destroyed' }]);
  assert.deepEqual([w.counts.destroyed, w.stranded], [3, 2]);
});

// ---------- the tool ----------
test('tools/end-reasons.mjs: reads a balance json and an arena data folder (LLM matches apart from bots)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'end-reasons-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // a tiny balance file: three real games with their end class
  const results = [3, 4, 5].map((seed, i) => {
    const r = runMatch({ seed, bots: ['boom', 'boom'], rules: SD, maxMinutes: 12 });
    return { id: i, bots: r.bots, seed, winnerTeam: r.result.winnerTeam, reason: r.result.reason, seconds: r.result.seconds, end: r.end, players: [] };
  });
  const bal = path.join(dir, 'fast-tiny.json');
  fs.writeFileSync(bal, JSON.stringify({ out: { meta: { preset: 'fast', suddenDeath: 30 } }, results }));
  // an arena folder with one finished "LLM" match recorded by the bot runner (log.jsonl + result.json + matches/<id>.json)
  const data = path.join(dir, 'data'), id = '20261030000000-test-vs-test-s5';
  fs.mkdirSync(path.join(data, 'matches'), { recursive: true });
  fs.mkdirSync(path.join(data, 'replays', id), { recursive: true });
  const rec = runMatch({ seed: 5, bots: ['boom', 'turtle'], rules: SD, maxMinutes: 12, log: path.join(data, 'replays', id, 'log.jsonl') });
  fs.writeFileSync(path.join(data, 'replays', id, 'result.json'), JSON.stringify({ id, hash: rec.game.hash() }));
  fs.writeFileSync(path.join(data, 'matches', id + '.json'), JSON.stringify({ id, status: 'finished', godMode: false, players: [{ type: 'llm', display: 'A' }, { type: 'llm', display: 'B' }], rules: { preset: 'fast' } }));
  const run = (...a) => spawnSync(process.execPath, [path.resolve('tools/end-reasons.mjs'), ...a], { encoding: 'utf8' });
  const out = run(bal, '--data', data, '--json', path.join(dir, 'o.json'));
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /preset fast, scripted bots/);
  assert.match(out.stdout, /preset fast, LLM matches/);
  assert.match(out.stdout, /fast-tiny\s+3 /);
  assert.match(out.stdout, /resim sim-[0-9a-f]{12} hash ok/);
  const js = JSON.parse(fs.readFileSync(path.join(dir, 'o.json'), 'utf8'));
  assert.equal(js.length, 2);
  assert.equal(js.find((x) => x.kind === 'LLM').n, 1);
  // the same arena match from the logs only gives a class too
  const out2 = run('--data', data, '--no-resim');
  assert.equal(out2.status, 0, out2.stderr);
  assert.match(out2.stdout, /from logs/);
});
