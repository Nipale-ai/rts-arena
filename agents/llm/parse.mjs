// Turns a chat-completion message into a list of {name, args} calls.
// 1. OpenAI tool_calls (preferred). 2. Fallback for models that answer with JSON in the text:
//    a ```json fenced block, <tool_call>{...}</tool_call>, or any balanced JSON object / array in the text.
import { TOOLS } from '../../sim/commands.mjs';

const NAMES = new Set(TOOLS.map((t) => t.name));

export function stripThinking(text) {
  return String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim();
}

// JSON.parse with a few cheap repairs that weak models need (trailing commas, single quotes, python literals).
export function lenientParse(s) {
  try { return { ok: true, value: JSON.parse(s) }; } catch {}
  let t = String(s).trim().replace(/,\s*([}\]])/g, '$1');
  try { return { ok: true, value: JSON.parse(t) }; } catch {}
  t = t.replace(/\bNone\b/g, 'null').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/'/g, '"');
  try { return { ok: true, value: JSON.parse(t) }; } catch (e) { return { ok: false, error: e.message }; }
}

// All top-level balanced {...} / [...] substrings of a text (string-aware).
export function balancedJson(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '{' && c !== '[') continue;
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < text.length; j++) {
      const d = text[j];
      if (inStr) { if (esc) esc = false; else if (d === '\\') esc = true; else if (d === '"') inStr = false; continue; }
      if (d === '"') inStr = true;
      else if (d === '{' || d === '[') depth++;
      else if (d === '}' || d === ']') { depth--; if (depth === 0) break; }
    }
    if (depth === 0 && j < text.length) {
      out.push(text.slice(i, j + 1));
      i = j;
    }
  }
  return out;
}

const NOTE_KEYS = ['note', 'thought', 'text', 'message', '...'];
const CMD_KEYS = ['cmd', 'name', 'tool', 'function', 'command', 'action'];

// Normalise one command-like value to {name, args} or null.
function toCall(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (v.function && typeof v.function === 'object') return toCall(v.function);
  let name = null;
  for (const k of CMD_KEYS) if (typeof v[k] === 'string') { name = v[k]; break; }
  if (!name) return null;
  let args;
  for (const k of ['args', 'arguments', 'parameters', 'params', 'input']) {
    if (v[k] !== undefined) {
      args = typeof v[k] === 'string' ? lenientParse(v[k]).value : v[k];
      break;
    }
  }
  if (args === undefined || args === null || typeof args !== 'object') {
    args = {};
    for (const [k, x] of Object.entries(v)) if (!CMD_KEYS.includes(k)) args[k] = x;
  }
  return { name, args };
}

// Collect commands (and an optional note) from a parsed JSON value of unknown shape.
function collect(v, acc) {
  if (Array.isArray(v)) { for (const x of v) collect(x, acc); return; }
  if (!v || typeof v !== 'object') return;
  if (Array.isArray(v.commands) || Array.isArray(v.tool_calls) || Array.isArray(v.calls) || Array.isArray(v.actions)) {
    { const nk = NOTE_KEYS.find((k) => typeof v[k] === 'string'); if (nk) acc.note = v[nk]; }
    collect(v.commands || v.tool_calls || v.calls || v.actions, acc);
    return;
  }
  const c = toCall(v);
  if (c && (NAMES.has(c.name) || CMD_KEYS.some((k) => typeof v[k] === 'string'))) { acc.calls.push(c); return; }
  if (!c) { const nk = NOTE_KEYS.find((k) => typeof v[k] === 'string'); if (nk) acc.note = v[nk]; }
}

export function parseReply(message) {
  const res = { calls: [], errors: [], via: 'none', note: null };
  message = message || {};
  const tcs = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const tc of tcs) {
    const fn = tc.function || tc;
    const name = fn.name;
    let args = fn.arguments;
    if (typeof args === 'string') {
      if (!args.trim()) args = {};
      else {
        const p = lenientParse(args);
        if (!p.ok) { res.errors.push({ kind: 'bad_json', tool: name, message: `arguments of ${name} are not valid JSON: ${p.error}` }); continue; }
        args = p.value;
      }
    }
    if (args === undefined || args === null) args = {};
    if (typeof args !== 'object' || Array.isArray(args)) { res.errors.push({ kind: 'bad_json', tool: name, message: `arguments of ${name} must be a JSON object` }); continue; }
    res.calls.push({ name, args });
  }
  if (res.calls.length) { res.via = 'tool_calls'; return res; }

  const text = stripThinking(message.content);
  const acc = { calls: [], note: null };
  const fences = [...text.matchAll(/```(?:json|JSON|tool_call)?\s*\n?([\s\S]*?)```/g)].map((m) => m[1]);
  const tagged = [...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)].map((m) => m[1]);
  const cands = fences.length ? fences : tagged.length ? tagged : [text];
  let sawJson = false;
  for (const c of cands) {
    const whole = lenientParse(c.trim());
    if (whole.ok && typeof whole.value === 'object') { sawJson = true; collect(whole.value, acc); continue; }
    for (const piece of balancedJson(c)) {
      const p = lenientParse(piece);
      if (p.ok) { sawJson = true; collect(p.value, acc); }
    }
  }
  if (acc.calls.length) {
    res.calls = acc.calls;
    res.via = 'json';
    res.note = acc.note;
  } else if (acc.note) {
    res.note = acc.note;
    res.via = 'json';
  } else if (text) {
    res.errors.push({ kind: sawJson ? 'no_commands' : 'no_tool_calls', message: sawJson ? 'the JSON contained no commands' : 'the reply contained neither tool calls nor a JSON command block' });
  } else {
    res.errors.push({ kind: 'empty_reply', message: 'the reply was empty' });
  }
  return res;
}

// Thought line when the model sent no usable note (empty note arguments, a wrong key, no note at all):
// the first sentence of the final answer, else of the reasoning text. The prefix shows that it is derived, not written as a note.
const clean = (t) => String(t ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]+/g, ' ').replace(/\s+/g, ' ').trim();
export function firstSentence(text, max) {
  const t = clean(text);
  if (t.length < 8) return '';
  const m = /^(.{8,}?[.!?:])(\s|$)/.exec(t);
  let s = m ? m[1] : t;
  if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, '') + '\u2026';
  return s;
}
export function deriveThought(message) {
  const m = message || {};
  const a = firstSentence(m.content, 120 - 8);
  if (a) return '[reply] ' + a;
  const b = firstSentence(m.reasoning_content ?? m.reasoning ?? m.thinking, 120 - 12);
  if (b) return '[reasoning] ' + b;
  return '';
}
