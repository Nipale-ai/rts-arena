// Minimal OpenAI-compatible chat client (fetch). Streams the reply (SSE) so that the decode speed can be measured the same way for every
// server; falls back to a plain request when a server refuses streaming. One request at a time per caller.
// Sends sampling and extra body fields exactly as configured. Never talks to anything but cfg.base_url.

// reasoning_budget_tokens (per player, default off). Where the number goes (reasoning_budget_style):
//   chat_template_kwargs  chat_template_kwargs.thinking_budget = N   Qwen-style chat templates that read `thinking_budget`; a template
//                         that ignores the variable ignores the budget (llama.cpp --jinja, vLLM, TabbyAPI/ExLlamaV3 pass the kwargs to the template)
//   thinking_token_budget top-level `thinking_token_budget` = N      vLLM (needs a reasoning parser / reasoning config on the server)
//   thinking_budget       top-level `thinking_budget` = N            DashScope / compatible gateways
//   reasoning_budget_tokens top-level `reasoning_budget_tokens` = N  llama.cpp-style servers that accept a per-request budget
//   max_completion_tokens top-level `max_completion_tokens` = N      hard cap on ALL generated tokens (reasoning + answer) where the server supports it
// Not verified against any live server yet: read completion_tokens in io.jsonl to see whether a server honours it.
export const REASONING_STYLES = ['chat_template_kwargs', 'thinking_token_budget', 'thinking_budget', 'reasoning_budget_tokens', 'max_completion_tokens'];

export function resolveConfig(raw) {
  const c = { ...raw };
  for (const k of ['name', 'base_url', 'model']) if (!c[k]) throw new Error(`player config: "${k}" is required`);
  c.base_url = String(c.base_url).replace(/\/+$/, '');
  c.hardware = c.hardware || 'unknown hardware';
  c.max_tokens = c.max_tokens ?? 2048;
  c.thinking = c.thinking ?? false;
  c.timeout_s = c.timeout_s ?? 120;
  c.sampling = c.sampling || {};
  c.min_interval_s = c.min_interval_s ?? 1; // game seconds between the end of one round and the start of the next
  c.tool_choice = c.tool_choice ?? 'auto';
  c.stream = c.stream !== false; // stream the reply so tok/s is a decode rate measured the same way for every server (see speedOf)
  // Optional cap on the hidden reasoning, OFF unless set (null). See buildBody for the request field per style.
  c.reasoning_budget_tokens = Number.isInteger(+c.reasoning_budget_tokens) && c.reasoning_budget_tokens !== null && c.reasoning_budget_tokens !== '' && +c.reasoning_budget_tokens >= 0 ? +c.reasoning_budget_tokens : null;
  c.reasoning_budget_style = REASONING_STYLES.includes(c.reasoning_budget_style) ? c.reasoning_budget_style : 'chat_template_kwargs';
  return c;
}

export function publicConfig(c) {
  const { api_key, ...rest } = c; // never write keys to replays
  return { ...rest, has_api_key: !!api_key };
}

export function buildBody(cfg, messages, tools) {
  const body = {
    model: cfg.model,
    messages,
    max_tokens: cfg.max_tokens,
    stream: !!cfg.stream,
    ...(cfg.stream ? { stream_options: { include_usage: true } } : {}),
    ...cfg.sampling,
  };
  if (tools && tools.length && cfg.tools !== false) {
    body.tools = tools;
    body.tool_choice = cfg.tool_choice;
  }
  // llama.cpp, vLLM and similar servers read the chat template switch from here
  body.chat_template_kwargs = { enable_thinking: !!cfg.thinking, ...(cfg.chat_template_kwargs || {}) };
  const rb = cfg.reasoning_budget_tokens;
  if (rb !== null && rb !== undefined && cfg.thinking) {
    if (cfg.reasoning_budget_style === 'chat_template_kwargs') body.chat_template_kwargs.thinking_budget = rb;
    else body[cfg.reasoning_budget_style] = rb;
  }
  return Object.assign(body, cfg.extra_body || {});
}

// -> { message, finish_reason, usage, timings, latency_ms, status, stream } ; throws Error with .kind on failure
// cfg.stream (default true, set false to switch it off): the reply is read as a stream. `stream` in the result then holds the arrival
// times of the first and the last token chunk (ms after the request started), the number of chunks and any server-specific extra fields.
export async function chat(cfg, messages, tools, { signal } = {}) {
  const body = buildBody(cfg, messages, tools);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), cfg.timeout_s * 1000);
  if (signal) signal.addEventListener('abort', () => ctl.abort(signal.reason), { once: true });
  const t0 = performance.now();
  let resp, text, st = null;
  const fail = (e) => {
    const timedOut = ctl.signal.aborted && String(ctl.signal.reason?.message) === 'timeout';
    const err = new Error(timedOut ? `timeout after ${cfg.timeout_s}s` : `network error: ${e.cause?.code || e.message}`);
    err.kind = timedOut ? 'timeout' : 'network';
    err.latency_ms = performance.now() - t0;
    return err;
  };
  try {
    resp = await fetch(cfg.base_url + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.api_key ? { Authorization: `Bearer ${cfg.api_key}` } : {}) },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (resp.ok && body.stream && /text\/event-stream/i.test(resp.headers.get('content-type') || '')) st = await readStream(resp, t0);
    else text = await resp.text();
  } catch (e) {
    throw fail(e);
  } finally {
    clearTimeout(timer);
  }
  const latency_ms = performance.now() - t0;
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    err.kind = 'http';
    err.status = resp.status;
    err.latency_ms = latency_ms;
    throw err;
  }
  if (st) {
    const ch = st.choice;
    if (!ch) {
      const err = new Error('stream has no choices: ' + st.rawHead);
      err.kind = 'bad_response';
      err.latency_ms = latency_ms;
      throw err;
    }
    return { message: st.message, finish_reason: ch.finish_reason, usage: st.usage || {}, timings: st.timings, latency_ms, status: resp.status, stream: st.info, extra: st.extra, raw: null };
  }
  let j;
  try { j = JSON.parse(text); } catch {
    const err = new Error('response is not JSON: ' + text.slice(0, 120));
    err.kind = 'bad_response';
    err.latency_ms = latency_ms;
    throw err;
  }
  const ch = j.choices?.[0];
  if (!ch) {
    const err = new Error('response has no choices: ' + text.slice(0, 160));
    err.kind = 'bad_response';
    err.latency_ms = latency_ms;
    throw err;
  }
  const { choices, usage, timings, id, object, created, model, ...extra } = j; // server-specific extras (grammar stats, engine stats ...)
  return { message: ch.message || {}, finish_reason: ch.finish_reason, usage: j.usage || {}, timings: j.timings || null, latency_ms, status: resp.status, extra: Object.keys(extra).length ? extra : undefined, raw: j };
}

// Reads an OpenAI chat-completion SSE stream into the same message shape a plain reply has.
// Arrival times are taken from the first and the last chunk that carries generated text or tool-call data.
async function readStream(resp, t0) {
  const dec = new TextDecoder();
  let buf = '', rawHead = '';
  const msg = { role: 'assistant', content: '', reasoning_content: '' };
  const calls = []; // by index
  let finish = null, usage = null, timings = null, tFirst = null, tLast = null, chunks = 0;
  let extra = {};
  const onData = (data) => {
    if (data === '[DONE]') return;
    if (rawHead.length < 160) rawHead += data.slice(0, 160);
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (j.usage) usage = j.usage;
    if (j.timings) timings = j.timings;
    const { choices, usage: _u, timings: _t, id, object, created, model, ...rest } = j;
    for (const [k, v] of Object.entries(rest)) if (v !== null && v !== undefined) extra[k] = v;
    const c = j.choices?.[0];
    if (!c) return;
    const d = c.delta || {};
    let got = false;
    if (typeof d.content === 'string' && d.content) { msg.content += d.content; got = true; }
    const r = d.reasoning_content ?? d.reasoning;
    if (typeof r === 'string' && r) { msg.reasoning_content += r; got = true; }
    for (const tc of d.tool_calls || []) {
      const i = Number.isInteger(tc.index) ? tc.index : calls.length;
      const e = calls[i] || (calls[i] = { id: undefined, type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) e.id = tc.id;
      if (tc.function?.name) e.function.name += tc.function.name;
      if (typeof tc.function?.arguments === 'string') e.function.arguments += tc.function.arguments;
      got = true;
    }
    if (got) {
      const now = performance.now() - t0;
      if (tFirst === null) tFirst = now;
      tLast = now;
      chunks++;
    }
    if (c.finish_reason) finish = c.finish_reason;
  };
  const feed = (line) => { if (line.startsWith('data:')) onData(line.slice(5).trim()); };
  for await (const part of resp.body) {
    buf += dec.decode(part, { stream: true });
    let k;
    while ((k = buf.indexOf('\n')) >= 0) { feed(buf.slice(0, k).replace(/\r$/, '')); buf = buf.slice(k + 1); }
  }
  buf += dec.decode();
  if (buf.trim()) feed(buf.trim());
  const tool_calls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  const message = { role: 'assistant', content: msg.content || null, ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}), ...(tool_calls.length ? { tool_calls } : {}) };
  const got = tFirst !== null || finish;
  return { message, choice: got ? { finish_reason: finish } : null, usage, timings, extra: Object.keys(extra).length ? extra : undefined, rawHead, info: { first_ms: tFirst, last_ms: tLast, chunks } };
}

// Speed figures from a response. tok/s = completion tokens / decode time, measured the same way for every player:
//   source 'stream-decode': (completion_tokens - 1) / (arrival of the last token chunk - arrival of the first one). The first token marks
//     the end of prompt processing, so the figure excludes prefill and network setup (needs a streamed reply and >= 8 tokens).
//   no stream (a server that refuses it): source 'wall-latency' = completion tokens / total latency, a lower bound that includes prefill.
// A server's own figure (llama.cpp `timings`) is kept as tok_s_server, for a cross-check only; it is never mixed into tok_s.
export function speedOf(res) {
  const u = res.usage || {};
  const t = res.timings;
  const completion = u.completion_tokens ?? t?.predicted_n ?? null;
  const prompt = u.prompt_tokens ?? t?.prompt_n ?? null;
  let tokS = null, src = null, decodeMs = null;
  const s = res.stream;
  if (s && s.first_ms !== null && s.last_ms !== null && completion >= 8 && s.last_ms - s.first_ms > 50) {
    decodeMs = s.last_ms - s.first_ms;
    tokS = ((completion - 1) * 1000) / decodeMs;
    src = 'stream-decode';
  } else if (completion && res.latency_ms > 0) { tokS = (completion * 1000) / res.latency_ms; src = 'wall-latency'; decodeMs = res.latency_ms; }
  let server = null;
  if (t && Number.isFinite(t.predicted_per_second) && t.predicted_per_second > 0) server = t.predicted_per_second;
  else if (t && t.predicted_ms > 0 && completion) server = (completion * 1000) / t.predicted_ms;
  else if (res.extra?.tensorfold?.tokens_per_second) server = res.extra.tensorfold.tokens_per_second;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? null;
  return {
    prompt_tokens: prompt, completion_tokens: completion, reasoning_tokens: reasoning, visible_tokens: reasoning !== null && completion !== null ? completion - reasoning : null,
    tok_s: tokS, tok_s_source: src, decode_ms: decodeMs, tok_s_server: server,
    ttft_ms: s && s.first_ms !== null ? Math.round(s.first_ms) : null, prompt_ms: t?.prompt_ms ?? (res.extra?.tensorfold?.prefill_seconds != null ? res.extra.tensorfold.prefill_seconds * 1000 : null), prompt_tok_s: t?.prompt_per_second ?? null,
  };
}
