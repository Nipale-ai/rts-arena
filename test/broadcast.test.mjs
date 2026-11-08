import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadReplay } from '../tools/lib/replay.mjs';
import { prepare, renderCut, PRESETS } from '../tools/render-broadcast.mjs';
import { scriptedReplay } from '../test-support/replays.mjs';
import { hasChrome, hasPuppeteer } from '../tools/make-video.mjs';

const can = hasChrome() && hasPuppeteer() && (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames,r_frame_rate,pix_fmt', '-of', 'json', f])).streams[0];
const frameHashes = (f) => execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', f, '-f', 'framemd5', '-'], { encoding: 'utf8' }).split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());

test('broadcast: frame-exact render (both presets, deterministic, right size and frame count)', { skip: !can && 'needs Google Chrome, puppeteer-core and ffmpeg', timeout: 240000 }, async () => {
  const dir = scriptedReplay(['rush', 'boom'], 3);
  const rep = loadReplay(dir);
  const { ev, plans } = prepare(rep);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-bc-render-'));
  const files = {};
  for (const pr of ['x', 'yt']) {
    const r = await renderCut({ rep, ev, plan: plans.highlight, presetName: pr, outFile: path.join(out, `a-${pr}.mp4`), cls: '32 GB', fps: 12, crf: 28, limitS: 1.5 });
    assert.equal(r.frames, 18);
    files[pr] = r.file;
    const p = probe(r.file);
    assert.equal(p.width, PRESETS[pr].w);
    assert.equal(p.height, PRESETS[pr].h);
    assert.equal(p.pix_fmt, 'yuv420p');
    assert.equal(+p.nb_read_frames, 18);
  }
  // same input, same pixels
  const again = await renderCut({ rep, ev, plan: plans.highlight, presetName: 'x', outFile: path.join(out, 'b-x.mp4'), cls: '32 GB', fps: 12, crf: 28, limitS: 1.5 });
  assert.deepEqual(frameHashes(again.file), frameHashes(files.x));
  // the frames differ over time (the picture is not frozen)
  assert.ok(new Set(frameHashes(files.x)).size > 10);
});
