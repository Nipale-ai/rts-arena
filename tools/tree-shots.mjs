#!/usr/bin/env node
// Dev tool: screenshot sequences of woodcutters at work, to judge the chopped trees (wobble at the axe hits, the fall, the stump). The sim runs in Node on the
// real map with a few workers, the page is driven frame by frame like the broadcast render (render/broadcast.mjs), so the result is frame-exact.
//   node tools/tree-shots.mjs --out dir --mode close [--wood 7] [--dur 16] [--shots 6] [--fps 30] [--dist 7.5] [--az 0] [--pol 1.2] [--w 1280] [--h 720] [--seed 7] [--swift | --gl]
//   node tools/tree-shots.mjs --out dir --mode wide  [--workers 10] [--wood 9] [--dur 100] [--every 10] [--fps 10] [--dist 24] ...
// close: one woodcutter, one tile with `wood` wood left; shots = pictures per second. wide: many woodcutters clear the forest edge; a picture every `every` seconds.
// --chunk T renders only from game second T on, with the page starting there (a parallel render chunk): compare with the serial run.
import '../server/local-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { args as spectateArgs, Match } from '../server/spectate.mjs';
import { chromePath, angleArgs, puppeteerDir } from './make-video.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = path.join(ROOT, 'render');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const A = {};
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) { const n = process.argv[i + 1]; if (n === undefined || n.startsWith('--')) A[a.slice(2)] = true; else { A[a.slice(2)] = n; i++; } } }
const OUT = A.out || 'tree-out', MODE = A.mode || 'close', W = +(A.w || 1280), H = +(A.h || 720), FPS = +(A.fps || (MODE === 'wide' ? 10 : 30));
const DUR = +(A.dur || (MODE === 'wide' ? 100 : 16)), WOOD = +(A.wood || (MODE === 'wide' ? 9 : 7)), SHOTS = +(A.shots || 6), EVERY = +(A.every || 10), CHUNK = A.chunk === undefined ? null : +A.chunk;
const log = (...a) => console.log(...a);

Object.assign(spectateArgs, { 'no-record': true, p1: 'turtle', p2: 'turtle', seed: A.seed || 7 });
const quiet = console.log; console.log = () => {};
const match = new Match(); const initMsg = match.initMsg(); console.log = quiet;
match.bots = []; // no scripted bots: only the units set up here move
const g = match.game, N = g.W, F = (x, y) => y * N + x;
const forest = (x, y) => x >= 0 && y >= 0 && x < N && y < N && g.terrain[F(x, y)] === 1;
const free = (x, y) => x >= 0 && y >= 0 && x < N && y < N && g.terrain[F(x, y)] === 0;
const tick = () => { console.log = () => {}; match.tick(); console.log = quiet; };

const { srv, port } = await new Promise((res) => { const s = http.createServer((req, rs) => { const u = new URL(req.url, 'http://127.0.0.1'); const f = path.normalize(path.join(RENDER, decodeURIComponent(u.pathname))); if (!f.startsWith(RENDER + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); rs.end(); return; } rs.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); fs.createReadStream(f).pipe(rs); }); s.listen(+(A.port || 0), '127.0.0.1', () => res({ srv: s, port: s.address().port })); });
const puppeteer = createRequire(import.meta.url)(path.join(puppeteerDir(), 'puppeteer-core'));
const swift = A.gl ? ['--use-angle=gl-egl'] : A.swift ? ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] : [];
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'new', protocolTimeout: 1800000, args: [...angleArgs(), ...swift, '--ignore-gpu-blocklist', '--no-sandbox', '--force-device-scale-factor=1', `--window-size=${W},${H}`] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log('[page]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/broadcast.html?capture=1&preset=yt`, { waitUntil: 'load' });
await page.waitForFunction('window.__bcReady === true', { timeout: 120000 });
await page.evaluate((m, c) => window.__bc.setup(m, c), initMsg, { cls: '', footer: '', story: false });
fs.mkdirSync(OUT, { recursive: true });
await page.addStyleTag({ content: '#stage > *:not(#view) { display: none !important; }' });
// tiles that really carry trees in the page (a forest tile of the sim may have none: groves keep gaps); n = trees on the tile
// --species 5,22 keeps only these tree species (model ids); by default every species counts: the groves pick a species per patch of forest from the seed
// and the map type (render/grove.mjs), so no single species is on every map (the oak, id 5, is on 56 of 776 forest tiles of the default seed: that was no edge)
const BIG = A.species ? String(A.species).split(',').map(Number) : null;
const treeN = new Map(await page.evaluate((big) => { const W = window.__rts.world.trees.work; return [...W.index].map(([k, v]) => [k, v.filter((i) => !big || big.includes(W.items[i][4].id)).length]); }, BIG));

// the forest edge nearest to the first start: a forest tile with forest behind it and open ground in front of it
const st = g.starts?.[0] || initMsg.starts[0], sx = Array.isArray(st) ? st[0] : st.tx, sy = Array.isArray(st) ? st[1] : st.ty;
let best = null, bd = 1e9; const cands = [];
const M0 = +(A.margin || 28); // the game camera never aims nearer than ~25 tiles to the map edge (render/cinema.mjs: edge clamp)
for (let y = M0; y < N - M0; y++) for (let x = M0; x < N - M0; x++) {
  if (!forest(x, y) || (treeN.get(F(x, y)) || 0) < 1 || !free(x - 1, y) || !free(x - 2, y) || !free(x - 1, y - 1) || !free(x - 1, y + 1) || !free(x - 2, y - 1) || !free(x - 2, y + 1)) continue;
  const d = Math.hypot(x - sx, y - sy);
  if (d > 3 && d < bd) { bd = d; best = [x, y]; cands.push([x, y, treeN.get(F(x, y)), +d.toFixed(1)]); }
}
if (!best) { log('no forest edge found'); process.exit(1); }
const [ex, ey] = best;
log('edge candidates (x,y,trees,dist)', JSON.stringify(cands.slice(-4)));
log('edge tile', ex, ey, 'start', sx, sy, 'map', N);
const p1 = g.players[1];
if (p1.expl && p1.expl.fill) p1.expl.fill(1); // the whole map counts as explored: the woodcutter may go to any forest edge, not only near the start
const ids = [];
const spawn = (x, y) => { const u = g.addUnit(1, 'worker', x * 1000 + 500, y * 1000 + 500); ids.push(u.id ?? u); };
let target = null;
if (MODE === 'close') {
  spawn(ex - 1, ey);
  const r = g.command(1, { cmd: 'gather', worker_ids: ids, resource: 'wood', near: [ex + 0.5, ey + 0.5] }); log('gather', JSON.stringify(r));
  tick();
  const u = g.units.get(ids[0]); target = u.ord.node && u.ord.node.k === 't' ? u.ord.node.idx : F(ex, ey);
  log('sim picked', target % N, Math.floor(target / N), 'trees there', treeN.get(target) || 0, 'ord', JSON.stringify(u.ord).slice(0, 300));
  if (target !== F(ex, ey) && u.ord.node) { target = F(ex, ey); const o = u.ord; o.node = { k: 't', idx: target }; o.slot = { k: 't', idx: target }; o.x0 = ex * 1000; o.y0 = ey * 1000; o.x1 = (ex + 1) * 1000; o.y1 = (ey + 1) * 1000; o.st = 'go'; } // the sim took another tile: use the edge tile that has the trees
  g.wood[target] = WOOD;
  log('target tile', target % N, Math.floor(target / N), 'wood', WOOD);
} else {
  const n = +(A.workers || 10);
  p1.carry = 60; // no trips to the town centre
  for (let k = 0; k < n; k++) spawn(ex - 1, ey - 3 + k);
  for (let y = ey - 7; y < ey + 12; y++) for (let x = ex; x < ex + 7; x++) if (forest(x, y)) g.wood[F(x, y)] = WOOD;
  const r = g.command(1, { cmd: 'gather', worker_ids: ids, resource: 'wood', near: [ex + 0.5, ey + 3] }); log('gather', JSON.stringify(r));
}


const TPS = 10, FPT = Math.max(1, Math.round(FPS / TPS)); // game ticks per second, frames per tick
const tgtItems = await page.evaluate((tile) => { const W = window.__rts.world.trees.work; return (W.index.get(tile) || []).map((k) => [W.items[k][2], W.items[k][3], W.items[k][4].id]); }, target);
log('target trees (x, z, species)', JSON.stringify(tgtItems));
const ctr = tgtItems.length ? [tgtItems.reduce((a, t) => a + t[0], 0) / tgtItems.length, tgtItems.reduce((a, t) => a + t[1], 0) / tgtItems.length] : [target % N + 0.5, Math.floor(target / N) + 0.5];
const cam = MODE === 'close'
  ? { tx: ctr[0], ty: +(A.ty ?? 1.0), tz: ctr[1], dist: +(A.dist || 7.5), az: +(A.az ?? 0), pol: +(A.pol ?? 1.2), fov: +(A.fov ?? 30) }
  : { tx: ex + 3, ty: 0, tz: ey + 3, dist: +(A.dist || 24), az: +(A.az ?? 0.7), pol: +(A.pol ?? 0.95), fov: +(A.fov ?? 34) };
if (A.solo !== undefined) { // keep only the trees within `solo` tiles of the target: the picture shows exactly the tree that is chopped
  const r = +A.solo || 3;
  log('solo kept', await page.evaluate((cx, cz, r) => { const W = window.__rts.world.trees.work; let n = 0; for (const it of W.items) { const keep = Math.hypot(it[2] - cx, it[3] - cz) <= r; it[0].setAlive(it[1], keep); if (keep) n++; } return n; }, ctr[0], ctr[1], r));
}
const ev = A.eye ? String(A.eye).split(',').map(Number) : null; // --eye az,dist,height,lookY,fov  (tiles / radians / degrees), around the target trees
const eye = ev ? { tx: ctr[0], tz: ctr[1], az: ev[0], d: ev[1], h: ev[2], ty: ev[3], fov: ev[4] } : null;
let prev = match.snapshot(), cur = prev, shot = 0, first = true;
const total = Math.round(DUR * FPS), startF = CHUNK === null ? 0 : Math.round(CHUNK * FPS);
const shotEvery = MODE === 'close' ? Math.max(1, Math.round(FPS / SHOTS)) : Math.round(EVERY * FPS);
const t0 = Date.now();
let pageStarted = CHUNK === null, lastTg = null;
for (let f = 0; f < total; f++) {
  if (f % FPT === 0) { prev = cur; tick(); cur = match.snapshot(); }
  if (!pageStarted) { if (f < startF) continue; pageStarted = true; first = true; prev = cur; } // a chunk: the page starts here and sees the state as it is
  if (cur.tg && cur.tg.length && cur !== lastTg) { lastTg = cur; log('snapshot tg', JSON.stringify(cur.tg), 'tick', cur.t, 'frame', f); }
  const alpha = (f % FPT) / FPT;
  const snaps = f % FPT === 0 || first ? (first ? [prev, cur] : [cur]) : []; first = false;
  await page.evaluate((fr) => { const Hk = window.__bcHooks; for (const s of fr.snaps) Hk.snap(s); Hk.render(fr.alpha, fr.animT, fr.dt, fr.cam);
    if (fr.eye) { // free camera for the close pictures (the game camera keeps 14+ tiles distance): same target, nearer eye, set after the game camera has culled the scene
      const R = window.__rts, e = fr.eye, g = R.cam.ty - fr.cam.ty, T = new R.camera.position.constructor(e.tx, g + e.ty, e.tz); // g = ground height at the target
      R.camera.position.set(e.tx + e.d * Math.sin(e.az), g + e.h, e.tz + e.d * Math.cos(e.az)); R.camera.fov = e.fov; R.camera.updateProjectionMatrix(); R.camera.lookAt(T); R.camera.updateMatrixWorld();
      R.post.render();
      const pr = T.clone().project(R.camera), q = R.camera.quaternion; return { g, pos: R.camera.position.toArray(), tgt: [e.tx, g + e.ty, e.tz], ndc: [pr.x, pr.y, pr.z], quat: [q.x, q.y, q.z, q.w], fov: R.camera.fov, aspect: R.camera.aspect, near: R.camera.near, far: R.camera.far };
    } }, { snaps, alpha, animT: f / FPS, dt: 1 / FPS, cam, eye }).then((r) => { if (f === 0 && r) log('eye debug', JSON.stringify(r)); }).catch((e) => { log('frame error', e.message); process.exit(1); });
  if (A.dbg && f === +A.dbg) {
    log('dbg', JSON.stringify(await page.evaluate((tile) => {
      const W = window.__rts.world.trees.work, it = W.items[W.index.get(tile)[0]], sc = it[0], i = it[1], out = {};
      out.alive = sc.alive[i]; out.counts = sc.counts; out.pos = Array.from(sc.pos.slice(i * 3, i * 3 + 3)); out.ready = sc.ready;
      const near = []; const mi = sc.meshes[0] && sc.meshes[0][0];
      if (mi) { const a = mi.instanceMatrix.array; for (let k = 0; k < mi.count; k++) { const x = a[k * 16 + 12], z = a[k * 16 + 14]; if (Math.hypot(x - it[2], z - it[3]) < 1.5) near.push(Array.from(a.slice(k * 16, k * 16 + 16)).map((v) => +v.toFixed(3))); } out.count0 = mi.count; out.geo = mi.geometry.boundingBox ? null : (mi.geometry.computeBoundingBox(), 0); out.bbox = mi.geometry.boundingBox && [mi.geometry.boundingBox.min.toArray(), mi.geometry.boundingBox.max.toArray()]; out.mat = mi.material.type + ' ' + (mi.material.transparent ? 't' : 'o') + ' ' + mi.material.opacity + ' vis ' + mi.material.visible; out.col = Array.from(mi.instanceColor.array.slice(0, 6)); }
      out.near = near; out.cam = window.__rts.camera.position.toArray(); out.mesh = mi ? { vis: mi.visible, fc: mi.frustumCulled, parentVis: mi.parent && mi.parent.visible } : null;
      return out;
    }, target)));
  }
  if (A.red && f === +A.red) { // paint the target trees red to find them in the picture
    await page.evaluate((tile) => { const W = window.__rts.world.trees.work; for (const k of W.index.get(tile) || []) { const it = W.items[k], sc = it[0]; sc.col[it[1] * 3] = 6; sc.col[it[1] * 3 + 1] = 0; sc.col[it[1] * 3 + 2] = 0; sc.dirty = true; } }, target);
    await page.evaluate((fr) => window.__bcHooks.render(fr.alpha, fr.animT, fr.dt, fr.cam), { alpha, animT: f / FPS, dt: 0, cam });
    log('ndc', JSON.stringify(await page.evaluate((tile) => { const W = window.__rts.world.trees.work, R = window.__rts; return (W.index.get(tile) || []).map((k) => { const it = W.items[k], V = R.camera.position.constructor; const b = new V(it[2], R.cam.ty - 1.4 + 0.0, it[3]).project(R.camera), t = new V(it[2], R.cam.ty - 1.4 + 3.3, it[3]).project(R.camera); return { base: [b.x, b.y], top: [t.x, t.y], cam: R.camera.position.toArray(), camS: [R.camS.tx, R.camS.tz, R.camS.dist, R.camS.az, R.camS.pol], cam2: [R.cam.tx, R.cam.tz, R.cam.dist], w: innerWidth, h: innerHeight, cv: [R.renderer.domElement.width, R.renderer.domElement.height, R.renderer.domElement.clientWidth] }; }); }, target)));
    await page.screenshot({ path: path.join(OUT, 'red.png'), type: 'png' });
    log('red done');
  }
  if (A.ray && f === +A.ray) {
    log('ray', JSON.stringify(await page.evaluate((x, z) => {
      const R = window.__rts, T = R.camera.position.constructor, out = { keys: Object.keys(R.G.tmesh || {}) };
      const rc = new (Object.getPrototypeOf(R.camera).constructor === Object ? Object : Object)();
      return out;
    }, ctr[0], ctr[1])));
  }
  if (A.sweep && f === +A.sweep) { // the same frame from eight sides: to pick the camera heading
    for (let k = 0; k < 8; k++) {
      const c2 = { ...cam, az: -3.14 + k * 0.785 };
      await page.evaluate((fr) => window.__bcHooks.render(fr.alpha, fr.animT, fr.dt, fr.cam), { alpha, animT: f / FPS, dt: 0, cam: c2 });
      await page.screenshot({ path: path.join(OUT, `sweep${k}.png`), type: 'png' });
    }
    log('sweep done'); break;
  }
  if (A.probe && f === +A.probe) { // where is everything? screen position of the target tile and of the woodcutter, tree items on the tile
    const u = g.units.get(ids[0]);
    log('probe unit', JSON.stringify({ x: u.x / 1000, y: u.y / 1000, act: u.act, ord: u.ord && u.ord.type }), 'target', target % N, Math.floor(target / N));
    log('probe page', JSON.stringify(await page.evaluate((tx, tz, ux, uz) => {
      const R = window.__rts, T = R.world.trees, THREE_V = R.camera.position.constructor;
      const sc = (x, z) => { const v = new THREE_V(x, 0.5, z).project(R.camera); return [+((v.x * 0.5 + 0.5) * innerWidth).toFixed(0), +((0.5 - v.y * 0.5) * innerHeight).toFixed(0)]; };
      return { tile: sc(tx + 0.5, tz + 0.5), unit: sc(ux, uz), cam: R.camera.position.toArray().map((v) => +v.toFixed(2)), stats: T.stats && T.stats() };
    }, target % N, Math.floor(target / N), u.x / 1000, u.y / 1000)));
    log('probe items', JSON.stringify(await page.evaluate((tile) => { const W = window.__rts.world.trees.work; return (W.index.get(tile) || []).map((k) => { const it = W.items[k]; const sc = it[0], i = it[1]; return { x: +it[2].toFixed(2), z: +it[3].toFixed(2), s: +it[4].s.toFixed(2), id: it[4].id, alive: sc.alive[i], ready: sc.ready, mat: Array.from(sc.mats.slice(i * 16 + 12, i * 16 + 15)).map((v) => +v.toFixed(2)), n: sc.n, drawn: sc.drawn, lods: sc.lods, meshes: sc.meshes.map((a) => (a || []).length), smax: sc.smax[i], sy: sc.sy[i] }; }); }, target)));
  }
  const last = f === total - 1;
  if (f % shotEvery === 0 || (MODE === 'wide' && last)) {
    await page.screenshot({ path: path.join(OUT, `f${String(shot).padStart(3, '0')}.png`), type: 'png' });
    log(`shot ${shot} t=${(f / FPS).toFixed(2)}s tick ${g.t} ${MODE === 'close' ? 'wood ' + g.wood[target] : ''}`);
    shot++;
  }
  if (f % 200 === 199) log(`  frame ${f + 1}/${total}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
log('chop', JSON.stringify(await page.evaluate(() => [...window.__rts.world.trees.work.chop].map(([k, e]) => [k % 128, Math.floor(k / 128), e.hits.length, e.hits.slice(0, 8).map((h) => +h.toFixed(2)), +e.seen.toFixed(2)]))));
log('stats', JSON.stringify(await page.evaluate(() => (window.__rts.world.trees.stats ? window.__rts.world.trees.stats() : null))));
await browser.close(); srv.close();
log('done', shot, 'pictures in', OUT);
