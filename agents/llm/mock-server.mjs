#!/usr/bin/env node
// Mock OpenAI-compatible server (POST /v1/chat/completions) for tests and demos. No GPU, no model.
// It plays a sensible strategy: it runs one of the scripted bots on the observation it receives and answers
// with tool calls. Delay, answer format and error rate are configurable.
//   node agents/llm/mock-server.mjs --port 8091 --delay 200 --strategy boom [--format tools|json|mixed] [--bad 0.1] [--tok-s 80]
import http from 'node:http';
import { createBot } from '../scripted/index.mjs';
import { expandObs, factsOfPrompt } from './compact.mjs';

// opts: delayMs, jitterMs, strategy, format ('tools'|'json'|'mixed'), badRate, tokS, timings (llama.cpp style), seed,
//   streamTokS (decode speed of a streamed reply; default 3000 so tests stay fast), noStream (refuse stream:true with HTTP 400),
//   script(obs, requestNumber) -> [{name, args}] | null (answer with exactly these calls instead of the bot's; used by tests),
//   emptyEvery (every k-th request answers with an empty `note {}` only, like the real servers did), failEvery
export function startMock(opts = {}) {
  const o = { delayMs: 0, jitterMs: 0, strategy: 'boom', format: 'tools', badRate: 0, tokS: 60, timings: true, failEvery: 0, emptyEvery: 0, streamTokS: 3000, noStream: false, ...opts };
  const bots = new Map(); // one bot (with memory) per player id; reset when game time goes backwards
  const stats = { requests: 0, active: 0, maxActive: 0, parallelViolations: 0, bodies: [] };
  let rnd = (o.seed ?? 1) >>> 0;
  const rand = () => ((rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0) / 4294967296);

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
    let buf = '';
    req.on('data', (d) => (buf += d));
    req.on('end', async () => {
      stats.requests++;
      stats.active++;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      let body;
      try { body = JSON.parse(buf); } catch { stats.active--; res.writeHead(400); res.end('{"error":"bad json"}'); return; }
      stats.bodies.push(body);
      if (body.stream && o.noStream) { stats.active--; res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"streaming is not supported"}'); return; }
      if (o.failEvery && stats.requests % o.failEvery === 0) { stats.active--; res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"mock failure"}'); return; }
      const user = body.messages.filter((m) => m.role === 'user').pop()?.content || '{}';
      let obs;
      try { obs = expandObs(JSON.parse(user), factsOfPrompt(body.messages.find((m) => m.role === 'system')?.content || '')); } catch { obs = {}; } // the scripted bots read the long form of the observation (compact.mjs)
      const pid = obs.you ?? 1;
      let ent = bots.get(pid);
      if (!ent || (obs.t ?? 0) < ent.t) bots.set(pid, (ent = { bot: createBot(o.strategy), t: 0 })); // new game: forget the old bot state
      ent.t = obs.t ?? 0;
      const bot = ent.bot;
      let cmds = [];
      try { cmds = bot.think(obs) || []; } catch (e) { cmds = []; }
      const note = `${o.strategy}: ${cmds.length ? String(cmds[0].cmd).replace(/_/g, ' ') + (cmds[0].unit_type ? ' ' + cmds[0].unit_type : cmds[0].building_type ? ' ' + cmds[0].building_type : '') : 'waiting for resources'}`.slice(0, 120);
      let calls = cmds.map((c) => { const { cmd, ...args } = c; return { name: cmd, args }; });
      calls.push({ name: 'note', args: { text: note } });
      if (o.script) { const sc = o.script(obs, stats.requests); if (sc) calls = sc; }
      if (rand() < o.badRate) {
        const kind = Math.floor(rand() * 4);
        if (kind === 0) calls.unshift({ name: 'dig_tunnel', args: { depth: 3 } });
        else if (kind === 1) calls.unshift({ name: 'train', args: { building_id: 'town center', unit_type: 'worker' } });
        else if (kind === 2) calls.unshift({ name: 'train', args: { unit_type: 'worker' } });
        else calls.unshift({ name: 'build', args: { building_type: 'castle', near: [20, 20] } });
      }
      const fmt = o.format === 'mixed' ? (rand() < 0.5 ? 'tools' : 'json') : o.format;
      let message;
      if (o.emptyEvery && stats.requests % o.emptyEvery === 0) {
        message = { role: 'assistant', content: null, reasoning_content: 'I will give my orders now. Let me write the reply.', tool_calls: [{ id: `call_${stats.requests}_0`, type: 'function', function: { name: 'note', arguments: '{}' } }] };
      } else if (fmt === 'tools') {
        message = { role: 'assistant', content: null, tool_calls: calls.map((c, i) => ({ id: `call_${stats.requests}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
      } else {
        const j = { note, commands: calls.filter((c) => c.name !== 'note').map((c) => ({ cmd: c.name, ...c.args })) };
        message = { role: 'assistant', content: `Here is my plan.\n\`\`\`json\n${JSON.stringify(j, null, 1)}\n\`\`\`\nGood luck.` };
      }
      const text = JSON.stringify(message);
      const completion = Math.max(8, Math.round(text.length / 3.5));
      const prompt = Math.round(JSON.stringify(body.messages).length / 3.8);
      const genMs = (completion / o.tokS) * 1000;
      const wait = o.delayMs + (o.jitterMs ? rand() * o.jitterMs : 0);
      await new Promise((r) => setTimeout(r, wait));
      stats.active--;
      const out = {
        id: 'mock-' + stats.requests, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model || 'mock',
        choices: [{ index: 0, message, finish_reason: fmt === 'tools' ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
      };
      if (o.timings) out.timings = { prompt_n: prompt, prompt_ms: 20, predicted_n: completion, predicted_ms: genMs, predicted_per_second: o.tokS };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: out.id, object: 'chat.completion.chunk', created: out.created, model: out.model, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
        const pieces = [];
        if (message.reasoning_content) pieces.push({ reasoning_content: message.reasoning_content });
        if (message.content) for (let i = 0; i < message.content.length; i += 40) pieces.push({ content: message.content.slice(i, i + 40) });
        (message.tool_calls || []).forEach((tc, i) => {
          pieces.push({ tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] });
          const a = tc.function.arguments;
          for (let k = 0; k < a.length; k += 24) pieces.push({ tool_calls: [{ index: i, function: { arguments: a.slice(k, k + 24) } }] });
        });
        const per = ((completion / o.streamTokS) * 1000) / Math.max(1, pieces.length);
        send({ role: 'assistant' });
        for (const d of pieces) { send(d); await new Promise((r) => setTimeout(r, per)); }
        send({}, out.choices[0].finish_reason);
        res.write('data: ' + JSON.stringify({ id: out.id, object: 'chat.completion.chunk', created: out.created, model: out.model, choices: [], usage: out.usage, ...(o.timings ? { timings: out.timings } : {}) }) + '\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => {
    server.listen(o.port ?? 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}/v1`, stats, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = {};
  for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  const m = await startMock({ port: +(a.port || 8091), delayMs: +(a.delay || 0), jitterMs: +(a.jitter || 0), strategy: a.strategy || 'boom', format: a.format || 'tools', badRate: +(a.bad || 0), tokS: +(a['tok-s'] || 60) });
  console.log(`mock model server on ${m.url} (strategy ${a.strategy || 'boom'}, delay ${a.delay || 0} ms)`);
}
