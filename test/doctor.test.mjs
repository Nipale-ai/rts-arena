import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { runDoctor, short } from '../server/doctor.mjs';
import { hasFfmpegAsync } from '../tools/make-video.mjs';
import { startArena } from '../test-support/arena-proc.mjs';
import { startMockTts } from '../test-support/mock-tts.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const allOk = { hasFfmpeg: () => true, hasChrome: () => true, hasPuppeteer: () => true, chromePath: () => '/opt/chrome', puppeteerDir: () => '/opt/nm' };
const ttsUp = async () => ({ ok: true });
const ttsDown = async () => ({ ok: false, error: 'secret detail' });
const status = (d) => Object.fromEntries(d.items.map((i) => [i.id, i.status]));
// fetch() does not let a script choose the Host header
const statusWithHost = (base, p, host) => new Promise((resolve, reject) => {
  const u = new URL(base);
  http.get({ host: u.hostname, port: u.port, path: p, headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});
const ITEM_KEYS = ['detail', 'fix', 'id', 'label', 'needed_for', 'status'];

test('doctor: everything there -> every item ok, shape is stable', async () => {
  const d = await runDoctor({ dataDir: tmp('rts-doc-'), ttsUrl: 'http://127.0.0.1:8000', tools: allOk, tts: ttsUp });
  assert.deepEqual(Object.keys(d).sort(), ['items', 'ok', 'video_ready']);
  assert.deepEqual(d.items.map((i) => i.id), ['node', 'data', 'ffmpeg', 'chrome', 'puppeteer', 'voice']);
  for (const i of d.items) {
    assert.deepEqual(Object.keys(i).sort(), ITEM_KEYS);
    assert.ok(['ok', 'missing', 'optional'].includes(i.status));
    assert.equal(i.status, 'ok', i.id);
    assert.ok(i.label && i.detail, i.id);
  }
  assert.equal(d.ok, true);
  assert.equal(d.video_ready, true);
});

test('doctor: every problem gets a status and a one-line English hint; only the voice server is optional', async () => {
  const none = { ...allOk, hasFfmpeg: () => false, hasChrome: () => false, hasPuppeteer: () => false };
  const d = await runDoctor({ dataDir: path.join(tmp('rts-doc-'), 'does-not-exist'), ttsUrl: 'http://127.0.0.1:8000', nodeVersion: '20.11.1', tools: none, tts: ttsDown });
  assert.deepEqual(status(d), { node: 'missing', data: 'missing', ffmpeg: 'missing', chrome: 'missing', puppeteer: 'missing', voice: 'optional' });
  for (const i of d.items) { assert.ok(i.fix.length > 10 && !i.fix.includes('\n'), `${i.id}: ${i.fix}`); assert.match(i.fix, /[A-Za-z]/); }
  assert.equal(d.ok, false);
  assert.equal(d.video_ready, false);
  assert.match(d.items[0].fix, /Node 22/);
});

test('doctor: no voice server or a missing video tool does not stop matches', async () => {
  const d = await runDoctor({ dataDir: tmp('rts-doc-'), ttsUrl: '', tools: { ...allOk, hasChrome: () => false }, tts: ttsUp });
  assert.equal(d.ok, true, 'Node and the data folder are all a match needs');
  assert.equal(d.video_ready, false);
  assert.equal(status(d).voice, 'optional', 'no URL set');
});

test('doctor: the voice check waits at most 1 s, a throwing check is just "optional", and the URL is shown without user, password or query', async () => {
  let seen;
  const spy = async (url, o) => { seen = o; throw new Error('boom'); };
  const d = await runDoctor({ dataDir: tmp('rts-doc-'), ttsUrl: 'http://user:hunter2@127.0.0.1:8000/v1?token=abc#frag', tools: allOk, tts: spy });
  assert.ok(seen.timeoutMs <= 500, 'two tries (/health, /v1/models) stay within 1 s');
  assert.equal(status(d).voice, 'optional');
  const text = JSON.stringify(d);
  for (const s of ['hunter2', 'user:', 'token', 'abc', 'frag', 'boom']) assert.ok(!text.includes(s), s);
  assert.match(d.items.find((i) => i.id === 'voice').detail, /http:\/\/127\.0\.0\.1:8000/);
});

test('doctor: the real voice check against a dead port is quick', async () => {
  const t0 = Date.now();
  const d = await runDoctor({ dataDir: tmp('rts-doc-'), ttsUrl: 'http://127.0.0.1:1', tools: allOk });
  assert.equal(status(d).voice, 'optional');
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test('arena: GET /api/doctor and the /check page; no key, environment or player file in the answer', async () => {
  const tts = await startMockTts();
  const SECRETS = ['sk-player-SECRET-1', 'sk-script-SECRET-2', 'sk-tts-SECRET-3', 'sk-env-SECRET-4', 'llm-secret.example'];
  const a = await startArena({
    env: { OPENAI_API_KEY: SECRETS[3], RTS_TTS_KEY: 'sk-env-SECRET-5', RTS_CHROME: '/nonexistent/chrome' },
    prepare: (data) => {
      fs.mkdirSync(path.join(data, 'players'), { recursive: true });
      fs.writeFileSync(path.join(data, 'players', 'p-1.json'), JSON.stringify({ id: 'p-1', name: 'Secret model', base_url: 'http://llm-secret.example/v1', model: 'm', api_key: SECRETS[0] }));
      fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ script_llm: { mode: 'custom', base_url: 'http://llm-secret.example/v1', model: 'm', api_key: SECRETS[1] }, tts: { url: tts.url, api_key: SECRETS[2] } }));
    },
  });
  try {
    const r = await a.call('/api/doctor');
    assert.equal(r.status, 200);
    assert.match(r.type, /application\/json/);
    assert.deepEqual(Object.keys(r.body).sort(), ['items', 'ok', 'video_ready']);
    assert.deepEqual(r.body.items.map((i) => i.id), ['node', 'data', 'ffmpeg', 'chrome', 'puppeteer', 'voice']);
    for (const i of r.body.items) assert.deepEqual(Object.keys(i).sort(), ITEM_KEYS);
    const s = status(r.body);
    assert.equal(s.node, 'ok');
    assert.equal(s.data, 'ok');
    assert.equal(s.voice, 'ok', 'the URL from the saved settings (the one the video job uses) answers');
    assert.equal(s.chrome, 'missing', 'RTS_CHROME points nowhere');
    assert.equal(r.body.ok, true);
    for (const secret of [...SECRETS, 'Secret model', 'OPENAI_API_KEY', 'RTS_TTS_KEY', 'api_key']) assert.ok(!r.text.includes(secret), `leaked: ${secret}`);
    // the page and its script are served like the other pages
    const page = await a.call('/check');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.text, /Check your setup/);
    assert.equal((await a.call('/ui/check.js')).status, 200);
    // a foreign Host header is refused like everywhere else
    assert.equal(await statusWithHost(a.base, '/api/doctor', 'evil.example'), 403);
    assert.equal(await statusWithHost(a.base, '/api/doctor', 'localhost'), 200);
  } finally { a.stop(); await tts.close(); }
});

test('doctor: ~ replaces the home folder only on a path boundary', () => {
  const sep = path.sep;
  const home = `${sep}Users${sep}ann`;
  assert.equal(short(home, home), '~');
  assert.equal(short(`${home}${sep}x${sep}y`, home), `~${sep}x${sep}y`);
  assert.equal(short(`${home}bel${sep}x`, home), `${home}bel${sep}x`, 'a folder that only starts with the same letters is not the home folder');
  assert.equal(short(`${sep}opt${sep}ann`, home), `${sep}opt${sep}ann`);
  assert.equal(short(`${home}${sep}`, home), `~${sep}`);
  assert.equal(short('/x', ''), '/x', 'no home folder known');
  assert.equal(short(`${sep}x`, sep), `~${sep}x`, 'a home folder that is the root');
});

// a stand-in "ffmpeg" that needs a while: the check must wait for it without freezing the process
const fakeFfmpeg = (seconds, exitCode = 0) => {
  const dir = tmp('rts-fakebin-');
  fs.writeFileSync(path.join(dir, 'ffmpeg'), `#!/bin/sh\nsleep ${seconds}\nexit ${exitCode}\n`, { mode: 0o755 });
  return dir;
};
const posix = { skip: process.platform === 'win32' && 'needs a shell script as ffmpeg' };

test('doctor: the ffmpeg check does not block the event loop', posix, async () => {
  const env = { ...process.env, PATH: fakeFfmpeg(0.6) + path.delimiter + process.env.PATH };
  let last = Date.now(), worst = 0;
  const timer = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last); last = n; }, 10);
  const t0 = Date.now();
  const ok = await hasFfmpegAsync({ env, timeoutMs: 5000 });
  clearInterval(timer);
  assert.equal(ok, true);
  assert.ok(Date.now() - t0 >= 500, 'it really waited for the slow program');
  assert.ok(worst < 200, `the event loop stood still for ${worst} ms`);
});

test('doctor: a hanging or failing ffmpeg is "missing" after the time limit', posix, async () => {
  const t0 = Date.now();
  assert.equal(await hasFfmpegAsync({ env: { ...process.env, PATH: fakeFfmpeg(5) + path.delimiter + process.env.PATH }, timeoutMs: 300 }), false);
  assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
  assert.equal(await hasFfmpegAsync({ env: { ...process.env, PATH: fakeFfmpeg(0, 1) + path.delimiter + process.env.PATH } }), false, 'exit code 1');
  assert.equal(await hasFfmpegAsync({ env: { ...process.env, PATH: tmp('rts-empty-') } }), false, 'not installed');
});

test('doctor: a whole run with a slow ffmpeg and a dead voice port keeps the event loop moving', posix, async () => {
  const env = { ...process.env, PATH: fakeFfmpeg(0.5) + path.delimiter + process.env.PATH };
  const tools = { hasFfmpeg: () => hasFfmpegAsync({ env, timeoutMs: 5000 }), hasChrome: () => true, hasPuppeteer: () => true, chromePath: () => '/opt/chrome', puppeteerDir: () => '/opt/nm' };
  let last = Date.now(), worst = 0;
  const timer = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last); last = n; }, 10);
  const d = await runDoctor({ dataDir: tmp('rts-doc-'), ttsUrl: 'http://127.0.0.1:1', tools });
  clearInterval(timer);
  assert.equal(status(d).ffmpeg, 'ok');
  assert.equal(status(d).voice, 'optional');
  assert.ok(worst < 200, `the event loop stood still for ${worst} ms`);
});
