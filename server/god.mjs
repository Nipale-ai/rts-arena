// HTTP side of God mode: POST /api/director with one intervention of the spectator.
// Only the local spectator page may call it: same origin (Origin header must match Host), a fetch from the page itself
// (Sec-Fetch-Site same-origin when the browser sends it), JSON body, and a secret token that the server writes into the
// served spectator page (window.__GOD_TOKEN). The LLM agents never touch HTTP: their orders are tool calls that the match
// driver applies with their own player id, and 'director' is not one of their tools.
import crypto from 'node:crypto';

export const GOD_TOKEN = crypto.randomBytes(18).toString('hex');
const KEYS = ['action', 'player', 'res', 'amount', 'unit', 'count', 'x', 'y', 'id', 'on', 'r', 'secs', 'mirror', 'kind'];

export function guardDirector(req, token = GOD_TOKEN) {
  if (req.method !== 'POST') return { ok: false, code: 405, error: 'POST only' };
  const o = req.headers.origin;
  let same = false;
  try { same = !!o && new URL(o).host === req.headers.host; } catch { same = false; }
  if (!same) return { ok: false, code: 403, error: 'director commands only come from the spectator page of this server' };
  const sf = req.headers['sec-fetch-site'];
  if (sf && sf !== 'same-origin') return { ok: false, code: 403, error: 'cross-site request' };
  if (!/^application\/json/i.test(String(req.headers['content-type'] || ''))) return { ok: false, code: 415, error: 'JSON only' };
  const given = Buffer.from(String(req.headers['x-god-token'] || ''));
  const want = Buffer.from(token);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return { ok: false, code: 403, error: 'bad token' };
  return { ok: true };
}

// only known fields, plain values
export function cleanDirector(body) {
  const cmd = { cmd: 'director' };
  if (body && typeof body === 'object') {
    for (const k of KEYS) {
      const v = body[k];
      if (typeof v === 'number' || typeof v === 'boolean') cmd[k] = v;
      else if (typeof v === 'string') cmd[k] = v.slice(0, 40);
    }
  }
  return cmd;
}

// the spectator page gets the token injected
export function injectToken(html, token = GOD_TOKEN) {
  return html.replace('</head>', `<script>window.__GOD_TOKEN=${JSON.stringify(token)};</script></head>`);
}
