#!/usr/bin/env node
// Dev tool: screenshot sequence of the finale (the loser base falls) in headless Chromium, on a virtual clock: performance.now and
// requestAnimationFrame are driven by this script (60 steps per virtual second), so the sequence is the same on a slow machine.
//   node server/spectate.mjs --p1 rush --p2 boom --seed 1 --ff 1291 --port 8874 --no-record
//   PUPPETEER_CORE=<node_modules> node tools/shots-finale.mjs --url http://127.0.0.1:8874/ --out <dir> [--fps 4] [--seconds 20] [--size 1280x720] [--query finale=1]
// Writes <out>/f0000.png ... and <out>/log.jsonl (one line per shot: virtual time, finale clock, camera, banner shown).
// On Linux the hardware GL of the iGPU is used (software GL is about 10 times slower); RTX_SWGL=1 keeps the default.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromePath, angleArgs, puppeteerDir } from './make-video.mjs';

const A = {};
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) { A[a.slice(2)] = process.argv[i + 1]; i++; } }
const [W, H] = (A.size || '1280x720').split('x').map(Number), fps = +(A.fps || 4), secs = +(A.seconds || 20);
const out = path.resolve(A.out || 'finale-shots');
fs.mkdirSync(out, { recursive: true });
const puppeteer = createRequire(import.meta.url)(path.join(puppeteerDir(), 'puppeteer-core'));
const glArgs = process.platform === 'linux' && !process.env.RTX_SWGL ? ['--use-gl=angle', '--use-angle=gl-egl'] : [];
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: [...angleArgs(), ...glArgs, '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--no-sandbox', '--force-device-scale-factor=1', `--window-size=${W},${H}`] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.evaluateOnNewDocument(() => {
  let vt = 1000, cbs = [];
  performance.now = () => vt;
  window.requestAnimationFrame = (cb) => { cbs.push(cb); return cbs.length; };
  window.__step = (ms) => { vt += ms; const c = cbs; cbs = []; for (const f of c) f(vt); };
});
await page.goto(A.url + (A.query ? '?' + A.query : ''), { waitUntil: 'load' });
// let the world load (real time, the virtual clock stands still, so the finale has not started yet)
await page.waitForFunction('window.__rts && window.__rts.snap && window.__rts.G', { timeout: 90000, polling: 200 });
if (!A.nowait) { await page.evaluate(() => Promise.all([window.__rts.world.modelsReady, window.__rts.world.u3Ready])); await new Promise((r) => setTimeout(r, 2500)); } // --nowait 1: start at once (the match is still running, to see the live path)
const sub = Math.round(60 / fps), log = fs.createWriteStream(path.join(out, 'log.jsonl'));
const total = Math.round(secs * fps);
for (let i = 0; i < total; i++) {
  const st = await page.evaluate((n) => {
    for (let k = 0; k < n; k++) window.__step(1000 / 60);
    const r = window.__rts;
    return { vt: +(performance.now() / 1000).toFixed(2), fin: r.finale, over: !!(r.snap && r.snap.over), banner: getComputedStyle(document.querySelector('#banner')).display, cam: { tx: +r.camS.tx.toFixed(1), tz: +r.camS.tz.toFixed(1), dist: +r.camS.dist.toFixed(1), az: +r.camS.az.toFixed(2), pol: +r.camS.pol.toFixed(2) } };
  }, sub);
  await page.screenshot({ path: path.join(out, `f${String(i).padStart(4, '0')}.png`), type: 'png' });
  log.write(JSON.stringify({ i, ...st }) + '\n');
}
log.end();
await browser.close();
