#!/usr/bin/env node
// Dev tool: run the director over a broadcast plan WITHOUT rendering (sim only, fast) and report how the camera behaves:
// hard cuts per minute, flights, subject coverage, smoothness (largest per-frame step), time scale ramps.
//   node tools/cam-report.mjs <replay dir> [--casters file-casters.json] [--target 80,100] [--preset x|yt] [--csv out.csv]
import fs from 'node:fs';
import { loadReplay } from './lib/replay.mjs';
import { prepare, PRESETS } from './render-broadcast.mjs';
import { timelineOf } from './plan.mjs';
import { Director, tallObjects } from './camera.mjs';
import { args as spectateArgs, Match } from '../server/spectate.mjs';

export async function camReport(dir, { casters = null, target = '80,100', preset = 'x', csv = null } = {}) {
  const rep = loadReplay(dir);
  const { ev, plans } = prepare(rep, { target });
  const plan = plans.highlight, tl = timelineOf(plan);
  spectateArgs.replay = rep.dir;
  const log = console.log; console.log = () => {};
  const match = new Match(); const init = match.initMsg(); console.log = log;
  const game = match.game;
  const track = casters ? JSON.parse(fs.readFileSync(casters, 'utf8')) : null;
  const P = PRESETS[preset];
  const d = new Director({ size: init.size, starts: init.starts, aspect: P.view[0] / P.view[1], scenes: plan.scenes, timeline: tl, events: ev.events, moments: plan.moments || [],
    focus: track?.focus ?? null, subjects: track?.subjects ?? [], tall: tallObjects(game), treeAt: (x, z) => { const ix = Math.floor(x), iz = Math.floor(z); return ix >= 0 && iz >= 0 && ix < game.W && iz < game.H && game.terrain[iz * game.W + ix] === 1; } });
  const fps = 60, total = Math.ceil(tl.duration_s * fps);
  const rows = []; let snap = null, prev = null, cuts = 0, maxStep = 0, maxAz = 0, maxDist = 0;
  const quiet = () => { console.log = () => {}; match.tick(); console.log = log; };
  for (let f = 0; f < total; f++) {
    const out = f / fps, tick = tl.tickAt(out), k = Math.min(Math.floor(tick), rep.endTick - 1);
    while (game.t < k + 1 && !game.over) quiet();
    snap = match.snapshot();
    const c = d.update(out, 1 / fps, snap);
    if (prev) {
      const step = Math.hypot(c.tx - prev.tx, c.tz - prev.tz) + Math.abs(c.dist - prev.dist) * 0.5;
      const da = Math.abs(((c.az - prev.az + Math.PI) % (2 * Math.PI)) - Math.PI);
      if (step > 6 || da > 0.25) { cuts++; rows.push({ out: +out.toFixed(2), cut: 1 }); } else { maxStep = Math.max(maxStep, step); maxAz = Math.max(maxAz, da); }
    }
    maxDist = Math.max(maxDist, c.dist);
    rows.push({ out: +out.toFixed(3), key: d.cur?.key, mode: d.mode, tx: +c.tx.toFixed(2), tz: +c.tz.toFixed(2), dist: +c.dist.toFixed(1), elev: +(90 - (c.pol * 180) / Math.PI).toFixed(1), az: +((c.az * 180) / Math.PI).toFixed(1), speed: +tl.speedAtOut(out).toFixed(2) });
    prev = c;
  }
  if (csv) fs.writeFileSync(csv, 'out,key,mode,tx,tz,dist,elev,az,speed\n' + rows.filter((r) => !r.cut).map((r) => [r.out, r.key, r.mode, r.tx, r.tz, r.dist, r.elev, r.az, r.speed].join(',')).join('\n'));
  const keys = rows.filter((r) => !r.cut); const sw = keys.filter((r, i) => i && r.key !== keys[i - 1].key).length;
  const el = keys.map((r) => r.elev);
  return { duration_s: tl.duration_s, hard_cuts: cuts, cuts_per_min: +((cuts * 60) / tl.duration_s).toFixed(2), shot_changes: sw, max_step_per_frame: +maxStep.toFixed(2), max_az_step_deg_per_frame: +((maxAz * 180) / Math.PI).toFixed(2), elev_range: [Math.min(...el), Math.max(...el)], max_dist: +maxDist.toFixed(0) };
}

if (process.argv[1] && process.argv[1].endsWith('cam-report.mjs')) {
  const a = process.argv.slice(2); const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  const r = await camReport(a[0], { casters: opt('--casters'), target: opt('--target') || '80,100', preset: opt('--preset') || 'x', csv: opt('--csv') });
  console.log(JSON.stringify(r, null, 1)); process.exit(0);
}
