// "Make video" for the arena: settings (script LLM, TTS server, voice references), the video endpoints and the file download.
// Hooked into server/arena.mjs with one call: `await videoApi.handle(req, res, url, pathname)` (true = handled) and `videoApi.summaryOf(id)`.
// Same-origin and host checks happen in arena.mjs before any of this runs (every non-GET request).
import './local-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { VideoJobs, VideoError, normalizeRequest, childRunner } from './video-jobs.mjs';
import { checkTts, voiceRef } from '../tools/video-voices.mjs';
import { VOICE_DIRS } from '../tools/caster-voice.mjs';

const PAUSE_FILE = process.env.RTS_PAUSE_FILE || ''; // while this file exists the video queue waits; off unless set (env or local-env.json)
const FILE_TYPES = { '.mp4': 'video/mp4', '.srt': 'text/plain; charset=utf-8' }; // nothing else in a job folder is served
export const DEFAULT_TTS_URL = 'http://127.0.0.1:8000';
const safeId = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(s) && !s.includes('..');
const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const hint = (k) => (k ? '••••' + String(k).slice(-2) : '');

const DEFAULTS = { script_llm: { mode: 'template', player_id: '', base_url: '', model: '', api_key: '' }, tts: { url: DEFAULT_TTS_URL, api_key: '', voices_default: true, voices: {} }, render: { workers: 8 } };

export function createVideoApi({ root, dataDir, replaysDir, getMatch, readPlayer, listPlayers, json, readBody, sendFile, uiDir, runner = null, paused = null, pollMs = 3000 }) {
  const settingsFile = path.join(dataDir, 'settings.json');
  const loadSettings = () => {
    const s = readJson(settingsFile, {}) || {};
    return { script_llm: { ...DEFAULTS.script_llm, ...(s.script_llm || {}) }, tts: { ...DEFAULTS.tts, ...(s.tts || {}), voices: { ...(s.tts?.voices || {}) } }, render: { ...DEFAULTS.render, ...(s.render || {}) } };
  };
  const masked = (s) => {
    const { api_key: lk, ...llm } = s.script_llm, { api_key: tk, ...tts } = s.tts;
    return { render: s.render, script_llm: { ...llm, has_key: !!lk, key_hint: hint(lk) }, tts: { ...tts, has_key: !!tk, key_hint: hint(tk) }, default_voice_dirs: VOICE_DIRS, default_tts_url: DEFAULT_TTS_URL };
  };
  function saveSettings(body) {
    const old = loadSettings(), b = body && typeof body === 'object' ? body : {};
    const s = structuredClone(old);
    if (b.script_llm) {
      const l = b.script_llm, o = old.script_llm;
      const mode = ['template', 'player', 'custom'].includes(l.mode) ? l.mode : o.mode;
      const keepKey = typeof l.api_key !== 'string' || !l.api_key.trim() || /^•+/.test(l.api_key.trim());
      s.script_llm = { mode, player_id: str(l.player_id, 80), base_url: str(l.base_url).replace(/\/+$/, ''), model: str(l.model, 200), api_key: l.clear_key ? '' : keepKey ? o.api_key : l.api_key.trim() };
      if (mode === 'custom' && !/^https?:\/\//.test(s.script_llm.base_url)) throw new VideoError('bad_request', 'The script LLM URL must start with http:// or https://');
      if (mode === 'custom' && !s.script_llm.model) throw new VideoError('bad_request', 'Enter the model id of the script LLM.');
      if (mode === 'player' && !readPlayer(s.script_llm.player_id)) throw new VideoError('bad_request', 'Pick one of the saved LLM players.');
    }
    if (b.tts) {
      const t = b.tts, o = old.tts;
      const url = str(t.url).replace(/\/+$/, '');
      if (url && !/^https?:\/\//.test(url)) throw new VideoError('bad_request', 'The TTS server URL must start with http:// or https://');
      const keepKey = typeof t.api_key !== 'string' || !t.api_key.trim() || /^•+/.test(t.api_key.trim());
      const voices = {};
      for (const n of Object.keys(VOICE_DIRS)) { const d = str(t.voices?.[n], 400); if (d) voices[n] = d; }
      s.tts = { url, api_key: t.clear_key ? '' : keepKey ? o.api_key : t.api_key.trim(), voices_default: t.voices_default !== false, voices };
    }
    if (b.render) s.render = { workers: Math.max(1, Math.min(32, Math.round(Number(b.render.workers)) || old.render.workers)) };
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = settingsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, settingsFile);
    return s;
  }

  // what the runner needs for a job (keys are read here, at start time)
  function resolveJob(job, ctx) {
    const st = loadSettings(), o = job.options;
    let llm = null;
    if (o.llm.source === 'player') {
      const p = readPlayer(o.llm.player_id);
      if (!p) throw new Error('The LLM player chosen for the script no longer exists. Pick another one or use the built-in template.');
      llm = { base: p.base_url, model: p.model, key: p.api_key || '' };
    } else if (o.llm.source === 'custom') llm = { base: o.llm.base_url, model: o.llm.model, key: ctx.secret || (st.script_llm.mode === 'custom' && st.script_llm.base_url === o.llm.base_url ? st.script_llm.api_key : '') };
    return { replayDir: path.join(replaysDir, job.match_id), llm, ttsUrl: st.tts.url || DEFAULT_TTS_URL, ttsKey: st.tts.api_key, voiceDirs: st.tts.voices, workers: st.render.workers };
  }

  const jobs = new VideoJobs({ dir: path.join(dataDir, 'videos'), runner: runner || childRunner({ root, resolve: resolveJob }), paused: paused || (() => !!PAUSE_FILE && fs.existsSync(PAUSE_FILE)), pollMs });

  const fail = (res, e) => {
    if (e instanceof VideoError) {
      const code = { bad_request: 400, not_found: 404, running: 409, already_queued: 409, queue_full: 429, no_replay: 404 }[e.code] || 400;
      return json(res, code, { error: e.message, code: e.code, ...(e.job ? { job: e.job } : {}) });
    }
    console.error('video api error:', e.message); // never the body: it may hold a key
    return json(res, 500, { error: 'server error' });
  };

  // a match can get a video when it has a finished replay
  function eligible(id) {
    const m = getMatch(id);
    if (!m) throw new VideoError('not_found', 'Unknown match.');
    if (m.status === 'running') throw new VideoError('running', 'This match is still running. Make the video after it has ended.');
    if (!fs.existsSync(path.join(replaysDir, id, 'log.jsonl'))) throw new VideoError('no_replay', 'This match has no replay on disk, so no video can be made.');
    if (m.players && m.players.length !== 2) throw new VideoError('bad_request', 'Videos are made for 2-player matches only.');
    return m;
  }

  function serveFile(req, res, matchId, jobId, name) {
    const ext = path.extname(name).toLowerCase();
    if (![matchId, jobId].every(safeId) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..') || !FILE_TYPES[ext]) { res.writeHead(404); res.end('not found'); return; }
    const job = jobs.jobs.get(jobId);
    const base = path.join(jobs.dir, matchId, jobId);
    const f = path.join(base, name);
    if (!job || job.match_id !== matchId || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end('not found'); return; }
    const size = fs.statSync(f).size;
    const head = { 'Content-Type': FILE_TYPES[ext], 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    if (new URL(req.url, 'http://x').searchParams.get('download')) head['Content-Disposition'] = `attachment; filename="${name}"`;
    const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (rg && (rg[1] || rg[2])) {
      let a = rg[1] === '' ? Math.max(0, size - +rg[2]) : +rg[1], b = rg[1] === '' || rg[2] === '' ? size - 1 : Math.min(+rg[2], size - 1);
      if (a >= size || a > b) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(f, { start: a, end: b }).pipe(res);
      return;
    }
    res.writeHead(200, { ...head, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(f).pipe(res);
  }

  async function handle(req, res, u, p) {
    try {
      if (p === '/settings') { sendFile(res, path.join(uiDir, 'settings.html')); return true; }
      let m;
      if ((m = /^\/videos\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(p)) && (req.method === 'GET' || req.method === 'HEAD')) { serveFile(req, res, m[1], m[2], decodeURIComponent(m[3])); return true; }
      if (p === '/api/settings/video') {
        if (req.method === 'POST') { saveSettings(await readBody(req)); }
        json(res, 200, masked(loadSettings()));
        return true;
      }
      if (p === '/api/settings/video/test-tts' && req.method === 'POST') {
        const b = await readBody(req).catch(() => ({}));
        const st = loadSettings();
        const url = str(b.url).replace(/\/+$/, '') || st.tts.url;
        const r = await checkTts(url);
        const refs = {};
        for (const n of Object.keys(VOICE_DIRS)) { try { voiceRef(n, { ...st.tts.voices, ...(b.voices || {}) }); refs[n] = 'ok'; } catch (e) { refs[n] = e.message; } }
        json(res, 200, { ...r, voice_references: refs });
        return true;
      }
      if (p === '/api/video-jobs' && req.method === 'GET') { json(res, 200, { paused: jobs.paused(), jobs: jobs.list().map(({ log, ...j }) => j) }); return true; }
      if ((m = /^\/api\/video-jobs\/([^/]+)(?:\/(cancel))?$/.exec(p)) && safeId(m[1])) {
        const j = jobs.get(m[1]);
        if (!j) { json(res, 404, { error: 'Unknown video job.' }); return true; }
        if (m[2] === 'cancel' && req.method === 'POST') { jobs.cancel(m[1]); json(res, 200, jobs.get(m[1])); return true; }
        json(res, 200, j); return true;
      }
      if ((m = /^\/api\/matches\/([^/]+)\/video(?:\/(cancel))?$/.exec(p)) && safeId(m[1])) {
        const id = m[1];
        if (req.method === 'GET') {
          if (!getMatch(id)) { json(res, 404, { error: 'Unknown match.' }); return true; }
          json(res, 200, { job: jobs.latestFor(id), videos: jobs.doneFor(id).map(({ log, ...j }) => j), paused: jobs.paused() });
          return true;
        }
        if (m[2] === 'cancel') {
          const l = jobs.latestFor(id);
          json(res, 200, { cancelled: !!l && jobs.cancel(l.id), job: jobs.latestFor(id) });
          return true;
        }
        if (req.method === 'POST') {
          let body; try { body = await readBody(req); } catch (e) { throw new VideoError('bad_request', e.message); }
          eligible(id);
          const players = new Set((listPlayers() || []).map((x) => x.id));
          const { options, secret } = normalizeRequest(body, { settings: loadSettings(), players });
          json(res, 200, { job: jobs.enqueue(id, options, { secret }) });
          return true;
        }
      }
    } catch (e) { fail(res, e); return true; }
    return false;
  }

  return { handle, summaryOf: (id) => jobs.summaryFor(id), jobs, loadSettings, shutdown: () => jobs.shutdown() };
}
