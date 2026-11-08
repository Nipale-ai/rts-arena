#!/usr/bin/env node
// Arena: one local server for the whole app. Lobby + setup pages (ui/), several matches in parallel, each with an id,
// spectator view per match (render/), replays of finished matches. Binds to 127.0.0.1 only. No dependencies beyond Node 22.
//
//   node server/arena.mjs [--port 8800] [--data data] [--allow-host name1,name2]
//
// Data (JSON, written by the UI): data/players/<id>.json (LLM endpoints incl. the api key, mode 0600),
// data/matches/<id>.json (match config, status, result). Replays: replays/<id>/ (written by LiveMatch).
// API keys are only ever sent to the base_url the user entered. They are never logged and never returned by the API.
import './local-env.mjs'; // machine-local RTS_* defaults (local-env.json) before anything reads them
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { args, Match } from './spectate.mjs';
import { Pacer, driftTimer } from './clock.mjs';
import { LiveMatch } from './live-match.mjs';
import { startMock } from '../agents/llm/mock-server.mjs';
import { BOT_NAMES } from '../agents/scripted/index.mjs';
import { TICK_HZ } from '../sim/util.mjs';
import { ensureFrozen } from '../sim-versions/lib.mjs';
import { TIME_LIMIT_S } from '../sim/data.mjs';
import { resolveRules, PRESETS } from '../sim/rules.mjs';
import { GOD_TOKEN, guardDirector, cleanDirector, injectToken } from './god.mjs';
import { rankedOf, soloMarker } from './results.mjs';
import { createMapStore, mapCatalog, mapIdOk } from './maps.mjs';
import { generateMap } from '../sim/mapgen.mjs';
import { checkMap } from '../sim/mapcheck.mjs';
import { createVideoApi, DEFAULT_TTS_URL } from './video-api.mjs';
import { runDoctor } from './doctor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = path.join(ROOT, 'render');
const UI = path.join(ROOT, 'ui');

const A = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const nx = process.argv[i + 1];
  if (nx === undefined || nx.startsWith('--')) A[a.slice(2)] = true;
  else { A[a.slice(2)] = nx; i++; }
}
const PORT = +(A.port ?? 8800);
const DATA = path.resolve(ROOT, typeof A.data === 'string' ? A.data : 'data');
const REPLAYS = typeof A.replays === 'string' ? path.resolve(ROOT, A.replays) : path.join(ROOT, 'replays');
const ALLOW_HOSTS = new Set(['127.0.0.1', 'localhost', ...String(A['allow-host'] || '').split(',').filter(Boolean)]);
for (const d of ['players', 'matches']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
const MAPS = createMapStore(DATA); // saved maps of the world editor: data/maps/<id>.json

// ---------------- small helpers ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg' };
const safeId = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(s) && !s.includes('..');
const readJson = (f, dflt = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, o, mode) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o, null, 1), mode ? { mode } : undefined); fs.renameSync(tmp, f); };
const newId = (p) => `${p}-${crypto.randomBytes(4).toString('hex')}`;
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

let CREATORS = null;
function creators() {
  if (!CREATORS) CREATORS = readJson(path.join(ROOT, 'configs', 'creators.json'), { creators: {} }).creators || {};
  return CREATORS;
}

// ---------------- players (saved LLM endpoints) ----------------
const playerFile = (id) => path.join(DATA, 'players', id + '.json');
const maskedPlayer = (p) => { const { api_key, ...rest } = p; return { ...rest, has_key: !!api_key, key_hint: api_key ? '••••' + String(api_key).slice(-2) : '' }; };

function normPlayer(raw, old) {
  const p = {
    id: old?.id || raw.id,
    name: str(raw.name, 60) || str(raw.model, 60) || 'LLM player',
    base_url: str(raw.base_url, 300).replace(/\/+$/, ''),
    model: str(raw.model, 200),
    hardware: str(raw.hardware, 100),
    creator: str(raw.creator, 80),
    class: str(raw.class, 40),
    thinking: !!raw.thinking,
    reasoning_budget_tokens: raw.reasoning_budget_tokens === undefined || raw.reasoning_budget_tokens === '' || raw.reasoning_budget_tokens === null ? undefined : Math.round(num(raw.reasoning_budget_tokens, 0, 131072, 0)),
    reasoning_budget_style: ['chat_template_kwargs', 'thinking_token_budget', 'thinking_budget', 'reasoning_budget_tokens', 'max_completion_tokens'].includes(raw.reasoning_budget_style) ? raw.reasoning_budget_style : undefined,
    max_tokens: Math.round(num(raw.max_tokens, 16, 131072, 2048)),
    timeout_s: Math.round(num(raw.timeout_s, 5, 1800, 120)),
    sampling: {},
    extra_body: raw.extra_body && typeof raw.extra_body === 'object' && !Array.isArray(raw.extra_body) ? raw.extra_body : undefined,
    api_key: typeof raw.api_key === 'string' && raw.api_key.trim() && !/^•+/.test(raw.api_key.trim()) ? raw.api_key.trim() : old?.api_key || '',
    saved: Date.now(),
  };
  const s = raw.sampling || {};
  for (const k of ['temperature', 'top_p', 'top_k', 'min_p', 'presence_penalty', 'frequency_penalty', 'repeat_penalty', 'seed']) {
    if (s[k] !== undefined && s[k] !== '' && s[k] !== null && Number.isFinite(Number(s[k]))) p.sampling[k] = Number(s[k]);
  }
  if (p.extra_body === undefined) delete p.extra_body;
  if (p.reasoning_budget_tokens === undefined) delete p.reasoning_budget_tokens;
  if (p.reasoning_budget_style === undefined) delete p.reasoning_budget_style;
  if (!/^https?:\/\//.test(p.base_url)) throw new Error('base_url must start with http:// or https://');
  if (!p.model) throw new Error('model is required');
  return p;
}

function savePlayer(raw) {
  const old = safeId(raw.player_id || raw.id) ? readJson(playerFile(raw.player_id || raw.id)) : null;
  const p = normPlayer({ ...raw, id: old?.id || (safeId(raw.player_id || raw.id) ? raw.player_id || raw.id : newId('p')) }, old);
  writeJson(playerFile(p.id), p, 0o600);
  return p;
}

// ---------------- mock servers (one per strategy+delay, in process, localhost only) ----------------
const mocks = new Map();
async function mockUrl(strategy, delayMs) {
  const key = `${strategy}:${delayMs}`;
  if (!mocks.has(key)) mocks.set(key, startMock({ strategy, delayMs, jitterMs: Math.round(delayMs / 4), tokS: 80, seed: 7 }));
  return (await mocks.get(key)).url;
}

// ---------------- matches ----------------
const matchFile = (id) => path.join(DATA, 'matches', id + '.json');
const live = new Map(); // id -> { rec, match, clients, lastClient }

class ArenaMatch extends Match {
  static pending = null;
  initLive() {
    const l = (this.live = ArenaMatch.pending);
    this.seed = l.seed;
    this.game = l.game;
    this.botNames = l.names;
    this.names = l.names;
    this.models = l.models;
    this.hws = l.hws;
    this.creators = l.creators;
    this.cls = l.cls;
    this.id = l.id;
    this.dir = l.dir;
  }
  tick() {
    this.live.tick();
    this.live.slots.forEach((s, i) => {
      const m = this.metrics[i];
      if (s.kind === 'llm') {
        const h = s.agent.hud();
        m.latency = h.latency; m.tokS = h.tokS; m.tokSrc = h.tokSource; m.thinks = h.thinks; m.cmds = h.cmds; m.invalid = h.invalid; m.invalidBy = h.invalidBy; m.empty = h.empty;
        m.thought = h.thought; m.lastCmd = h.lastCmd; m.lastCmdT = h.lastCmdTick;
      } else if (s.lastCmd) {
        m.lastCmd = s.lastCmd; m.lastCmdT = s.lastCmdTick; m.thought = s.thought || '';
      }
    });
    if (this.live.finished && !this.finished) this.finish();
  }
  director(cmd) { return this.live.director(cmd); } // logged by the LiveMatch with the other commands
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.live.finish();
    onFinished(this.id);
  }
}

class ReplayMatch extends Match {} // plain spectate.mjs replay mode (args.replay is set while constructing)

function winnerOf(rec, res) {
  if (!res || !res.winnerTeam) return null;
  const names = rec.players.filter((p) => p.team === res.winnerTeam).map((p) => p.display);
  return names.join(' + ') || `Team ${res.winnerTeam}`;
}

function onFinished(id) {
  const e = live.get(id);
  if (!e) return;
  const r = e.match.live.result || {};
  e.rec.status = e.stopped ? 'stopped' : 'finished';
  e.rec.finished_at = Date.now();
  e.rec.godMode = !!r.godMode;
  e.rec.ranked = rankedOf(r, { stopped: !!e.stopped, solo: e.rec.solo }); // spectator interventions, a stopped match, a solo run and a cutoff never count for rankings or statistics
  e.rec.result = { godMode: !!r.godMode, reason: r.reason, winnerTeam: r.winnerTeam || 0, winner: winnerOf(e.rec, r), game_seconds: r.seconds, wall_seconds: r.wall_seconds, hash: r.hash, scores: (r.players || []).map((p) => ({ id: p.id, team: p.team, score: p.score })) };
  writeJson(matchFile(id), e.rec);
  e.lastClient = Date.now();
}

const SLOT_COLORS = ['#4d8dff', '#ff7a45', '#3ddc97', '#c77dff'];

async function createMatch(body) {
  const n = Array.isArray(body.players) ? body.players.length : 0;
  if (n !== 2 && n !== 4) throw new Error('2 or 4 players (the map generator has 2 or 4 start positions)');
  const seed = Math.round(num(body.seed, 0, 2 ** 31 - 1, Math.floor(Math.random() * 100000)));
  // rules preset: "fast" by default whenever an LLM (or mock) plays, "classic" for bots only; explicit body.rules.preset wins
  const anyLlm = body.players.some((s) => s && (s.type === 'llm' || s.type === 'mock'));
  const wanted = PRESETS[body.rules?.preset] ? body.rules.preset : anyLlm ? 'fast' : 'classic';
  const ov = { preset: wanted };
  if (body.map?.size && [96, 128].includes(+body.map.size)) ov.mapSize = +body.map.size;
  if (body.rules?.time_limit_min !== undefined && body.rules.time_limit_min !== '' && body.rules.time_limit_min !== null) ov.timeLimitS = Math.round(num(body.rules.time_limit_min, 1, TIME_LIMIT_S / 60, 30) * 60);
  if (typeof body.rules?.map_type === 'string' && body.rules.map_type) ov.mapType = body.rules.map_type; // meadow forest desert winter coast (unknown ones fall back to the preset)
  if (typeof body.rules?.weather === 'string' && body.rules.weather) ov.weather = body.rules.weather;
  if (body.rules?.caravans === true || body.rules?.caravans === false) ov.caravans = body.rules.caravans;
  if (body.map?.type === 'custom' && MAPS.get(str(body.map.id, 80))?.mapType) ov.mapType = MAPS.get(str(body.map.id, 80)).mapType;
  const sim = resolveRules(ov);
  const rules = { preset: sim.preset, time_limit_min: sim.timeLimitS / 60, speed: num(body.rules?.speed, 0.25, 64, 1), sim };
  let map = { type: 'standard', size: sim.mapSize, seed }, mapData = null;
  if (body.map?.type === 'custom' || body.map?.id) {
    mapData = MAPS.get(str(body.map.id, 80));
    if (!mapData) throw new Error('unknown map "' + str(body.map.id, 80) + '" (open the editor to build or save it)');
    if (mapData.players.length !== n) throw new Error(`this map has ${mapData.players.length} start positions, but ${n} players were set up`);
    const chk = checkMap(mapData);
    if (!chk.ok) throw new Error('this map cannot be played: ' + chk.errors[0]);
    map = { type: 'custom', id: str(body.map.id, 80), name: mapData.name, size: mapData.size, seed };
  }
  const specs = [], players = [];
  for (let i = 0; i < n; i++) {
    const sl = body.players[i] || {};
    const team = Math.round(num(sl.team, 1, 4, i + 1));
    const type = ['bot', 'mock', 'llm'].includes(sl.type) ? sl.type : 'bot';
    const base = { slot: i + 1, team, type, creator: str(sl.creator, 80) || null };
    if (base.creator && creators()[base.creator] === undefined) base.creator_free = base.creator;
    if (type === 'bot') {
      const bot = BOT_NAMES.includes(sl.bot) ? sl.bot : 'boom';
      specs.push(`scripted:${bot}`);
      players.push({ ...base, bot, display: bot[0].toUpperCase() + bot.slice(1), model: `scripted bot: ${bot}`, hardware: 'Node.js, no GPU', class: str(sl.class, 40) });
    } else if (type === 'mock') {
      const strategy = BOT_NAMES.includes(sl.strategy) ? sl.strategy : 'boom';
      const delay = Math.round(num(sl.delay_ms, 0, 5000, 150));
      const cfg = { name: str(sl.name, 60) || `Mock ${strategy}`, base_url: await mockUrl(strategy, delay), model: `mock-${strategy}`, hardware: str(sl.hardware, 100) || `mock server, ${delay} ms`, thinking: false, max_tokens: 1024, timeout_s: 30, min_interval_s: 1, sampling: { temperature: 0.6, seed: 42 }, class: str(sl.class, 40) || undefined, creator: base.creator || undefined };
      specs.push(cfg);
      players.push({ ...base, strategy, delay_ms: delay, display: cfg.name, model: cfg.model, hardware: cfg.hardware, class: cfg.class || '' });
    } else {
      const saved = savePlayer({ ...sl, id: sl.player_id });
      const cfg = { ...saved, min_interval_s: 1, creator: base.creator || saved.creator || undefined, class: saved.class || undefined };
      specs.push(cfg);
      players.push({ ...base, player_id: saved.id, display: saved.name, model: saved.model, base_url: saved.base_url, hardware: saved.hardware, thinking: saved.thinking, sampling: saved.sampling, class: saved.class, max_tokens: saved.max_tokens });
    }
  }
  const cls = str(body.class, 40) || players.map((p) => p.class).find(Boolean) || undefined;
  const lm = new LiveMatch({ seed, specs, ...(mapData ? { map: mapData } : {}), teams: players.map((p) => p.team), creators: players.map((p) => p.creator), cls, record: true, outRoot: REPLAYS, rules: sim, maxGameSeconds: sim.timeLimitS + 5 });
  lm.slots.forEach((s, i) => { players[i].display = s.name; });
  const id = lm.id;
  const solo = soloMarker(body.solo);
  const rec = { id, sim_version: ensureFrozen(), name: str(body.name, 80) || players.map((p) => p.display).join(' vs '), created: Date.now(), status: 'running', seed, map, rules, class: cls || '', series: str(body.series, 60) || undefined, ...(solo ? { solo } : {}), players };
  writeJson(matchFile(id), rec);
  args.speed = rules.speed;
  ArenaMatch.pending = lm;
  const match = new ArenaMatch();
  ArenaMatch.pending = null;
  match.maxTicks = lm.maxTicks;
  live.set(id, { rec, match, clients: new Set(), lastClient: Date.now(), acc: 0, last: performance.now(), lastMsg: 0 });
  return rec;
}

function stopMatch(id) {
  const e = live.get(id);
  if (!e || e.rec.status !== 'running') return false;
  e.stopped = true;
  e.match.finish();
  return true;
}

// replay viewers: created on demand, dropped when nobody watches
function openReplay(dirName) {
  const rid = 'r-' + dirName;
  if (live.has(rid)) return rid;
  const dir = path.join(REPLAYS, dirName);
  if (!safeId(dirName) || !fs.existsSync(path.join(dir, 'log.jsonl'))) return null;
  args.replay = dir;
  args.speed = 1;
  const match = new ReplayMatch();
  delete args.replay;
  live.set(rid, { rec: { id: rid, status: 'replay' }, match, clients: new Set(), lastClient: Date.now(), acc: 0, last: performance.now(), replay: true, started: false });
  return rid;
}

// ---------------- listing ----------------
function listMatches() {
  const out = new Map();
  for (const f of fs.readdirSync(path.join(DATA, 'matches'))) {
    if (!f.endsWith('.json')) continue;
    const r = readJson(path.join(DATA, 'matches', f));
    if (r?.id) out.set(r.id, r.ranked ? { ...r, ranked: rankedOf(r.result, { stopped: r.status === 'stopped', solo: r.solo }) } : r); // older records of stopped matches say ranked: true
  }
  // running ones from memory (always fresher)
  for (const [id, e] of live) if (!e.replay) out.set(id, e.rec);
  // older replays that were recorded outside the arena
  if (fs.existsSync(REPLAYS)) {
    for (const d of fs.readdirSync(REPLAYS)) {
      if (out.has(d) || !safeId(d)) continue;
      const r = readJson(path.join(REPLAYS, d, 'result.json'));
      if (!r) continue;
      const meta = readJson(path.join(REPLAYS, d, 'runMeta.json')); // written by tools/solo/run-solo.mjs
      const start = (fs.readFileSync(path.join(REPLAYS, d, 'log.jsonl'), 'utf8').split('\n', 1)[0] || '{}');
      let st = {}; try { st = JSON.parse(start); } catch { /* ignore */ }
      const names = r.bots || st.bots || [];
      out.set(d, { id: d, name: names.join(' vs '), created: fs.statSync(path.join(REPLAYS, d)).mtimeMs, status: 'finished', imported: true, seed: r.seed, class: st.class || '', godMode: !!r.godMode, ranked: rankedOf(r, { solo: meta?.solo, invalid: !!meta && (meta.valid === false || meta.status !== 'done') }), ...(meta?.solo ? { solo: meta.solo } : {}),
        players: names.map((nm, i) => ({ slot: i + 1, team: st.teams?.[i] ?? i + 1, display: nm, model: st.players?.[i]?.model || '', hardware: st.players?.[i]?.hardware || '', type: st.players?.[i]?.kind === 'llm' ? 'llm' : 'bot' })),
        result: { godMode: !!r.godMode, reason: r.reason, winnerTeam: r.winnerTeam || 0, winner: null, game_seconds: r.seconds, wall_seconds: r.wall_seconds } });
      const rec = out.get(d);
      rec.result.winner = winnerOf(rec, rec.result);
    }
  }
  return [...out.values()].sort((a, b) => b.created - a.created);
}

function summary(r) {
  const e = live.get(r.id);
  const out = { ...r, players: (r.players || []).map(({ base_url, sampling, ...p }) => p) };
  if (r.status !== 'running') out.video = videoApi.summaryOf(r.id);
  out.watch_url = r.status === 'running' ? `/watch/${r.id}/` : null;
  out.replay_url = r.status !== 'running' ? `/watch/r-${r.id}/` : null;
  if (e && r.status === 'running') {
    const g = e.match.game;
    out.godMode = !!g.godMode;
    out.progress = { game_seconds: Math.round(g.t / TICK_HZ), scores: g.players.slice(1).map((p) => g.score(p)) };
  }
  return out;
}

// ---------------- test connection ----------------
async function testConnection(body) {
  let key = typeof body.api_key === 'string' && !/^•+/.test(body.api_key.trim()) ? body.api_key.trim() : '';
  if (!key && safeId(body.player_id)) key = readJson(playerFile(body.player_id), {}).api_key || '';
  const base = str(body.base_url, 300).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('base_url must start with http:// or https://');
  const model = str(body.model, 200);
  const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  const out = { ok: false, models: null, model_listed: null, models_ms: null, completion_ms: null, reply: null, error: null };
  // the model answer waits as long as a match would (a cold start loads the weights first); the model list gets 20 s
  const waitS = num(body.timeout_s ?? (safeId(body.player_id) ? readJson(playerFile(body.player_id), {}).timeout_s : null), 5, 1800, 120);
  const timed = async (url, init, ms = 20000) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    const t0 = performance.now();
    try { const r = await fetch(url, { ...init, headers, signal: ctl.signal }); const text = await r.text(); return { r, text, ms: Math.round(performance.now() - t0) }; }
    finally { clearTimeout(timer); }
  };
  try {
    const m = await timed(base + '/models', { method: 'GET' });
    out.models_ms = m.ms;
    if (m.r.ok) {
      try { const ids = (JSON.parse(m.text).data || []).map((x) => x.id).filter(Boolean); out.models = ids.slice(0, 40); out.model_listed = model ? ids.includes(model) : null; } catch { /* not JSON */ }
    } else out.models_status = m.r.status;
  } catch (e) { out.error = `GET /models failed: ${e.name === 'AbortError' ? 'timeout' : e.cause?.code || (e.message === 'fetch failed' ? 'connection refused or host unreachable' : e.message)}`; return out; }
  if (!model) { // no model id yet: the list of models is the answer (the page offers them as choices)
    out.ok = out.models_ms != null && !!out.models;
    if (!out.ok && !out.error) out.error = out.models_status ? `GET /models answered HTTP ${out.models_status}; type the model id by hand` : 'the server did not return a model list; type the model id by hand';
    return out;
  }
  try {
    const c = await timed(base + '/chat/completions', { method: 'POST', body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 1, stream: false }) }, waitS * 1000);
    out.completion_ms = c.ms;
    out.completion_status = c.r.status;
    if (c.r.ok) {
      try { const j = JSON.parse(c.text); out.reply = String(j.choices?.[0]?.message?.content ?? '').slice(0, 60); } catch { /* ignore */ }
      out.ok = true;
    } else { let msg = c.text.slice(0, 200); try { msg = JSON.parse(c.text).error?.message || msg; } catch { /* ignore */ } out.error = `HTTP ${c.r.status}: ${String(msg).replace(key || '\u0000', '***')}`; }
  } catch (e) { out.error = `chat/completions failed: ${e.name === 'AbortError' ? 'timeout' : e.cause?.code || (e.message === 'fetch failed' ? 'connection failed' : e.message)}`; }
  return out;
}

// ---------------- http ----------------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (d) => { n += d.length; if (n > 1e6) { reject(new Error('body too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });
}
function sendFile(res, f, inject) {
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  const type = MIME[path.extname(f)] || 'application/octet-stream';
  if (inject) {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(inject(fs.readFileSync(f, 'utf8')));
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}
function under(base, rel) {
  const f = path.normalize(path.join(base, decodeURIComponent(rel)));
  return f.startsWith(base + path.sep) || f === base ? f : null;
}

const WATCH_BAR = `<style>#arena-bar{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:50;display:flex;gap:8px;font:500 12px Inter,system-ui,sans-serif}
#arena-bar a{color:#e6ebf2;background:rgba(10,14,20,.82);border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:6px 12px;text-decoration:none;backdrop-filter:blur(8px)}
#arena-bar a:hover{border-color:#4d8dff}</style><div id="arena-bar"><a href="/">&larr; Lobby</a><a href="/new">New match</a></div>`;

function matchFromReq(req, u) {
  const q = u.searchParams.get('m');
  if (q && live.has(q)) return live.get(q);
  const ref = req.headers.referer || '';
  const m = /\/watch\/([A-Za-z0-9._-]+)\//.exec(ref);
  return m ? live.get(m[1]) : null;
}

// ---------------- post-match video (server/video-api.mjs): settings, "Make video" jobs, downloads ----------------
const VIDEO_BAR = '<link rel="stylesheet" href="/ui/video.css"><script type="module" src="/ui/video-bar.js"></script>';
const videoApi = createVideoApi({
  root: ROOT, dataDir: DATA, replaysDir: REPLAYS, json, readBody, sendFile, uiDir: UI,
  getMatch: (id) => {
    if (!safeId(id)) return null;
    const e = live.get(id);
    if (e && !e.replay) return e.rec;
    return readJson(matchFile(id)) || (fs.existsSync(path.join(REPLAYS, id, 'result.json')) ? { id, status: 'finished', imported: true } : null);
  },
  readPlayer: (id) => (safeId(id) ? readJson(playerFile(id)) : null),
  listPlayers: () => fs.readdirSync(path.join(DATA, 'players')).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(DATA, 'players', f))).filter(Boolean),
});

const server = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!ALLOW_HOSTS.has(host)) { res.writeHead(403); res.end('forbidden host'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const o = req.headers.origin;
      if (o && new URL(o).host !== req.headers.host) { res.writeHead(403); res.end('forbidden origin'); return; }
      if (req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403); res.end('forbidden origin'); return; }
    }
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;

    // ---- API ----
    if (p === '/api/director') {
      const gd = guardDirector(req);
      if (!gd.ok) return json(res, gd.code, { ok: false, error: gd.error });
      const e = matchFromReq(req, u);
      if (!e || e.replay || e.rec.status !== 'running') return json(res, 404, { ok: false, error: 'no running match' });
      let body; try { body = await readBody(req); } catch (err) { return json(res, 400, { ok: false, error: err.message }); }
      const r = e.match.director(cleanDirector(body));
      if (r.ok) e.rec.godMode = true;
      json(res, 200, r);
      if (e.clients.size) broadcast(e, e.match.snapshot());
      return;
    }
    if (p === '/api/state') {
      return json(res, 200, { bots: BOT_NAMES, time_limit_min: TIME_LIMIT_S / 60, presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { map_size: v.mapSize, time_limit_min: v.timeLimitS / 60 }])), map_types: [{ id: 'standard', label: 'Standard (generated, mirrored)', sizes: [96, 128] }], creators: Object.values(creators()).map((c) => ({ id: c.id, name: c.name, x: c.x, logo: c.logo, primary: c.primary, secondary: c.secondary })), maps: MAPS.list(), players: fs.readdirSync(path.join(DATA, 'players')).filter((f) => f.endsWith('.json')).map((f) => maskedPlayer(readJson(path.join(DATA, 'players', f)))).sort((a, b) => b.saved - a.saved) });
    }
    if (p === '/api/doctor') return json(res, 200, await runDoctor({ dataDir: DATA, ttsUrl: videoApi.loadSettings().tts.url || DEFAULT_TTS_URL })); // the /check page
    if (p === '/api/matches' && req.method === 'GET') return json(res, 200, listMatches().map(summary));
    if (p === '/api/matches' && req.method === 'POST') {
      try { const rec = await createMatch(await readBody(req)); return json(res, 200, summary(rec)); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    let m = /^\/api\/matches\/([^/]+)(?:\/(stop))?$/.exec(p);
    if (m && safeId(m[1])) {
      if (m[2] === 'stop' && req.method === 'POST') return json(res, 200, { stopped: stopMatch(m[1]) });
      const r = live.get(m[1])?.rec || readJson(matchFile(m[1]));
      return r ? json(res, 200, summary(r)) : json(res, 404, { error: 'unknown match' });
    }
    if (p === '/api/players' && req.method === 'POST') {
      try { return json(res, 200, maskedPlayer(savePlayer(await readBody(req)))); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    m = /^\/api\/players\/([^/]+)$/.exec(p);
    if (m && safeId(m[1])) {
      if (req.method === 'DELETE') {
        const f = playerFile(m[1]);
        if (fs.existsSync(f)) { fs.mkdirSync(path.join(DATA, '_alt-players'), { recursive: true }); fs.renameSync(f, path.join(DATA, '_alt-players', `${m[1]}-${Date.now()}.json`)); }
        return json(res, 200, { deleted: true });
      }
      const pl = readJson(playerFile(m[1]));
      return pl ? json(res, 200, maskedPlayer(pl)) : json(res, 404, { error: 'unknown player' });
    }
    // ---- world editor: maps ----
    if (p === '/api/maps/catalog') return json(res, 200, mapCatalog());
    if (p === '/api/maps/generate' && req.method === 'POST') {
      try {
        const b = await readBody(req);
        const players = +b.players === 4 ? 4 : 2, size = +b.size === 96 ? 96 : 128;
        const seed = Math.round(num(b.seed, 0, 2 ** 31 - 1, 1));
        const m = generateMap(seed, { players, size, treasure: b.treasure ? { gold: 2000, stone: 1200 } : null, shrines: !!b.shrines });
        m.name = str(b.name, 60) || `Generated ${players}p seed ${seed}`;
        return json(res, 200, { map: m, check: checkMap(m) });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/maps/validate' && req.method === 'POST') {
      try { return json(res, 200, checkMap((await readBody(req)).map)); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/maps' && req.method === 'GET') return json(res, 200, { maps: MAPS.list() });
    if (p === '/api/maps' && req.method === 'POST') {
      try { const b = await readBody(req); return json(res, 200, MAPS.save(b.map, b.id)); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    m = /^\/api\/maps\/([^/]+)$/.exec(p);
    if (m && mapIdOk(m[1])) {
      if (req.method === 'DELETE') return MAPS.remove(m[1]) ? json(res, 200, { deleted: true }) : json(res, 404, { error: 'unknown map' });
      const mp = MAPS.get(m[1]);
      return mp ? json(res, 200, { id: m[1], map: mp }) : json(res, 404, { error: 'unknown map' });
    }
    if (await videoApi.handle(req, res, u, p)) return;
    if (p === '/api/test' && req.method === 'POST') {
      try { return json(res, 200, await testConnection(await readBody(req))); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }

    // ---- spectator plumbing (the render app uses absolute /events and /api/speed|pause|fog; the match comes from the Referer) ----
    if (p === '/events') {
      const e = matchFromReq(req, u);
      if (!e) { res.writeHead(404); res.end('no match'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(e.match.initMsg())}\n\n`);
      e.clients.add(res);
      broadcast(e, e.match.snapshot()); // snapshot() hands out tg/ng/dead/ev only once: the other viewers must get what this one drains
      req.on('close', () => { e.clients.delete(res); e.lastClient = Date.now(); });
      return;
    }
    if (p === '/api/speed' || p === '/api/pause' || p === '/api/fog') {
      const e = matchFromReq(req, u);
      if (!e) return json(res, 404, { error: 'no match' });
      const mt = e.match, q = u.searchParams;
      if (p === '/api/speed') { mt.speed = Math.max(0.25, Math.min(64, +q.get('x') || 1)); mt.paused = false; }
      else if (p === '/api/pause') mt.paused = q.get('on') === '1' ? true : q.get('on') === '0' ? false : !mt.paused;
      else mt.fogPid = +q.get('p') || 0;
      json(res, 200, { speed: mt.speed, paused: mt.paused, fog: mt.fogPid });
      if (e.clients.size) broadcast(e, mt.snapshot());
      return;
    }

    // ---- pages ----
    let w = /^\/watch\/([A-Za-z0-9._-]+)(\/.*)?$/.exec(p);
    if (w) {
      let id = w[1];
      if (id.startsWith('r-') && !live.has(id)) id = openReplay(id.slice(2)) || id;
      else if (!live.has(id) && safeId(id)) { // finished match not in memory: go to its replay
        res.writeHead(302, { Location: `/watch/r-${id}/` }); res.end(); return;
      }
      const e = live.get(id);
      if (!e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('unknown match'); return; }
      if (!w[2]) { res.writeHead(302, { Location: `/watch/${id}/` }); res.end(); return; }
      if (!e.replay && e.rec.status !== 'running' && !id.startsWith('r-')) { res.writeHead(302, { Location: `/watch/r-${id}/` }); res.end(); return; }
      const rel = w[2] === '/' ? 'index.html' : w[2];
      const f = under(RENDER, rel);
      if (!f) { res.writeHead(403); res.end(); return; }
      return sendFile(res, f, rel === 'index.html' ? (t) => injectToken(t.replace('</body>', WATCH_BAR + (e.replay ? VIDEO_BAR : '') + '</body>'), GOD_TOKEN) : null);
    }
    if (p === '/' || p === '/lobby') return sendFile(res, path.join(UI, 'index.html'));
    if (p === '/editor' || p === '/editor/') return sendFile(res, path.join(UI, 'editor.html'));
    if (p === '/new' || p === '/setup') return sendFile(res, path.join(UI, 'setup.html'));
    if (p === '/check') return sendFile(res, path.join(UI, 'check.html'));
    if (p.startsWith('/ui/')) { const f = under(UI, p.slice(4)); return f ? sendFile(res, f) : (res.writeHead(403), res.end()); }
    if (p.startsWith('/assets/')) { const f = under(path.join(RENDER, 'assets'), p.slice(8)); return f ? sendFile(res, f) : (res.writeHead(403), res.end()); }
    if (p.startsWith('/theme/')) { const f = under(path.join(RENDER, 'theme'), p.slice(7)); return f ? sendFile(res, f) : (res.writeHead(403), res.end()); } // display names + themes: the pages of ui/ import them (ui/editor.js)
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    console.error('request error:', e.message); // never include headers or bodies (keys)
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
});

function broadcast(e, obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of e.clients) c.write(line);
}

// one loop for all matches. Fixed-step, drift corrected: the ticks due come from the wall clock (Pacer), the loop itself runs on an
// absolute 50 ms schedule, and nothing in it waits for a model (LLM requests are asynchronous).
driftTimer(() => {
  const now = performance.now();
  for (const [id, e] of live) {
    const mt = e.match;
    if (!e.pacer) e.pacer = new Pacer();
    if (e.replay && !e.started) { if (!e.clients.size) { e.pacer.hold(); continue; } e.started = true; e.pacer.hold(); }
    if (!mt.paused && !mt.game.over && !mt.finished) {
      const n = e.pacer.take(mt.speed);
      for (let i = 0; i < n && !mt.game.over && !mt.finished; i++) {
        mt.tick();
        if (!e.replay && mt.live.maxTicks && mt.game.t >= mt.live.maxTicks) { mt.finish(); break; }
      }
    } else e.pacer.hold();
    if (!e.replay && e.rec.status === 'running' && mt.game.over && !mt.finished) mt.finish();
    // one snapshot per sim tick (or flag change), not per timer call: repeated identical snapshots only cost bandwidth
    const sig = `${mt.game.t}|${mt.paused}|${mt.speed}|${mt.fogPid}`;
    if (e.clients.size && (!mt.game.over || !e.sentOver) && sig !== e.lastSig) {
      e.lastSig = sig;
      broadcast(e, mt.snapshot());
      if (mt.game.over) e.sentOver = true;
    }
    // drop finished matches and idle replays from memory after a while without viewers
    if (!e.clients.size && now > 0 && Date.now() - e.lastClient > 5 * 60_000 && (e.replay || e.rec.status !== 'running')) live.delete(id);
  }
}, 50);

function shutdown() {
  videoApi.shutdown();
  for (const [, e] of live) if (!e.replay && e.rec.status === 'running') { e.stopped = true; try { e.match.finish(); } catch { /* ignore */ } }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '127.0.0.1', () => console.log(`Arena: http://127.0.0.1:${server.address().port}/  (data: ${path.relative(ROOT, DATA) || DATA})`));
