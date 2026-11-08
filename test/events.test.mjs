import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMatch } from '../tools/run-match.mjs';
import { loadReplay, ReplaySim } from '../tools/lib/replay.mjs';
import { computeEvents } from '../tools/events.mjs';
import { computeHighlights } from '../tools/highlights.mjs';
import { startMock } from '../agents/llm/mock-server.mjs';
import { LiveMatch } from '../server/live-match.mjs';
import { scriptedReplay } from '../test-support/replays.mjs';

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `rts-bc-${n}-`));

const dirA = scriptedReplay(['rush', 'boom'], 3);

test('events: deterministic, and the re-simulation matches the recorded hashes', () => {
  const a = computeEvents(dirA), b = computeEvents(loadReplay(dirA));
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'two runs give byte-identical output');
  assert.ok(a.verified.ok, JSON.stringify(a.verified));
  assert.ok(a.verified.states_checked > 20);
  assert.ok(a.events.length > 20);
});

test('events: the hooks do not change sim results', () => {
  const rep = loadReplay(dirA);
  const plain = new ReplaySim(rep);
  while (plain.step());
  const ev = computeEvents(rep);
  assert.equal(ev.end_hash, plain.game.hash());
  assert.equal(ev.ticks, plain.game.t);
});

test('events: consistent and complete for a bot game', () => {
  const ev = computeEvents(dirA);
  const E = ev.events;
  for (let i = 1; i < E.length; i++) assert.ok(E[i].t >= E[i - 1].t, 'sorted by tick');
  assert.equal(new Set(E.map((e) => e.id)).size, E.length, 'unique ids');
  const types = new Set(E.map((e) => e.type));
  for (const t of ['first_contact', 'battle', 'tier_up', 'key_building', 'victory']) assert.ok(types.has(t), `has ${t}`);
  const fc = E.find((e) => e.type === 'first_contact');
  const firstBattle = E.find((e) => e.type === 'battle');
  assert.ok(fc.t <= firstBattle.t_end, 'contact before the first battle ends');
  for (const p of [1, 2]) {
    const tiers = E.filter((e) => e.type === 'tier_up' && e.p === p).map((e) => e.tier);
    assert.deepEqual(tiers, [...tiers].sort((x, y) => x - y), 'tiers only go up');
  }
  const v = E.find((e) => e.type === 'victory');
  assert.equal(v.t, ev.ticks);
  for (const b of E.filter((e) => e.type === 'battle')) {
    assert.ok(b.t_end >= b.t && b.value >= 150 && b.loc.length === 2);
    assert.equal(Object.keys(b.participants).length, 2);
    assert.ok(b.participants[1].lost_value + b.participants[2].lost_value === b.value);
  }
  // series: one entry per second, destroyed value of all battles never exceeds the series total
  const secs = Math.ceil(ev.ticks / 10) + 1;
  assert.ok(Math.abs(ev.series.destroyed.length - secs) <= 1);
  const total = ev.series.destroyed.reduce((a, b) => a + b, 0);
  assert.ok(E.filter((e) => e.type === 'battle').reduce((a, b) => a + b.value, 0) <= total);
  // momentum swings alternate between players
  const sw = E.filter((e) => e.type === 'momentum_swing');
  for (const s of sw) assert.notEqual(s.from, s.to);
});

test('events: a replay that no longer matches the sim is flagged', () => {
  const dir = tmp('bad');
  const lines = fs.readFileSync(path.join(dirA, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const st = lines.find((l) => l.type === 'state' && l.t >= 300);
  st.hash = (st.hash + 1) >>> 0;
  fs.writeFileSync(path.join(dir, 'log.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const ev = computeEvents(dir);
  assert.equal(ev.verified.ok, false);
  assert.equal(ev.verified.first_mismatch_tick, st.t);
});

test('events: LLM decisions carry thought, latency and tokens; landing tick equals the logged order tick', async () => {
  const m = await startMock({ delayMs: 15, strategy: 'boom', seed: 5 });
  try {
    const out = tmp('llm');
    const cfg = { name: 'Mock', base_url: m.url, model: 'mock', hardware: 'mock box', timeout_s: 5 };
    const live = new LiveMatch({ seed: 9, p1: cfg, p2: 'scripted:turtle', outRoot: out, maxGameSeconds: 200 });
    await live.run({ speed: 40 });
    const rep = loadReplay(live.dir);
    const ev = computeEvents(rep);
    assert.ok(ev.verified.ok, JSON.stringify(ev.verified));
    const dec = ev.events.filter((e) => e.type === 'llm_decision');
    assert.ok(dec.length > 20);
    assert.ok(dec.every((d) => d.p === 1 && d.latency_ms > 0 && d.completion_tokens > 0 && d.prompt_tokens > 0));
    assert.ok(dec.filter((d) => d.thought).length > dec.length / 2, 'the mock model sends a note with most replies');
    const byReq = new Map();
    for (const c of rep.cmds) if (c.req !== undefined && !byReq.has(c.req)) byReq.set(c.req, c.t);
    for (const d of dec.filter((x) => !x.estimated)) assert.equal(d.t, byReq.get(d.n), `decision ${d.n} lands with its first order`);
    assert.equal(ev.players[0].kind, 'llm');
    assert.equal(ev.players[0].hardware, 'mock box');
    // deterministic, including the model part
    assert.equal(JSON.stringify(ev), JSON.stringify(computeEvents(live.dir)));
    // tension covers every second
    const hl = computeHighlights(ev);
    assert.equal(hl.tension.length, ev.series.destroyed.length);
  } finally { await m.close(); }
});
