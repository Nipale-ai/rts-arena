import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { demoMatchBody } from '../ui/common.js';
import { startArena } from '../test-support/arena-proc.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('demo match body: two built-in bots, a random seed, no model', () => {
  const b = demoMatchBody(() => 0.5);
  assert.equal(b.players.length, 2);
  assert.deepEqual(b.players.map((p) => p.type), ['bot', 'bot']);
  assert.deepEqual(b.players.map((p) => p.team), [1, 2]);
  assert.ok(b.players.every((p) => !('base_url' in p) && !('api_key' in p) && !('player_id' in p)));
  assert.equal(b.seed, Math.floor(0.5 * 99999));
  const seeds = new Set(Array.from({ length: 20 }, () => demoMatchBody().seed));
  assert.ok(seeds.size > 10, 'a new seed every time');
  for (const s of seeds) assert.ok(Number.isInteger(s) && s >= 0 && s < 99999);
});

test('arena: the lobby is empty on a first run; the demo body creates a bot-vs-bot match through POST /api/matches, which then advances', async () => {
  const a = await startArena();
  try {
    assert.deepEqual((await a.call('/api/matches')).body, [], 'no matches yet: the lobby shows "Getting started"');
    // the same request the lobby button sends (ui/common.js startMatch -> POST /api/matches, the call the setup page makes too)
    const made = await a.call('/api/matches', demoMatchBody());
    assert.equal(made.status, 200, made.text);
    const m = made.body;
    assert.match(m.id, /rush-vs-boom/);
    assert.equal(m.status, 'running');
    assert.equal(m.watch_url, `/watch/${m.id}/`);
    assert.deepEqual(m.players.map((p) => [p.type, p.bot]), [['bot', 'rush'], ['bot', 'boom']]);
    assert.equal(m.rules.preset, 'fast');
    assert.equal(m.rules.speed, 4);
    assert.equal(m.name, 'Demo: Rush vs Boom');
    // the watch page answers (the 3D models are not in the test checkout, the page itself is)
    const page = await a.call(m.watch_url);
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    // the match advances: game time moves on while we wait (4x speed, the first seconds come quickly)
    let t0 = null, t1 = null;
    for (let i = 0; i < 60 && (t1 === null || t1 < (t0 ?? 0) + 4); i++) {
      await sleep(250);
      const s = (await a.call(`/api/matches/${m.id}`)).body;
      assert.equal(s.status, 'running');
      if (s.progress) { if (t0 === null) t0 = s.progress.game_seconds; t1 = s.progress.game_seconds; }
    }
    assert.ok(t0 !== null && t1 >= t0 + 4, `game time went ${t0} -> ${t1}`);
    // it is listed, so the lobby shows it and the card goes away
    assert.deepEqual((await a.call('/api/matches')).body.map((x) => x.id), [m.id]);
    // end it and check the replay was recorded where the arena reads replays
    assert.equal((await a.call(`/api/matches/${m.id}/stop`, {})).body.stopped, true);
    assert.equal((await a.call(`/api/matches/${m.id}`)).body.status, 'stopped');
    assert.ok(fs.existsSync(path.join(a.data, 'replays', m.id, 'log.jsonl')));
    assert.equal((await fetch(a.base + m.watch_url, { redirect: 'manual' })).status, 302, 'a finished match goes to its replay');
  } finally { a.stop(); }
});

test('arena: each demo gets its own seed and match', async () => {
  const a = await startArena();
  try {
    const one = (await a.call('/api/matches', demoMatchBody(() => 0.1))).body;
    const two = (await a.call('/api/matches', demoMatchBody(() => 0.9))).body;
    assert.notEqual(one.id, two.id);
    assert.notEqual(one.seed, two.seed);
    assert.equal((await a.call('/api/matches')).body.length, 2);
    for (const x of [one, two]) await a.call(`/api/matches/${x.id}/stop`, {});
  } finally { a.stop(); }
});
