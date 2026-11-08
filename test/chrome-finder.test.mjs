import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromePath, hasChrome } from '../tools/make-video.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const have = (...files) => (f) => files.includes(f);
const find = (o) => chromePath({ home: '/Users/x', ...o });

test('chromePath: RTS_CHROME is taken as it is, even when nothing is there', () => {
  assert.equal(find({ env: { RTS_CHROME: '/my/chrome', PATH: '/usr/bin' }, platform: 'linux', exists: have('/usr/bin/chromium') }), '/my/chrome');
  assert.equal(find({ env: { RTS_CHROME: '' , PATH: '' }, platform: 'darwin', exists: have(MAC) }), MAC, 'empty means not set');
});

test('chromePath on macOS: Google Chrome first, then Chromium, then ~/Applications, then a command on PATH', () => {
  const all = [MAC, '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Users/x/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/opt/homebrew/bin/chromium'];
  const env = { PATH: '/opt/homebrew/bin:/usr/bin' };
  assert.equal(find({ env, platform: 'darwin', exists: have(...all) }), MAC, 'a Mac with Chrome gets the same path as before, whatever else is installed');
  assert.equal(find({ env, platform: 'darwin', exists: have(...all.slice(1)) }), all[1]);
  assert.equal(find({ env, platform: 'darwin', exists: have(...all.slice(2)) }), all[2]);
  assert.equal(find({ env, platform: 'darwin', exists: have(all[3]) }), all[3]);
});

test('chromePath on Linux: the names on PATH in the order google-chrome, google-chrome-stable, chromium, chromium-browser', () => {
  const env = { PATH: '/usr/local/bin:/usr/bin' };
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const files = names.map((n) => `/usr/bin/${n}`);
  for (let i = 0; i < names.length; i++) assert.equal(find({ env, platform: 'linux', exists: have(...files.slice(i)) }), files[i]);
  assert.equal(find({ env, platform: 'linux', exists: have('/usr/bin/chromium', '/usr/local/bin/chromium-browser') }), '/usr/bin/chromium', 'the name order wins over the folder order');
  assert.equal(find({ env, platform: 'linux', exists: have(MAC) }), 'google-chrome', 'the macOS app path is not looked at on Linux');
});

test('chromePath on Windows (best effort): install folders from the environment, PATH with .exe', () => {
  const pf = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', pf86 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
  const local = 'D:\\Me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'D:\\Me\\AppData\\Local', PATH: 'C:\\bin' };
  assert.equal(find({ env, platform: 'win32', exists: have(pf, pf86, local) }), pf);
  assert.equal(find({ env, platform: 'win32', exists: have(pf86, local) }), pf86);
  assert.equal(find({ env, platform: 'win32', exists: have(local) }), local);
  assert.equal(find({ env, platform: 'win32', exists: have(path.join('C:\\bin', 'chromium.exe')) }), path.join('C:\\bin', 'chromium.exe'));
});

test('chromePath: nothing found -> the usual place of the platform, and hasChrome says no', () => {
  assert.equal(find({ env: { PATH: '/usr/bin' }, platform: 'darwin', exists: () => false }), MAC);
  assert.equal(find({ env: { PATH: '/usr/bin' }, platform: 'linux', exists: () => false }), 'google-chrome');
  assert.equal(find({ env: { PROGRAMFILES: 'C:\\P' }, platform: 'win32', exists: () => false }), 'C:\\P\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(hasChrome({ env: { RTS_CHROME: '/nonexistent/chrome' } }), false);
  assert.equal(hasChrome({ env: { RTS_CHROME: process.execPath } }), true);
});

// the video output must not change on a Mac that has Google Chrome: same executable as the old hard-coded path
test('chromePath on this machine: a Mac with Google Chrome still resolves to the old hard-coded path', { skip: !(process.platform === 'darwin' && fs.existsSync(MAC)) && 'needs a Mac with Google Chrome in /Applications' }, () => {
  const env = { ...process.env }; delete env.RTS_CHROME;
  assert.equal(chromePath({ env }), MAC);
  assert.equal(hasChrome({ env }), true);
});

test('only tools/make-video.mjs knows where Chrome lives: no other file hard-codes a browser path', () => {
  const hits = [];
  const walk = (dir) => {
    // a nested git worktree (or clone) has a .git entry of its own and is another copy of the repo: not ours to scan
    if (dir !== ROOT && fs.existsSync(path.join(dir, '.git'))) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', '.claude', 'node_modules', 'sim', 'sim-versions', 'data', 'replays', 'vendor'].includes(e.name) || e.name.startsWith('_alt-') || e.name.startsWith('tmp-')) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(mjs|js)$/.test(e.name) && f !== path.join(ROOT, 'tools/make-video.mjs') && f !== fileURLToPath(import.meta.url)) {
        if (/Google Chrome\.app|Chromium\.app/.test(fs.readFileSync(f, 'utf8'))) hits.push(path.relative(ROOT, f));
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, []);
});
