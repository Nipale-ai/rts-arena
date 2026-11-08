// Job queue for "Make video": one job at a time, FIFO, progress, cancel, persisted next to the match (data/videos/<match>/<job>/).
// The queue knows nothing about rendering: a runner does the work (default: tools/make-video.mjs in a child process), so tests use a fake one.
// A job never stores an API key. Keys are looked up when the job starts (saved LLM player, settings) or held in memory (custom endpoint).
import './local-env.mjs'; // machine-local RTS_* defaults (local-env.json) before anything reads them
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export class VideoError extends Error { constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); } }

export const FORMATS = ['yt', 'x', 'both'];
export const LENGTHS = ['highlight', 'story5', 'full'];
export const ACTIVE = new Set(['queued', 'running']);
const LOG_TAIL = 40;

const writeJson = (f, o) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o, null, 1)); fs.renameSync(tmp, f); };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// ---------------------------------------------------------------- request -> options (pure, no key inside)
// settings.script_llm: { mode: 'template'|'player'|'custom', player_id, base_url, model }
// returns { options, secret } where options is safe to store and show
export function normalizeRequest(body, { settings = {}, players = new Set() } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const format = b.format === undefined ? 'yt' : b.format;
  if (!FORMATS.includes(format)) throw new VideoError('bad_request', `format must be one of ${FORMATS.join(', ')}`);
  const length = b.length === undefined ? 'highlight' : b.length;
  if (!LENGTHS.includes(length)) throw new VideoError('bad_request', `length must be one of ${LENGTHS.join(', ')}`);
  let voices = b.voices === undefined ? (settings.tts?.voices_default === false ? 'off' : 'on') : b.voices;
  if (voices === true) voices = 'on'; if (voices === false) voices = 'off';
  if (voices !== 'on' && voices !== 'off') throw new VideoError('bad_request', 'voices must be "on" or "off"');
  let src = b.llm;
  if (src === undefined) { const d = settings.script_llm || {}; src = d.mode === 'player' ? { player_id: d.player_id } : d.mode === 'custom' ? { base_url: d.base_url, model: d.model, key: d.api_key } : null; }
  let llm = { source: 'template' }, secret = '';
  if (src && src !== 'template' && !(typeof src === 'object' && src.source === 'template')) {
    if (typeof src !== 'object') throw new VideoError('bad_request', 'llm must be an object or "template"');
    if (src.player_id) {
      if (!players.has(src.player_id)) throw new VideoError('bad_request', 'the chosen LLM player does not exist (any more); pick another one or use the built-in template');
      llm = { source: 'player', player_id: String(src.player_id) };
    } else if (src.base_url || src.model) {
      const base = String(src.base_url || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/[^\s]+$/.test(base)) throw new VideoError('bad_request', 'llm.base_url must start with http:// or https://');
      const model = String(src.model || '').trim().slice(0, 200);
      if (!model) throw new VideoError('bad_request', 'llm.model is required');
      llm = { source: 'custom', base_url: base, model };
      secret = typeof src.key === 'string' ? src.key.trim() : '';
    }
  }
  return { options: { format, length, voices, llm }, secret };
}

// ---------------------------------------------------------------- the queue
export class VideoJobs {
  // dir: data/videos; runner.start(job, ctx) -> { promise, cancel(), pause(), resume() }; paused(): true while renders must wait
  constructor({ dir, runner, paused = () => false, maxQueue = 8, pollMs = 3000, now = Date.now } = {}) {
    this.dir = dir; this.runner = runner; this.paused = paused; this.maxQueue = maxQueue; this.pollMs = pollMs; this.now = now;
    this.jobs = new Map(); this.secrets = new Map(); this.current = null; this.timer = null; this.stopped = false;
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }
  load() {
    for (const m of fs.readdirSync(this.dir)) {
      const md = path.join(this.dir, m);
      if (!fs.statSync(md).isDirectory()) continue;
      for (const j of fs.readdirSync(md)) {
        const job = readJson(path.join(md, j, 'job.json'));
        if (!job?.id) continue;
        if (ACTIVE.has(job.status)) { job.status = 'failed'; job.error = 'The arena was restarted while this video was in progress. Start it again.'; job.finished = this.now(); job.eta_s = null; writeJson(path.join(md, j, 'job.json'), job); }
        this.jobs.set(job.id, job);
      }
    }
  }
  jobDir(job) { return path.join(this.dir, job.match_id, job.id); }
  save(job, force = true) {
    const t = this.now();
    if (!force && job._saved && t - job._saved < 2000) return;
    Object.defineProperty(job, '_saved', { value: t, enumerable: false, writable: true, configurable: true });
    fs.mkdirSync(this.jobDir(job), { recursive: true });
    writeJson(path.join(this.jobDir(job), 'job.json'), job);
  }
  // public view (adds queue position)
  view(job) {
    if (!job) return null;
    const queued = this.queue();
    return { ...job, queue_position: job.status === 'queued' ? queued.findIndex((j) => j.id === job.id) + 1 : 0 };
  }
  queue() { return [...this.jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.created - b.created); }
  get(id) { return this.view(this.jobs.get(id)); }
  latestFor(matchId) { const l = [...this.jobs.values()].filter((j) => j.match_id === matchId).sort((a, b) => b.created - a.created)[0]; return this.view(l); }
  list() { return [...this.jobs.values()].sort((a, b) => b.created - a.created).map((j) => this.view(j)); }
  // finished videos of a match, newest first
  doneFor(matchId) { return [...this.jobs.values()].filter((j) => j.match_id === matchId && j.status === 'done').sort((a, b) => b.created - a.created).map((j) => this.view(j)); }
  summaryFor(matchId) {
    const l = this.latestFor(matchId);
    if (!l) return null;
    const done = this.doneFor(matchId)[0];
    return { job_id: l.id, status: l.status, percent: l.percent, stage: l.stage, ready: !!done, ready_job_id: done?.id || null };
  }

  enqueue(matchId, options, { secret = '' } = {}) {
    const open = [...this.jobs.values()].find((j) => j.match_id === matchId && ACTIVE.has(j.status));
    if (open) throw new VideoError('already_queued', 'A video for this match is already in the queue.', { job: this.view(open) });
    if (this.queue().length >= this.maxQueue) throw new VideoError('queue_full', `The video queue is full (${this.maxQueue} waiting). Try again when one has finished.`);
    const job = { id: 'v-' + crypto.randomBytes(4).toString('hex'), match_id: matchId, options, status: 'queued', stage: 'queued', percent: 0, message: 'Waiting for its turn', eta_s: null, log: [], warnings: [], error: null, outputs: [], created: this.now(), started: null, finished: null };
    if (secret) this.secrets.set(job.id, secret);
    this.jobs.set(job.id, job);
    this.save(job);
    this.pump();
    return this.view(job);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || !ACTIVE.has(job.status)) return false;
    if (job.status === 'queued') { this.finish(job, 'cancelled', 'Cancelled'); this.pump(); return true; }
    job.cancel_requested = true;
    job.message = 'Cancelling';
    this.save(job);
    this.run?.cancel();
    return true;
  }

  finish(job, status, message, extra = {}) {
    job.status = status; job.message = message; job.finished = this.now(); job.eta_s = null; job.cancel_requested = undefined;
    Object.assign(job, extra);
    if (status === 'done') { job.percent = 100; job.stage = 'done'; }
    this.secrets.delete(job.id);
    this.save(job);
  }

  // start the next job when none runs and no measurement holds the machine
  pump() {
    if (this.stopped) return;
    if (!this.current) {
      const next = this.queue()[0];
      if (next) {
        if (this.paused()) { next.message = 'Waiting: a measurement is running on this machine, renders are paused'; this.save(next, false); }
        else this.startJob(next);
      }
    } else if (this.run) { // a measurement may start while a render runs: freeze it, continue afterwards
      const p = this.paused();
      if (p && !this.run.frozen) { this.run.pause?.(); this.run.frozen = true; this.current.message = 'Paused: a measurement is running on this machine'; this.save(this.current, false); }
      else if (!p && this.run.frozen) { this.run.resume?.(); this.run.frozen = false; this.current.message = 'Resumed'; this.save(this.current, false); }
    }
    const need = this.current || this.queue().length;
    if (need && !this.timer) { this.timer = setInterval(() => this.pump(), this.pollMs); this.timer.unref?.(); }
    else if (!need && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  startJob(job) {
    this.current = job;
    job.status = 'running'; job.started = this.now(); job.stage = 'check'; job.percent = 0; job.message = 'Starting';
    this.save(job);
    const dir = this.jobDir(job);
    const ctx = {
      dir, secret: this.secrets.get(job.id) || '',
      progress: (stage, percent, message) => this.progress(job, stage, percent, message),
      log: (line) => this.log(job, line),
      warn: (w) => { if (!job.warnings.includes(w)) job.warnings.push(w); },
    };
    let run;
    try { run = this.runner.start(job, ctx); } catch (e) { this.settle(job, null, e); return; }
    this.run = run;
    Promise.resolve(run.promise).then((res) => this.settle(job, res, null), (err) => this.settle(job, null, err));
  }

  settle(job, res, err) {
    this.run = null; this.current = null;
    if (job.cancel_requested || err?.cancelled) this.finish(job, 'cancelled', 'Cancelled');
    else if (err) this.finish(job, 'failed', 'Failed', { error: err.message || String(err) });
    else {
      for (const w of res?.warnings || []) if (!job.warnings.includes(w)) job.warnings.push(w);
      const outputs = (res?.outputs || []).map((o) => ({ ...o, url: `/videos/${job.match_id}/${job.id}/${o.file}` }));
      if (!outputs.some((o) => o.kind === 'video')) this.finish(job, 'failed', 'Failed', { error: 'The renderer finished but produced no video file.' });
      else this.finish(job, 'done', 'Done', { outputs, script: res.script, voices: res.voices });
    }
    this.pump();
  }

  progress(job, stage, percent, message) {
    job.stage = stage; job.percent = Math.max(job.percent || 0, Math.min(99, Math.round(percent))); if (message) job.message = message;
    const el = (this.now() - job.started) / 1000;
    job.eta_s = job.percent >= 8 && el > 5 ? Math.round((el * (100 - job.percent)) / job.percent) : null;
    this.save(job, false);
  }
  log(job, line) {
    job.log.push(String(line).slice(0, 300));
    if (job.log.length > LOG_TAIL) job.log.splice(0, job.log.length - LOG_TAIL);
  }
  shutdown() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.run?.cancel?.(); }
}

// ---------------------------------------------------------------- default runner: tools/make-video.mjs as a child process
// resolve(job) -> { replayDir, llm: {base,model,key}|null, ttsUrl, voiceDirs }
export function childRunner({ root, resolve, node = process.execPath }) {
  return {
    start(job, ctx) {
      const r = resolve(job, ctx);
      const args = [process.env.RTS_VIDEO_TOOL || path.join(root, 'tools/make-video.mjs'), r.replayDir, '--out', ctx.dir, '--format', job.options.format, '--length', job.options.length, '--voices', job.options.voices];
      if (r.llm) args.push('--llm', `${r.llm.base},${r.llm.model}`);
      if (job.options.voices === 'on' && r.ttsUrl) args.push('--tts-url', r.ttsUrl);
      for (const [k, v] of Object.entries(r.voiceDirs || {})) args.push('--voice', `${k}=${v}`);
      if (r.workers) args.push('--workers', String(r.workers));
      if (process.env.RTS_VIDEO_LIMIT_S) args.push('--limit-s', process.env.RTS_VIDEO_LIMIT_S);
      const secret = r.llm?.key || '';
      const scrub = (s) => (secret ? s.split(secret).join('***') : s);
      const env = { ...process.env, OPENAI_API_KEY: secret, RTS_TTS_KEY: r.ttsKey || '' };
      fs.mkdirSync(ctx.dir, { recursive: true });
      const p = spawn(node, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let result = null, errMsg = null, killed = false, buf = '';
      const onData = (d) => {
        buf += d.toString();
        const parts = buf.split('\n'); buf = parts.pop();
        for (const raw of parts) {
          const line = scrub(raw).trimEnd();
          if (!line) continue;
          if (line.startsWith('@@result ')) { try { result = JSON.parse(line.slice(9)); } catch { /* ignore */ } continue; }
          if (line.startsWith('@@error ')) { errMsg = line.slice(8); ctx.log('ERROR: ' + errMsg); continue; }
          const m = /^@@(\w+)\|(\d+)\|(.*)$/.exec(line);
          if (m) { ctx.progress(m[1], +m[2], m[3]); continue; }
          ctx.log(line);
        }
      };
      p.stdout.on('data', onData); p.stderr.on('data', onData);
      const group = (sig) => { try { process.kill(-p.pid, sig); } catch { try { p.kill(sig); } catch { /* gone */ } } };
      const promise = new Promise((resolveP, rejectP) => {
        p.on('error', (e) => rejectP(new Error('Could not start the video tool: ' + e.message)));
        p.on('exit', (code, sig) => {
          if (killed) { const e = new Error('cancelled'); e.cancelled = true; return rejectP(e); }
          if (code === 0 && result) return resolveP(result);
          rejectP(new Error(errMsg || `The video tool stopped unexpectedly (${sig || 'exit ' + code}). See the log for details.`));
        });
      });
      return {
        promise,
        cancel() { killed = true; group('SIGCONT'); group('SIGTERM'); setTimeout(() => group('SIGKILL'), 8000).unref(); },
        pause() { group('SIGSTOP'); },
        resume() { group('SIGCONT'); },
      };
    },
  };
}
