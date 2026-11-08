// "Check your setup": what this machine has for the arena, as JSON for GET /api/doctor and the /check page (ui/check.js).
// Each item: { id, label, status: ok | missing | optional, detail, fix, needed_for }. `ok` at the top = a match can be played here
// (Node + data folder); `video_ready` = "Make video" has everything it needs. The ffmpeg / Chrome / puppeteer-core questions are asked
// with the same functions the video job uses (tools/make-video.mjs), the voice server with the same check and URL (tools/video-voices.mjs).
// Nothing secret goes out: no API keys, no environment, no player or settings files; paths are shortened to ~, a TTS URL loses its user,
// password and query.
import './local-env.mjs'; // machine-local RTS_* defaults (local-env.json) before anything reads them
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasFfmpegAsync, hasChrome, hasPuppeteer, chromePath, puppeteerDir } from '../tools/make-video.mjs';
import { checkTts } from '../tools/video-voices.mjs';

export const MIN_NODE = 22;
const TTS_TIMEOUT_MS = 500; // checkTts tries /health, then /v1/models: at most 1 s in all

// ~ for the home folder, only on a path boundary: <home>/x -> ~/x, but a sibling folder whose name starts with the same letters stays as it is
export const short = (p, home = os.homedir()) => {
  const s = String(p);
  if (!home) return s;
  if (s === home) return '~';
  const base = home.endsWith(path.sep) ? home : home + path.sep;
  return s.startsWith(base) ? '~' + path.sep + s.slice(base.length) : s;
};
// scheme://host:port only
function safeUrl(u) {
  try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return ''; }
}

export async function runDoctor({ dataDir, ttsUrl, nodeVersion = process.versions.node, tools = { hasFfmpeg: hasFfmpegAsync, hasChrome, hasPuppeteer, chromePath, puppeteerDir }, tts = checkTts } = {}) {
  const item = (id, label, status, detail, fix = '', needed_for = '') => ({ id, label, status, detail, fix, needed_for });
  const items = [];

  const major = Number(String(nodeVersion).split('.')[0]);
  items.push(major >= MIN_NODE
    ? item('node', 'Node.js', 'ok', `v${nodeVersion}`)
    : item('node', 'Node.js', 'missing', `v${nodeVersion} is too old`, `Install Node ${MIN_NODE} or newer from https://nodejs.org/ and start the arena again.`));

  let writable = true;
  try { await fs.promises.access(dataDir, fs.constants.W_OK); } catch { writable = false; }
  items.push(writable
    ? item('data', 'Data folder', 'ok', `${short(dataDir)} is writable`)
    : item('data', 'Data folder', 'missing', `${short(dataDir)} is not writable`, 'Make the folder writable, or start with --data <folder> (or set RTS_ARENA_DATA).'));

  items.push(await tools.hasFfmpeg()
    ? item('ffmpeg', 'ffmpeg', 'ok', 'found on PATH', '', 'Make video')
    : item('ffmpeg', 'ffmpeg', 'missing', 'not found on PATH', 'Install ffmpeg (macOS: brew install ffmpeg, Debian/Ubuntu: sudo apt install ffmpeg) and restart the arena.', 'Make video'));

  items.push(tools.hasChrome()
    ? item('chrome', 'Chrome / Chromium', 'ok', short(tools.chromePath()), '', 'Make video')
    : item('chrome', 'Chrome / Chromium', 'missing',
      process.env.RTS_CHROME ? `RTS_CHROME points to ${short(tools.chromePath())}, but there is no file there` : 'no Chrome or Chromium found (not in the usual places, and no google-chrome or chromium command on PATH)',
      'Install Google Chrome or Chromium (on Linux the command google-chrome or chromium must work in a terminal), or set RTS_CHROME to the browser executable, and restart the arena.', 'Make video'));

  items.push(tools.hasPuppeteer()
    ? item('puppeteer', 'puppeteer-core', 'ok', short(tools.puppeteerDir()), '', 'Make video')
    : item('puppeteer', 'puppeteer-core', 'missing', `not found in ${short(tools.puppeteerDir())}`, 'Install puppeteer-core (npm install puppeteer-core) and set PUPPETEER_CORE to the node_modules folder that contains it, then restart the arena.', 'Make video'));

  const url = safeUrl(ttsUrl);
  const voice = url ? await tts(ttsUrl, { timeoutMs: TTS_TIMEOUT_MS }).catch(() => ({ ok: false })) : { ok: false };
  items.push(voice.ok
    ? item('voice', 'Voice server', 'ok', `answers at ${url}`, '', 'Make video (voices)')
    : item('voice', 'Voice server', 'optional', url ? `no answer at ${url}` : 'no URL set', 'Optional: without it "Make video" makes captions only. Start a Fish Audio Drama 3 server and set its URL under Settings > Voices.', 'Make video (voices)'));

  const byId = Object.fromEntries(items.map((i) => [i.id, i.status]));
  return {
    ok: byId.node === 'ok' && byId.data === 'ok',
    video_ready: ['ffmpeg', 'chrome', 'puppeteer'].every((k) => byId[k] === 'ok'),
    items,
  };
}
