// rts-llm-1.8 harness: raw completion + results in io.jsonl, one retry for a reply without orders, memory, held purchases,
// clock / combat digest / events, decode tok/s measured the same way for every server, error kinds, clearer sim messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chat, speedOf, resolveConfig } from '../client.mjs';
import { LlmPlayer, errorKind, HOLD_MAX_TICKS } from '../player.mjs';
import { startMock } from '../mock-server.mjs';
import { buildSystemPrompt, PROMPT_VERSION } from '../prompt.mjs';
import { LiveMatch } from '../../../server/live-match.mjs';
import { observe } from '../../../sim/observe.mjs';
import { Game } from '../../../sim/game.mjs';
import { resolveRules } from '../../../sim/rules.mjs';
import { richGame, stepN, tc, workers } from '../../../test-support/helpers.mjs';

const cfg = (name, url, extra = {}) => ({ name, base_url: url, model: name.toLowerCase(), hardware: 'mock', timeout_s: 8, ...extra });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const users = (m) => m.stats.bodies.map((b) => JSON.parse(b.messages[1].content));

// an SSE server with exact chunk timing: first token chunk after `first` ms, last after `last` ms, then usage
function sseServer({ first = 150, last = 650, completion = 101, timings = null, extra = {} } = {}) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const w = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const ch = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
      w(ch({ role: 'assistant' }));
      await new Promise((r) => setTimeout(r, first));
      w(ch({ reasoning_content: 'thinking' }));
      await new Promise((r) => setTimeout(r, last - first));
      w(ch({ tool_calls: [{ index: 0, id: 'c0', function: { name: 'note', arguments: '{"text":"hi"}' } }] }));
      w(ch({}, 'tool_calls'));
      w({ choices: [], usage: { prompt_tokens: 5000, completion_tokens: completion, completion_tokens_details: { reasoning_tokens: completion - 12 } }, ...(timings ? { timings } : {}), ...extra });
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

// ---------- H7: tok/s ----------
test('tok/s: one decode rate from streamed token timing, the same for a server with and without its own timings', async () => {
  const withTimings = await sseServer({ timings: { predicted_per_second: 999, predicted_ms: 1000, prompt_ms: 5 } });
  const without = await sseServer({ extra: { tensorfold: { tokens_per_second: 77 } } });
  try {
    const out = [];
    for (const s of [withTimings, without]) {
      const c = resolveConfig(cfg('x', s.url));
      const res = await chat(c, [{ role: 'user', content: 'hi' }], []);
      out.push(speedOf(res));
      assert.equal(res.message.tool_calls[0].function.name, 'note', 'stream assembled into a normal message');
      assert.equal(res.message.reasoning_content, 'thinking');
    }
    for (const sp of out) {
      assert.equal(sp.tok_s_source, 'stream-decode');
      // (101 - 1) tokens between the first chunk (150 ms) and the last (650 ms) = 200 tok/s, whatever the server reports
      assert.ok(sp.tok_s > 160 && sp.tok_s < 240, 'tok_s ' + sp.tok_s);
      assert.ok(sp.ttft_ms >= 120 && sp.ttft_ms < 400, 'ttft ' + sp.ttft_ms);
      assert.equal(sp.visible_tokens, 12);
    }
    assert.equal(out[0].tok_s_server, 999, 'the server figure is kept apart, as a cross-check');
    assert.equal(out[1].tok_s_server, 77);
  } finally { await withTimings.close(); await without.close(); }
});

test('tok/s: a server that refuses streaming is asked again without it; the figure is labelled wall-latency', async () => {
  const m = await startMock({ delayMs: 10, noStream: true, strategy: 'boom' });
  try {
    const live = new LiveMatch({ seed: 7, p1: cfg('NoStream', m.url), p2: 'scripted:turtle', record: false, maxGameSeconds: 30 });
    await live.run({ speed: 30 });
    const s = live.result.agents[0];
    assert.equal(s.stream_fallback, 1);
    assert.ok(s.requests > 3 && s.replies > 3);
    assert.equal(s.tok_s_method, 'wall-latency');
    assert.equal(s.tok_s_avg, null, 'no decode figure when nothing was streamed');
    assert.ok(m.stats.bodies.slice(1).every((b) => b.stream === false), 'later requests do not stream');
  } finally { await m.close(); }
});

test('tok/s: summary says how it was measured and carries the server figure as cross-check', async () => {
  const m = await startMock({ delayMs: 10, strategy: 'boom', streamTokS: 2000 });
  try {
    const live = new LiveMatch({ seed: 7, p1: cfg('Str', m.url), p2: 'scripted:turtle', record: false, maxGameSeconds: 30 });
    await live.run({ speed: 30 });
    const s = live.result.agents[0];
    assert.match(s.tok_s_method, /^stream-decode/);
    assert.ok(s.tok_s_avg > 100, 'decode rate ' + s.tok_s_avg);
    assert.equal(s.tok_s_server_avg, 60);
    assert.ok(['stream-decode', 'wall-latency'].includes(live.slots[0].agent.hud().tokSource));
  } finally { await m.close(); }
});

// ---------- H1: raw completion, results, retry ----------
test('empty reply (only an empty note): re-requested once at once with tool_errors; counted; raw first reply stored; results in io.jsonl', async () => {
  const m = await startMock({ delayMs: 15, strategy: 'boom', emptyEvery: 3, script: () => [{ name: 'note', args: { text: 'wood' } }, { name: 'gather', args: { resource: 'wood', count: 1 } }] });
  try {
    const out = tmp('rts-h18-');
    const live = new LiveMatch({ seed: 9, p1: cfg('Empty', m.url), p2: 'scripted:turtle', outRoot: out, maxGameSeconds: 120 });
    await live.run({ speed: 40 });
    const s = live.result.agents[0];
    assert.ok(s.empty_replies >= 3, 'empty replies ' + s.empty_replies);
    assert.ok(s.retries >= 3 && s.retries <= s.empty_replies);
    assert.ok(s.retry_ok >= 2, 'retries that gave orders ' + s.retry_ok);
    assert.ok(s.retry_ok + s.retry_failed >= s.retries - 1, 'every retry but a last unfinished one has an outcome');
    // the retry request carries tool_errors no_orders and the same round number
    const retried = users(m).filter((o) => o.meta.retry);
    assert.ok(retried.length >= 3);
    for (const o of retried) assert.ok(o.tool_errors.some((e) => e.error === 'no_orders' && /no game order/.test(e.message)));
    // one io line per round; the retried rounds keep the raw first reply
    const io = readJsonl(path.join(live.dir, 'io.jsonl'));
    assert.equal(new Set(io.map((e) => `${e.p}:${e.n}`)).size, io.length, 'one line per round');
    const r = io.find((e) => e.retry && e.retry.first.response.message.tool_calls[0].function.arguments === '{}');
    assert.ok(r, 'a retried round after an empty note');
    assert.equal(r.retry.reason, 'no_orders');
    assert.equal(r.retry.first.response.message.tool_calls[0].function.arguments, '{}', 'raw tool call text of the empty reply');
    assert.ok(r.retry.first.response.message.reasoning_content.includes('Let me write'), 'raw reasoning of the empty reply');
    assert.ok(r.attempt === 2 && r.n_commands > 0);
    // per-turn command results
    const withRes = io.filter((e) => Array.isArray(e.results) && e.results.length);
    assert.ok(withRes.length > 5);
    assert.ok(withRes[0].results.every((x) => typeof x.ok === 'boolean' && x.cmd));
    // response keeps content, tool calls, usage and the streamed timing
    assert.ok(io[0].response.message && io[0].response.usage && io[0].response.stream.first_ms >= 0);
  } finally { await m.close(); }
});

test('every empty reply gets the second request, also after a retry that failed (the prompt says so)', async () => {
  const m = await startMock({ delayMs: 5, emptyEvery: 1, strategy: 'boom' }); // every request is empty
  try {
    const live = new LiveMatch({ seed: 9, p1: cfg('AlwaysEmpty', m.url), p2: 'scripted:turtle', record: false, maxGameSeconds: 40 });
    await live.run({ speed: 40 });
    const s = live.result.agents[0];
    assert.ok(s.empty_replies >= 4);
    assert.ok(s.retries >= s.empty_replies - 1, `retries ${s.retries} vs empty ${s.empty_replies}`); // only the reply still open at the end may miss its retry
    assert.ok(s.retry_failed >= 1 && s.retry_ok === 0);
    assert.ok(live.game.t >= 400, 'the game goes on');
  } finally { await m.close(); }
});

test('retry can be switched off per player (retry_empty: false)', async () => {
  const m = await startMock({ delayMs: 5, emptyEvery: 2, strategy: 'boom' });
  try {
    const live = new LiveMatch({ seed: 9, p1: cfg('NoRetry', m.url, { retry_empty: false }), p2: 'scripted:turtle', record: false, maxGameSeconds: 30 });
    await live.run({ speed: 40 });
    const s = live.result.agents[0];
    assert.ok(s.empty_replies > 2);
    assert.equal(s.retries, 0);
  } finally { await m.close(); }
});

// ---------- H2: memory ----------
test('memory: the next observation carries the last note, the results of the last orders and the round before', async () => {
  const m = await startMock({ delayMs: 10, strategy: 'boom' });
  try {
    const live = new LiveMatch({ seed: 9, p1: cfg('Mem', m.url), p2: 'scripted:turtle', record: false, maxGameSeconds: 90 });
    await live.run({ speed: 40 });
    const U = users(m);
    assert.equal(U[0].last_note, undefined, 'nothing to remember in round 1');
    const notes = [];
    for (let i = 1; i < U.length; i++) {
      assert.ok(typeof U[i].last_note === 'string' && U[i].last_note.length > 0, 'round ' + (i + 1) + ' has last_note');
      notes.push(U[i].last_note);
    }
    assert.ok(notes.every((n) => /^boom: /.test(n)), 'it is the note the model wrote: ' + notes[0]);
    const i3 = U.findIndex((o) => o.turn_before);
    assert.ok(i3 >= 2, 'turn_before from round 3 on');
    const tb = U[i3].turn_before;
    assert.ok(typeof tb.t === 'number' && typeof tb.note === 'string' && Array.isArray(tb.orders));
    assert.ok(tb.orders.every((o) => /: (ok|FAILED \w+)$/.test(o)), JSON.stringify(tb.orders));
    assert.ok(U.some((o) => o.last_commands && o.last_commands.length), 'last_commands still there');
  } finally { await m.close(); }
});

// ---------- H3: held purchases ----------
function fakeGame(res, standing) {
  const units = { spearman: { cost: { food: 50, wood: 25 } }, worker: { cost: { food: 50 } } };
  return { t: 100, over: false, rules: { timeLimitS: 1800, suddenDeath: 1320 }, players: { 1: { alive: true, res, standing, faction: { units }, events: [], killFeed: [], unitStats: {} } } };
}
test('held purchase: fails for resources while a standing order eats them -> standing orders pause, purchase placed when affordable, orders resume', () => {
  const standing = [{ kind: 'train', id: 7, unit: 'spearman', bid: 85, btype: 'barracks', keep: 2, until: null }, { kind: 'wave', id: 8 }, { kind: 'houses', id: 9, margin: 5 }];
  const g = fakeGame({ food: 44, wood: 200, gold: 580 }, standing);
  const p = new LlmPlayer({ name: 'H', base_url: 'http://127.0.0.1:1/v1', model: 'm' }, { pid: 1 });
  p.takeCommands(g);
  p.batches.push({ req: 3, expected: 1, results: [], round: null });
  const fail = { ok: false, error: 'insufficient_resources', message: 'tier 2 costs 400 food, 150 gold; you have 44 food', need: { food: 400, gold: 150 } };
  p.recordResult({ cmd: 'advance_tier' }, fail, 100);
  assert.match(p.feedback[0].held, /auto_train spearman at 85/);
  assert.ok(!/auto_build_houses/.test(p.feedback[0].held), 'houses use wood, which is not short');
  assert.equal(p.hold.state, 'waiting');
  // next tick: the harness pauses the standing orders that spend the missing resource (wave and houses stay)
  let out = p.takeCommands(g);
  assert.deepEqual(out.map((x) => [x.req, x.cmd.cmd, x.cmd.id]), [['hold', 'cancel_standing', 7]]);
  for (const x of out) p.recordResult(x.cmd, { ok: true }, 101);
  assert.equal(p.batches.length, 0);
  assert.deepEqual(p.takeCommands(g), [], 'not affordable yet: nothing happens');
  // visible to the model
  const obsHold = p.hold;
  assert.equal(obsHold.paused[0].args.unit_type, 'spearman');
  // affordable now
  g.t += 50;
  g.players[1].res = { food: 410, wood: 200, gold: 600 };
  out = p.takeCommands(g);
  assert.deepEqual(out.map((x) => [x.req, x.cmd.cmd]), [['hold', 'advance_tier']]);
  p.recordResult(out[0].cmd, { ok: true, tier: 2 }, 160);
  assert.equal(p.hold, null);
  assert.equal(p.m.hold_bought, 1);
  assert.ok(p.feedback.some((f) => f.ok && f.note && /placed automatically/.test(f.note)));
  out = p.takeCommands(g);
  assert.deepEqual(out.map((x) => x.cmd), [{ cmd: 'auto_train', unit_type: 'spearman', building_id: 85, keep_queue: 2 }]);
});

test('held purchase: no standing order eats the missing resource -> nothing is held; a hold that cannot be paid expires and the orders resume', () => {
  const g = fakeGame({ food: 44, wood: 5, gold: 5 }, [{ kind: 'wave', id: 8 }]);
  const p = new LlmPlayer({ name: 'H', base_url: 'http://127.0.0.1:1/v1', model: 'm' }, { pid: 1 });
  p.takeCommands(g);
  p.batches.push({ req: 3, expected: 1, results: [], round: null });
  p.recordResult({ cmd: 'advance_tier' }, { ok: false, error: 'insufficient_resources', message: 'x', need: { food: 400 } }, 100);
  assert.equal(p.hold, null);
  assert.equal(p.feedback[0].held, undefined);
  // expiry
  g.players[1].standing = [{ kind: 'train', id: 4, unit: 'worker', bid: null, btype: 'town_center', keep: null, until: 30 }];
  p.batches.push({ req: 4, expected: 1, results: [], round: null });
  p.recordResult({ cmd: 'advance_tier' }, { ok: false, error: 'insufficient_resources', message: 'x', need: { food: 400 } }, 100);
  assert.ok(p.hold);
  p.takeCommands(g);
  g.t += HOLD_MAX_TICKS + 1;
  const out = p.takeCommands(g); // the call that notices the expiry also carries the restore
  assert.equal(p.hold, null);
  assert.equal(p.m.hold_expired, 1);
  assert.ok(p.feedback.some((f) => f.error === 'hold_expired'));
  assert.deepEqual(out.map((x) => x.cmd.cmd), ['auto_train']);
  assert.equal(out[0].cmd.until_count, 30);
});

test('held purchase, real game: auto_train workers eat all food; an explicit advance_tier is held and succeeds', async () => {
  let n = 0;
  const m = await startMock({
    delayMs: 20, strategy: 'boom',
    script: (obs) => {
      n++;
      const tcb = obs.buildings.find((b) => b.type === 'town_center');
      if (n === 1) return [{ name: 'note', args: { text: 'workers, then tier 2' } }, { name: 'gather', args: { resource: 'food', count: 4 } }, { name: 'gather', args: { resource: 'gold', count: 2 } }, { name: 'auto_train', args: { unit_type: 'worker', building_id: tcb.id, keep_queue: 5 } }, { name: 'advance_tier', args: {} }];
      return [{ name: 'note', args: { text: 'waiting for tier 2' } }, { name: 'set_rally', args: { building_id: tcb.id, xy: [30, 30] } }];
    },
  });
  try {
    const live = new LiveMatch({ seed: 4, p1: cfg('Saver', m.url, { hold_max_s: 600 }), p2: 'scripted:turtle', record: false, maxGameSeconds: 400 });
    await live.run({ speed: 60 });
    const s = live.result.agents[0];
    assert.equal(s.held_purchases, 1, JSON.stringify(s));
    assert.equal(s.hold_bought, 1);
    assert.ok(live.game.players[1].tier === 2 || live.game.players[1].advancing === 2, 'tier 2 reached or under way');
    const U = users(m);
    assert.ok(U.some((o) => o.saving_for && o.saving_for.need.food === 400 && /auto_train worker/.test(o.saving_for.paused_standing_orders[0])), 'saving_for shown to the model');
    assert.ok(U.some((o) => o.last_commands && o.last_commands.some((f) => f.cmd === 'advance_tier' && /HELD/.test(f.held || ''))), 'the failure says it is held');
    assert.ok(U.some((o) => o.last_commands && o.last_commands.some((f) => f.cmd === 'advance_tier' && !f.error && /placed automatically/.test(f.note || ''))));
    const sa = live.game.players[1].standing.find((o) => o.kind === 'train');
    assert.ok(sa && sa.unit === 'worker', 'the paused standing order runs again');
  } finally { await m.close(); }
});

// ---------- H4 / H5: clock, combat digest, events ----------
test('observation: clock, since_last_round (losses, kills, trained), events without "trained" spam, ids on every enemy group', () => {
  const g = richGame(3);
  const p = new LlmPlayer({ name: 'O', base_url: 'http://127.0.0.1:1/v1', model: 'm' }, { pid: 1 });
  const pl = g.players[1];
  pl.unitStats.worker = { dmg: 0, kills: 0, killValue: 0, lost: 4, lostValue: 200 };
  pl.killFeed.push({ t: 12, killer: 1, killerType: 'spearman', victim: 2, victimType: 'archer', kind: 'unit' }, { t: 14, killer: 1, killerType: 'ram', victim: 2, victimType: 'house', kind: 'building' });
  for (let i = 0; i < 20; i++) g.event(pl, { type: 'trained', unit: 'spearman', id: 900 + i });
  g.event(pl, { type: 'attacked', x: 10, y: 10, what: 'worker' });
  const round = { n: 1, startTick: g.t, since: 2, attempt: 1, lostBase: { worker: 1 }, game_s: 0, pre: { feedback: [], toolErrors: [], lastError: null } };
  const obs = p.buildObs(g, round);
  assert.equal(obs.clock.time_left_s, g.rules.timeLimitS - obs.t);
  assert.equal(obs.clock.sudden_death_in_s, undefined, 'classic rules have no sudden death');
  const gf = new Game({ seed: 3, rules: resolveRules('fast') });
  const of = p.buildObs(gf, { ...round, since: -1 });
  assert.equal(of.clock.sudden_death_in_s, gf.rules.suddenDeath - of.t);
  assert.equal(of.clock.time_left_s, gf.rules.timeLimitS - of.t);
  assert.deepEqual(obs.since_last_round.your_units_lost, { worker: 3 });
  assert.deepEqual(obs.since_last_round.enemy_units_killed, { archer: 1 });
  assert.deepEqual(obs.since_last_round.enemy_buildings_destroyed, { house: 1 });
  assert.equal(obs.since_last_round.your_units_trained.spearman, 20);
  assert.ok(obs.events.every((e) => e.type !== 'trained') && obs.events.some((e) => e.type === 'attacked'));
  // enemy group of 8: ids only with fullIds
  const home = g.starts[1];
  for (let i = 0; i < 8; i++) g.addUnit(2, 'spearman', 20000 + (i % 2) * 300, 20000 + i * 100); // the middle of one 8x8 grouping cell
  stepN(g, 3);
  const plain = observe(g, 1), full = observe(g, 1, { fullIds: true });
  const grp = (o) => o.enemy_units.find((e) => e.type === 'spearman' && e.n >= 7);
  assert.ok(grp(plain) && grp(plain).ids === undefined, 'bots keep the short form');
  assert.match(grp(full).ids, /\d/);
  void home;
});

test('observation in a match: clock and the digest are part of what the model gets', async () => {
  const m = await startMock({ delayMs: 10, strategy: 'boom' });
  try {
    const live = new LiveMatch({ seed: 9, p1: cfg('Clock', m.url), p2: 'scripted:rush', record: false, maxGameSeconds: 120 });
    await live.run({ speed: 40 });
    const U = users(m);
    assert.ok(U.every((o) => o.clock && o.clock.time_left_s > 0));
    assert.ok(U.some((o) => o.since_last_round && o.since_last_round.trained));
    assert.ok(U.every((o) => !(o.events || []).some((e) => e.type === 'trained')));
  } finally { await m.close(); }
});

// ---------- H6: messages and observation fields ----------
test('messages: gather without workers says why; from=target is explained; dead units are named; stuck workers are flagged', () => {
  const g = richGame(2);
  const w = workers(g, 1);
  // everybody already gathers wood -> from=wood (the target) and no worker is taken
  for (const u of w) g.command(1, { cmd: 'gather', resource: 'wood', worker_ids: [u.id] });
  const r = g.command(1, { cmd: 'gather', resource: 'wood', count: 2, from: 'wood' });
  assert.equal(r.error, 'no_workers');
  assert.match(r.message, /from=wood/);
  assert.match(r.message, /target resource itself/);
  const r2 = g.command(1, { cmd: 'gather', resource: 'wood', count: 2 });
  assert.match(r2.message, /already gather wood/);
  assert.match(g.command(1, { cmd: 'scout', unit_id: 424242, xy: [10, 10] }).message, /dead or the id is wrong/);
  assert.match(g.command(1, { cmd: 'set_rally', building_id: 424242, xy: [10, 10] }).message, /destroyed or the id is wrong/);
  assert.match(g.command(1, { cmd: 'attack_move', units: [424242], target: [10, 10] }).message, /dead or not yours/);
  // a stuck worker: accepted, but the answer says it may not move; the observation lists it
  const u = w[0];
  u.stuck = g.t;
  const r3 = g.command(1, { cmd: 'gather', resource: 'stone', worker_ids: [u.id] });
  assert.equal(r3.ok, true);
  assert.match(r3.note, new RegExp(`${u.id} is stuck`));
  const o = observe(g, 1);
  assert.equal(o.workers.stuck, 1);
  assert.equal(o.workers.stuck_ids, String(u.id));
});

test('messages: insufficient_resources carries the structured cost (need); standing order counter is named queued_since_set', () => {
  const g = new Game({ seed: 1 });
  stepN(g, 3);
  const a = g.command(1, { cmd: 'advance_tier' });
  assert.equal(a.error, 'insufficient_resources');
  assert.deepEqual(a.need, { food: 400, gold: 150 });
  const t = tc(g, 1);
  const tr = g.command(1, { cmd: 'train', building_id: t.id, unit_type: 'scout', count: 1 });
  if (!tr.ok) assert.ok(tr.need && typeof tr.need === 'object');
  g.players[1].res.wood = 0;
  const b = g.command(1, { cmd: 'build', building_type: 'barracks', near: [20, 20] });
  if (b.error === 'insufficient_resources') assert.ok(b.need.wood >= 1);
  g.command(1, { cmd: 'auto_train', unit_type: 'worker', keep_queue: 2 });
  const o = observe(g, 1);
  assert.equal(o.standing_orders[0].queued_since_set, 0);
  assert.equal(o.standing_orders[0].queued_total, undefined);
});

// ---------- H8: error kinds, logs ----------
test('error kinds: resources / target / args / other', () => {
  assert.equal(errorKind('insufficient_resources'), 'resources');
  assert.equal(errorKind('pop_cap'), 'resources');
  assert.equal(errorKind('not_found'), 'target');
  assert.equal(errorKind('no_workers'), 'target');
  assert.equal(errorKind('bad_args'), 'args');
  assert.equal(errorKind('unknown_tool'), 'args');
  assert.equal(errorKind('tier_too_low'), 'other');
});

test('logs: rejected commands carry their message in log.jsonl; summary and HUD split the invalid commands by kind', async () => {
  const m = await startMock({ delayMs: 10, badRate: 1, format: 'tools', seed: 3 });
  try {
    const out = tmp('rts-h18b-');
    const live = new LiveMatch({ seed: 7, p1: cfg('Bad', m.url), p2: 'scripted:turtle', outRoot: out, maxGameSeconds: 90 });
    await live.run({ speed: 30 });
    const s = live.result.agents[0];
    assert.ok(s.commands_invalid > 5);
    const by = s.invalid_by_kind;
    assert.equal(by.resources + by.target + by.args + by.other, s.commands_invalid);
    assert.ok(by.args > 0);
    assert.ok(Object.keys(s.errors_by_code).length > 0);
    const log = readJsonl(path.join(live.dir, 'log.jsonl'));
    const bad = log.filter((l) => l.type === 'cmd' && !l.ok);
    assert.ok(bad.length > 0 && bad.every((l) => typeof l.msg === 'string' && l.msg.length > 3 && l.err), 'err code and message');
    const states = log.filter((l) => l.type === 'state');
    const hud = states[states.length - 1].hud[0];
    assert.ok(hud.invalidBy && ['stream-decode', 'wall-latency'].includes(hud.tokSrc) && hud.invalid >= 0);
    assert.ok(readJsonl(path.join(live.dir, 'io.jsonl')).some((e) => Array.isArray(e.results) && e.results.some((r) => r.ok === false && r.message)), 'results with messages in io.jsonl');
  } finally { await m.close(); }
});

// ---------- prompt ----------
test('prompt 1.9: explains memory, the held order, the clock; version bumped', () => {
  const p = buildSystemPrompt('fast');
  assert.equal(PROMPT_VERSION, 'rts-llm-1.9');
  for (const w of ['last_note', 'turn_before', 'since_last_round', 'saving_for', 'time_left_s', 'queued_since_set', 'HOLDS', 'stuck_ids', 'second request']) assert.ok(p.includes(w), w);
  assert.ok(!p.includes('queued_total'));
  assert.ok(p.length < 17500, 'the prompt stays compact: ' + p.length);
});
