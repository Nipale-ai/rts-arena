#!/usr/bin/env node
// Close-up frame sequences of the unit animations (dev tool): a scripted scene is run in the real sim, every frame is drawn by
// render/broadcast.html in headless Chrome (the same path as the video renderer: output time animT, seeded random) and the frames
// are tiled into one contact sheet per scene.
//   node tools/anim-shots.mjs chop|mine|build|farm|fight|melee|death [--out dir] [--fps 12] [--secs 3] [--w 720 --h 540] [--cols 6] [--seed 42]
//        [--dist 7] [--pol 1.1] [--az 0.5] [--start-s N] [--no-sheet]
// Scenes: a worker next to a tree / a stone node / an unfinished house / a farm; two swordsmen (one per player) fighting each other (fight: --a --b --sep, --kill S removes the second one at S seconds);
// farm = foraging at a berry bush (nodes of food), death: three idle swordsmen in a row, picked so that each plays one of the three falls (render/units3d.mjs deathClip), all removed at --kill S (default 1);
// melee: two lines of --n (8) fighters (--a --b) in rows --row (1.5) tiles apart, --sep (4) tiles between the lines, every fighter has its own opponent.
import '../server/local-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { args as spectateArgs, Match } from '../server/spectate.mjs';
import { chromePath, angleArgs, puppeteerDir } from './make-video.mjs';
import { deathClip, HUMAN_DEATHS } from '../render/units3d.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = path.join(ROOT, 'render');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary' };

const A = { _: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) { A._.push(a); continue; }
  const n = process.argv[i + 1];
  if (n === undefined || n.startsWith('--')) A[a.slice(2)] = true; else { A[a.slice(2)] = n; i++; }
}
const scene = A._[0] || 'chop';
const FPS = +(A.fps || 12), SECS = +(A.secs || 3), W = +(A.w || 720), H = +(A.h || 540), COLS = +(A.cols || 6), SEED = +(A.seed || 42);
const outDir = path.resolve(A.out || `/tmp/anim-3010-shots/${scene}`);
fs.mkdirSync(outDir, { recursive: true });

// ---- the scene in the real sim ----
spectateArgs.p1 = 'turtle'; spectateArgs.p2 = 'turtle'; spectateArgs.seed = String(SEED); spectateArgs['no-record'] = true;
const log = console.log;
console.log = () => {};
const match = new Match();
const initMsg = match.initMsg();
console.log = log;
const g = match.game;
const keepAlive = [];
const killMany = new Set(); let killAt = 0, killId = 0; // --kill S: the second fighter disappears at S seconds (the fight ends)
const quiet = () => { console.log = () => {}; g.step(); if (killAt && killMany.size && g.t >= killAt) { for (const id of killMany) g.units.delete(id); killMany.clear(); } if (killAt && killId && g.t >= killAt) { g.units.delete(killId); killId = 0; keepAlive.length = 0; const aa = g.units.get(focusId); if (aa) aa.tgt = 0; } console.log = log; for (let i = 0; i < keepAlive.length; i++) { const u = g.units.get(keepAlive[i]); if (!u) continue; if (u.hp < u.maxhp * 0.35) u.hp = u.maxhp; u.tgt = keepAlive[i ^ 1]; } } // tgt: what an auto-targeting soldier of the real game has (the snapshot shows 'attacking' only then); // the fight scene: fighters get healed so the hits go on
const st1 = g.starts[0];
const tile = (x, y) => g.terrain[y * g.W + x];
const free = (x, y) => x >= 0 && y >= 0 && x < g.W && y < g.H && tile(x, y) === 0 && !g.blk[y * g.W + x];
// nearest tile of a kind (terrain 1 = forest) with a free neighbour, searched in rings around the base of player 1
function nearTree() {
  for (let r = 4; r < 60; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const x = Math.round(st1.tx) + dx, y = Math.round(st1.ty) + dy;
    if (x < 1 || y < 1 || x >= g.W - 1 || y >= g.H - 1 || tile(x, y) !== 1 || g.wood[y * g.W + x] <= 0) continue;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) if (free(nx, ny)) return { tx: x, ty: y, fx: nx, fy: ny };
  }
  return null;
}
function nearNode(res) {
  let best = null, bd = 1e9;
  for (const n of g.nodes.values()) {
    if (n.res !== res) continue;
    const d = Math.hypot(n.tx - st1.tx, n.ty - st1.ty);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
// a view direction (azimuth) from which no tree or building stands between the camera and (x, z); `want` = preferred azimuth
function bestAz(x, z, want) {
  let best = want, bs = 1e9;
  for (let i = 0; i < 24; i++) {
    const az = want + ((i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.PI) / 12;
    let blocked = 0;
    for (let d = 1.4; d <= 10; d += 0.5) for (const lat of [-1, 0, 1]) {
      const px = Math.floor(x + Math.sin(az) * d + Math.cos(az) * lat), pz = Math.floor(z + Math.cos(az) * d - Math.sin(az) * lat);
      if (px < 0 || pz < 0 || px >= g.W || pz >= g.H || tile(px, pz) !== 0 || g.blk[pz * g.W + px]) blocked += lat === 0 ? 2 : 1;
    }
    const sc = blocked * 100 + Math.abs(az - want) * 30;
    if (sc < bs) { bs = sc; best = az; }
  }
  return best;
}
let focusId = null, focus2 = null, camAz = A.az !== undefined ? +A.az : 0.6, camDist = +(A.dist || 14), camPol = +(A.pol || 0.85), camFov = +(A.fov || 15), startS = +(A['start-s'] || 0);
function spawnWorker(x, y) { return g.addUnit(1, 'worker', Math.round(x * 1000), Math.round(y * 1000)); }
if (scene === 'chop') {
  const t = nearTree();
  const w = spawnWorker(t.fx + 0.5, t.fy + 0.5);
  focusId = w.id;
  g.command(1, { cmd: 'gather', resource: 'wood', worker_ids: [w.id], near: [t.tx, t.ty] });
  if (A.az === undefined) camAz = bestAz(t.fx + 0.5, t.fy + 0.5, Math.atan2(t.fx - t.tx, t.fy - t.ty) + +(A.off || 1.4));
  startS = A['start-s'] !== undefined ? startS : 2;
} else if (scene === 'mine' || scene === 'farm') {
  const n = (scene === 'mine' ? nearNode('stone') || nearNode('gold') : nearNode('berries')) || nearNode('food') || nearNode('stone');
  let fx = n.tx - 1, fy = n.ty;
  for (const [x, y] of [[n.tx - 1, n.ty], [n.tx + n.size, n.ty], [n.tx, n.ty - 1], [n.tx, n.ty + n.size]]) if (free(x, y)) { fx = x; fy = y; break; }
  const w = spawnWorker(fx + 0.5, fy + 0.5);
  focusId = w.id;
  g.command(1, { cmd: 'gather', resource: n.res === 'berries' ? 'food' : n.res, worker_ids: [w.id], near: [n.tx, n.ty] });
  if (A.az === undefined) camAz = bestAz(fx + 0.5, fy + 0.5, Math.atan2(fx - (n.tx + n.size / 2), fy - (n.ty + n.size / 2)) + +(A.off || 1.4));
  startS = A['start-s'] !== undefined ? startS : 2;
} else if (scene === 'build') {
  g.players[1].res.wood = 5000; g.players[1].res.stone = 5000; g.players[1].res.food = 5000; g.players[1].res.gold = 5000;
  const w = spawnWorker(st1.tx + 8.5, st1.ty + 8.5);
  focusId = w.id;
  const r = g.command(1, { cmd: 'build', building_type: 'house', near: [Math.round(st1.tx) + 10, Math.round(st1.ty) + 8], worker_ids: [w.id] });
  if (!r.ok) throw new Error('build: ' + JSON.stringify(r));
  if (A.az === undefined) camAz = bestAz(Math.round(st1.tx) + 11, Math.round(st1.ty) + 9, 0.6);
  startS = A['start-s'] !== undefined ? startS : 4;
} else if (scene === 'fight' || scene === 'melee' || scene === 'death') {
  // an open patch of ground (no tree, rock or building within 2 tiles) of 6 x 4 tiles, nearest to the base
  const okTile = (x, y) => x >= 2 && y >= 2 && x < g.W - 2 && y < g.H - 2 && tile(x, y) === 0 && !g.blk[y * g.W + x];
  const NM = scene === 'melee' ? +(A.n || 8) : 1, ROW = +(A.row || 1.5), PW = scene === 'melee' ? 12 + Math.round(+(A.sep || 4)) : 8, PH = scene === 'melee' ? Math.ceil(NM * ROW) + 4 : 6; // size of the open patch
  let spot = null;
  for (let r = +(A.rmin || 18); r < 70 && !spot; r++) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const x0 = Math.round(st1.tx) + dx, y0 = Math.round(st1.ty) + dy;
    let all = true;
    for (let y = y0 - 2; y < y0 + PH && all; y++) for (let x = x0 - 2; x < x0 + PW && all; x++) if (!okTile(x, y)) all = false;
    if (all) spot = [x0, y0];
  }
  const [mx, my] = spot || [Math.round(st1.tx) + 12, Math.round(st1.ty) + 12];
  const sep = +(A.sep || (scene === 'melee' ? 4 : 1.5));
  if (scene === 'death') { // candidates until every fall has an id; the unit id decides the fall (the same rule as the game)
    const reg = JSON.parse(fs.readFileSync(path.join(RENDER, 'assets/models/units/UNITS.json'), 'utf8')), got = new Map();
    for (let i = 0; i < 60 && got.size < HUMAN_DEATHS.length; i++) {
      const u = g.addUnit(1, A.a || 'swordsman', (mx + 1.0) * 1000, (my + 0.5) * 1000), c = deathClip(reg, 'schwertkaempfer', { id: u.id, dir: 1 });
      if (got.has(c)) g.units.delete(u.id); else got.set(c, u.id);
    }
    HUMAN_DEATHS.forEach((c, i) => { const u = g.units.get(got.get(c)); u.x = (mx + 1.0 + i * +(A.gap || 2.2)) * 1000; keepAlive.length = 0; killMany.add(u.id); if (i === 1) focusId = u.id; });
    killAt = Math.round(+(A.kill || 1) * 10); console.log('death scene: ids ' + [...got].map(([c, id]) => c + '=' + id).join(' '));
  } else for (let i = 0; i < NM; i++) {
    const zz = (my + 0.5 + i * ROW) * 1000;
    const a = g.addUnit(1, A.a || 'swordsman', (mx + 1.0) * 1000, zz), b = g.addUnit(2, A.b || 'swordsman', (mx + 1.0 + sep) * 1000, zz);
    if (i === (NM >> 1)) { focusId = a.id; focus2 = b.id; }
    keepAlive.push(a.id, b.id); // pairs (the harness keeps both of a pair healed and aimed at each other)
    g.command(1, { cmd: 'attack_move', units: [a.id], target: b.id });
    g.command(2, { cmd: 'attack_move', units: [b.id], target: a.id });
  }
  if (A.kill && scene !== 'death') { killAt = Math.round(+A.kill * 10); killId = focus2; }
  startS = A['start-s'] !== undefined ? startS : 0;
  camAz = A.az !== undefined ? +A.az : 0.15;
} else { console.error('unknown scene ' + scene); process.exit(2); }

for (const id of [...g.units.keys()]) if (id !== focusId && id !== focus2 && !keepAlive.includes(id) && !killMany.has(id)) g.units.delete(id); // only the actors in the picture
console.log(`scene ${scene}: start tile (${st1.tx},${st1.ty}) unit ${focusId} at ${JSON.stringify(g.units.get(focusId) && [g.units.get(focusId).x / 1000, g.units.get(focusId).y / 1000])} az ${camAz.toFixed(2)} dist ${camDist}`);
if (A.trace) { for (let k = 0; k < +A.trace * 10; k++) { quiet(); const u = g.units.get(focusId); if (k % 5 === 0 && u) console.log(g.t, (u.x / 1000).toFixed(2), (u.y / 1000).toFixed(2), JSON.stringify(u.ord).slice(0, 60), u.res, u.amt, u.cd, u.hp); } }
if (A.dry) process.exit(0);
// ---- page ----
function staticServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const f = path.normalize(path.join(RENDER, decodeURIComponent(u.pathname)));
    if (!f.startsWith(RENDER + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => srv.listen(+(process.env.ANIM_PORT || 8901), '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}
const { srv, port } = await staticServer();
const puppeteer = createRequire(import.meta.url)(path.join(puppeteerDir(), 'puppeteer-core'));
const browser = await puppeteer.launch({
  executablePath: chromePath(), headless: 'new',
  args: [...angleArgs(), '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--no-sandbox', '--force-device-scale-factor=1', '--disable-renderer-backgrounding', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/broadcast.html?capture=1&preset=yt${process.env.RTS_QUERY ? '&' + process.env.RTS_QUERY : ''}`, { waitUntil: 'load' });
await page.waitForFunction('window.__bcReady === true', { timeout: 60000 });
await page.addStyleTag({ content: `body.preset-yt { width: ${W}px !important; height: ${H}px !important; } .preset-yt #view { width: ${W}px !important; height: ${H}px !important; }` });
await page.evaluate(() => window.dispatchEvent(new Event('resize')));
await page.evaluate((m) => window.__bc.setup(m, { cls: '', footer: '', story: false }), initMsg);
await page.addStyleTag({ content: '#stage > *:not(#view) { display: none !important; }' });

// ---- run ----
// the scene runs from tick 0; frames are drawn from startS on (the page sees all snapshots from the first tick, like a chunk with a warm-up)
const TICK = 10;
const total = Math.ceil(SECS * FPS), preFrames = Math.round(startS * FPS);
let first = true;
const pos = (id) => { const u = g.units.get(id); return u && !u.dead ? [u.x / 1000, u.y / 1000] : null; };
let camX = 0, camZ = 0, last = null;
const frames = [];
for (let f = -Math.round(1.5 * FPS); f < preFrames + total; f++) {
  const out = Math.max(0, f) / FPS + 0; // output time
  const tick = (f < 0 ? 0 : f / FPS) * TICK;
  const k = Math.floor(tick), alpha = tick - k;
  const snaps = [];
  if (first) { while (g.t < k) quiet(); snaps.push(match.snapshot()); first = false; } else if (g.t < k) { while (g.t < k) quiet(); snaps.push(match.snapshot()); }
  if (g.t < k + 1) { quiet(); snaps.push(match.snapshot()); }
  if (snaps.length) last = snaps[snaps.length - 1];
  if (f < 0) continue;
  const p1 = pos(focusId), p2 = focus2 ? pos(focus2) : null;
  if (p1) { const cx = p2 ? (p1[0] + p2[0]) / 2 : p1[0], cz = p2 ? (p1[1] + p2[1]) / 2 : p1[1]; camX = camX ? camX + (cx - camX) * 0.15 : cx; camZ = camZ ? camZ + (cz - camZ) * 0.15 : cz; }
  const cam = { tx: camX, ty: 0.55, tz: camZ, dist: camDist, az: camAz, pol: camPol, fov: camFov };
  const animT = f / FPS;
  await page.evaluate((fr) => { for (const s of fr.snaps) window.__bcHooks.snap(s); window.__bcHooks.render(fr.alpha, fr.animT, fr.dt, fr.cam); }, { snaps: f === 0 && snaps.length < 2 ? [last, last] : snaps, alpha, animT, dt: 1 / FPS, cam });
  if (f < preFrames) continue;
  const file = path.join(outDir, `f${String(f - preFrames).padStart(3, '0')}.png`);
  fs.writeFileSync(file, await page.screenshot({ type: 'png', optimizeForSpeed: true }));
  frames.push(file);
}
await browser.close();
srv.close();
console.log(`${scene}: ${frames.length} frames in ${outDir}`);
if (!A['no-sheet']) {
  const rows = Math.ceil(frames.length / COLS);
  const sheet = path.join(outDir, `sheet-${scene}.png`);
  const r = spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(outDir, 'f%03d.png'),
    '-vf', `crop=${Math.round(W * 0.7)}:${Math.round(H * 0.7)}:${Math.round(W * 0.15)}:${Math.round(H * 0.12)},scale=${A.tw || 320}:-1,drawtext=text='%{eif\\:n\\:d}  t=%{eif\\:n*1000/${FPS}\\:d} ms':x=6:y=6:fontsize=14:fontcolor=white:box=1:boxcolor=black@0.55,tile=${COLS}x${rows}`,
    '-frames:v', '1', sheet], { stdio: 'inherit' });
  console.log(r.status === 0 ? 'sheet ' + sheet : 'sheet failed');
}
