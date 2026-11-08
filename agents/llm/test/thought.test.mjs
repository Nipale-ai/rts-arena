import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveThought, parseReply } from '../parse.mjs';
import { validateCall } from '../validate.mjs';
import { LlmPlayer } from '../player.mjs';

test('note tool: empty args, alias keys and the "..." key', () => {
  assert.equal(validateCall({ name: 'note', args: {} }).cmd.text, '');
  assert.equal(validateCall({ name: 'note', args: { '...': 'boom to 30 workers' } }).cmd.text, 'boom to 30 workers');
  for (const k of ['text', 'note', 'thought', 'message']) assert.equal(validateCall({ name: 'note', args: { [k]: ' go  wood ' } }).cmd.text, 'go wood');
  assert.equal(validateCall({ name: 'note', args: { whatever: 'x y z' } }).cmd.text, 'x y z');
});

test('JSON fallback accepts note aliases', () => {
  const r = parseReply({ content: '```json\n{"thought":"rush now","commands":[{"cmd":"gather","resource":"wood","count":2}]}\n```' });
  assert.equal(r.note, 'rush now');
});

test('derived thought: first sentence of the answer, else of the reasoning, prefixed and max 120', () => {
  assert.equal(deriveThought({ content: 'Training archers now. Then I attack.' }), '[reply] Training archers now.');
  assert.equal(deriveThought({ content: '<think>hmm</think>', reasoning_content: 'The enemy has towers, so I should build rams first. More text.' }), '[reasoning] The enemy has towers, so I should build rams first.');
  assert.equal(deriveThought({ content: '', reasoning: 'x' }), '');
  const long = deriveThought({ content: 'a'.repeat(300) });
  assert.ok(long.length <= 120 && long.startsWith('[reply] '));
});

test('player: a reply with an empty note call gets a derived thought', () => {
  const p = new LlmPlayer({ name: 'T', base_url: 'http://127.0.0.1:1/v1', model: 'm' }, { pid: 1 });
  const msg = { content: '', reasoning_content: 'Need more workers before the barracks. Then wood.', tool_calls: [
    { function: { name: 'note', arguments: '{}' } },
    { function: { name: 'gather', arguments: '{"resource":"wood","count":2}' } },
  ] };
  p.onReply({ message: msg, usage: {}, latency_ms: 10, finish_reason: 'tool_calls' }, { n: 1 }, { n: 1, startTick: 0, since: -1, attempt: 1, game_s: 0, lostBase: null, pre: { feedback: [], toolErrors: [], lastError: null } });
  const cmds = p.queue[0].cmds;
  assert.equal(cmds.find((c) => c.cmd === 'note').text, '[reasoning] Need more workers before the barracks.');
});

test('replay log carries the think / tok/s figures so a reloaded or replayed page is not empty', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { startMock } = await import('../mock-server.mjs');
  const { LiveMatch } = await import('../../../server/live-match.mjs');
  const m = await startMock({ delayMs: 10, strategy: 'boom', seed: 5 });
  try {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-hud-'));
    const live = new LiveMatch({ seed: 3, p1: { name: 'Mock', base_url: m.url, model: 'mock', hardware: 'x', timeout_s: 5 }, p2: 'scripted:boom', outRoot: out, maxGameSeconds: 60 });
    await live.run({ speed: 40 });
    const states = fs.readFileSync(path.join(live.dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'state');
    const last = states[states.length - 1];
    assert.ok(last.hud[0].thinks > 0 && last.hud[0].latency > 0);
    assert.equal(last.hud[1], null);
  } finally { await m.close(); }
});

test('reasoning budget: off by default, sent in the chosen style only when set and thinking is on', async () => {
  const { buildBody, resolveConfig } = await import('../client.mjs');
  const base = { name: 'a', base_url: 'http://x/v1', model: 'm', thinking: true };
  assert.equal(buildBody(resolveConfig(base), [], []).chat_template_kwargs.thinking_budget, undefined);
  assert.equal(resolveConfig(base).reasoning_budget_tokens, null);
  assert.equal(buildBody(resolveConfig({ ...base, reasoning_budget_tokens: 2000 }), [], []).chat_template_kwargs.thinking_budget, 2000);
  assert.equal(buildBody(resolveConfig({ ...base, reasoning_budget_tokens: 2000, reasoning_budget_style: 'thinking_token_budget' }), [], []).thinking_token_budget, 2000);
  assert.equal(buildBody(resolveConfig({ ...base, thinking: false, reasoning_budget_tokens: 2000 }), [], []).chat_template_kwargs.thinking_budget, undefined);
});
