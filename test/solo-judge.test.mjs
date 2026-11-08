import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveMatch } from '../server/live-match.mjs';
import { judge } from '../tools/solo/judge.mjs';
import { loadScenario, resolveScenarioRules, ROOT } from '../tools/solo/scenario.mjs';

const duel = loadScenario('duel-ladder');
const eco = loadScenario('eco-sprint');
const duel120 = { ...duel, maxGameSeconds: 120 }; // the cutoff the 120 s fixture was played with: a cutoff before the scenario's own is no cutoff (judge: invalid)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-judge-')); // small; the OS cleans the temp folder
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const memo = new Map();
const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
// a judge call with the run's own result.json; a plain call is memoized (every call re-simulates the replay, about 1.5 s)
const J = (dir, scenario, modelSeat, extra = {}) => {
  const run = () => {
    const rf = path.join(dir, 'result.json');
    return judge({ result: fs.existsSync(rf) ? readJson(rf) : null, logPath: dir, scenario, modelSeat, ...extra });
  };
  return Object.keys(extra).length ? run() : once(`J|${dir}|${scenario.id}|${modelSeat}`, run);
};

// A real LiveMatch of two scripted bots under the scenario's own rules (no pacer, no model): the same files a runner leaves behind.
function record(scenario, bots, seed, maxGameSeconds = scenario.maxGameSeconds) {
  const lm = new LiveMatch({ seed, specs: bots.map((b) => `scripted:${b}`), rules: resolveScenarioRules(scenario), maxGameSeconds, outRoot: TMP });
  while (!lm.finished) lm.tick();
  return { dir: lm.dir, result: lm.result };
}

// ---------- real replays (the folder is git-ignored data: found in ROOT/replays, $RTS_REPLAYS or the main checkout) ----------
const REPLAY_ROOTS = [process.env.RTS_REPLAYS, path.join(ROOT, 'replays')].filter(Boolean);
function replay(t, name) {
  for (const root of REPLAY_ROOTS) {
    if (!fs.existsSync(root)) continue;
    const d = fs.readdirSync(root).find((x) => x === name || x.endsWith(name));
    if (d) return path.join(root, d);
  }
  t.skip(`replay *${name} is not available here (looked in ${REPLAY_ROOTS.join(', ')})`);
  return null;
}

// s205, MiniMax (seat 1) vs GLM (seat 2), preset fast, seed 205.
// By hand: result.json says reason "mutual destruction (tie-break)", winnerTeam 2, both players alive:false. The sim crowned GLM only by
// the seed (sim/game.mjs:830). The re-simulation shows both town centers fell at tick 16664 with no killer (sudden-death decay, rules
// suddenDeath 1320). Mutual destruction is never a win, so GLM's "winnerTeam 2" does not make a win for seat 2: both seats = loss.
test('real replay s205: mutual destruction decided by a seed tie-break is no win for either seat', (t) => {
  const dir = replay(t, 's205');
  if (!dir) return;
  const res = readJson(path.join(dir, 'result.json'));
  assert.equal(res.reason, 'mutual destruction (tie-break)');
  assert.equal(res.winnerTeam, 2);
  for (const seat of [1, 2]) {
    const j = J(dir, duel, seat);
    assert.equal(j.outcome, 'loss', `seat ${seat}`);
    assert.equal(j.endClass, 'mutual');
    assert.equal(j.end.source, 'resim');
    assert.equal(j.end.decayMutual, true, 'both bases crumbled');
    assert.equal(j.metrics.winnerTeam, 2, 'the tie-break winner is reported but not counted');
    assert.match(j.reason, /mutual destruction.*no victory/);
  }
  const glm = J(dir, duel, 2);
  assert.equal(glm.metrics.gameSeconds, 1667);
  assert.equal(glm.metrics.decisions, 7);
  assert.equal(glm.metrics.invalidCommands, 3);
  assert.equal(glm.metrics.gathered.total, 1755 + 4054 + 1687 + 2940);
  assert.equal(glm.metrics.tierFinal, 2);
  assert.equal(glm.metrics.cutOffReplies, 1, 'one reply of GLM hit the token limit (io.jsonl finish_reason length)');
  assert.ok(glm.notes.some((n) => /cut off at the token limit/.test(n)));
});

// s206, same two models, preset fast, seed 206.
// By hand: result.json says "victory", winnerTeam 2, GLM alive, MiniMax dead at 1649 s. But the sudden death of the fast preset began at
// 1320 s, and the re-simulation shows the last production building of MiniMax (a siege workshop) was killed at tick 16486 by nobody
// (killer 0): it crumbled. That is decay, not destruction, so GLM has NO win here. (The task text called s206 a destruction win;
// the replay does not support that.) Without the re-simulation the judge cannot tell, and then it must not call it a win either.
test('real replay s206: the last base crumbled in sudden death: decay, no win (and no win without proof)', (t) => {
  const dir = replay(t, 's206');
  if (!dir) return;
  const glm = J(dir, duel, 2);
  assert.equal(glm.outcome, 'loss');
  assert.equal(glm.endClass, 'decay');
  assert.equal(glm.end.source, 'resim');
  assert.match(glm.reason, /sudden-death decay/);
  assert.equal(glm.metrics.winnerTeam, 2);
  assert.equal(glm.metrics.modelAlive, true);
  assert.equal(glm.metrics.rulesMatchScenario, false, 'this match ran with sudden death, the scenario has it off');
  assert.ok(glm.notes.some((n) => /recorded rules differ from the scenario at: .*suddenDeath/.test(n)));
  assert.equal(J(dir, duel, 1).outcome, 'loss');
  // no re-simulation: the result alone cannot prove a destruction after minute 22 -> invalid for the claimed winner and for the loser (blind for the result)
  const blind2 = J(dir, duel, 2, { resim: false });
  assert.equal(blind2.outcome, 'invalid');
  assert.equal(blind2.endClass, 'unknown');
  assert.match(blind2.reason, /cannot be confirmed/);
  const blind1 = J(dir, duel, 1, { resim: false });
  assert.equal(blind1.outcome, 'invalid');
  assert.match(blind1.reason, /cannot be classified/);
});

// s207, same two models, preset war (no sudden death, no wonder, no shrines), seed 207.
// By hand: result.json "victory", winnerTeam 2 (GLM) at 840 s, MiniMax dead. The re-simulation: the last production building of MiniMax
// (siege workshop) was killed at tick 8394 by player 2 with a ram. War has no decay, so this is a real destruction: GLM wins, MiniMax loses.
test('real replay s207: destroyed by a ram under the war preset: win for GLM, loss for MiniMax', (t) => {
  const dir = replay(t, 's207');
  if (!dir) return;
  const res = readJson(path.join(dir, 'result.json'));
  const glm = J(dir, duel, 2), mm = J(dir, duel, 1);
  assert.equal(glm.outcome, 'win');
  assert.equal(glm.endClass, 'destroyed');
  assert.equal(glm.end.source, 'resim');
  assert.equal(glm.end.stranded, false);
  assert.match(glm.reason, /^win: the opponent was destroyed at 14:00/);
  assert.equal(mm.outcome, 'loss');
  assert.equal(mm.endClass, 'destroyed');
  assert.match(mm.reason, /^loss: the model's base was destroyed/);
  // metrics are wired to result.json
  const pl = (id) => res.players.find((p) => p.id === id), ag = (id) => res.agents.find((a) => a.pid === id);
  assert.equal(glm.metrics.gameSeconds, res.seconds);
  assert.equal(glm.metrics.decisions, ag(2).rounds);
  assert.equal(glm.metrics.invalidCommands, ag(2).commands_invalid);
  assert.equal(glm.metrics.decisionsPerMinute, +(ag(2).rounds / (res.seconds / 60)).toFixed(2));
  assert.equal(glm.metrics.latencyMedianMs, ag(2).latency_ms.median);
  assert.equal(glm.metrics.gathered.total, Object.values(pl(2).gathered).reduce((a, b) => a + b, 0));
  assert.equal(glm.metrics.kills, Object.values(pl(2).unitStats).reduce((a, u) => a + (u.kills || 0), 0));
  assert.equal(glm.metrics.losses, Object.values(pl(2).unitStats).reduce((a, u) => a + (u.lost || 0), 0));
  assert.equal(glm.metrics.killValue, pl(2).killValue);
  assert.equal(glm.metrics.lostValue, pl(2).lostValue);
  assert.equal(mm.metrics.decisions, ag(1).rounds);
  assert.equal(glm.metrics.modelAlive, true);
  assert.equal(mm.metrics.modelAlive, false);
  // milestones: first tick with the tier, taken from the re-simulation; the state lines (10 s steps) agree to within 10 s
  const exact = glm.metrics.tierReachedAtS, blind = J(dir, duel, 2, { resim: false });
  assert.equal(glm.metrics.tierTimeSource, 'resim (exact)');
  assert.equal(blind.metrics.tierTimeSource, 'state lines (10 s steps)');
  for (const tier of [2, 3]) {
    assert.ok(exact[tier] !== null && exact[tier] > 0);
    const gap = blind.metrics.tierReachedAtS[tier] - exact[tier];
    assert.ok(gap >= 0 && gap <= 10, `tier ${tier}: exact ${exact[tier]}, state lines ${blind.metrics.tierReachedAtS[tier]}`);
  }
  // the war preset cannot decay, so even the log alone proves the destruction (no sudden death in the recorded rules)
  assert.equal(blind.outcome, 'win');
  assert.equal(blind.end.inferred, true);
});

// scripted bots, stamped replay (turtle seat 1 vs boom seat 2, fast, seed 61): result.json victory, winnerTeam 1 at 1109 s; the
// re-simulation shows the stables of player 2 were killed by player 1 with a mortar at tick 11083: destroyed -> seat 1 wins, seat 2 loses.
test('real replay of two scripted bots (stamped): exact destruction win for turtle', (t) => {
  const dir = replay(t, '20261026212425-turtle-vs-boom-s61');
  if (!dir) return;
  const a = J(dir, duel, 1), b = J(dir, duel, 2);
  assert.equal(a.outcome, 'win');
  assert.equal(a.endClass, 'destroyed');
  assert.equal(a.end.source, 'resim');
  assert.equal(b.outcome, 'loss');
  assert.equal(a.metrics.decisions, null, 'a scripted bot has no model rounds');
  assert.equal(a.metrics.invalidCommands, null);
  assert.ok(a.notes.some((n) => /no agent summary for seat 1/.test(n)) || a.metrics.decisions === null);
});

// scripted bots, old folder without result.json and without sim stamp (rush seat 1 vs boom seat 2, seed 3).
// By hand: the log's result line says victory, winnerTeam 2, 1353 s. The start line has no rules, which is the classic default: no sudden
// death exists, and the log holds no resign command, so a "victory" can only be a destruction. It cannot be re-simulated (unstamped),
// so the verdict is marked inferred.
test('real replay of two scripted bots (old, unstamped, no result.json): inferred destruction win from the log alone', (t) => {
  const dir = replay(t, 'scripted-rush-boom-s3');
  if (!dir) return;
  const w = J(dir, duel, 2), l = J(dir, duel, 1);
  assert.equal(w.outcome, 'win');
  assert.equal(w.endClass, 'destroyed');
  assert.equal(w.end.source, 'log');
  assert.equal(w.end.inferred, true);
  assert.equal(w.metrics.gameSeconds, 1353);
  assert.equal(w.metrics.rulesMatchScenario, null, 'no rules recorded, nothing to compare');
  assert.ok(w.notes.some((n) => /no result\.json/.test(n)));
  assert.ok(w.notes.some((n) => /no sim version stamp/.test(n)));
  assert.equal(l.outcome, 'loss');
});

// rush vs boom, classic, 60 s time limit: result "time limit (score)", winnerTeam 1 by score. A score lead is not a destruction.
test('real replay with a time limit: the score winner has no win', (t) => {
  const dir = replay(t, '20261102172309-rush-vs-boom-s1');
  if (!dir) return;
  for (const seat of [1, 2]) {
    const j = J(dir, duel, seat);
    assert.equal(j.outcome, 'loss');
    assert.equal(j.endClass, 'time');
    assert.match(j.reason, /time limit/);
  }
});

// ---------- runs recorded here, under the scenario rules ----------
test('duel under the scenario rules: a base falls to an attack, the winner seat wins, the other loses; the rules match the scenario', () => {
  const games = [
    once('rb', () => record(duel, ['rush', 'boom'], duel.seeds.tune[0])),
    once('bb', () => record(duel, ['boom', 'boom'], duel.seeds.tune[3])),
  ];
  let decided = 0;
  for (const g of games) {
    const r = readJson(path.join(g.dir, 'result.json'));
    for (const seat of [1, 2]) {
      const j = J(g.dir, duel, seat);
      assert.equal(j.metrics.rulesMatchScenario, true, j.notes.join(' / '));
      assert.equal(j.end.source, 'resim');
      assert.equal(j.metrics.pacerDropped, 0);
      if (r.over && r.reason === 'victory') {
        // sudden death is off in the scenario, so a victory can only be a destruction
        assert.equal(j.endClass, 'destroyed');
        assert.equal(j.outcome, r.winnerTeam === seat ? 'win' : 'loss');
      } else {
        assert.ok(['cutoff', 'mutual'].includes(j.endClass), j.endClass);
        assert.notEqual(j.outcome, 'win');
      }
      assert.ok(j.metrics.gameSeconds <= duel.maxGameSeconds);
    }
    if (r.reason === 'victory') decided++;
  }
  assert.ok(decided >= 1, 'at least one fixture game ends by destruction, so the win path is tested');
});

test('invariant: only a destroyed end with the model seat as winner is a win', () => {
  const dirs = [once('rb', () => record(duel, ['rush', 'boom'], duel.seeds.tune[0])), once('bb', () => record(duel, ['boom', 'boom'], duel.seeds.tune[3])), once('cut', () => record(duel120, ['turtle', 'rush'], duel.seeds.tune[2]))];
  for (const [i, g] of dirs.entries()) for (const seat of [1, 2]) {
    const j = J(g.dir, i === 2 ? duel120 : duel, seat), r = g.result;
    if (j.outcome === 'win') {
      assert.equal(j.endClass, 'destroyed');
      assert.equal(r.winnerTeam, seat);
    }
    if (j.endClass !== 'destroyed') assert.notEqual(j.outcome, 'win');
  }
});

test('a stranded base counts as destroyed (plan A1) and is marked', () => {
  const g = once('bb', () => record(duel, ['boom', 'boom'], duel.seeds.tune[3]));
  const r = readJson(path.join(g.dir, 'result.json'));
  assert.equal(r.reason, 'victory');
  const w = J(g.dir, duel, r.winnerTeam);
  assert.equal(w.outcome, 'win');
  assert.equal(w.end.stranded, true, 'the loser kept its town center but had no unit, no food and nothing queued');
  assert.match(w.reason, /stranded/);
});

test('cutoff: the scenario limit ends the game with no winner; outcome "cutoff" for both seats', () => {
  const g = once('cut', () => record(duel120, ['turtle', 'rush'], duel.seeds.tune[2]));
  const r = readJson(path.join(g.dir, 'result.json'));
  assert.equal(r.reason, 'cutoff');
  assert.equal(r.over, false);
  for (const seat of [1, 2]) {
    const j = J(g.dir, duel120, seat);
    assert.equal(j.outcome, 'cutoff');
    assert.equal(j.endClass, 'cutoff');
    assert.match(j.reason, /cutoff came at 2:00/);
    assert.equal(j.metrics.gameSeconds, 120);
  }
});

test('eco sprint: measured from numbers, no win or loss word, tier 3 time and gathered amount', () => {
  const g = once('eco', () => record(eco, ['boom', 'boom'], eco.seeds.tune[0]));
  const r = readJson(path.join(g.dir, 'result.json'));
  assert.equal(r.reason, 'cutoff', 'the 600 s cutoff is the normal end of an eco run');
  for (const seat of [1, 2]) {
    const j = J(g.dir, eco, seat);
    assert.equal(j.outcome, 'measured');
    assert.equal(j.endClass, 'cutoff');
    assert.doesNotMatch(j.reason, /\b(win|won|loss|lost|lose|defeat|victory)\b/i, j.reason);
    const mine = r.players.find((p) => p.id === seat);
    assert.equal(j.metrics.gatheredTotal, Object.values(mine.gathered).reduce((a, b) => a + b, 0));
    assert.deepEqual(Object.keys(j.metrics.tierReachedAtS), ['2', '3']);
    assert.equal(j.metrics.tierTarget, 3);
    assert.equal(j.metrics.tierTargetAtS, j.metrics.tierReachedAtS[3]);
    assert.equal(j.metrics.tierTimeSource, 'resim (exact)');
    assert.equal(j.metrics.gameSeconds, 600);
    assert.match(j.reason, /^tier 3 (not reached|reached at \d+:\d\d); \d+ gathered in 10:00$/);
    if (j.metrics.tierReachedAtS[2] !== null) assert.ok(j.metrics.tierReachedAtS[2] > 45, 'tier 2 takes 45 s to research');
  }
});

test('eco sprint on a real replay that ended early: still measured, with a note', (t) => {
  const dir = replay(t, 's207');
  if (!dir) return;
  const j = J(dir, eco, 2);
  assert.equal(j.outcome, 'measured');
  assert.equal(j.metrics.tierTargetAtS, 670, 'GLM reached tier 3 at tick 6700 = 670 s');
  assert.equal(j.reason, 'tier 3 reached at 11:10; 13505 gathered in 14:00');
  assert.ok(j.notes.some((n) => /ended before the cutoff/.test(n)));
  const lost = J(dir, eco, 1);
  assert.equal(lost.outcome, 'measured');
  assert.equal(lost.metrics.tierTargetAtS, null);
  assert.match(lost.reason, /^tier 3 not reached; 8997 gathered/);
  assert.ok(lost.notes.some((n) => /seat was eliminated/.test(n)));
});

// ---------- invalid runs ----------
function copyRun(src, mutate) {
  const dir = fs.mkdtempSync(path.join(TMP, 'run-'));
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  mutate?.(dir);
  return dir;
}

test('invalid: pacer.dropped > 0, a crash, a missing log, no result, disagreeing files', () => {
  const g = once('cut', () => record(duel120, ['turtle', 'rush'], duel.seeds.tune[2]));
  const res = readJson(path.join(g.dir, 'result.json'));
  let j = judge({ result: res, logPath: g.dir, scenario: duel120, modelSeat: 1, runMeta: { pacer: { dropped: 3, maxDelayMs: 900 } } });
  assert.equal(j.outcome, 'invalid');
  assert.match(j.reason, /dropped 3 tick/);
  j = judge({ result: { ...res, pacer: { dropped: 1 } }, logPath: g.dir, scenario: duel120, modelSeat: 1 });
  assert.equal(j.outcome, 'invalid', 'pacer.dropped in the result counts too');
  j = judge({ result: res, logPath: g.dir, scenario: duel120, modelSeat: 1, runMeta: { pacer: { dropped: 0 } } });
  assert.equal(j.outcome, 'cutoff', 'no dropped ticks: valid');
  j = judge({ result: res, logPath: g.dir, scenario: duel120, modelSeat: 1, runMeta: { crashed: true, error: 'ECONNRESET' } });
  assert.equal(j.outcome, 'invalid');
  assert.match(j.reason, /crashed: ECONNRESET/);
  j = judge({ result: res, logPath: path.join(TMP, 'does-not-exist'), scenario: duel120, modelSeat: 1 });
  assert.equal(j.outcome, 'invalid');
  assert.match(j.reason, /no log/);
  // the match never reached its end: no result line, no result.json
  const noRes = copyRun(g.dir, (d) => {
    const lines = fs.readFileSync(path.join(d, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).filter((l) => JSON.parse(l).type !== 'result');
    fs.writeFileSync(path.join(d, 'log.jsonl'), lines.join('\n') + '\n');
  });
  j = judge({ result: null, logPath: noRes, scenario: duel120, modelSeat: 1 });
  assert.equal(j.outcome, 'invalid');
  assert.match(j.reason, /no result: the run was aborted/);
  // result.json and the log tell different stories
  j = judge({ result: { ...res, winnerTeam: 2, reason: 'victory' }, logPath: g.dir, scenario: duel120, modelSeat: 1 });
  assert.equal(j.outcome, 'invalid');
  assert.match(j.reason, /disagree/);
  // a log that ends in a half written line is read up to there, with a note
  const cutLine = copyRun(g.dir, (d) => fs.appendFileSync(path.join(d, 'log.jsonl'), '{"type":"cmd","t":1'));
  j = judge({ result: res, logPath: cutLine, scenario: duel120, modelSeat: 1 });
  assert.equal(j.outcome, 'cutoff');
  assert.ok(j.notes.some((n) => /last log line is cut off/.test(n)));
  // a broken line in the middle is not repaired
  const broken = copyRun(g.dir, (d) => { const l = fs.readFileSync(path.join(d, 'log.jsonl'), 'utf8').split('\n'); l[3] = '{oops'; fs.writeFileSync(path.join(d, 'log.jsonl'), l.join('\n')); });
  j = judge({ result: res, logPath: broken, scenario: duel120, modelSeat: 1 });
  assert.equal(j.outcome, 'invalid');
  assert.match(j.reason, /unreadable log/);
});

test('a run stopped from outside is invalid, whatever the log shows (stopped, dead model server); a cutoff before the scenario cutoff is no cutoff', () => {
  const g = once('cut', () => record(duel120, ['turtle', 'rush'], duel.seeds.tune[2]));
  const res = readJson(path.join(g.dir, 'result.json'));
  for (const abort of ['stopped', 'model_server_dead']) {
    for (const seat of [1, 2]) {
      const j = judge({ result: res, logPath: g.dir, scenario: duel120, modelSeat: seat, runMeta: { abort, pacer: { dropped: 0 } } });
      assert.equal(j.outcome, 'invalid', abort);
      assert.match(j.reason, new RegExp(`stopped before the match ended \\(${abort}\\)`));
    }
  }
  // the same replay judged under the real scenario (cutoff 1500 s): the match ended at 2:00, so this was no cutoff of the scenario
  for (const sc of [duel, eco]) {
    const j = judge({ result: res, logPath: g.dir, scenario: sc, modelSeat: 1 });
    assert.equal(j.outcome, 'invalid', sc.id);
    assert.equal(j.endClass, 'cutoff');
    assert.match(j.reason, /stopped at 2:00, before the scenario cutoff at (25:00|10:00)/);
  }
  // a real cutoff stays a cutoff
  assert.equal(judge({ result: res, logPath: g.dir, scenario: duel120, modelSeat: 1 }).outcome, 'cutoff');
});

test('eco with an end summary still gets the exact tier time (re-simulated once)', () => {
  const g = once('eco', () => record(eco, ['boom', 'boom'], eco.seeds.tune[0]));
  const res = readJson(path.join(g.dir, 'result.json'));
  const exact = judge({ result: res, logPath: g.dir, scenario: eco, modelSeat: 1, endSummary: { elims: [] } });
  assert.equal(exact.metrics.tierTimeSource, 'resim (exact)');
  assert.equal(exact.end.source, 'endSummary');
  const coarse = judge({ result: res, logPath: g.dir, scenario: eco, modelSeat: 1, endSummary: { elims: [] }, resim: false });
  assert.match(coarse.metrics.tierTimeSource, /10 s steps/);
  // tier 3 is not reached by two boom bots in 600 s; tier 2 is (515 s on this fixture), so the comparison uses tier 2
  const [e2, c2] = [exact.metrics.tierReachedAtS[2], coarse.metrics.tierReachedAtS[2]];
  assert.ok(e2 !== null && c2 !== null, 'tier 2 is reached on this fixture');
  assert.ok(c2 >= e2 && c2 - e2 <= 10, `the coarse value is an upper bound within 10 s (exact ${e2}, coarse ${c2})`);
  assert.notEqual(e2 % 10, 0, 'the exact value is not a multiple of the 10 s step');
  assert.equal(c2 % 10, 0);
});

test('the judge accepts the log.jsonl path as well as the folder, and refuses bad calls', () => {
  const g = once('cut', () => record(duel120, ['turtle', 'rush'], duel.seeds.tune[2]));
  assert.equal(judge({ result: g.result, logPath: path.join(g.dir, 'log.jsonl'), scenario: duel120, modelSeat: 2 }).outcome, 'cutoff');
  assert.throws(() => judge({ result: g.result, logPath: g.dir, scenario: duel120, modelSeat: 3 }), /modelSeat 3 but the match has 2 seats/);
  assert.throws(() => judge({ result: g.result, logPath: g.dir, scenario: duel120, modelSeat: 0 }), TypeError);
  assert.throws(() => judge({ result: g.result, logPath: g.dir, scenario: null, modelSeat: 1 }), /needs a scenario/);
  assert.throws(() => judge({ result: g.result, logPath: g.dir, scenario: { judge: { kind: 'points' } }, modelSeat: 1 }), TypeError);
  assert.throws(() => judge({ result: g.result, scenario: duel120, modelSeat: 1 }), /needs logPath/);
});

// ---------- end class from an end summary or from the rules alone ----------
function fakeRun({ rules, reason = 'victory', winnerTeam = 2, seconds = 500, over = true, stamp = false, extraCmds = [] }) {
  const dir = fs.mkdtempSync(path.join(TMP, 'fake-'));
  const players = [1, 2].map((id) => ({ id, team: id, alive: id === winnerTeam, score: 10, killValue: 0, lostValue: 0, gathered: { food: 100, wood: 0, stone: 0, gold: 0 }, tier: 1, trained: {}, unitStats: {} }));
  const res = { over, winnerTeam, reason, tick: seconds * 10, seconds, players };
  const lines = [{ type: 'start', seed: 1, bots: ['a', 'b'], teams: [1, 2], ...(rules ? { rules } : {}) }, ...extraCmds, { type: 'result', ...res }];
  fs.writeFileSync(path.join(dir, 'log.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, res };
}
const SD_RULES = { preset: 'fast', suddenDeath: 100, timeLimitS: 1800 };

test('an end summary from the live run is used as is (no re-simulation)', () => {
  const run = fakeRun({ rules: SD_RULES });
  const sum = (cause) => ({ elims: [{ p: 1, team: 1, t: 5000, reason: 'destroyed', cause, last: { t: 4990, type: 'town_center', killer: cause === 'decay' ? 0 : 2, src: null } }] });
  const decay = judge({ result: run.res, logPath: run.dir, scenario: duel, modelSeat: 2, endSummary: sum('decay') });
  assert.equal(decay.outcome, 'loss');
  assert.equal(decay.endClass, 'decay');
  assert.equal(decay.end.source, 'endSummary');
  const killed = judge({ result: run.res, logPath: run.dir, scenario: duel, modelSeat: 2, endSummary: sum('destroyed') });
  assert.equal(killed.outcome, 'win');
  const stranded = judge({ result: run.res, logPath: run.dir, scenario: duel, modelSeat: 2, endSummary: sum('stranded') });
  assert.equal(stranded.outcome, 'win');
  assert.equal(stranded.end.stranded, true);
  const resign = judge({ result: run.res, logPath: run.dir, scenario: duel, modelSeat: 2, endSummary: sum('resign') });
  assert.equal(resign.outcome, 'loss');
  assert.equal(resign.endClass, 'resign');
});

test('without proof there is no win: unknown end class, sudden death in the rules, no re-simulation', () => {
  const run = fakeRun({ rules: SD_RULES });
  const w = judge({ result: run.res, logPath: run.dir, scenario: duel, modelSeat: 2 });
  assert.equal(w.outcome, 'invalid');
  assert.equal(w.endClass, 'unknown');
  assert.match(w.reason, /cannot be confirmed/);
  // blind for the result: the rule that reruns an unconfirmed end does not look at who won (an unknown class is invalid for the loser too)
  const l = judge({ result: run.res, logPath: run.dir, scenario: duel, modelSeat: 1 });
  assert.equal(l.outcome, 'invalid');
  assert.equal(l.endClass, 'unknown');
  assert.match(l.reason, /cannot be classified/);
  // a victory before the sudden death starts can only be an attack
  const early = fakeRun({ rules: { ...SD_RULES, suddenDeath: 900 }, seconds: 500 });
  assert.equal(judge({ result: early.res, logPath: early.dir, scenario: duel, modelSeat: 2 }).outcome, 'win');
  // no sudden death in the rules: also an attack, unless somebody resigned
  const calm = fakeRun({ rules: { preset: 'war', suddenDeath: 0 } });
  assert.equal(judge({ result: calm.res, logPath: calm.dir, scenario: duel, modelSeat: 2 }).outcome, 'win');
  const gg = fakeRun({ rules: { preset: 'war', suddenDeath: 0 }, extraCmds: [{ type: 'cmd', t: 4000, p: 1, cmd: { cmd: 'resign' }, ok: true }] });
  const r = judge({ result: gg.res, logPath: gg.dir, scenario: duel, modelSeat: 2 });
  assert.equal(r.outcome, 'loss');
  assert.equal(r.endClass, 'resign');
  // the technical stop of the war preset has no winner and is a time end
  const tech = fakeRun({ rules: { preset: 'war', suddenDeath: 0 }, reason: 'no result (technical time limit)', winnerTeam: 0, seconds: 3600 });
  const tj = judge({ result: tech.res, logPath: tech.dir, scenario: duel, modelSeat: 1 });
  assert.equal(tj.endClass, 'time');
  assert.equal(tj.outcome, 'loss');
});

test('every outcome has an end class and a reason; the eco verdict never uses a win or loss outcome', () => {
  const g = once('eco', () => record(eco, ['boom', 'boom'], eco.seeds.tune[0]));
  const d = once('cut', () => record(duel120, ['turtle', 'rush'], duel.seeds.tune[2]));
  for (const j of [J(g.dir, eco, 1), J(g.dir, eco, 2), J(d.dir, duel120, 1)]) {
    assert.ok(['win', 'loss', 'cutoff', 'invalid', 'measured'].includes(j.outcome));
    assert.ok(j.reason.length > 10);
    assert.ok(Array.isArray(j.notes));
    assert.ok(typeof j.metrics === 'object');
  }
  assert.ok(!['win', 'loss'].includes(J(g.dir, eco, 1).outcome));
});
