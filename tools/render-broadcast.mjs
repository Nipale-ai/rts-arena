#!/usr/bin/env node
// Frame-exact broadcast render from a replay. No screen recording: the sim is re-run deterministically in Node, every
// output frame (60 fps) is rendered by render/broadcast.html in headless Chrome, grabbed with puppeteer-core and piped
// into ffmpeg (libx264, MP4).
//   node tools/render-broadcast.mjs replays/<id> [--cut highlight|full|both] [--preset x|yt|both] [--out dir]
//        [--class "32 GB" (default: `class` of the match config, recorded in the replay; no label when absent)] [--footer "text"] [--fps 60] [--crf 16] [--limit-s N] [--from-tick N --to-tick N]
//        [--target 60,90]   (length range of the highlight cut in output seconds)
//        [--no-moments]   (no key-decision slow motion / explanation / fog of war view)
//        [--no-casters]   (no two-caster commentary track; default: casters.json + .srt + TTS manifest next to the video, captions burned in)
//        [--llm http://host:port/v1,model[,key]]   (writes the caster lines with this OpenAI-compatible model; default: template writer)
//        [--llm-output answer.json]   (play back a saved LLM answer instead of calling a model)  [--casters-seed N] [--casters-rounds N]
//        [--audio on|off]   (default on: deterministic sound mix from tools/audio-mix.mjs, muxed as AAC; loudness about -14 LUFS)
//        [--voices casters-voice.json]   (voice track from tools/caster-voice.mjs: mixed on top, ducking and captions follow its real line times; needs the same script)
//        [--cold-open S]   (highlight cut: S seconds of the climax at 1x in front, game sound only, the video opens on its strongest moment)
//        [--theme id]   (a test theme of render/theme/placeholder-themes.mjs or a theme folder such as dustmoon-v1: picture and sound; default classic)
//        [--plan plan.json]   (use a ready plan, e.g. one with forced 1x windows, instead of the automatic one; needs one --cut)
// Presets: x = 1080x1350 (4:5, class + model + hardware on top), yt = 1920x1080.
import { showFog } from './story-show.mjs';
import '../server/local-env.mjs'; // machine-local RTS_* defaults (local-env.json) before anything reads them
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadReplay, missingFlags } from './lib/replay.mjs';
import { computeEvents } from './events.mjs';
import { computeHighlights } from './highlights.mjs';
import { buildPlan, timelineOf, addSlowMotion } from './plan.mjs';
import { detectMoments } from './commentary.mjs';
import { Director, tallObjects } from './camera.mjs';
import { Overlay } from './overlay.mjs';
import { makeCasterTrack, writeTrack, parseLlmArg } from './casters.mjs';
import { args as spectateArgs, Match } from '../server/spectate.mjs';
import { chromePath, angleArgs, puppeteerDir } from './make-video.mjs';
import { themeById } from '../render/theme/placeholder-themes.mjs'; // test themes of the hooks
import { loadTheme } from '../render/theme/theme-loader.mjs'; // a real theme folder: render/assets/themes/<id>-vN
import { ShooterTable } from '../render/shooter-theme.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = path.join(ROOT, 'render');
export const PRESETS = { x: { w: 1080, h: 1350, view: [1080, 1030] }, yt: { w: 1920, h: 1080, view: [1920, 1080] } };
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary' };

function parseArgs(argv) {
  const A = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { A._.push(a); continue; }
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) A[a.slice(2)] = true; else { A[a.slice(2)] = n; i++; }
  }
  return A;
}

function staticServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const f = path.normalize(path.join(RENDER, decodeURIComponent(u.pathname)));
    if (!f.startsWith(RENDER + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

// Prepare event log, highlights and plans (written next to the replay).
// "the picture shows what is said" (BROADCAST-RULES.md, rule 1): every caster line gets its picture from its show tags, in every cut
export async function showLayer({ rep, ev, plan, track, off = false }) {
  if (off || !track?.lines?.length) return null;
  const { Show } = await import('./story-show.mjs');
  const { spokenNames } = await import('./overlay.mjs');
  const show = new Show({ rep, ev, lines: track.lines, names: spokenNames(ev.players.map((p) => p.name)), plan, tl: timelineOf(plan), beats: track.beats, template: track.generated?.source === 'template' });
  for (const f of show.panelsDropped) console.warn(`panel dropped ${f}`);
  if (show.faults.length) { for (const f of show.faults) console.error(`SHOW FAULT ${f}`); process.exit(3); } // same stop as the story cut: never a panel that contradicts the line
  return show;
}

export function prepare(rep, A = {}) {
  const ev = computeEvents(rep);
  const hl = computeHighlights(ev);
  const win = A['from-tick'] !== undefined || A['to-tick'] !== undefined ? [+(A['from-tick'] ?? 0), Math.min(ev.ticks, +(A['to-tick'] ?? ev.ticks))] : undefined;
  // the end screen needs time after the winner banner (banner 2.4 s, then the stats table for about 6 s)
  const params = ev.events.some((e) => e.type === 'victory') && (!win || win[1] >= ev.ticks) ? { tail_s: 10.5 } : {};
  // key decisions: slow motion + explanation + fog of war view (text only; a cut without LLM notes has none). Each costs up to
  // about 8 s of output, so the highlight cut is planned that much shorter first.
  const cand = A['no-moments'] ? [] : detectMoments(ev, { window: win, max: 10 }).sort((a, b) => b.score - a.score);
  const reserve = 13 * Math.min(2, cand.length);
  const tgt = typeof A.target === 'string' ? A.target.split(',').map(Number) : [60, 140];
  let plans = {
    highlight: buildPlan(ev, hl, { mode: 'highlight', window: win, params, target_s: [Math.max(20, tgt[0] - reserve), Math.max(30, tgt[1] - reserve)] }),
    full: buildPlan(ev, hl, { mode: 'full', window: win, params }),
  };
  if (cand.length) {
    plans = {
      highlight: addSlowMotion(plans.highlight, cand, { maxCount: 3, maxDuration: tgt[1] }),
      full: addSlowMotion(plans.full, cand, { maxCount: 8 }),
    };
  }
  return { ev, hl, plans };
}

// what player `pid` can see (2) or has explored (1), as the spectator page expects it
function fogMsg(game, pid) {
  const p = game.players[pid];
  const f = new Uint8Array(game.W * game.H);
  for (let i = 0; i < f.length; i++) f[i] = p.vis[i] ? 2 : p.expl[i] ? 1 : 0;
  return { p: pid, d: Buffer.from(f).toString('base64') };
}

export async function renderCut({ rep, ev, plan, presetName, outFile, cls = '', footer = '', fps = 60, crf = 16, limitS = Infinity, startS = 0, warmFrames = 0, captions = null, focus = null, subjects = [], show = null, page: pageHooks }) {
  const preset = PRESETS[presetName];
  const tl = timelineOf(plan);
  const layoutFaults = new Map(); // what a viewer must never see (render/layout-faults.mjs): text, time in the video
  // match / snapshot source (replay mode of the spectator server class, no HTTP)
  const names = rep.players;
  spectateArgs.replay = rep.dir;
  names.forEach((p, i) => { spectateArgs[`p${i + 1}-model`] = p.model; spectateArgs[`p${i + 1}-hw`] = p.hardware; if (p.creator) spectateArgs[`p${i + 1}-creator`] = p.creator; else delete spectateArgs[`p${i + 1}-creator`]; });
  const log = console.log;
  console.log = () => {};
  const match = new Match();
  const initMsg = match.initMsg();
  console.log = log;
  // a model without a recipe maker carries no flag in the video: never silently
  const noFlag = missingFlags(names, initMsg);
  if (noFlag.length) { console.error(`NO RECIPE MAKER FLAG for ${noFlag.map((p) => p.name).join(', ')}: set "creator" in players.json (configs/creators.json)`); process.exitCode = 3; }
  const game = match.game;
  const quietTick = () => { console.log = () => {}; match.tick(); console.log = log; };
  const advanceTo = (n) => { while (game.t < n && !game.over) quietTick(); };

  const director = new Director({ size: initMsg.size, starts: initMsg.starts, aspect: preset.view[0] / preset.view[1], scenes: plan.scenes, timeline: tl, events: ev.events, moments: plan.moments || [],
    // commentary coupling (w3-h): the camera goes to the subject of each caster line; trees block the view (forest tiles of the map)
    // relic shrines must not loom in front of the lens (they stand about twice as high as a tree)
    focus, subjects, show, tall: tallObjects(game), treeAt: (x, z) => { const ix = Math.floor(x), iz = Math.floor(z); return ix >= 0 && iz >= 0 && ix < game.W && iz < game.H && game.terrain[iz * game.W + ix] === 1; } });
  const overlay = new Overlay({ events: ev.events, timeline: tl, players: initMsg.players, moments: plan.moments || [], ev, captions, story: plan.story ? plan : null });

  const { srv, port } = await staticServer();
  const NM = puppeteerDir();
  const puppeteer = createRequire(import.meta.url)(path.join(NM, 'puppeteer-core'));
  const browser = await puppeteer.launch({
    executablePath: chromePath(), headless: 'new',
    args: [...angleArgs(), '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--no-sandbox', '--force-device-scale-factor=1', '--disable-renderer-backgrounding', `--window-size=${preset.w},${preset.h}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: preset.w, height: preset.h, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  // a chunk of a parallel render that cannot load the rigged units must not go on with the old procedural figures (box bodies, cone heads): load the page again, then stop
  for (let attempt = 1; ; attempt++) {
    await page.goto(`http://127.0.0.1:${port}/broadcast.html?capture=1&preset=${presetName}${process.env.RTS_QUERY ? "&" + process.env.RTS_QUERY : ""}`, { waitUntil: 'load' });
    await page.waitForFunction('window.__bcReady === true', { timeout: 30000 });
    try { await page.evaluate((m, c) => window.__bc.setup(m, c), initMsg, { cls, footer, story: !!plan.story }); break; } catch (e) {
      console.error(`[render] page setup failed, attempt ${attempt} of 3: ${String(e.message).split('\n')[0].slice(0, 300)}`);
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
  if (pageHooks) await pageHooks(page);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmpOut = outFile + '.part.mp4';
  const ff = spawn('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', 'pipe:0',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-r', String(fps), '-movflags', '+faststart', tmpOut], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((resolve, reject) => { ff.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`)))); ff.stdin.on('error', () => {}); });

  const total = Math.min(Math.ceil(tl.duration_s * fps), Math.floor(limitS * fps));
  const renderStart = Math.floor(startS * fps); // dev: frames before this are simulated and directed but not rendered
  const pageStart = Math.max(0, renderStart - warmFrames); // chunk of a parallel render: the page runs warmFrames frames (smoke, fades, labels, animations) before the first frame that is captured
  let needInit = pageStart > 0;
  const endTick = rep.endTick;
  let first = true, lastSnap = null, fogSent = { p: 0, t: -1 };
  // A snapshot hands out the trees and resource nodes that ran out only once. Frames before the page starts (a chunk) still take snapshots (the director needs them),
  // so what they list is kept here and given to the page with its first snapshot: the trees and bushes that went before the chunk stand as stumps / are gone, as in a serial render.
  const gone = { tg: [], ng: [] };
  const t0 = performance.now();
  for (let f = 0; f < total; f++) {
    const out = f / fps;
    const tick = tl.tickAt(out);
    const k = Math.min(Math.floor(tick), endTick - 1);
    const alpha = Math.min(1, tick - k);
    const snaps = [];
    if (first) { advanceTo(k); snaps.push(match.snapshot()); first = false; }
    else if (game.t < k) { advanceTo(k); snaps.push(match.snapshot()); }
    if (game.t < k + 1) { advanceTo(k + 1); snaps.push(match.snapshot()); }
    if (snaps.length) lastSnap = snaps[snaps.length - 1];
    const cam = director.update(out, 1 / fps, lastSnap);
    const ui = overlay.at(out, tick);
    if (show) { // story "show" layer: the picture of the line that is spoken now (fog of war view of one player, highlights, comparison bars, what a model saw)
      const sh = show.at(out, lastSnap, game);
      ui.show = sh;
      ui.fog = showFog(sh); // always, also between two lines: the overlay's own key-decision fog must never come through
    }
    if (f < pageStart) { for (const sn of snaps) { if (sn.tg) gone.tg.push(...sn.tg); if (sn.ng) gone.ng.push(...sn.ng); } continue; }
    if (needInit) {
      needInit = false;
      if (!snaps.length) { const sn = match.snapshot(); snaps.push(sn, sn); } else if (snaps.length === 1) snaps.unshift(snaps[0]);
      const s0 = snaps[0];
      if (gone.tg.length) s0.tg = [...gone.tg, ...(s0.tg || [])];
      if (gone.ng.length) s0.ng = [...gone.ng, ...(s0.ng || [])];
    }
    // fog of war view of the deciding player (key decisions): the map data is pushed when the tick or the player changes
    let fog = null;
    if (ui.fog && ui.fog.a > 0) {
      fog = { p: ui.fog.p, a: ui.fog.a, data: null };
      if (fogSent.p !== ui.fog.p || fogSent.t !== game.t) { fog.data = fogMsg(game, ui.fog.p); fogSent = { p: ui.fog.p, t: game.t }; }
    }
    await page.evaluate((fr) => window.__bc.frame(fr), { snaps, alpha, animT: out, dt: 1 / fps, cam, ui, fog });
    if (f % fps === 0) for (const x of await page.evaluate(() => window.__bc.faults())) if (!layoutFaults.has(x)) layoutFaults.set(x, +out.toFixed(1));
    if (process.env.RTS_CAMLOG) { // dev: director pose and the final pose after the page-side ground clamp, one line per frame
      const fin = await page.evaluate(() => { const c = window.__rts.camera; return { y: +c.position.y.toFixed(2), x: +c.position.x.toFixed(2), z: +c.position.z.toFixed(2), fov: c.fov }; });
      fs.appendFileSync(process.env.RTS_CAMLOG, JSON.stringify({ f, out: +out.toFixed(3), mode: cam.mode, cam: Object.fromEntries(Object.entries(cam).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v])), fin }) + '\n');
    }
    if (f < renderStart) continue; // warm-up frame: drawn, not captured
    const png = await page.screenshot({ type: 'png', optimizeForSpeed: true });
    if (process.env.RTS_DUMP && f < 12) fs.writeFileSync(path.join(process.env.RTS_DUMP, path.basename(outFile, '.mp4') + '-' + f + '.png'), png); // dev: raw frames for diffing
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % 300 === 299) {
      const el = (performance.now() - t0) / 1000;
      log(`  ${presetName} ${path.basename(outFile)}: frame ${f + 1}/${total} (${(((f + 1) / total) * 100).toFixed(0)}%), ${((f + 1 - renderStart) / el).toFixed(1)} fps, game ${(tick / 10).toFixed(0)}s, ${ui.badge.speed.toFixed(1)}x`);
    }
  }
  ff.stdin.end();
  await ffDone;
  await browser.close();
  srv.close();
  fs.renameSync(tmpOut, outFile);
  if (layoutFaults.size) { console.error(`LAYOUT FAULTS in ${path.basename(outFile)}:`); for (const [x, t] of layoutFaults) console.error(`  ${t} s: ${x}`); process.exitCode = 3; }
  return { file: outFile, frames: total - renderStart, seconds: (total - renderStart) / fps, wall_s: +((performance.now() - t0) / 1000).toFixed(1) };
}

async function main() {
  const A = parseArgs(process.argv.slice(2));
  const src = A._[0];
  if (!src) { console.error('usage: node tools/render-broadcast.mjs replays/<id> [--cut highlight|full|both] [--preset x|yt|both] [--out dir] [--class "32 GB"] [--limit-s N]'); process.exit(2); }
  try { os.setPriority(0, 10); } catch { /* nice -n 10 */ }
  // --theme <id> (a test theme of render/theme/placeholder-themes.mjs or a theme folder like dustmoon-v1): the page gets ?theme=<id> (picture) and the sound director its shooter table (sound). Without it nothing changes.
  let dirOpts = {};
  if (A.theme) {
    let th = themeById(A.theme);
    if (!th) { try { th = await loadTheme(A.theme); } catch (e) { console.error(`theme "${A.theme}": ${e.message}`); process.exit(2); } }
    process.env.RTS_QUERY = [process.env.RTS_QUERY, `theme=${encodeURIComponent(A.theme)}`].filter(Boolean).join('&');
    dirOpts = { shooters: new ShooterTable(th) };
  }
  const rep = loadReplay(src);
  const { ev, hl, plans } = prepare(rep, A);
  if (!ev.verified.ok) console.error(`WARNING: re-simulation does not match the recorded hashes (tick ${ev.verified.first_mismatch_tick}).`);
  if (typeof A.plan === 'string') {
    const cut = A.cut === 'full' ? 'full' : 'highlight';
    plans[cut] = JSON.parse(fs.readFileSync(A.plan, 'utf8'));
    A.cut = cut;
  }
  const outDir = path.resolve(A.out || path.join(rep.dir, 'broadcast'));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(rep.dir, 'events.json'), JSON.stringify(ev));
  fs.writeFileSync(path.join(rep.dir, 'highlights.json'), JSON.stringify(hl));
  fs.writeFileSync(path.join(outDir, 'plan-highlight.json'), JSON.stringify(plans.highlight));
  fs.writeFileSync(path.join(outDir, 'plan-full.json'), JSON.stringify(plans.full));
  const cuts = A.cut === 'highlight' ? ['highlight'] : A.cut === 'full' ? ['full'] : ['highlight', 'full'];
  const presets = A.preset === 'x' ? ['x'] : A.preset === 'yt' ? ['yt'] : ['x', 'yt'];
  const tracks = {}, voiceFiles = {};
  for (const cut of cuts) {
    if (A['no-casters']) continue;
    const cls = A.class === true ? '' : A.class || rep.start.class || '';
    const llm = typeof A.llm === 'string' ? parseLlmArg(A.llm) : null;
    const r = await makeCasterTrack({ ev, plan: plans[cut], cls, llm, llmOutput: typeof A['llm-output'] === 'string' ? A['llm-output'] : null, cacheDir: path.join(outDir, 'llm-cache'), seed: +(A['casters-seed'] || 0), fill: !A['no-fill'], rounds: +(A['casters-rounds'] || 2), log: console.log });
    const files = writeTrack(outDir, `${rep.id}-${cut}`, r);
    tracks[cut] = r.track;
    if (typeof A.voices === 'string') { // real line times of the voice track: ducking, captions and the mix follow them
      const vf = path.resolve(A.voices), v = JSON.parse(fs.readFileSync(vf, 'utf8')), cv = await import('./caster-voice.mjs');
      if (v.manifest.script_hash !== cv.scriptHash(r.tts.entries)) throw new Error(`--voices ${A.voices} was made for another script (text or voices differ); run tools/caster-voice.mjs on ${files.tts}`);
      tracks[cut] = cv.applyVoices(r.track, v); voiceFiles[cut] = path.join(path.dirname(vf), v.wav);
    }
    console.log(`casters ${cut}: ${r.track.lines.length} lines (${r.track.generated.source}), ${r.track.cues.length} captions, dropped ${r.track.dropped.length} -> ${files.json}`);
  }
  const audioFiles = {}; // SOUND: one mix per cut (the same sound for both presets), written as WAV next to the video and muxed after the render
  if (A.audio !== 'off') {
    const { mixCutFromReplay } = await import('./audio-mix.mjs');
    for (const cut of cuts) audioFiles[cut] = (await mixCutFromReplay({ rep, ev, plan: plans[cut], tl: timelineOf(plans[cut]), track: tracks[cut] || null, voiceWav: voiceFiles[cut] || null, dirOpts, outFile: path.join(outDir, `${rep.id}-${cut}-audio.wav`), limitS: A['limit-s'] ? +A['limit-s'] : Infinity, log: console.log })).file;
  }
  for (const cut of cuts) for (const pr of presets) {
    const plan = plans[cut];
    console.log(`render ${cut} / ${pr}: ${plan.duration_s.toFixed(1)} s output (${plan.selected_scenes.length} scenes at 1x, max ${plan.stats.max_speed}x)`);
    const outFile = path.join(outDir, `${rep.id}-${cut}-${pr}.mp4`), common = { rep, ev, presetName: pr, cls: A.class === true ? '' : A.class || rep.start.class || '', footer: A.footer === true ? '' : A.footer || '', fps: +(A.fps || 60), crf: +(A.crf || 16) };
    const coldS = cut === 'highlight' && A['cold-open'] ? +A['cold-open'] : 0;
    const mainFile = coldS ? outFile.replace(/\.mp4$/, '-main.mp4') : outFile;
    const show = await showLayer({ rep, ev, plan, track: tracks[cut], off: A.show === 'off' });
    const r = await renderCut({ ...common, plan, outFile: mainFile, limitS: A['limit-s'] ? +A['limit-s'] : Infinity, captions: tracks[cut]?.cues ?? null, focus: tracks[cut]?.focus ?? null, subjects: tracks[cut]?.subjects ?? [], show });
    let audio = audioFiles[cut];
    if (coldS) { // the climax in front: its own clip with game sound only, joined without re-encoding
      const { coldOpenPlan } = await import('./story.mjs');
      const cold = coldOpenPlan(ev, hl, { seconds: coldS, pre_s: coldS * 0.65 });
      cold.story = { teaser: true, no_bar: true, teaser_s: coldS, total_s: coldS, chapters: [], units: [], offset_s: 0 };
      const coldFile = outFile.replace(/\.mp4$/, '-cold.mp4');
      await renderCut({ ...common, plan: cold, outFile: coldFile });
      const list = outFile.replace(/\.mp4$/, '-concat.txt');
      fs.writeFileSync(list, `file '${coldFile}'\nfile '${mainFile}'\n`);
      spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outFile], { stdio: 'inherit' });
      if (audio) {
        const { mixCutFromReplay } = await import('./audio-mix.mjs');
        const wc = (await mixCutFromReplay({ rep, ev, plan: cold, tl: timelineOf(cold), track: null, voiceWav: null, dirOpts, outFile: outFile.replace(/\.mp4$/, '-audio-cold.wav'), log: console.log })).file;
        const joined = outFile.replace(/\.mp4$/, '-audio-joined.wav');
        spawnSync('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', wc, '-i', audio, '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', '-c:a', 'pcm_s24le', '-ar', '48000', joined], { stdio: 'inherit' });
        audio = joined;
      }
      r.file = outFile;
    }
    if (audio) (await import('./audio-mix.mjs')).muxAudio(r.file, audio);
    console.log(`  -> ${r.file}: ${r.frames} frames, ${r.seconds.toFixed(1)} s, wall ${r.wall_s} s`);
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
