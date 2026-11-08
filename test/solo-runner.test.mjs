// Solo runner (tools/solo/run-solo.mjs): mock and null players, short cutoff, high tempo. No model, no real server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runSolo, runSeries, checkBox, levelBot, botVersion, SoloPreflightError } from '../tools/solo/run-solo.mjs';
import { loadScenario, seedsHash } from '../tools/solo/scenario.mjs';
import { worldOptions } from '../agents/scripted/world-bot.mjs';
import { readRunMeta, RUN_META_FILE } from '../tools/solo/meta.mjs';
import { verifyReplay } from '../server/replay-verify.mjs';
import { startMock } from '../agents/llm/mock-server.mjs';
import { currentSimVersion } from '../sim-versions/lib.mjs';

const SPEED = 20; // game seconds per wall second: a 60 s cutoff takes about 3 s
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rts-solo-'));
// the real duel scenario with a 60 s cutoff (the minimum the scenario format allows); another id, so it is not mistaken for the frozen board
const mini = (over = {}) => ({ ...loadScenario('duel-ladder'), id: 'duel-mini', maxGameSeconds: 60, ...over });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('mock player against a level 3 bot: the cutoff ends the match without a winner, runMeta.json sits next to an untouched result.json', async () => {
  const out = tmp();
  const r = await runSolo({ scenario: mini(), level: 3, modelSeat: 1, seed: 42, player: { type: 'mock', strategy: 'boom', delay_ms: 150 }, outDir: out, speed: SPEED });
  const res = readJson(path.join(r.replayDir, 'result.json'));
  assert.equal(res.reason, 'cutoff');
  assert.equal(res.winnerTeam, 0, 'a cutoff has no winner');
  assert.equal(res.over, false);
  assert.equal(res.seconds, 60);
  // result.json is exactly what LiveMatch writes: no solo fields in it
  assert.equal('solo' in res, false);
  assert.equal('pacer' in res, false);
  const meta = readRunMeta(r.replayDir);
  assert.ok(meta, `${RUN_META_FILE} exists and has the schema`);
  assert.equal(meta.status, 'done');
  assert.deepEqual(meta.solo, { scenario: 'duel-mini', level: 3, seed: 42, runIndex: 0 });
  assert.equal(meta.ranked, false);
  assert.match(meta.prompt_note, /old 1-vs-1 prompt rts-llm-[\d.]+ .*cutoff is not in it/);
  assert.equal(r.judge.outcome, 'cutoff', 'cutoff is not a win');
  assert.equal(meta.judge.outcome, 'cutoff');
  assert.equal(meta.end.cls, 'cutoff');
  // pacer: both numbers are stored (the valid flag follows pacer.dropped)
  assert.equal(typeof meta.pacer.dropped, 'number');
  assert.ok(meta.pacer.maxDelayMs > 0 && meta.pacer.maxDelayMs < 5000, `maxDelayMs ${meta.pacer.maxDelayMs}`);
  assert.equal(meta.valid, meta.pacer.dropped === 0);
  // the key of the cell
  const k = meta.keys;
  assert.equal(k.level, 3);
  assert.equal(k.speed, SPEED);
  assert.equal(k.sim_version, currentSimVersion());
  assert.equal(k.sim_version, lines(path.join(r.replayDir, 'log.jsonl'))[0].sim_version, 'the version stamped in the replay');
  assert.match(k.scenario_hash, /^[0-9a-f]{16}$/);
  assert.match(k.prompt_hash, /^[0-9a-f]{16}$/);
  assert.match(k.rules_hash, /^[0-9a-f]{16}$/);
  assert.match(k.bot_version, /^bots-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(k.harness).sort(), ['max_tokens', 'min_interval_s', 'reasoning_budget_tokens', 'sampling', 'stream', 'thinking', 'timeout_s']);
  assert.equal(k.theme, 'default');
  // model numbers for the list line
  assert.ok(meta.model.rounds > 0 && meta.model.decisions_per_min > 0);
  assert.ok(meta.model.latency_median_ms >= 100, 'the mock waited its 150 ms');
  assert.equal(meta.preflight.ok, true);
  // the mock is made like the arena makes it (server/arena.mjs, createMatch + mockUrl): a tripwire in case the arena numbers change
  const arena = fs.readFileSync(new URL('../server/arena.mjs', import.meta.url), 'utf8');
  const cfg = /max_tokens: (\d+), timeout_s: (\d+), min_interval_s: (\d+), sampling: \{ temperature: ([\d.]+), seed: (\d+) \}/.exec(arena);
  assert.ok(cfg, 'the mock config line in arena.mjs changed: update preparePlayer in tools/solo/run-solo.mjs');
  assert.deepEqual([k.harness.max_tokens, k.harness.timeout_s, k.harness.min_interval_s, k.harness.sampling.temperature, k.harness.sampling.seed], cfg.slice(1).map(Number));
  assert.match(arena, /jitterMs: Math\.round\(delayMs \/ 4\), tokS: 80, seed: 7/);
  // the recorded replay still re-simulates to the same end hash
  assert.equal(verifyReplay(r.replayDir).ok, true);
});

test('the opponent is the level bot on the other seat; the seat swap puts the model on seat 2', async () => {
  const out = tmp();
  const r = await runSolo({ scenario: mini(), level: 3, modelSeat: 2, seed: 7, style: 'rush', player: { type: 'mock', strategy: 'boom', delay_ms: 100 }, outDir: out, speed: SPEED });
  const start = lines(path.join(r.replayDir, 'log.jsonl'))[0];
  assert.deepEqual(start.players.map((p) => p.kind), ['bot', 'llm'], 'seat 1 is the bot, seat 2 the model');
  assert.equal(start.players[0].name, 'Rush');
  assert.equal(r.runMeta.model_seat, 2);
  assert.deepEqual(r.runMeta.opponent, { bot: 'rush', level: 3, seat: 1 });
  assert.equal(r.runMeta.style, 'rush');
  assert.ok(r.runMeta.model.rounds > 0, 'the model seat is read from agents[modelSeat - 1]');
  assert.equal(r.runMeta.player.strategy, 'boom');
  assert.equal(r.runMeta.player.anchor, 'mock:boom:100');
});

test('level 0 is the idle bot; levels 1 and 2 are refused with the reason (A1b)', async () => {
  assert.equal(levelBot(0), 'idle');
  assert.equal(levelBot(3), 'boom');
  assert.equal(levelBot(3, 'turtle'), 'turtle');
  const base = { scenario: mini(), modelSeat: 1, seed: 1, player: { type: 'null' }, outDir: tmp(), speed: SPEED };
  await assert.rejects(runSolo({ ...base, level: 1 }), /levels 1 and 2 need the name parser from A1b/);
  await assert.rejects(runSolo({ ...base, level: 2 }), /levels 1 and 2 need the name parser from A1b/);
  const r = await runSolo({ ...base, level: 0 });
  assert.equal(r.runMeta.opponent.bot, 'idle');
  assert.equal(r.runMeta.style, null);
});

test('null agent: no model, no orders at all, the seat only keeps what the sim does by itself', async () => {
  const out = tmp();
  const r = await runSolo({ scenario: mini(), level: 3, modelSeat: 1, seed: 42, player: { type: 'null' }, outDir: out, speed: SPEED });
  const log = lines(path.join(r.replayDir, 'log.jsonl'));
  assert.equal(log.filter((l) => l.type === 'cmd' && l.p === 1).length, 0, 'seat 1 sent no command');
  assert.ok(log.filter((l) => l.type === 'cmd' && l.p === 2).length > 0, 'the bot did');
  assert.equal(r.runMeta.model.requests, 0);
  assert.equal(r.runMeta.model.rounds, 0);
  assert.equal(r.runMeta.player.type, 'null');
  assert.equal(r.runMeta.player.anchor, 'null');
  assert.equal(r.runMeta.keys.harness, null);
  assert.equal(r.runMeta.preflight, null, 'nothing to check: no server');
  assert.equal(readJson(path.join(r.replayDir, 'players.json'))[0].kind, 'null');
  assert.equal(r.judge.outcome, 'cutoff');
  assert.equal(verifyReplay(r.replayDir).ok, true);
});

test('null agent with a fixed list of orders sends them once at tick 0', async () => {
  const r = await runSolo({ scenario: mini(), level: 3, modelSeat: 1, seed: 42, player: { type: 'null', standing: [{ cmd: 'auto_train', unit_type: 'worker', keep: 4 }] }, outDir: tmp(), speed: SPEED });
  const mine = lines(path.join(r.replayDir, 'log.jsonl')).filter((l) => l.type === 'cmd' && l.p === 1);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].t, 0);
  assert.equal(mine[0].cmd.cmd, 'auto_train');
});

test('a mock holds any delay: the recorded latency median is at least the delay', async () => {
  const r = await runSolo({ scenario: mini(), level: 3, modelSeat: 1, seed: 11, player: { type: 'mock', strategy: 'turtle', delay_ms: 400 }, outDir: tmp(), speed: SPEED });
  assert.ok(r.runMeta.model.latency_median_ms >= 400, `median ${r.runMeta.model.latency_median_ms} ms`);
  assert.ok(r.runMeta.player.hardware.includes('400 ms'));
  assert.ok(r.runMeta.keys.harness.timeout_s >= 30);
});

test('an LLM config in the shape of players.json: harness settings, quant and recipe maker reach the key; the API key never reaches the replay', async () => {
  const mock = await startMock({ strategy: 'rush', delayMs: 120, jitterMs: 0, tokS: 80, seed: 7 });
  const cfg = {
    kind: 'llm', id: 'p-test', saved: 1793633226026, name: 'Test model (TensorFold, Zoe)', base_url: mock.url, model: 'test-model', hardware: '2x DGX Spark 256 GB', creator: 'blue-circle', quant: 'EXL3 4.0 bpw',
    thinking: true, max_tokens: 4096, timeout_s: 90, sampling: { temperature: 1, top_p: 0.95, seed: 42 }, min_interval_s: 2, api_key: 'sekret-key-123', class: '2 SPARKS 256 GB',
  };
  try {
    const r = await runSolo({ scenario: mini(), level: 3, modelSeat: 2, seed: 4, player: cfg, outDir: tmp(), speed: SPEED });
    const m = r.runMeta;
    assert.deepEqual(m.keys.harness, { max_tokens: 4096, timeout_s: 90, thinking: true, min_interval_s: 2, sampling: { temperature: 1, top_p: 0.95, seed: 42 }, reasoning_budget_tokens: null, stream: true });
    assert.deepEqual([m.player.type, m.player.name, m.player.quant, m.player.creator, m.player.hardware, m.player.class], ['llm', 'Test model (TensorFold, Zoe)', 'EXL3 4.0 bpw', 'blue-circle', '2x DGX Spark 256 GB', '2 SPARKS 256 GB']);
    assert.equal(m.keys.box_class, '2 SPARKS 256 GB', 'the class comes from the config unless boxClass is given');
    assert.equal(m.preflight.ok, true);
    assert.ok(m.model.rounds > 0 && m.model.latency_median_ms >= 120);
    // nothing in the replay folder (or runMeta.json) holds the key
    for (const f of fs.readdirSync(r.replayDir)) assert.ok(!fs.readFileSync(path.join(r.replayDir, f), 'utf8').includes('sekret-key-123'), f);
    // a config file path works as well
    const file = path.join(tmp(), 'player.json');
    fs.writeFileSync(file, JSON.stringify(cfg));
    const r2 = await runSolo({ scenario: mini(), level: 3, modelSeat: 1, seed: 5, player: file, outDir: tmp(), speed: SPEED });
    assert.equal(r2.runMeta.player.name, cfg.name);
  } finally { await mock.close(); }
});

test('box check: a dead LLM server aborts before anything is recorded, with a plain message', async () => {
  const out = tmp();
  const dead = { name: 'Dead box', base_url: 'http://127.0.0.1:1/v1', model: 'm', hardware: 'none' };
  await assert.rejects(
    runSolo({ scenario: mini(), level: 3, modelSeat: 1, seed: 1, player: dead, outDir: out, speed: SPEED }),
    (e) => e instanceof SoloPreflightError && e.code === 'SOLO_BOX_DOWN' && /box check failed, run not started/.test(e.message) && e.message.includes('http://127.0.0.1:1/v1/models') && /not reachable/.test(e.message),
  );
  assert.deepEqual(fs.readdirSync(out), [], 'no run folder was made');
  // a series stops at once when the box is down, and also at a set-up error (the next seed would fail the same way)
  await assert.rejects(runSeries({ scenario: mini(), level: 3, player: dead, seeds: [1, 2], outDir: out, speed: SPEED }), SoloPreflightError);
});

test('box check answers: 2xx ok (model listed or not), 404 ok with a warning, 401 and 500 not ok', async () => {
  const answers = { '/ok/models': [200, JSON.stringify({ data: [{ id: 'm1' }] })], '/nolist/models': [404, '{}'], '/key/models': [401, '{}'], '/boom/models': [500, '{}'] };
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(req.headers.authorization || null); const a = answers[req.url.replace('/v1', '')] || [404, '{}']; res.writeHead(a[0], { 'Content-Type': 'application/json' }); res.end(a[1]); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  try {
    const ok = await checkBox({ base_url: base + '/ok', model: 'm1' });
    assert.deepEqual([ok.ok, ok.status, ok.model_listed, ok.warn], [true, 200, true, null]);
    const other = await checkBox({ base_url: base + '/ok', model: 'other' });
    assert.equal(other.ok, true);
    assert.match(other.warn, /not in its list/);
    const nolist = await checkBox({ base_url: base + '/nolist', model: 'm1' });
    assert.deepEqual([nolist.ok, nolist.status], [true, 404]);
    assert.match(nolist.warn, /no model list/);
    const key = await checkBox({ base_url: base + '/key', model: 'm1' });
    assert.deepEqual([key.ok, key.status], [false, 401]);
    assert.match(key.error, /refuses the key/);
    assert.equal((await checkBox({ base_url: base + '/boom', model: 'm1' })).ok, false);
    seen.length = 0;
    await checkBox({ base_url: base + '/ok', model: 'm1', api_key: 'sekret' });
    await checkBox({ base_url: base + '/ok', model: 'm1' });
    assert.deepEqual(seen, ['Bearer sekret', null], 'the key goes only to the base_url it belongs to');
  } finally { await new Promise((r) => srv.close(r)); }
});

test('a clock that drops ticks makes the run invalid (pacer.dropped > 0), with the reason and the judge agreeing', async () => {
  let stalled = false;
  const r = await runSolo({
    scenario: mini(), level: 3, modelSeat: 1, seed: 5, player: { type: 'null' }, outDir: tmp(), speed: 50,
    onFrame: (m) => { if (!stalled && m.game.t > 100) { stalled = true; const t = performance.now(); while (performance.now() - t < 450); } }, // block the loop for 450 ms
  });
  assert.ok(r.runMeta.pacer.dropped > 0, `dropped ${r.runMeta.pacer.dropped}`);
  assert.ok(r.runMeta.pacer.maxDelayMs >= 400, `maxDelayMs ${r.runMeta.pacer.maxDelayMs}`);
  assert.ok(r.runMeta.pacer.firstDropGameS > 0);
  assert.equal(r.runMeta.valid, false);
  assert.ok(r.runMeta.invalid_reasons.includes('pacer_dropped'));
  assert.equal(r.judge.outcome, 'invalid');
  assert.match(r.judge.reason, /pacer\.dropped/);
});

test('a dead model server (requests keep failing, no valid answer) stops the run as invalid', async () => {
  const r = await runSolo({
    scenario: mini(), level: 3, modelSeat: 1, seed: 9, player: { type: 'mock', strategy: 'boom', delay_ms: 0, mock_opts: { failEvery: 1 } },
    outDir: tmp(), speed: SPEED, deadServerS: 1,
  });
  assert.ok(r.runMeta.invalid_reasons.includes('model_server_dead'), JSON.stringify(r.runMeta.invalid_reasons));
  assert.equal(r.runMeta.valid, false);
  assert.ok(r.runMeta.model.errors > 0);
  assert.ok(r.runMeta.game.seconds < 60, 'stopped before the cutoff');
  assert.equal(r.runMeta.status, 'done');
  // the verdict agrees with the validity: no "cutoff" (a loss) for a run that never reached its cutoff
  assert.equal(r.judge.outcome, 'invalid');
  assert.match(r.judge.reason, /stopped before the match ended \(model_server_dead\)/);
  assert.equal(r.runMeta.judge.outcome, 'invalid');
});

test('a stopped run (abort signal) is invalid and keeps its replay', async () => {
  const ac = new AbortController();
  const r = await runSolo({ scenario: mini(), level: 3, modelSeat: 1, seed: 3, player: { type: 'null' }, outDir: tmp(), speed: SPEED, signal: ac.signal, onFrame: (m) => { if (m.game.t >= 100) ac.abort(); } });
  assert.deepEqual(r.runMeta.invalid_reasons, ['stopped']);
  assert.equal(r.runMeta.valid, false);
  assert.equal(r.judge.outcome, 'invalid', 'a stopped run is no cutoff and no loss');
  assert.match(r.judge.reason, /stopped before the match ended \(stopped\)/);
  assert.ok(r.runMeta.game.seconds < 60);
  assert.ok(fs.existsSync(path.join(r.replayDir, 'log.jsonl')));
});

// a run that is stopped right after the start: enough for the key fields, no game to wait for
const stopEarly = (ac) => (m) => { if (m.game.t >= 30) ac.abort(); };

test('board seeds: only for the unchanged, frozen scenario file; the played list and its hash go into the run', async () => {
  const real = loadScenario('duel-ladder');
  const ac = new AbortController();
  const r = await runSolo({ scenario: real, level: 0, modelSeat: 2, seed: real.seeds.board[1], seedSet: 'board', player: { type: 'null' }, outDir: tmp(), speed: SPEED, signal: ac.signal, onFrame: stopEarly(ac) });
  assert.equal(r.runMeta.board_frozen, true);
  assert.deepEqual(r.runMeta.seed_list, real.seeds.board);
  assert.equal(r.runMeta.keys.seed_list_hash, seedsHash(real.seeds.board));
  assert.equal(r.runMeta.keys.seed_set, 'board');
  assert.deepEqual([r.runMeta.scenario.from_file, r.runMeta.scenario.official, r.runMeta.scenario.speed], [true, true, 1]);
  assert.equal(r.runMeta.keys.scenario_hash, real.fileHash.slice(0, 16));
  // a copy with another cutoff keeps the old fileHash but is not the file: no board run, and its hash is its own
  const base = { level: 0, modelSeat: 1, player: { type: 'null' }, outDir: tmp(), speed: SPEED };
  await assert.rejects(runSolo({ ...base, scenario: { ...real, maxGameSeconds: 60 }, seed: real.seeds.board[0], seedSet: 'board' }), /no board run, the scenario is not the unchanged file in scenarios\//);
  // a file elsewhere with the same id and the same board list (only rules or cutoff changed) is a probe too
  const dir = tmp(), copy = path.join(dir, 'duel-ladder.json');
  fs.writeFileSync(copy, JSON.stringify({ ...JSON.parse(fs.readFileSync(real.filePath, 'utf8')), maxGameSeconds: 90 }));
  const elsewhere = loadScenario(copy);
  assert.deepEqual(elsewhere.seeds.board, real.seeds.board);
  await assert.rejects(runSolo({ ...base, scenario: elsewhere, seed: elsewhere.seeds.board[0], seedSet: 'board' }), /no board run, the scenario is not the unchanged file in scenarios\//);
  // another board list under the same id and version
  const evil = { ...real, seeds: { ...real.seeds, board: [1, 2, 3, 4, 5, 6, 7, 8] } };
  await assert.rejects(runSolo({ ...base, scenario: evil, seed: 3, seedSet: 'board' }), /no board run, the board seeds are not frozen: .*changed/);
  // an object without a file and another id
  await assert.rejects(runSolo({ ...base, scenario: mini(), seed: mini().seeds.board[0], seedSet: 'board' }), /no board run, the board seeds are not frozen: .*not frozen in SEEDS-HASH/);
  // tune seeds of the changed copy are fine (a probe), with a hash of its own
  const ac2 = new AbortController();
  const probe = await runSolo({ ...base, scenario: { ...real, maxGameSeconds: 60 }, seed: real.seeds.tune[0], seedSet: 'tune', signal: ac2.signal, onFrame: stopEarly(ac2) });
  assert.equal(probe.runMeta.scenario.from_file, false);
  assert.equal(probe.runMeta.board_frozen, null);
  assert.notEqual(probe.runMeta.keys.scenario_hash, real.fileHash.slice(0, 16));
  assert.deepEqual(probe.runMeta.seed_list, real.seeds.tune);
  // a free seed: kept, but marked: no seed set, no list, no freeze
  const ac3 = new AbortController();
  const free = await runSolo({ ...base, scenario: real, seed: 12345, signal: ac3.signal, onFrame: stopEarly(ac3) });
  assert.deepEqual([free.runMeta.seed_set, free.runMeta.seed_list, free.runMeta.board_frozen, free.runMeta.keys.seed_list_hash], [null, null, null, null]);
});

test('TUNE changes the bots for the whole process and is not in bot_version: the runner refuses to start', async () => {
  const had = process.env.TUNE;
  process.env.TUNE = '{"sd": 1}';
  try {
    await assert.rejects(runSolo({ scenario: mini(), level: 3, modelSeat: 1, seed: 1, player: { type: 'null' }, outDir: tmp(), speed: SPEED }), /environment variable TUNE is set/);
  } finally { if (had === undefined) delete process.env.TUNE; else process.env.TUNE = had; }
});

test('the chat of the bots is off in a solo run (the opening line names the style); botChat turns it on; the key says which', async () => {
  const say = (r) => lines(path.join(r.replayDir, 'log.jsonl')).filter((l) => l.type === 'cmd' && l.p === 2 && l.cmd?.cmd === 'say');
  const quiet = await runSolo({ scenario: mini(), level: 3, modelSeat: 1, seed: 42, style: 'rush', player: { type: 'null' }, outDir: tmp(), speed: SPEED });
  assert.equal(say(quiet).length, 0, 'no taunt');
  assert.equal(quiet.runMeta.keys.bot_chat, false);
  assert.equal(worldOptions.chat, true, 'the switch is back after the run');
  const loud = await runSolo({ scenario: mini(), level: 3, modelSeat: 1, seed: 42, style: 'rush', player: { type: 'null' }, outDir: tmp(), speed: SPEED, botChat: true });
  assert.ok(say(loud).length > 0, 'with botChat the opening line is there');
  assert.match(say(loud)[0].cmd.text, /Blades out early today|No time to build a wall|Do not unpack/);
  assert.equal(loud.runMeta.keys.bot_chat, true);
  assert.equal(worldOptions.chat, true);
  // the switch is also restored when the start fails
  await assert.rejects(runSolo({ scenario: mini(), level: 3, modelSeat: 1, seed: 1, player: '/no/such/config.json', outDir: tmp(), speed: SPEED }), /player config/);
  assert.equal(worldOptions.chat, true);
});

test('eco goal: the tier time of a run is exact (re-simulated), not a 10 s step', async () => {
  const eco = loadScenario('eco-sprint');
  const sc = { ...eco, id: 'eco-mini', maxGameSeconds: 90, judge: { kind: 'eco', tierTarget: 2 } };
  const r = await runSolo({ scenario: sc, level: 0, modelSeat: 1, seed: eco.seeds.tune[0], seedSet: 'tune', player: { type: 'mock', strategy: 'boom', delay_ms: 100 }, outDir: tmp(), speed: 30 });
  if (!r.runMeta.valid) return assert.ok(r.runMeta.invalid_reasons.every((x) => x === 'pacer_dropped'), 'a loaded machine may drop ticks');
  assert.equal(r.judge.outcome, 'measured');
  assert.equal(r.judge.metrics.tierTimeSource, 'resim (exact)', 'the live end summary alone would give 10 s steps (judge test: exact vs coarse)');
  assert.equal(r.runMeta.judge.metrics.tierTimeSource, 'resim (exact)');
});

test('series: seeds one after the other, every seed from both seats, run index and seed set go into the marker', async () => {
  const out = tmp(), seen = [], [s1, s2] = mini().seeds.tune;
  const runs = await runSeries({ scenario: mini(), level: 3, player: { type: 'null' }, seeds: [s1, s2], seats: [1, 2], outDir: out, speed: 40, seedSet: 'tune', boxClass: '32 GB', onRun: (r) => seen.push([r.runMeta.seed, r.runMeta.model_seat]) });
  assert.deepEqual(seen, [[s1, 1], [s1, 2], [s2, 1], [s2, 2]]);
  assert.equal(runs.length, 4);
  assert.equal(fs.readdirSync(out).length, 4);
  assert.ok(runs.every((r) => r.runMeta.seed_set === 'tune' && r.runMeta.keys.box_class === '32 GB' && r.runMeta.solo.runIndex === 0));
  await assert.rejects(runSeries({ scenario: mini(), level: 3, player: '/no/such/config.json', seeds: [1, 2], outDir: out, speed: 40 }), /player config/);
  assert.equal(fs.readdirSync(out).length, 4, 'nothing more was recorded');
  const again = await runSolo({ scenario: mini(), level: 3, modelSeat: 1, seed: s1, runIndex: 1, player: { type: 'null' }, outDir: out, speed: 40 });
  assert.equal(again.runMeta.solo.runIndex, 1);
});

test('wrong input gives clear messages: cutoff not below the sim time limit, seat, level range, missing outDir', async () => {
  const base = { level: 3, modelSeat: 1, seed: 1, player: { type: 'null' }, outDir: tmp(), speed: SPEED };
  await assert.rejects(runSolo({ ...base, scenario: mini({ maxGameSeconds: 1800 }) }), /maxGameSeconds.*not below the sim time limit/s);
  await assert.rejects(runSolo({ ...base, scenario: mini(), modelSeat: 3 }), /modelSeat must be 1 or 2/);
  await assert.rejects(runSolo({ ...base, scenario: mini(), level: 4 }), /level 4 is outside/);
  await assert.rejects(runSolo({ ...base, scenario: mini(), outDir: undefined }), /"outDir" is required/);
  await assert.rejects(runSolo({ ...base, scenario: mini(), player: { type: 'mock', strategy: 'nope' } }), /mock strategy "nope"/);
  await assert.rejects(runSolo({ ...base, scenario: 'no-such-scenario' }), /scenario not found/);
  // seeds come from the frozen lists: a seed outside the named list is refused, and the board list is not the tune list
  const sc = mini();
  await assert.rejects(runSolo({ ...base, scenario: sc, seedSet: 'tune', seed: 1 }), /seed 1 is not in seeds\.tune/);
  await assert.rejects(runSolo({ ...base, scenario: sc, seedSet: 'board', seed: sc.seeds.tune[0] }), /is not in seeds\.board/);
  await assert.rejects(runSolo({ ...base, scenario: sc, seedSet: 'lucky', seed: 1 }), /seedSet must be "tune" or "board"/);
});

test('bot_version hashes the bot code and changes with it', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'agents', 'scripted'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'scripted', 'a.mjs'), 'export const a = 1;\n');
  const v1 = botVersion(root);
  assert.match(v1, /^bots-[0-9a-f]{12}$/);
  assert.equal(botVersion(root), v1);
  fs.writeFileSync(path.join(root, 'agents', 'scripted', 'levels.json'), '{"1":{"errorRate":0.25}}');
  const v2 = botVersion(root);
  assert.notEqual(v2, v1, 'a level table next to the bots counts');
  fs.writeFileSync(path.join(root, 'agents', 'scripted', 'a.mjs'), 'export const a = 2;\n');
  assert.notEqual(botVersion(root), v2);
});
