// Static validation of one call against the tool schema, before it reaches the game.
// The game validates semantics (ownership, cost, tiers ...); this catches malformed calls cheaply.
import { TOOLS } from '../../sim/commands.mjs';

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function coerce(v, sch) {
  if (!sch || !sch.type) return { ok: true, v };
  switch (sch.type) {
    case 'integer': {
      const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? +v : v;
      if (!Number.isInteger(n)) return { ok: false, why: 'an integer' };
      return { ok: true, v: n };
    }
    case 'string': return typeof v === 'string' ? { ok: true, v } : { ok: false, why: 'a string' };
    case 'array': return Array.isArray(v) ? { ok: true, v } : { ok: false, why: 'an array' };
    case 'object': return v && typeof v === 'object' ? { ok: true, v } : { ok: false, why: 'an object' };
    default: return { ok: true, v };
  }
}

// -> {ok:true, cmd:{cmd,...args}} | {ok:false, error, message}
export function validateCall(call) {
  const tool = BY_NAME.get(call.name);
  if (!tool) return { ok: false, error: 'unknown_tool', message: `unknown tool "${call.name}"; tools: ${[...BY_NAME.keys()].join(', ')}` };
  const sch = tool.parameters;
  const args = { ...(call.args || {}) };
  if (call.name === 'note' && args.text === undefined) {
    // servers/models send the text under other keys ("note", "thought", "message", "...") or not at all; an empty note is harmless
    const key = ['note', 'thought', 'message', 'content', 'reason', '...', '\u2026'].find((k) => typeof args[k] === 'string' && args[k].trim()) || Object.keys(args).find((k) => typeof args[k] === 'string' && args[k].trim());
    args.text = key ? args[key] : '';
  }
  for (const r of sch.required || []) {
    if (args[r] === undefined) return { ok: false, error: 'missing_arg', message: `${call.name}: missing required argument "${r}"` };
  }
  for (const [k, v0] of Object.entries(args)) {
    const ps = sch.properties?.[k];
    if (!ps) continue; // unknown extra arguments are ignored by the game
    // Some tool servers (e.g. Qwen XML tool templates) hand array / number arguments over as text ("[104, 104]", "45"): decode them. Same for every player.
    let v = v0;
    if (typeof v === 'string') {
      const t = v.trim();
      if (/^[[{]/.test(t)) { try { v = JSON.parse(t); } catch { v = v0; } }
      else if (/^-?\d+$/.test(t) && (ps.oneOf || []).some((o) => o.type === 'integer')) v = +t;
    }
    if (v === null && !(ps.oneOf || []).some((o) => o.type === 'null') && !(sch.required || []).includes(k)) { delete args[k]; continue; }
    const c = coerce(v, ps);
    if (!c.ok) return { ok: false, error: 'bad_arg_type', message: `${call.name}: argument "${k}" must be ${c.why}` };
    args[k] = c.v;
    if (ps.enum && !ps.enum.includes(args[k])) return { ok: false, error: 'bad_arg_value', message: `${call.name}: "${k}" must be one of ${ps.enum.join(', ')}` };
  }
  if (call.name === 'note') args.text = String(args.text).replace(/\s+/g, ' ').trim().slice(0, 120);
  return { ok: true, cmd: { cmd: call.name, ...args } };
}
