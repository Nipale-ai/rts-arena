#!/usr/bin/env node
// Story cut of a match: cold open + intro + build-up + first contact + key decisions (freeze frames) + decisive fight + end + recap.
//   node tools/render-story.mjs <replay dir> [--target 300] [--out dir] [--preset x|yt|both] [--llm base,model[,key] | --llm-output answer.json]
//        [--voices casters-voice.json] [--stage plan|casters|all] [--story '<json of STORY overrides>'] [--limit-s N] [--from-s N] [--workers N (parallel chunks, one Chromium each)] [--class "32 GB"] [--crf 20] [--audio on|off] [--name story]
//        [--theme id [--theme-names classic]]   (a theme folder such as dustmoon-v1: picture, names in captions and voice, sound; default classic. --theme-names classic keeps the picture and
//        the sound of the theme but the classic names, for a script written and spoken with them. Every chunk of --workers gets both. tools/lib/theme-arg.mjs)
// stage plan: story plan + chapters only; casters: plus the casters track (prompt, checker, TTS manifest); all (default): voice mix, video, audio.
// The cold open is a second short clip (the climax at 1x) that is put in front of the main part; the voice track and the captions belong to the main part.
import '../server/local-env.mjs'; // RTS_* defaults from local-env.json
import { chunkArgs } from './lib/chunk-args.mjs';
import { resolveThemeArg, applyThemeArg } from './lib/theme-arg.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadReplay, enrichEvents } from './lib/replay.mjs';
import { computeEvents } from './events.mjs';
import { precheckStory } from './story-precheck.mjs';
import { createHash } from 'node:crypto';
import { computeHighlights } from './highlights.mjs';
import { buildStory } from './story.mjs';
import { timelineOf } from './plan.mjs';
import { makeCasterTrack, writeTrack, parseLlmArg } from './casters.mjs';
import { renderCut } from './render-broadcast.mjs';
import { Show } from './story-show.mjs';
import { spokenNames } from './overlay.mjs';

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
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || '').slice(-400)}`); return r; };

async function main() {
  const A = parseArgs(process.argv.slice(2));
  const src = A._[0];
  if (!src) { console.error('usage: node tools/render-story.mjs <replay dir> [--target 300] [--out dir] [--preset x|yt|both] [--llm base,model] [--voices casters-voice.json] [--stage plan|casters|all] [--theme id [--theme-names classic]] [--lod0] [--team-tint 0.5]'); process.exit(2); }
  try { os.setPriority(0, 10); } catch { /* nice */ }
  // --theme: a wrong id stops here, before the minutes of work; the theme is switched on below, after what belongs to the replay is written (events.json and highlights.json stay look-neutral)
  let themeArg;
  try { themeArg = await resolveThemeArg(A.theme, { names: A['theme-names'] }); } catch (e) { console.error(e.message); process.exit(2); }
  const rep = loadReplay(src);
  const ev = computeEvents(rep), hl = computeHighlights(ev);
  enrichEvents(rep, ev, JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'configs', 'creators.json'), 'utf8')).creators || {});
  if (!ev.verified.ok) console.error(`WARNING: re-simulation does not match the recorded hashes (tick ${ev.verified.first_mismatch_tick}).`);
  fs.writeFileSync(path.join(rep.dir, 'events.json'), JSON.stringify(ev));
  fs.writeFileSync(path.join(rep.dir, 'highlights.json'), JSON.stringify(hl));
  const { dirOpts } = applyThemeArg(themeArg, { log: console.log }); // picture (RTS_QUERY), words (active theme), sound (dirOpts of the two mixes below)
  // --lod0 (video): the best level of detail everywhere: riglod=0 (rigged units, render/units3d.mjs FORCE_LOD) and lodk=8 (every distance of the scatters of trees, rocks, props times 8, render/scatter.mjs). The chunks of --workers inherit RTS_QUERY. Without the flag nothing changes.
  // --team-tint N (video, 0..1): the body of a rigged unit is pushed N towards the hue of its team colour at the same brightness (render/units3d.mjs teamGain, page parameter teamtint). Without the flag nothing changes.
  if (A['team-tint'] && !/(^|&)teamtint=/.test(process.env.RTS_QUERY || '')) process.env.RTS_QUERY = [process.env.RTS_QUERY, `teamtint=${+A['team-tint'] || 0}`].filter(Boolean).join('&');
  if (A.lod0 && !/(^|&)riglod=/.test(process.env.RTS_QUERY || '')) process.env.RTS_QUERY = [process.env.RTS_QUERY, 'riglod=0', 'lodk=8'].filter(Boolean).join('&');
  console.log(`render flags: lod0=${A.lod0 ? 1 : 0} team-tint=${A['team-tint'] ?? 'off'} footer=${typeof A.footer === 'string' ? JSON.stringify(A.footer) : 'none'} workers=${A.workers ?? 1} teaser_s=${(typeof A.story === 'string' ? JSON.parse(A.story).teaser_s : undefined) ?? 'default'} inset=${/(^|&)inset=1/.test(process.env.RTS_QUERY || '') ? 'ON' : 'off'}`);
  const outDir = path.resolve(A.out || path.join(rep.dir, 'broadcast'));
  fs.mkdirSync(outDir, { recursive: true });
  const name = A.name || 'story';
  const target = +(A.target || 300);
  const { plan, teaser, story, stats } = buildStory(ev, hl, { target_s: target, story: typeof A.story === 'string' ? JSON.parse(A.story) : undefined }); // --story '{"cap":3,...}': overrides of the story parameters (tools/story.mjs STORY), e.g. a calmer cut
  fs.writeFileSync(path.join(outDir, `plan-${name}.json`), JSON.stringify(plan));
  const noTeaser = !teaser; // teaser_s 0: no cold open, no teaser sound
  if (teaser) fs.writeFileSync(path.join(outDir, `plan-${name}-teaser.json`), JSON.stringify(teaser));
  console.log(`story plan: ${story.total_s} s (cold open ${story.teaser_s} s + main ${story.main_s} s), ${story.units.length} freeze frames, ${JSON.stringify(stats.seconds_at_speed)} s at each speed, max ${stats.max_speed}x`);
  if (A.stage === 'plan') return;
  const cls = A.class === true ? '' : A.class || rep.start.class || '';
  const llm = typeof A.llm === 'string' ? parseLlmArg(A.llm) : null;
  const r = await makeCasterTrack({ ev, plan, cls, llm, llmOutput: typeof A['llm-output'] === 'string' ? A['llm-output'] : null, cacheDir: path.join(outDir, 'llm-cache'), seed: 0, rounds: +(A['casters-rounds'] || 2), fill: !A['no-fill'], log: console.log });
  const files = writeTrack(outDir, `${rep.id}-${name}`, r);
  let track = r.track, voiceWav = null;
  console.log(`casters: ${r.track.lines.length} lines (${r.track.generated.source}), ${r.track.cues.length} captions, dropped ${r.track.dropped.length}, ${r.track.stats.words_per_s} words/s, talk ${r.track.stats.talk_fraction}, longest gap ${r.track.stats.longest_gap_s} s -> ${files.json}`);
  if (typeof A.voices === 'string') {
    const vf = path.resolve(A.voices), v = JSON.parse(fs.readFileSync(vf, 'utf8')), cv = await import('./caster-voice.mjs');
    if (v.manifest.script_hash !== cv.scriptHash(r.tts.entries)) throw new Error(`--voices ${A.voices} was made for another script; run tools/caster-voice.mjs on ${files.tts}`);
    track = cv.applyVoices(r.track, v); voiceWav = path.join(path.dirname(vf), v.wav);
  }
  // "show what is said": every caster line gets the picture it talks about (camera, fog of war view, highlights); --show off renders the old cut
  const show = A.show === 'off' || !track.lines?.length ? null : new Show({ rep, ev, lines: track.lines, names: spokenNames(ev.players.map((p) => p.name)), plan, tl: timelineOf(plan), beats: track.beats, template: track.generated?.source === 'template' });
  for (const f of show?.panelsDropped || []) console.warn(`panel dropped ${f}`);
  // a panel that contradicts the line or runs ahead of the picture: never silently, and before the first frame
  if (show?.faults.length) { for (const f of show.faults) console.error(`SHOW FAULT ${f}`); process.exit(3); }
  // the real script and the real shots, before the voices and before the final: what can be measured stops here
  const writtenScript = track.generated?.source !== 'template';
  // hard stop (Koordinator 06.11.): a written script with a replaced line, a dropped template line or an invalid show tag never goes on, also not in a window render
  if (writtenScript) {
    const g = track.generated || {}, n = ['replaced', 'template_dropped', 'show_invalid'].map((k) => [k, (g[k] || []).length]).filter(([, c]) => c > 0);
    if (n.length) { console.error(`SCRIPT STOP: generated.${n.map(([k, c]) => `${k}=${c}`).join(', ')}: ${['replaced', 'template_dropped', 'show_invalid'].flatMap((k) => (g[k] || []).map((x) => `${k}: "${x.text}" ${x.reasons}`)).join(' | ')}`); process.exit(4); }
  }
  if (show && !A['from-s'] && !A['limit-s'] && !A.preview && !A['no-precheck']) {
    // a written script stops; the template of the public tool only warns (it has no one to fix it, and it drops what does not fit by itself)
    const pc = { strict: writtenScript, ...precheckStory({ ev, track, parts: show.parts, tl: timelineOf(plan), plan, story, target_s: target }) };
    fs.writeFileSync(path.join(outDir, `${rep.id}-${name}-precheck.json`), JSON.stringify(pc, null, 1));
    for (const f of pc.faults) console.error(`PRECHECK ${writtenScript ? 'FAULT' : 'note'} ${f}`);
    if (writtenScript && pc.faults.length) process.exit(4);
    console.log('precheck: no fault');
  }
  if (A.stage === 'casters') return;
  const preview = !!A.preview; // quick look: cold open + window, 30 fps, small, no audio
  const warmFrames = Math.round(+(A.warm ?? (A['from-s'] ? 5 : 0)) * +(A.fps || (preview ? 30 : 60))); // seconds of warm-up drawn before the first captured frame of a window (chunks)
  const fps = +(A.fps || (preview ? 30 : 60)), crf = +(A.crf || (preview ? 30 : 18)), limitS = A['limit-s'] ? +A['limit-s'] : Infinity, startS = A['from-s'] ? +A['from-s'] : 0;
  const partial = (Number.isFinite(limitS) || startS > 0) && !preview; // a dev render of a window: no cold open, no audio
  // a final only after a short draft of this very script (words and shots): the draft shows in a minute what a final shows in eight
  if (!partial && !preview && show && writtenScript) {
    const proof = path.join(rep.dir, 'story-draft.json'), sig = createHash('sha256').update(JSON.stringify(track.lines.map((l) => [l.text, l.show ?? null]))).digest('hex').slice(0, 16);
    if (fps <= 12) fs.writeFileSync(proof, JSON.stringify({ sig, name, at: new Date().toISOString() }));
    else if (!A['no-draft-check']) {
      let have = null; try { have = JSON.parse(fs.readFileSync(proof, 'utf8')).sig; } catch { /* no draft yet */ }
      if (have !== sig) { console.error(`NO DRAFT of this script: render one first (--fps 6 --crf 30 --audio off --name draft) and look at it, or pass --no-draft-check`); process.exit(5); }
    }
  }
  let wav = null;
  if (A.audio !== 'off' && !partial) {
    const { mixCutFromReplay } = await import('./audio-mix.mjs');
    const wm = (await mixCutFromReplay({ rep, ev, plan, tl: timelineOf(plan), track, voiceWav, dirOpts, outFile: path.join(outDir, `${rep.id}-${name}-audio-main.wav`), log: console.log })).file;
    const wt = noTeaser ? null : (await mixCutFromReplay({ rep, ev, plan: teaser, tl: timelineOf(teaser), track: null, voiceWav: null, dirOpts, outFile: path.join(outDir, `${rep.id}-${name}-audio-teaser.wav`), log: console.log })).file;
    wav = path.join(outDir, `${rep.id}-${name}-audio.wav`);
    if (noTeaser) fs.copyFileSync(wm, wav);
    else sh('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', wt, '-i', wm, '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', '-c:a', 'pcm_s24le', '-ar', '48000', wav]);
  }
  if (A['audio-only']) { console.log(`audio only: ${wav}`); return; } // c18: only the sound (new voice lines), no picture
  if (show && A['show-report']) fs.writeFileSync(path.join(outDir, `${rep.id}-${name}-show.json`), JSON.stringify({ lines: show.lineMap, parts: show.parts.map(({ line, key, o0, o1, cam, fog, tag, marks, versus, asOf, inset }) => ({ asOf, line, key, o0, o1, cam: cam && cam.k, fog, tag: tag && tag.text, marks: (marks || []).length, versus: !!versus, inset: !!inset })) }, null, 1));
  const presets = A.preset === 'x' ? ['x'] : A.preset === 'yt' ? ['yt'] : ['x', 'yt'];
  const results = [];
  for (const pr of presets) {
    const base = path.join(outDir, `${rep.id}-${name}-${pr}`);
    const common = { rep, ev, presetName: pr, cls, footer: A.footer === true ? '' : A.footer || '', fps, crf };
    let teaserFile = null, main;
    const workers = Math.max(1, +(A.workers || 1));
    if (!partial && workers > 1) {
      // parallel: the frames of the main part are split into chunks, each chunk is its own process (own headless Chromium) that simulates and directs from the start but only renders its frames;
      // the cold open is rendered by this process meanwhile. All chunks use the same encoder settings and start on a keyframe, so they are joined without re-encoding.
      const total = Math.ceil(plan.duration_s * fps), bounds = Array.from({ length: workers + 1 }, (_, i) => Math.round((i * total) / workers));
      const kids = [];
      for (let i = 0; i < workers; i++) {
        const cn = `${name}-w${i}`, args = [path.join(path.dirname(fileURLToPath(import.meta.url)), 'render-story.mjs'), src, '--target', String(target), '--out', outDir, '--preset', pr, '--fps', String(fps), '--crf', String(crf), '--name', cn, '--from-s', String((bounds[i] + 0.5) / fps), '--limit-s', String((bounds[i + 1] + 0.5) / fps)];
        args.push(...chunkArgs(A));
        if (i === 0) args[args.indexOf('--from-s') + 1] = '0';
        const file = path.join(outDir, `${rep.id}-${cn}-${pr}-main.mp4`);
        const p = new Promise((resolve, reject) => { const c = spawn('nice', ['-n', '10', process.execPath, ...args], { stdio: ['ignore', 'pipe', 'inherit'] }); let last = ''; c.stdout.on('data', (d) => { const t = String(d); const m = /frame (\d+)\/(\d+).*?([\d.]+) fps/.exec(t); if (m) last = `w${i} ${m[1]}/${m[2]} ${m[3]} fps`; }); c.on('exit', (code) => (code === 0 ? resolve(file) : reject(new Error(`chunk ${i} failed (${code})`)))); kids.push({ i, c, get last() { return last; } }); });
        kids[kids.length - 1].p = p;
      }
      const t0 = Date.now();
      const tick = setInterval(() => console.log(`  parallel ${((Date.now() - t0) / 1000).toFixed(0)} s: ${kids.map((k) => k.last).join(' | ')}`), 60000);
      if (!noTeaser) teaserFile = (await renderCut({ ...common, plan: teaser, outFile: `${base}-teaser.mp4` })).file;
      const files = await Promise.all(kids.map((k) => k.p)); clearInterval(tick);
      const list = `${base}-chunks.txt`; fs.writeFileSync(list, files.map((f) => `file '${f}'\n`).join(''));
      const joined = `${base}-main.mp4`;
      sh('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
      main = { file: joined, frames: total, seconds: total / fps, wall_s: (Date.now() - t0) / 1000 };
      console.log(`  parallel render of ${workers} chunks: ${main.wall_s.toFixed(0)} s wall for ${total} frames = ${(total / main.wall_s).toFixed(1)} fps overall`);
    } else {
      if (!partial && !noTeaser) teaserFile = (await renderCut({ ...common, plan: teaser, outFile: `${base}-teaser.mp4` })).file;
      main = await renderCut({ ...common, plan, outFile: `${base}-main.mp4`, limitS, startS, warmFrames, captions: track.cues ?? null, focus: track.focus ?? null, subjects: track.subjects ?? [], show });
    }
    let final = main.file;
    if (teaserFile) {
      const list = `${base}-concat.txt`;
      fs.writeFileSync(list, `file '${teaserFile}'\nfile '${main.file}'\n`);
      final = `${base}.mp4`;
      sh('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', final]);
      if (preview) { const sm = `${base}-preview.mp4`; sh('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', final, '-vf', 'scale=-2:720', '-c:v', 'libx264', '-preset', 'fast', '-crf', '30', '-an', sm]); final = sm; }
      if (wav) { const { muxAudio } = await import('./audio-mix.mjs'); muxAudio(final, wav); }
    }
    if (!teaserFile && noTeaser && !partial && !preview) { // no cold open: the show is the main part; picture and sound are joined here
      final = `${base}.mp4`; fs.copyFileSync(main.file, final);
      if (wav) { const { muxAudio } = await import('./audio-mix.mjs'); muxAudio(final, wav); }
    }
    results.push(final);
    console.log(`  -> ${final}`);
  }
  console.log(results.join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
