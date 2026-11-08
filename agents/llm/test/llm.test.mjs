import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseReply } from '../parse.mjs';
import { validateCall } from '../validate.mjs';
import { startMock } from '../mock-server.mjs';
import { buildSystemPrompt, toolDefs, PROMPT_VERSION } from '../prompt.mjs';
import { TOOLS } from '../../../sim/commands.mjs';
import { UNITS, BUILDINGS } from '../../../sim/data.mjs';
import { LiveMatch } from '../../../server/live-match.mjs';
import { verifyReplay } from '../../../server/replay-verify.mjs';

const cfg = (name, url, extra = {}) => ({ name, base_url: url, model: name.toLowerCase(), hardware: 'mock', timeout_s: 5, ...extra });

// ---------- parsing ----------
test('parse: OpenAI tool_calls', () => {
  const r = parseReply({ tool_calls: [
    { id: '1', type: 'function', function: { name: 'train', arguments: '{"building_id":45,"unit_type":"worker","count":2}' } },
    { id: '2', type: 'function', function: { name: 'advance_tier', arguments: '' } },
  ] });
  assert.equal(r.via, 'tool_calls');
  assert.deepEqual(r.calls, [{ name: 'train', args: { building_id: 45, unit_type: 'worker', count: 2 } }, { name: 'advance_tier', args: {} }]);
  assert.equal(r.errors.length, 0);
});

test('parse: broken tool call arguments become an error, good calls survive', () => {
  const r = parseReply({ tool_calls: [
    { function: { name: 'train', arguments: '{"building_id": 45, "unit_type": ' } },
    { function: { name: 'gather', arguments: '{"resource":"wood","count":3,}' } },
  ] });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'gather');
  assert.equal(r.errors[0].kind, 'bad_json');
});

test('parse: fallback JSON block with note', () => {
  const content = 'Plan:\n```json\n{"note":"boom","commands":[{"cmd":"train","building_id":1,"unit_type":"worker"},{"cmd":"gather","resource":"wood","count":2}]}\n```';
  const r = parseReply({ content });
  assert.equal(r.via, 'json');
  assert.equal(r.note, 'boom');
  assert.deepEqual(r.calls.map((c) => c.name), ['train', 'gather']);
  assert.equal(r.calls[0].args.unit_type, 'worker');
});

test('parse: fallback variants (think tags, bare array, name/arguments, tool_call tags, python literals)', () => {
  let r = parseReply({ content: '<think>I should {"cmd":"resign"}</think>[{"name":"gather","arguments":{"resource":"food","count":1}}]' });
  assert.deepEqual(r.calls, [{ name: 'gather', args: { resource: 'food', count: 1 } }]);
  r = parseReply({ content: '<tool_call>{"name":"advance_tier","arguments":{}}</tool_call><tool_call>{"name":"research","arguments":{"tech":"wood_axe"}}</tool_call>' });
  assert.deepEqual(r.calls.map((c) => c.name), ['advance_tier', 'research']);
  r = parseReply({ content: "{'cmd': 'set_rally', 'building_id': 3, 'xy': None,}" });
  assert.deepEqual(r.calls[0], { name: 'set_rally', args: { building_id: 3, xy: null } });
  r = parseReply({ content: 'I will build a house now. Sorry, no tools.' });
  assert.equal(r.calls.length, 0);
  assert.equal(r.errors[0].kind, 'no_tool_calls');
  assert.equal(parseReply({ content: '' }).errors[0].kind, 'empty_reply');
});

test('validate: schema checks and coercion', () => {
  assert.equal(validateCall({ name: 'dig', args: {} }).error, 'unknown_tool');
  assert.equal(validateCall({ name: 'train', args: { unit_type: 'worker' } }).error, 'missing_arg');
  assert.equal(validateCall({ name: 'train', args: { building_id: 'tc', unit_type: 'worker' } }).error, 'bad_arg_type');
  assert.equal(validateCall({ name: 'gather', args: { resource: 'diamonds', count: 1 } }).error, 'bad_arg_value');
  const ok = validateCall({ name: 'train', args: { building_id: '45', unit_type: 'worker', count: 2 } });
  assert.deepEqual(ok.cmd, { cmd: 'train', building_id: 45, unit_type: 'worker', count: 2 });
  const n = validateCall({ name: 'note', args: { text: 'x'.repeat(300) } });
  assert.equal(n.cmd.text.length, 120);
});

test('prompt: generated from game data, same tools as the game', () => {
  const p = buildSystemPrompt();
  for (const u of Object.keys(UNITS)) assert.ok(p.includes(u), u);
  assert.ok(p.includes(`${UNITS.spearman.cost.food} food`));
  assert.deepEqual(toolDefs().map((t) => t.function.name), TOOLS.map((t) => t.name));
  assert.match(PROMPT_VERSION, /^rts-llm-/);
});

test('prompt: elimination rule matches playerEliminated (no town center and no production building), not "buildings left"', () => {
  const p = buildSystemPrompt('fast');
  assert.ok(!/buildings left/.test(p), 'the old, wrong sentence is gone');
  assert.match(p, /a player is out once they own no town center and no production building \(([^)]*)\), and the last player standing wins/);
  const listed = p.match(/no production building \(([^)]*)\)/)[1];
  const production = Object.entries(BUILDINGS).filter(([, d]) => d.production).map(([t]) => t.replace(/_/g, ' '));
  assert.deepEqual(listed.split(', ').sort(), production.sort(), 'the listed buildings are the ones the game treats as production');
  assert.equal(PROMPT_VERSION, 'rts-llm-1.9');
});

// ---------- matches against the mock ----------
test('invalid commands: rejected, counted, reported back to the model, game keeps running', async () => {
  const m = await startMock({ delayMs: 20, badRate: 1, format: 'mixed', seed: 3 });
  try {
    const live = new LiveMatch({ seed: 7, p1: cfg('Bad', m.url), p2: 'scripted:turtle', record: false, maxGameSeconds: 90 });
    await live.run({ speed: 30 });
    const s = live.result.agents[0];
    assert.ok(s.requests > 10, 'requests ' + s.requests);
    assert.ok(s.commands_invalid > 5, 'invalid ' + s.commands_invalid);
    assert.ok(s.commands_applied > 5, 'applied ' + s.commands_applied);
    assert.ok(s.reply_format.tool_calls > 0 && s.reply_format.json > 0, JSON.stringify(s.reply_format));
    assert.ok(live.game.t >= 900);
    // the next observation carries the errors
    assert.ok(m.stats.bodies.some((b) => b.messages[1].content.includes('"tool_errors"')), 'tool_errors fed back');
    assert.ok(m.stats.bodies.some((b) => b.messages[1].content.includes('"last_commands"')));
    assert.equal(m.stats.maxActive, 1, 'one request in flight');
  } finally { await m.close(); }
});

test('real time: a slow model gives fewer orders than a fast one, the game never waits', async () => {
  const script = (obs) => [{ name: 'note', args: { text: 'rally' } }, { name: 'set_rally', args: { building_id: obs.buildings.find((b) => b.type === 'town_center').id, xy: [30, 30] } }]; // one order per reply that always works: orders follow the number of replies
  const fast = await startMock({ delayMs: 30, strategy: 'boom', script });
  const slow = await startMock({ delayMs: 1200, strategy: 'boom', script });
  try {
    const live = new LiveMatch({ seed: 5, p1: cfg('Fast', fast.url, { retry_empty: false }), p2: cfg('Slow', slow.url, { retry_empty: false }), record: false });
    const t0 = performance.now();
    const speed = 12;
    // run ~4 wall seconds
    setTimeout(() => live.finish(), 4000);
    await live.run({ speed });
    const wall = (performance.now() - t0) / 1000;
    const [a, b] = live.result.agents;
    assert.ok(live.game.t > 4 * speed * 10 * 0.6, `game advanced ${live.game.t} ticks in ${wall}s`);
    assert.ok(a.requests >= 3 * b.requests, `fast ${a.requests} vs slow ${b.requests} requests`);
    assert.ok(a.commands_applied > b.commands_applied, `fast ${a.commands_applied} vs slow ${b.commands_applied} orders`);
    assert.equal(fast.stats.maxActive, 1);
    assert.equal(slow.stats.maxActive, 1);
  } finally { await fast.close(); await slow.close(); }
});

test('a dead or hanging server does not stop the game', async () => {
  const hang = await startMock({ delayMs: 5000 });
  try {
    const live = new LiveMatch({ seed: 5, p1: cfg('Hang', hang.url, { timeout_s: 0.4 }), p2: cfg('Dead', 'http://127.0.0.1:1/v1'), record: false, maxGameSeconds: 60 });
    await live.run({ speed: 30 });
    assert.ok(live.game.t >= 600);
    assert.ok(live.result.agents[0].timeouts >= 1);
    assert.ok(live.result.agents[1].errors >= 1);
  } finally { await hang.close(); }
});

test('replay determinism with an LLM player', async () => {
  const m = await startMock({ delayMs: 15, badRate: 0.2, format: 'mixed', seed: 11 });
  try {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-replay-'));
    const live = new LiveMatch({ seed: 21, p1: cfg('Llm', m.url), p2: 'scripted:rush', outRoot: out, maxGameSeconds: 240 });
    await live.run({ speed: 40 });
    for (const f of ['log.jsonl', 'io.jsonl', 'result.json', 'system-prompt.txt', 'tools.json', 'players.json']) assert.ok(fs.existsSync(path.join(live.dir, f)), f);
    const start = JSON.parse(fs.readFileSync(path.join(live.dir, 'log.jsonl'), 'utf8').split('\n')[0]);
    assert.equal(start.seed, 21);
    assert.equal(start.prompt_version, PROMPT_VERSION);
    const io = fs.readFileSync(path.join(live.dir, 'io.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(io.length > 10 && io[0].response && io[0].latency_ms >= 0 && io[0].tok_s > 0 && io[0].user);
    assert.ok(!fs.readFileSync(path.join(live.dir, 'players.json'), 'utf8').includes('"api_key"'), 'no key in replay');
    const v = verifyReplay(live.dir);
    assert.ok(v.ok, JSON.stringify(v));
    assert.equal(v.hash, live.result.hash);
    assert.ok(v.commands > 50);
  } finally { await m.close(); }
});
