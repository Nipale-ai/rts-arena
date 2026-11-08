import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VideoJobs, VideoError, normalizeRequest } from '../server/video-jobs.mjs';
import { checkTts, buildVoices, VoiceError } from '../tools/video-voices.mjs';
import { startMockTts } from '../test-support/mock-tts.mjs';
import { scriptedReplay } from '../test-support/replays.mjs';
import { hasChrome, hasPuppeteer } from '../tools/make-video.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const t = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout waiting'); await sleep(40); } };

// ---------------------------------------------------------------- the queue (fake runner)
function fakeRunner() {
  const r = { started: [], runs: new Map(), cancelled: [], paused: [], resumed: [] };
  r.start = (job, ctx) => {
    let res, rej;
    const promise = new Promise((a, b) => { res = a; rej = b; });
    const run = { ctx, finish: (v) => res(v), fail: (e) => rej(e), cancel: () => { r.cancelled.push(job.id); const e = new Error('cancelled'); e.cancelled = true; rej(e); }, pause: () => r.paused.push(job.id), resume: () => r.resumed.push(job.id) };
    r.started.push(job.id); r.runs.set(job.id, run);
    return { promise, cancel: run.cancel, pause: run.pause, resume: run.resume };
  };
  return r;
}
const OK = { outputs: [{ file: 'a.mp4', kind: 'video', label: 'v' }], warnings: [] };
const opts = { format: 'yt', length: 'highlight', voices: 'off', llm: { source: 'template' } };
const mk = (o = {}) => { const runner = fakeRunner(); const dir = tmp('rts-vj-'); return { runner, dir, q: new VideoJobs({ dir, runner, pollMs: 20, ...o }) }; };

test('queue: one job at a time, first in first out, queue positions', async () => {
  const { q, runner } = mk();
  const a = q.enqueue('m1', opts), b = q.enqueue('m2', opts), c = q.enqueue('m3', opts);
  assert.equal(runner.started.length, 1);
  assert.equal(q.get(a.id).status, 'running');
  assert.equal(q.get(b.id).queue_position, 1);
  assert.equal(q.get(c.id).queue_position, 2);
  runner.runs.get(a.id).finish(OK);
  await until(() => q.get(a.id).status === 'done');
  assert.equal(runner.started.length, 2);
  assert.equal(runner.started[1], b.id);
  assert.equal(q.get(c.id).queue_position, 1);
  runner.runs.get(b.id).fail(new Error('Chrome was not found'));
  await until(() => q.get(b.id).status === 'failed');
  assert.match(q.get(b.id).error, /Chrome was not found/);
  assert.equal(runner.started[2], c.id, 'a failed job does not block the queue');
  q.shutdown();
});

test('queue: same match twice is refused, a full queue is refused with a readable message', () => {
  const { q } = mk({ maxQueue: 2 });
  q.enqueue('m1', opts);
  assert.throws(() => q.enqueue('m1', opts), (e) => e instanceof VideoError && e.code === 'already_queued' && e.job.match_id === 'm1');
  q.enqueue('m2', opts); q.enqueue('m3', opts);
  assert.throws(() => q.enqueue('m4', opts), (e) => e.code === 'queue_full' && /queue is full/.test(e.message));
  q.shutdown();
});

test('queue: progress only goes forward, ETA appears from 8 percent, stage and message are kept', async () => {
  let t = 1000000;
  const { q, runner } = mk({ now: () => t });
  const j = q.enqueue('m1', opts);
  const ctx = runner.runs.get(j.id).ctx;
  ctx.progress('script', 5, 'Writing'); assert.equal(q.get(j.id).eta_s, null);
  t += 20000; ctx.progress('render', 40, 'Rendering'); // 20 s for 40 percent -> 30 s left
  assert.equal(q.get(j.id).eta_s, 30);
  ctx.progress('render', 30, 'late line'); assert.equal(q.get(j.id).percent, 40);
  assert.equal(q.get(j.id).stage, 'render');
  for (let i = 0; i < 60; i++) ctx.log('line ' + i);
  assert.equal(q.get(j.id).log.length, 40);
  assert.equal(q.get(j.id).log.at(-1), 'line 59');
  runner.runs.get(j.id).finish(OK);
  await until(() => q.get(j.id).status === 'done');
  assert.equal(q.get(j.id).percent, 100);
  assert.equal(q.get(j.id).outputs[0].url, `/videos/m1/${j.id}/a.mp4`);
  q.shutdown();
});

test('queue: cancel a waiting job and a running job; the next one starts', async () => {
  const { q, runner } = mk();
  const a = q.enqueue('m1', opts), b = q.enqueue('m2', opts), c = q.enqueue('m3', opts);
  assert.equal(q.cancel(b.id), true);
  assert.equal(q.get(b.id).status, 'cancelled');
  assert.equal(q.cancel(a.id), true);
  await until(() => q.get(a.id).status === 'cancelled');
  assert.deepEqual(runner.cancelled, [a.id]);
  await until(() => runner.started.includes(c.id));
  assert.equal(q.cancel(a.id), false, 'a finished job cannot be cancelled');
  q.shutdown();
});

test('queue: a run without a video file is a failure, not a success', async () => {
  const { q, runner } = mk();
  const j = q.enqueue('m1', opts);
  runner.runs.get(j.id).finish({ outputs: [{ file: 'x.srt', kind: 'captions' }] });
  await until(() => q.get(j.id).status === 'failed');
  assert.match(q.get(j.id).error, /no video file/);
  q.shutdown();
});

test('queue: a measurement lock holds waiting jobs and freezes a running one', async () => {
  let lock = true;
  const { q, runner } = mk({ paused: () => lock });
  const a = q.enqueue('m1', opts);
  assert.equal(runner.started.length, 0);
  assert.match(q.get(a.id).message, /measurement is running/);
  lock = false;
  await until(() => runner.started.length === 1);
  lock = true;
  await until(() => runner.paused.length === 1);
  assert.match(q.get(a.id).message, /Paused/);
  lock = false;
  await until(() => runner.resumed.length === 1);
  q.shutdown();
});

test('queue: jobs are saved next to the match, never hold a key, and a restart marks running jobs as failed', async () => {
  const { q, runner, dir } = mk();
  const { options, secret } = normalizeRequest({ llm: { base_url: 'http://127.0.0.1:1/v1', model: 'm', key: 'SECRET-KEY-123' } });
  const j = q.enqueue('m1', options, { secret });
  assert.equal(runner.runs.get(j.id).ctx.secret, 'SECRET-KEY-123');
  const file = path.join(dir, 'm1', j.id, 'job.json');
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRET-KEY-123'));
  q.shutdown();
  const q2 = new VideoJobs({ dir, runner: fakeRunner() });
  assert.equal(q2.get(j.id).status, 'failed');
  assert.match(q2.get(j.id).error, /restarted/);
  assert.equal(q2.latestFor('m1').id, j.id);
});

test('request: formats, lengths, voices and the LLM choice are validated', () => {
  const players = new Set(['p-1']);
  const n = (b, s = {}) => normalizeRequest(b, { settings: s, players });
  assert.deepEqual(n({}).options, { format: 'yt', length: 'highlight', voices: 'on', llm: { source: 'template' } });
  assert.equal(n({ voices: false }).options.voices, 'off');
  assert.equal(n({ format: 'both', length: 'full' }).options.length, 'full');
  assert.throws(() => n({ format: 'gif' }), /format must be/);
  assert.throws(() => n({ length: 'forever' }), /length must be/);
  assert.throws(() => n({ voices: 'maybe' }), /voices must be/);
  assert.throws(() => n({ llm: { player_id: 'nope' } }), /does not exist/);
  assert.throws(() => n({ llm: { base_url: 'ftp://x', model: 'm' } }), /http/);
  assert.throws(() => n({ llm: { base_url: 'http://x/v1' } }), /model is required/);
  assert.deepEqual(n({ llm: { player_id: 'p-1' } }).options.llm, { source: 'player', player_id: 'p-1' });
  const c = n({ llm: { base_url: 'http://h:8080/v1/', model: 'qwen', key: ' k ' } });
  assert.deepEqual(c.options.llm, { source: 'custom', base_url: 'http://h:8080/v1', model: 'qwen' });
  assert.equal(c.secret, 'k');
  assert.equal(n({ llm: 'template' }).options.llm.source, 'template');
  // no llm in the request: the settings decide
  assert.equal(n({}, { script_llm: { mode: 'player', player_id: 'p-1' } }).options.llm.player_id, 'p-1');
  assert.equal(n({}, { tts: { voices_default: false } }).options.voices, 'off');
});

// ---------------------------------------------------------------- voices: HTTP TTS path (mock server) and its fallbacks
function manifest(dir, n = 4) {
  const entries = Array.from({ length: n }, (_, i) => ({ id: `l${i}`, speaker: i % 2 ? 'ana' : 'pbp', voice: i % 2 ? 'caster_b' : 'caster_a', delivery: 'calm', text: 'Hello there everybody', text_tts: '[calm] Hello there everybody out there', start_s: 2 + i * 4, expected_s: 1.8, accept_take_s: [0.6, 4.2], latest_end_s: 2 + i * 4 + 3, interject: false }));
  const f = path.join(dir, 'x-casters-tts.json');
  fs.writeFileSync(f, JSON.stringify({ entries }));
  return f;
}
function refs(dir) {
  const out = {};
  for (const n of ['caster_a', 'caster_b']) {
    const d = path.join(dir, n); fs.mkdirSync(d, { recursive: true });
    spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=1', path.join(d, 'referenz.wav')]);
    fs.writeFileSync(path.join(d, 'transkript.txt'), 'a short reference');
    out[n] = d;
  }
  return out;
}
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('voices: a TTS server is detected, a missing one gives a readable message', async () => {
  const m = await startMockTts();
  assert.equal((await checkTts(m.url)).ok, true);
  await m.close();
  const dead = await checkTts(m.url, { timeoutMs: 800 });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /not reachable/);
  assert.match((await checkTts('')).error, /no TTS server URL/);
  assert.match((await checkTts('ftp://x')).error, /no TTS server URL/);
});

test('voices: lines are voiced, placed on the timeline and written in the format the renderer expects', { skip: !hasFfmpeg && 'needs ffmpeg' }, async () => {
  const m = await startMockTts(), dir = tmp('rts-vv-');
  try {
    const r = await buildVoices({ manifestFile: manifest(dir), outDir: dir, url: m.url, voiceDirs: refs(dir) });
    assert.equal(r.lines, 4);
    const j = JSON.parse(fs.readFileSync(r.json, 'utf8'));
    assert.equal(j.lines.length, 4);
    assert.ok(j.lines.every((l, i) => l.end > l.start && l.start >= 2 + i * 4 - 0.01));
    assert.ok(fs.statSync(r.wav).size > 100000);
    assert.deepEqual(m.stats.voices.sort(), ['rts_caster_a', 'rts_caster_b']);
    assert.equal(m.stats.speech, 4);
    assert.ok(m.stats.bodies.every((b) => b.response_format === 'wav' && b.input.startsWith('[calm]')));
    // a second video registers again: the server's "already exists" answer is fine
    await buildVoices({ manifestFile: manifest(dir), outDir: dir, url: m.url, voiceDirs: refs(dir) });
  } finally { await m.close(); }
});

test('voices: server down, server error, missing reference and a bad key all end in a VoiceError (captions-only video)', { skip: !hasFfmpeg && 'needs ffmpeg' }, async () => {
  const dir = tmp('rts-vv2-'), vd = refs(dir), man = manifest(dir);
  const down = await startMockTts(); const url = down.url; await down.close();
  await assert.rejects(buildVoices({ manifestFile: man, outDir: dir, url, voiceDirs: vd }), (e) => e instanceof VoiceError && /not reachable/.test(e.message));
  const bad = await startMockTts({ failSpeech: true });
  await assert.rejects(buildVoices({ manifestFile: man, outDir: dir, url: bad.url, voiceDirs: vd }), (e) => e instanceof VoiceError && /failed on|no line/.test(e.message));
  await bad.close();
  const ok = await startMockTts();
  await assert.rejects(buildVoices({ manifestFile: man, outDir: dir, url: ok.url, voiceDirs: { caster_a: path.join(dir, 'nope'), caster_b: vd.caster_b } }), (e) => e instanceof VoiceError && /voice reference for caster_a not found/.test(e.message));
  await ok.close();
  const keyed = await startMockTts({ requireKey: 'TTS-SECRET' });
  await assert.rejects(buildVoices({ manifestFile: man, outDir: dir, url: keyed.url, voiceDirs: vd, key: 'wrong' }), (e) => e instanceof VoiceError && !/TTS-SECRET|wrong/.test(e.message));
  const good = await buildVoices({ manifestFile: man, outDir: dir, url: keyed.url, voiceDirs: vd, key: 'TTS-SECRET' });
  assert.equal(good.lines, 4);
  assert.ok(keyed.stats.keys.every((k) => k === 'Bearer TTS-SECRET' || k === 'Bearer wrong'));
  await keyed.close();
});

test('voices: a line that fails twice is dropped, the rest stays (and too many failures give up)', { skip: !hasFfmpeg && 'needs ffmpeg' }, async () => {
  const dir = tmp('rts-vv3-');
  const m = await startMockTts({ failSpeech: 5 }); // every 5th request fails: one line loses its first take only
  const r = await buildVoices({ manifestFile: manifest(dir, 6), outDir: dir, url: m.url, voiceDirs: refs(dir) });
  assert.equal(r.lines + r.dropped.length, 6);
  assert.ok(r.lines >= 5);
  await m.close();
});

// ---------------------------------------------------------------- the arena endpoints (fake video tool, real HTTP)
function recordReplay(root, id, mode) {
  const src = scriptedReplay(['rush', 'boom'], 3);
  const dir = path.join(root, id); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(src, 'log.jsonl'), path.join(dir, 'log.jsonl'));
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ id, seed: 3, bots: ['Rush', 'Boom'], seconds: 60, reason: 'victory', winnerTeam: 1 }));
  if (mode) fs.writeFileSync(path.join(dir, 'FAKE_MODE'), mode);
  return dir;
}
async function startArena() {
  const data = tmp('rts-varena-'), replays = tmp('rts-vreplays-');
  const child = spawn(process.execPath, [path.join(ROOT, 'server/arena.mjs'), '--port', '0', '--data', data, '--replays', replays], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RTS_VIDEO_TOOL: path.join(ROOT, 'test-support/fake-make-video.mjs'), RTS_PAUSE_FILE: path.join(data, 'NO-SUCH-LOCK') } });
  let out = '';
  child.stderr.on('data', (d) => (out += d)); child.stdout.on('data', (d) => (out += d));
  const base = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('arena did not start')), 15000);
    child.stdout.on('data', (d) => { const m = /Arena: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(m[1]); } });
    child.on('exit', () => reject(new Error('arena exited')));
  });
  const call = async (p, body, headers = {}) => {
    const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { base, data, replays, call, output: () => out, stop: () => child.kill('SIGTERM') };
}
const getRaw = (url, headers = {}, hostHeader) => new Promise((resolve, reject) => {
  const u = new URL(url);
  http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { ...headers, ...(hostHeader ? { Host: hostHeader } : {}) } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); }).on('error', reject).end();
});

test('arena: video endpoints are same-origin only, validate input and refuse unknown or running matches', { timeout: 60000 }, async () => {
  const a = await startArena();
  try {
    recordReplay(a.replays, 'm-ok');
    const evil = { Origin: 'http://evil.example' };
    assert.equal((await a.call('/api/matches/m-ok/video', { format: 'yt' }, evil)).status, 403);
    assert.equal((await a.call('/api/matches/m-ok/video', { format: 'yt' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await a.call('/api/settings/video', { tts: { url: 'http://x:1' } }, evil)).status, 403);
    assert.equal((await a.call('/api/matches/m-ok/video/cancel', {}, evil)).status, 403);
    assert.equal((await a.call('/api/video-jobs/v-x/cancel', {}, evil)).status, 403);
    const wrongHost = await new Promise((resolve) => { const r = http.request(a.base + '/api/video-jobs', { headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode)); r.end(); });
    assert.equal(wrongHost, 403);
    assert.equal((await getRaw(a.base + '/videos/m-ok/v-1/x.mp4', {}, 'evil.example')).status, 403);
    assert.equal((await a.call('/api/matches/m-ok/video', { format: 'gif' })).status, 400);
    assert.match((await a.call('/api/matches/m-ok/video', { length: 'forever' })).body.error, /length must be/);
    assert.match((await a.call('/api/matches/m-ok/video', { llm: { player_id: 'p-nope' } })).body.error, /does not exist/);
    assert.equal((await a.call('/api/matches/nope/video', { format: 'yt' })).status, 404);
    assert.equal((await a.call('/api/matches/..%2Fetc/video', { format: 'yt' })).status, 404);
    // a match that is still running cannot get a video yet
    const m = await a.call('/api/matches', { players: [{ type: 'bot', bot: 'rush' }, { type: 'bot', bot: 'boom' }], seed: 5, rules: { speed: 1 } });
    assert.equal(m.status, 200);
    const run = await a.call(`/api/matches/${m.body.id}/video`, { format: 'yt' });
    assert.equal(run.status, 409);
    assert.match(run.body.error, /still running/);
    await a.call(`/api/matches/${m.body.id}/stop`, {});
  } finally { a.stop(); }
});

test('arena: Make video end to end with the job runner (progress, files, range download, no key in the log)', { timeout: 90000 }, async () => {
  const a = await startArena();
  try {
    recordReplay(a.replays, 'm-ok');
    // a saved LLM player with a key: the key must reach the tool and never the log, the job file or the API
    const pl = await a.call('/api/players', { name: 'Script LLM', base_url: 'http://127.0.0.1:1/v1', model: 'qwen', api_key: 'SECRET-KEY-123' });
    assert.equal(pl.status, 200);
    fs.writeFileSync(path.join(a.replays, 'm-ok', 'FAKE_MODE'), 'key');
    const r = await a.call('/api/matches/m-ok/video', { format: 'yt', length: 'highlight', voices: 'off', llm: { player_id: pl.body.id } });
    assert.equal(r.status, 200);
    const id = r.body.job.id;
    assert.equal((await a.call('/api/matches/m-ok/video', { format: 'yt' })).status, 409, 'second request for the same match while it is queued');
    const done = await until(async () => { const j = (await a.call(`/api/video-jobs/${id}`)).body; return j.status === 'done' || j.status === 'failed' ? j : null; });
    assert.equal(done.status, 'done', done.error);
    assert.equal(done.percent, 100);
    assert.ok(done.warnings.includes('fake warning'));
    assert.ok(done.log.some((l) => l.includes('the key is ***')), 'key replaced in the log');
    for (const text of [JSON.stringify(done), fs.readFileSync(path.join(a.data, 'videos', 'm-ok', id, 'job.json'), 'utf8'), a.output(), JSON.stringify((await a.call('/api/state')).body), JSON.stringify((await a.call('/api/matches')).body)]) assert.ok(!text.includes('SECRET-KEY-123'));
    const args = JSON.parse(fs.readFileSync(path.join(a.data, 'videos', 'm-ok', id, 'args.json'), 'utf8'));
    assert.deepEqual(args.args.slice(args.args.indexOf('--workers'), args.args.indexOf('--workers') + 2), ['--workers', '8'], 'story renders get 8 workers by default');
    assert.ok(args.key_given); assert.ok(args.args.includes('--llm')); assert.ok(!args.args.join(' ').includes('SECRET-KEY-123'), 'the key is not on the command line');
    // listing shows the video state; the video is served with range support and as a download
    const list = (await a.call('/api/matches')).body.find((x) => x.id === 'm-ok');
    assert.equal(list.video.ready, true);
    const url = done.outputs.find((o) => o.kind === 'video').url;
    const full = await getRaw(a.base + url);
    assert.equal(full.status, 200); assert.equal(full.body.length, 5000); assert.equal(full.headers['content-type'], 'video/mp4');
    const part = await getRaw(a.base + url, { Range: 'bytes=100-199' });
    assert.equal(part.status, 206); assert.equal(part.body.length, 100); assert.equal(part.headers['content-range'], 'bytes 100-199/5000');
    assert.equal((await getRaw(a.base + url, { Range: 'bytes=9000-' })).status, 416);
    assert.match((await getRaw(a.base + url + '?download=1')).headers['content-disposition'], /attachment/);
    // nothing outside the job folder, nothing but video / caption files
    for (const bad of [`/videos/m-ok/${id}/job.json%00.mp4`, `/videos/m-ok/${id}/..%2F..%2Fjob.json`, `/videos/m-ok/${id}/args.json`, `/videos/..%2Fx/${id}/a.mp4`, `/videos/m-ok/v-nope/a.mp4`, `/videos/other/${id}/${path.basename(url)}`]) assert.equal((await getRaw(a.base + bad)).status, 404, bad);
  } finally { a.stop(); }
});

test('arena: a failing tool shows a readable error; a running job can be cancelled; the queue goes on', { timeout: 60000 }, async () => {
  const a = await startArena();
  try {
    recordReplay(a.replays, 'm-fail', 'fail'); recordReplay(a.replays, 'm-slow', 'slow'); recordReplay(a.replays, 'm-next', 'ok');
    const f = (await a.call('/api/matches/m-fail/video', { voices: 'off', llm: 'template' })).body.job;
    const failed = await until(async () => { const j = (await a.call(`/api/video-jobs/${f.id}`)).body; return j.status === 'queued' || j.status === 'running' ? null : j; });
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Chrome was not found/);
    const s = (await a.call('/api/matches/m-slow/video', { voices: 'off', llm: 'template' })).body.job;
    const n = (await a.call('/api/matches/m-next/video', { voices: 'off', llm: 'template' })).body.job;
    await until(async () => (await a.call(`/api/video-jobs/${s.id}`)).body.status === 'running');
    assert.equal((await a.call(`/api/video-jobs/${n.id}`)).body.status, 'queued');
    assert.equal((await a.call(`/api/video-jobs/${n.id}`)).body.queue_position, 1);
    const c = await a.call('/api/matches/m-slow/video/cancel', {});
    assert.equal(c.body.cancelled, true);
    await until(async () => (await a.call(`/api/video-jobs/${s.id}`)).body.status === 'cancelled');
    const nd = await until(async () => { const j = (await a.call(`/api/video-jobs/${n.id}`)).body; return j.status === 'done' ? j : null; });
    assert.equal(nd.status, 'done');
    const latest = (await a.call('/api/matches/m-slow/video')).body;
    assert.equal(latest.job.status, 'cancelled');
    assert.equal(latest.videos.length, 0);
  } finally { a.stop(); }
});

test('arena: settings store keys with mode 0600 and never return them; bad values are refused', { timeout: 30000 }, async () => {
  const a = await startArena();
  try {
    const g0 = (await a.call('/api/settings/video')).body;
    assert.equal(g0.script_llm.mode, 'template'); assert.equal(g0.tts.url, 'http://127.0.0.1:8000'); assert.deepEqual(Object.keys(g0.default_voice_dirs), ['caster_a', 'caster_b']); // no default folder unless RTS_VOICES_DIR is set
    const bad = await a.call('/api/settings/video', { tts: { url: 'ftp://x' } });
    assert.equal(bad.status, 400); assert.match(bad.body.error, /http/);
    assert.equal((await a.call('/api/settings/video', { script_llm: { mode: 'custom', base_url: 'http://h:1/v1', model: '' } })).status, 400);
    assert.equal((await a.call('/api/settings/video', { script_llm: { mode: 'player', player_id: 'p-none' } })).status, 400);
    const ok = await a.call('/api/settings/video', { script_llm: { mode: 'custom', base_url: 'http://h:1/v1/', model: 'qwen', api_key: 'LLM-SECRET-9' }, tts: { url: 'http://127.0.0.1:9/', api_key: 'TTS-SECRET-9', voices: { caster_a: '/some/dir' }, voices_default: false } });
    assert.equal(ok.status, 200);
    const txt = JSON.stringify(ok.body);
    assert.ok(!txt.includes('LLM-SECRET-9') && !txt.includes('TTS-SECRET-9'));
    assert.equal(ok.body.script_llm.has_key, true); assert.equal(ok.body.script_llm.base_url, 'http://h:1/v1'); assert.equal(ok.body.tts.voices.caster_a, '/some/dir'); assert.equal(ok.body.tts.voices_default, false);
    assert.equal(g0.render.workers, 8);
    assert.equal((await a.call('/api/settings/video', { render: { workers: 99 } })).body.render.workers, 32);
    assert.equal((await a.call('/api/settings/video', { render: { workers: 4 } })).body.render.workers, 4);
    const file = path.join(a.data, 'settings.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // an empty or masked key field keeps the stored key; the settings test endpoint says why the TTS is unusable
    await a.call('/api/settings/video', { script_llm: { mode: 'custom', base_url: 'http://h:1/v1', model: 'qwen', api_key: '••••-9' } });
    assert.ok(fs.readFileSync(file, 'utf8').includes('LLM-SECRET-9'));
    const t = (await a.call('/api/settings/video/test-tts', {})).body;
    assert.equal(t.ok, false); assert.match(t.error, /not reachable/); assert.match(t.voice_references.caster_a, /not found/);
    assert.ok(!a.output().includes('LLM-SECRET-9'));
    assert.equal((await getRaw(a.base + '/settings')).status, 200);
  } finally { a.stop(); }
});

// ---------------------------------------------------------------- real runs: script -> voices -> render (needs Chrome, puppeteer-core, ffmpeg)
const canRender = hasChrome() && hasPuppeteer() && hasFfmpeg;
function runTool(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'tools/make-video.mjs'), ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => { const m = /@@result (.*)/.exec(out); resolve({ code, out, result: m ? JSON.parse(m[1]) : null, error: /@@error (.*)/.exec(out)?.[1] }); });
  });
}
const streams = (f) => spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim().split('\n').sort().join(',');

test('make-video: template script, voices off -> a playable mp4 with sound and captions', { skip: !canRender && 'needs Chrome, puppeteer-core and ffmpeg', timeout: 240000 }, async () => {
  const out = tmp('rts-mv-'), rep = scriptedReplay(['rush', 'boom'], 3);
  const r = await runTool([rep, '--out', out, '--format', 'x', '--length', 'highlight', '--voices', 'off', '--limit-s', '2']);
  assert.equal(r.code, 0, r.out.slice(-800));
  const v = r.result.outputs.find((o) => o.kind === 'video');
  assert.match(v.file, /-x\.mp4$/);
  assert.equal(streams(path.join(out, v.file)), 'audio,video');
  assert.equal(r.result.voices, false);
  assert.equal(r.result.script.source, 'template');
  assert.ok(r.result.outputs.some((o) => o.kind === 'captions'));
});

test('make-video: voices through a (mock) TTS server are mixed in; an unreachable TTS server and a dead script LLM fall back with a clear message', { skip: !canRender && 'needs Chrome, puppeteer-core and ffmpeg', timeout: 480000 }, async () => {
  const rep = scriptedReplay(['rush', 'boom'], 3), vd = refs(tmp('rts-mvrefs-'));
  const tts = await startMockTts();
  const common = ['--format', 'x', '--length', 'highlight', '--limit-s', '2', '--voice', `caster_a=${vd.caster_a}`, '--voice', `caster_b=${vd.caster_b}`];
  try {
    const withVoices = await runTool([rep, '--out', tmp('rts-mv1-'), ...common, '--voices', 'on', '--tts-url', tts.url]);
    assert.equal(withVoices.code, 0, withVoices.out.slice(-800));
    assert.equal(withVoices.result.voices, true);
    assert.ok(tts.stats.speech > 0, 'the TTS endpoint was called');
    assert.deepEqual(tts.stats.voices.sort(), ['rts_caster_a', 'rts_caster_b']);
  } finally { await tts.close(); }
  // the same server is gone now; the LLM url is dead too
  const fallback = await runTool([rep, '--out', tmp('rts-mv2-'), ...common, '--voices', 'on', '--tts-url', tts.url, '--llm', 'http://127.0.0.1:9/v1,nomodel']);
  assert.equal(fallback.code, 0, fallback.out.slice(-800));
  assert.equal(fallback.result.voices, false);
  assert.ok(fallback.result.warnings.some((w) => /Voices skipped: TTS server at .* is not reachable/.test(w) && /captions only/.test(w)), JSON.stringify(fallback.result.warnings));
  assert.ok(fallback.result.warnings.some((w) => /script LLM did not deliver/.test(w) && /template wrote/.test(w)), JSON.stringify(fallback.result.warnings));
  assert.equal(fallback.result.script.source, 'template');
  assert.ok(fallback.result.outputs.some((o) => o.kind === 'video'));
});

test('make-video: story5 uses the story cut tool (own script, workers) and still produces a video', { skip: !canRender && 'needs Chrome, puppeteer-core and ffmpeg', timeout: 300000 }, async () => {
  const out = tmp('rts-mvs-'), rep = scriptedReplay(['rush', 'boom'], 3);
  const r = await runTool([rep, '--out', out, '--format', 'x', '--length', 'story5', '--voices', 'off', '--workers', '2', '--limit-s', '2']);
  assert.equal(r.code, 0, r.out.slice(-800));
  assert.equal(r.result.length, 'story5', JSON.stringify(r.result.warnings));
  const v = r.result.outputs.find((o) => o.kind === 'video');
  assert.match(v.file, /-story-x(-main)?\.mp4$/);
  assert.ok(fs.statSync(path.join(out, v.file)).size > 10000);
});

test('make-video: a bad replay or option is a readable error, not a stack trace', async () => {
  const empty = tmp('rts-mvbad-');
  const r1 = await runTool([empty, '--out', tmp('rts-mvo-')]);
  assert.equal(r1.code, 1);
  assert.match(r1.error, /Replay not found/);
  const r2 = await runTool([scriptedReplay(['rush', 'boom'], 3), '--out', tmp('rts-mvo-'), '--length', 'forever']);
  assert.match(r2.error, /Unknown length/);
});
