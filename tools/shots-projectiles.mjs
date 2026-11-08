// Dev tool: close-up screenshot sequences of projectiles in flight (render/shots.mjs), rendered with the frame-exact broadcast page.
//   PUPPETEER_CORE=<node_modules> node tools/shots-projectiles.mjs --scene archers|tower|arrow|bolt|catapult|mortar|ball --out dir [--port 8878] [--sub 3] [--quality live|broadcast] [--theme id]
// archers / tower: a shot of a real match (seed 7, rush vs boom); arrow / bolt / catapult / mortar / ball: a synthetic shot between two points next to the first base.
// Writes one PNG per output frame (3 per sim tick by default) and a contact sheet sheet.png.
import '../server/local-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { args as spectateArgs, Match } from '../server/spectate.mjs';
import { chromePath, angleArgs, puppeteerDir } from './make-video.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = path.join(ROOT, 'render');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary' };
const A = {};
for (let i = 2; i < process.argv.length; i += 2) A[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const scene = A.scene || 'archers', out = path.resolve(A.out || 'shots-out'), W = 1920, H = 1080, SUB = +A.sub || 3, PORT = +A.port || 8878; // the yt view is 1920 x 1080
fs.mkdirSync(out, { recursive: true });

Object.assign(spectateArgs, { p1: 'rush', p2: 'boom', seed: A.seed || '7', 'no-record': true });
const log = console.log;
console.log = () => {};
const match = new Match();
const init = match.initMsg();
const game = match.game;
const tick = () => { match.tick(); };
console.log = log;
const uIdx = (n) => init.units.indexOf(n);

// ---- pick the shot and collect snapshots t0 .. t0+N
const snaps = [];
let focus = null;
const mk = (rows, base) => ({ ...base, t: base.t, proj: rows });
const quiet = (s) => { s.say = []; return s; }; // no speech bubbles in the picture
console.log = () => {};
if (scene === 'archers' || scene === 'tower') {
  const want = scene === 'tower' ? (q) => q[7] < 0 : (q) => q[7] === uIdx('archer');
  let prevSnap = null, found = null;
  for (let i = 0; i < 12000 && !found; i++) {
    tick();
    if (game.t % 1) continue;
    const s = match.snapshot();
    for (const q of s.proj) {
      if (!want(q) || q[9] !== 1) continue;
      const D = Math.hypot(q[2] - q[0], q[3] - q[1]) + 1.4; // remaining + first step
      if (D >= (scene === 'tower' ? 6.5 : 6)) { found = { s, q, D }; break; }
    }
  }
  if (!found) throw new Error('no shot found');
  const { s, q } = found;
  snaps.push(quiet(s));
  for (let i = 0; i < Math.ceil(found.D / 1.4) + 3; i++) { tick(); snaps.push(quiet(match.snapshot())); }
  const ox = q[0] - ((q[2] - q[0]) / Math.hypot(q[2] - q[0], q[3] - q[1])) * 1.4, oz = q[1] - ((q[3] - q[1]) / Math.hypot(q[2] - q[0], q[3] - q[1])) * 1.4;
  focus = { ox, oz, tx: q[2], tz: q[3], D: found.D };
} else {
  for (let i = 0; i < 1200; i++) tick();
  const base = match.snapshot();
  const st = game.starts[0];
  const spec = { arrow: { name: 'archer', speed: 1400, splash: 0, D: 7 }, bolt: { name: '', speed: 1400, splash: 0, D: 10 }, catapult: { name: 'catapult', speed: 800, splash: 1, D: 9 }, mortar: { name: 'mortar', speed: 600, splash: 1, D: 12 }, ball: { name: 'war_boat', speed: 1000, splash: 0, D: 6.5 } }[scene];
  // an open strip of grass (no forest, water or rock, 3 tiles wide) near the first base, so the camera sees the whole flight
  const free = (x, z) => x >= 2 && z >= 2 && x < game.W - 2 && z < game.H - 2 && game.terrain[Math.floor(z) * game.W + Math.floor(x)] === 0;
  let best = null;
  for (let dz = -14; dz <= 34 && !best; dz++) for (let dx = -16; dx <= 16 && !best; dx++) {
    const x0 = st.tx + dx, z0 = st.ty + dz;
    let ok = true;
    for (let i = -2; i <= spec.D + 3 && ok; i++) for (let j = -2; j <= 2 && ok; j++) if (!free(x0 + i, z0 + j)) ok = false;
    if (ok) best = [x0 + 0.5, z0 + 0.5];
  }
  if (!best) throw new Error('no open strip');
  const ox = best[0], oz = best[1], tx = ox + spec.D, tz = oz;
  const step = spec.speed / 1000, n = Math.ceil(spec.D / step);
  for (let k = 0; k <= n + 4; k++) {
    const f = Math.min(spec.D, step * (k + 1));
    const rows = k + 1 > n ? [] : [[+(ox + f).toFixed(2), oz, tx, tz, 1, spec.speed, spec.splash, spec.name ? uIdx(spec.name) : -1, 999999, k + 1]];
    snaps.push(quiet(mk(rows, { ...base, t: base.t + k, dead: [], ev: [] })));
  }
  focus = { ox, oz, tx, tz, D: spec.D };
}
console.log = log;
console.log(scene, 'snapshots', snaps.length, 'focus', JSON.stringify(focus));

// ---- page
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const f = path.normalize(path.join(RENDER, decodeURIComponent(u.pathname)));
  if (!f.startsWith(RENDER + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
const puppeteer = createRequire(import.meta.url)(path.join(puppeteerDir(), 'puppeteer-core'));
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', args: [...angleArgs(), '--ignore-gpu-blocklist', '--no-sandbox', '--enable-unsafe-swiftshader', '--force-device-scale-factor=1', `--window-size=${W},${H}`] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${PORT}/broadcast.html?capture=1&preset=yt&quality=${A.quality || 'live'}${A.theme ? '&theme=' + encodeURIComponent(A.theme) : ''}`, { waitUntil: 'load' });
await page.waitForFunction('window.__bcReady === true', { timeout: 30000 });
await page.evaluate(async (m) => { const h = window.__bcHooks; h.init(m); await h.ready; }, init);
await page.addStyleTag({ content: '#stage > :not(#view){display:none!important}' });

const dx = focus.tx - focus.ox, dz = focus.tz - focus.oz, D = Math.hypot(dx, dz) || 1;
const az = Math.atan2(-dz / D, dx / D) + (A.flip ? Math.PI : 0);
const cam = { tx: (focus.ox + focus.tx) / 2, ty: A.cy ? +A.cy : 1.3, tz: (focus.oz + focus.tz) / 2, dist: A.dist ? +A.dist : Math.max(14, D * 1.7), az, pol: A.pol ? +A.pol : 1.38, fov: A.fov ? +A.fov : 30 };
await page.evaluate((s) => window.__bcHooks.snap(s), snaps[0]);
const files = [];
let n = 0;
for (let k = 0; k < snaps.length - 1; k++) {
  await page.evaluate((s) => window.__bcHooks.snap(s), snaps[k + 1]);
  for (let a = 0; a < SUB; a++) {
    await page.evaluate((al, t, c) => window.__bcHooks.render(al, t, 1 / 30, c), a / SUB, n / 30, cam);
    const f = path.join(out, `${scene}-${String(n).padStart(3, '0')}.png`);
    if (A.debug) { // where the first arrow / shell is: world position and normalized screen position
      const d = await page.evaluate(() => { const w = window.__rts.world; const m = w.shell.count ? w.shell : w.proj; if (!m.count) return null; const e = m.instanceMatrix.array; const p = { x: e[12], y: e[13], z: e[14] }; return { n: m.count, ...p, scr: window.__bcHooks.project([{ x: p.x, z: p.z, h: p.y }])[0] }; });
      console.log('frame', n, JSON.stringify(d));
    }
    if (!A.dry) await page.screenshot({ path: f, type: 'png' });
    files.push(f); n++;
  }
}
await browser.close();
srv.close();
// contact sheet: --picks frames spread over the flight (default 6), 2 per row, full size
const picks = +A.picks || 6, cols = 2, rows = Math.ceil(picks / cols);
const idx = Array.from({ length: picks }, (_, i) => Math.round(((i + 0.5) / picks) * (files.length - 1))).map((v) => `eq(n\\,${v})`).join('+');
if (A.dry) process.exit(0);
const r = spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', path.join(out, `${scene}-%03d.png`), '-vf', `select=${idx},scale=960:-1,tile=${cols}x${rows}`, '-vsync', '0', '-frames:v', '1', path.join(out, `${scene}-sheet.png`)]);
console.log('frames', files.length, 'sheet', r.status);
process.exit(0);
