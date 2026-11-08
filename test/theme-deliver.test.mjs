// tools/theme-deliver.mjs (package C7): a delivery (files + the work note PROVENANCE.json) goes into a theme folder as final assets with the six provenance fields
// and the sha256, as a fragment; all or nothing, never over a final file. Synthetic files in the temp folder.
// Run: nice -n 5 node --test test/theme-deliver.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deliver, planDelivery, kindOfPath, readNote, sixFields } from '../tools/theme-deliver.mjs';
import { assembleTheme } from '../tools/theme-assemble.mjs';
import { splitTheme } from '../tools/lib/theme-parts.mjs';
import { checkTheme, simCatalog } from '../tools/theme-check.mjs';
import { goodArcher, makeGlb, makeOgg, makePng, HOLE } from '../test-support/theme-glb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools/theme-deliver.mjs');
const CAT = simCatalog();
const tmp = (p = 'rts-deliver-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2)); };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const read = (f, enc) => fs.readFileSync(f, enc);
const FILES = goodArcher().files; // models/archer.glb (with the muzzle_anchor node), _lod1, _lod2, audio/archer_shot.ogg
const PROMPT = 'A lone settler with a long laser rifle and a teal backpack, ochre rust armour, white team patches.';

// the slice as it stands before the delivery: every file a placeholder; the fragments live in .parts/ so that theme-check can run on the folder
function slice() {
  const { theme } = goodArcher();
  const holes = { ...theme, assets: Object.fromEntries(Object.entries(theme.assets).map(([f, e]) => [f, HOLE(e.kind)])) };
  const dir = path.join(tmp(), 'testmoon-v1');
  for (const [rel, data] of splitTheme(holes)) put(path.join(dir, '.parts', rel), data);
  return dir;
}
const NOTE = () => ({
  defaults: { generator: 'Hunyuan3D', model_version: '2.1', licence_note: 'Tencent Hunyuan 3D 2.1 Community License (to verify)', credits: '3D mesh and texture: Hunyuan3D 2.1 (Tencent), seed 42, modified (decimated, re-baked, rigged)', reference: 'A2.png', job_id: 'job-1' },
  files: [
    { file: 'models/archer.glb', prompt_file: 'prompt-A.txt', seed: 42, date: '2026-11-05' },
    { file: 'models/archer_lod1.glb', prompt: 'derived from archer.glb: collapse decimate to 42 %', seed: 42 },
    { file: 'models/archer_lod2.glb', prompt: 'derived from archer.glb: collapse decimate to 17 %', seed: 42 },
    { file: 'audio/archer_shot.ogg', generator: 'tools/audio/make-theme-sounds.mjs', model_version: null, prompt: 'A short laser shot: a rising sine sweep with a noise burst, 0.4 s.', seed: null, licence_note: 'own code', credits: 'Sound: own code' },
  ],
});
function delivery({ files = FILES, note = NOTE(), name = 'arc-gunner-0311', extra = {} } = {}) {
  const dir = path.join(tmp(), name);
  for (const [rel, data] of Object.entries({ ...files, ...extra })) put(path.join(dir, rel), data);
  put(path.join(dir, 'prompt-A.txt'), `${PROMPT}\n`);
  if (note !== null) put(path.join(dir, 'PROVENANCE.json'), note); // note: null = a delivery without the work note
  return dir;
}
const fragmentOf = (themeDir, name) => JSON.parse(read(path.join(themeDir, '.parts/assets', `${name}.json`), 'utf8'));
const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });

test('the work note becomes the six fields: generator + model_version, the prompt text from prompt_file, licence_note as license, credits, seed, sha256 of the file', () => {
  const theme = slice(), src = delivery();
  const res = deliver(theme, src);
  assert.deepEqual(res.problems, []);
  assert.deepEqual(res.items.map((i) => `${i.action}:${i.file}`), ['copy:models/archer.glb', 'copy:models/archer_lod1.glb', 'copy:models/archer_lod2.glb', 'copy:audio/archer_shot.ogg']);
  const frag = fragmentOf(theme, 'arc_gunner_0311');
  assert.deepEqual(Object.keys(frag), ['assets']);
  assert.deepEqual(frag.assets['models/archer.glb'], {
    kind: 'model', status: 'final', generator: 'Hunyuan3D 2.1', prompt: PROMPT, seed: 42,
    license: 'Tencent Hunyuan 3D 2.1 Community License (to verify)', credits: '3D mesh and texture: Hunyuan3D 2.1 (Tencent), seed 42, modified (decimated, re-baked, rigged)', sha256: sha(FILES['models/archer.glb']),
  });
  const snd = frag.assets['audio/archer_shot.ogg'];
  assert.equal(snd.generator, 'tools/audio/make-theme-sounds.mjs', 'null model_version cancels the default');
  assert.equal(snd.seed, null);
  assert.equal(snd.license, 'own code');
  assert.equal(snd.kind, 'sound');
  assert.equal(frag.assets['models/archer_lod1.glb'].prompt, 'derived from archer.glb: collapse decimate to 42 %');
  for (const e of Object.values(frag.assets)) assert.deepEqual(Object.keys(e).sort(), ['credits', 'generator', 'kind', 'license', 'prompt', 'seed', 'sha256', 'status']);
  for (const [f, buf] of Object.entries(FILES)) assert.ok(read(path.join(theme, f)).equals(buf), `${f} was copied byte for byte`);
  assert.ok(read(path.join(src, 'models/archer.glb')).equals(FILES['models/archer.glb']), 'the delivery folder is untouched');
  assert.equal(res.wrote.length, 4);
  assert.equal(res.fragmentWritten, true);
});

test('after the delivery theme-assemble gives final assets, and theme-check passes on the folder', () => {
  const theme = slice();
  assert.equal(deliver(theme, delivery()).problems.length, 0);
  const a = assembleTheme(theme, { catalog: CAT, write: true });
  assert.equal(a.ok, true, JSON.stringify(a.errors) + a.problems);
  const out = JSON.parse(read(path.join(theme, 'theme.json'), 'utf8'));
  assert.deepEqual(Object.values(out.assets).map((e) => e.status), ['final', 'final', 'final', 'final']);
  assert.equal(a.lost.length, 0);
  const check = checkTheme(theme);
  assert.deepEqual(check.errors, []);
  assert.match(check.notes.map((n) => n.message).join('\n'), /4 assets: 4 final, 0 placeholder/);
});

test('`source` renames: the file in the delivery has another name than in the theme', () => {
  const theme = slice();
  const note = { files: [{ file: 'models/archer.glb', source: 'work/arc-gunner.glb', generator: 'Blender', prompt: 'hand-made from the concept', seed: null, license: 'own work', credits: 'Model: own work' }] };
  const src = delivery({ files: { 'work/arc-gunner.glb': FILES['models/archer.glb'] }, note });
  const res = deliver(theme, src);
  assert.deepEqual(res.problems, []);
  assert.ok(read(path.join(theme, 'models/archer.glb')).equals(FILES['models/archer.glb']));
  assert.equal(fragmentOf(theme, 'arc_gunner_0311').assets['models/archer.glb'].seed, null, 'hand-made work: seed null');
});

test('both shapes of the note work: a bare list of records and { files: { path: record } }', () => {
  const rec = { generator: 'g', prompt: 'p', seed: 1, license: 'l', credits: 'c' };
  assert.equal(readNote([{ file: 'a' }]).records.length, 1);
  assert.deepEqual(readNote({ files: { 'models/a.glb': { seed: 1 } }, defaults: { credits: 'c' } }), { records: [{ file: 'models/a.glb', seed: 1 }], defaults: { credits: 'c' } });
  assert.match(readNote({ nope: 1 }).problem, /list of records/);
  const theme = slice();
  const src = delivery({ files: { 'models/archer.glb': FILES['models/archer.glb'] }, note: [{ file: 'models/archer.glb', ...rec }] });
  assert.deepEqual(deliver(theme, src).problems, []);
  const theme2 = slice();
  const src2 = delivery({ files: { 'models/archer.glb': FILES['models/archer.glb'] }, note: { files: { 'models/archer.glb': rec } } });
  assert.deepEqual(deliver(theme2, src2).problems, []);
});

test('all or nothing: one wrong record and not a file is copied, not a fragment written; every problem is listed', () => {
  const theme = slice(), note = NOTE();
  delete note.files[1].prompt; // lod1: no prompt
  delete note.files[2].seed; // lod2: no seed key
  note.files[3].credits = ''; // sound: empty credits
  note.files.push({ file: 'models/Archer_Big.glb', prompt: 'x', seed: 1 }); // capital letters
  note.files.push({ file: 'models/other.glb', prompt: 'x', seed: 1 }); // the source is not there
  note.files.push({ file: 'readme.txt', prompt: 'x', seed: 1 }); // no kind
  const res = deliver(theme, delivery({ note }));
  const all = res.problems.join('\n');
  assert.match(all, /models\/archer_lod1\.glb: prompt missing/);
  assert.match(all, /models\/archer_lod2\.glb: seed missing \(an integer, or null for hand-made work\)/);
  assert.match(all, /audio\/archer_shot\.ogg: credits missing/);
  assert.match(all, /models\/Archer_Big\.glb: path must be a relative lower-case ASCII path/);
  assert.match(all, /models\/other\.glb: source file models\/other\.glb not found/);
  assert.match(all, /readme\.txt: no asset kind for this path/);
  assert.equal(fs.existsSync(path.join(theme, 'models')), false, 'nothing copied');
  assert.equal(fs.existsSync(path.join(theme, '.parts/assets/arc_gunner_0311.json')), false, 'no fragment');
  assert.equal(res.wrote.length, 0);
});

test('a delivery is checked for what it is: a glb needs triangles, an Ogg needs Opus, an atlas is a PNG; prompt and prompt_file are not both', () => {
  const theme = slice();
  const bad = { 'models/archer.glb': Buffer.from('not a glb at all'), 'audio/archer_shot.ogg': Buffer.from('OggS but nothing else'), 'models/archer_atlas.png': Buffer.from('plain text') };
  const rec = (file) => ({ file, generator: 'g', prompt: 'p', seed: 1, license: 'l', credits: 'c' });
  const res = deliver(theme, delivery({ files: bad, note: [rec('models/archer.glb'), rec('audio/archer_shot.ogg'), rec('models/archer_atlas.png'), { ...rec('models/archer_lod1.glb'), prompt_file: 'prompt-A.txt' }], extra: { 'models/archer_lod1.glb': FILES['models/archer_lod1.glb'] } }));
  const all = res.problems.join('\n');
  assert.match(all, /models\/archer\.glb: cannot read the file/);
  assert.match(all, /audio\/archer_shot\.ogg: not an Ogg file/);
  assert.match(all, /models\/archer_atlas\.png: not a PNG file/);
  assert.match(all, /models\/archer_lod1\.glb: give prompt or prompt_file, not both/);
  assert.match(deliver(theme, delivery({ note: [{ ...rec('models/archer.glb'), prompt: undefined, prompt_file: 'no-such-prompt.txt' }] })).problems.join(), /prompt_file no-such-prompt\.txt cannot be read/);
  const noOpus = Buffer.from(makeOgg(1)); noOpus.write('Vorbis!!', 28, 'latin1');
  assert.match(deliver(theme, delivery({ files: { 'audio/archer_shot.ogg': noOpus }, note: [rec('audio/archer_shot.ogg')] })).problems.join(), /Ogg file without an Opus stream/);
  const png = makePng(1024, 1024);
  assert.deepEqual(deliver(theme, delivery({ files: { 'models/archer_atlas.png': png }, note: [rec('models/archer_atlas.png')] })).problems, [], 'a PNG header is enough for the atlas');
});

test('a final file is never edited: a delivery that is in the theme already is "unchanged"; other bytes under a final name are refused; a different file in the folder is not overwritten', () => {
  const theme = slice(), src = delivery();
  assert.deepEqual(deliver(theme, src).problems, []);
  // the same delivery again, same fragment name: nothing to do (the entries are final and the bytes are the same)
  const same = deliver(theme, src);
  assert.deepEqual(same.problems, []);
  assert.deepEqual(same.items.map((i) => i.action), ['unchanged', 'unchanged', 'unchanged', 'unchanged']);
  assert.equal(same.fragmentWritten, false);
  assert.equal(same.wrote.length, 0);
  // other bytes under the name of a final file
  const other = delivery({ files: { ...FILES, 'models/archer.glb': makeGlb({ tris: 2300, height: 0.9, nodes: ['muzzle_anchor'] }) }, name: 'arc-gunner-v2' });
  const refused = deliver(theme, other);
  assert.match(refused.problems.join('\n'), /models\/archer\.glb: is final in the theme with another sha256 .*a final file is never edited, make a new theme version/);
  assert.ok(read(path.join(theme, 'models/archer.glb')).equals(FILES['models/archer.glb']), 'the final file is as it was');
  // a final entry whose file went missing is restored from the same bytes
  fs.renameSync(path.join(theme, 'models/archer_lod2.glb'), path.join(theme, 'models/archer_lod2.glb.moved'));
  const restored = deliver(theme, src);
  assert.deepEqual(restored.items.map((i) => i.action), ['unchanged', 'unchanged', 'restore', 'unchanged']);
  assert.ok(read(path.join(theme, 'models/archer_lod2.glb')).equals(FILES['models/archer_lod2.glb']));
  // a different file where a new file should go: not overwritten
  const theme2 = slice();
  put(path.join(theme2, 'models/archer.glb'), 'someone else was here');
  const clash = deliver(theme2, delivery());
  assert.match(clash.problems.join('\n'), /models\/archer\.glb: a different file is already in the theme folder .*not overwritten/);
  assert.equal(read(path.join(theme2, 'models/archer.glb'), 'utf8'), 'someone else was here');
  // the same bytes already there (copied by hand): only the entry is new
  const theme3 = slice();
  put(path.join(theme3, 'models/archer.glb'), FILES['models/archer.glb']);
  const adopt = deliver(theme3, delivery());
  assert.equal(adopt.items[0].action, 'adopt');
  assert.deepEqual(adopt.problems, []);
});

test('a fragment name that is taken by other content is refused (give --name); the name comes from the delivery folder', () => {
  const theme = slice();
  assert.deepEqual(deliver(theme, delivery({ name: 'Arc Gunner 0311!' })).problems, []);
  assert.ok(fs.existsSync(path.join(theme, '.parts/assets/arc_gunner_0311.json')), 'lower case, snake_case');
  const theme2 = slice();
  put(path.join(theme2, '.parts/assets/arc_gunner_0311.json'), { assets: {} });
  const res = deliver(theme2, delivery());
  assert.match(res.problems.join(), /assets\/arc_gunner_0311\.json exists with other content: give this delivery another --name/);
  assert.equal(fs.existsSync(path.join(theme2, 'models')), false, 'found before a file was copied');
  assert.deepEqual(deliver(theme2, delivery(), { name: 'again' }).problems, [], 'another name works');
  assert.ok(fs.existsSync(path.join(theme2, '.parts/assets/again.json')));
});

test('a dry run plans and checks, and writes nothing', () => {
  const theme = slice();
  const res = deliver(theme, delivery(), { dryRun: true });
  assert.deepEqual(res.problems, []);
  assert.equal(res.items.length, 4);
  assert.equal(fs.existsSync(path.join(theme, 'models')), false);
  assert.equal(fs.existsSync(path.join(theme, '.parts/assets/arc_gunner_0311.json')), false);
  assert.equal(res.fragmentWritten, false);
});

test('the theme must have fragments (the way to get them is named), and the fragments must not disagree', () => {
  const hand = path.join(tmp(), 'testmoon-v1');
  put(path.join(hand, 'theme.json'), goodArcher().theme);
  assert.match(deliver(hand, delivery()).problems.join(), /the theme has no fragments yet .*theme-assemble\.mjs testmoon-v1 --split once/);
  const theme = slice();
  put(path.join(theme, '.parts/clash.json'), { assets: { 'models/archer.glb': { ...HOLE('model'), generator: 'x' } } });
  assert.match(deliver(theme, delivery()).problems.join(), /the fragments of the theme disagree/);
  const broken = slice();
  put(path.join(broken, '.parts/broken.json'), '{ nope');
  assert.match(deliver(broken, delivery()).problems.join(), /broken\.json: not valid JSON/);
  assert.match(deliver(slice(), path.join(tmp(), 'no-delivery')).problems.join(), /does not exist/);
  assert.match(deliver(slice(), delivery({ note: null })).problems.join(), /PROVENANCE\.json does not exist|needs a PROVENANCE\.json/);
  assert.match(deliver(slice(), delivery({ note: [] })).problems.join(), /no record/);
});

test('--parts: the fragments may live outside the theme folder, which then holds only theme.json and the delivered files', () => {
  const { theme } = goodArcher();
  const holes = { ...theme, assets: Object.fromEntries(Object.entries(theme.assets).map(([f, e]) => [f, HOLE(e.kind)])) };
  const dir = path.join(tmp(), 'testmoon-v1'), parts = path.join(tmp(), 'myparts');
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, data] of splitTheme(holes)) put(path.join(parts, rel), data);
  assert.match(run(dir, delivery()).stdout, /the theme has no fragments yet/, 'without --parts the folder is searched in the theme folder only');
  const done = run(dir, delivery(), '--parts', parts, '--assemble');
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.ok(fs.existsSync(path.join(parts, 'assets/arc_gunner_0311.json')));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['audio', 'models', 'theme.json'], 'no fragments in the theme folder');
  assert.deepEqual(checkTheme(dir).errors, [], 'theme-check needs no change for this way');
  assert.equal(run(dir, delivery(), '--parts').status, 2);
});

test('the paths and kinds: folder and extension decide', () => {
  assert.equal(kindOfPath('models/archer.glb'), 'model');
  assert.equal(kindOfPath('models/archer_atlas.png'), 'atlas');
  assert.equal(kindOfPath('fx/archer_muzzle.png'), 'sprite');
  assert.equal(kindOfPath('textures/ground_grass_a.jpg'), 'texture');
  assert.equal(kindOfPath('audio/archer_shot.ogg'), 'sound');
  assert.equal(kindOfPath('concept/archer_a.webp'), 'concept');
  assert.equal(kindOfPath('audio/archer_shot.wav'), null);
  assert.equal(kindOfPath('archer.glb'), null);
  const f = sixFields({ generator: 'G', model_version: 'G 2.1 fp16', prompt: 'p', seed: 3, licence_note: 'L', credits: 'C' }, '.');
  assert.equal(f.fields.generator, 'G 2.1 fp16', 'nothing is said twice');
  assert.deepEqual(f.problems, []);
  assert.equal(sixFields({ generator: 'Hunyuan3D 2.1', model_version: '2.1', prompt: 'p', seed: 3, licence_note: 'L', credits: 'C' }, '.').fields.generator, 'Hunyuan3D 2.1');
  assert.equal(sixFields({ generator: 'Hunyuan3D', model_version: '2.1', prompt: 'p', seed: 3, licence_note: 'L', credits: 'C' }, '.').fields.generator, 'Hunyuan3D 2.1');
  assert.equal(sixFields({ generator: 'G', prompt: 'p', seed: 1.5, license: 'L', credits: 'C' }, '.').problems[0], 'seed must be an integer or null');
  assert.equal(sixFields({ generator: 'G', prompt: 'p', seed: 1, license: 'direct', credits: 'C' }, '.').fields.license, 'direct', 'license works as well as licence_note');
});

test('the command line: --dry-run, the real run, --assemble, usage errors, a refused delivery', () => {
  assert.equal(run().status, 2);
  assert.equal(run('a').status, 2);
  assert.equal(run(path.join(tmp(), 'nowhere'), tmp()).status, 2);
  const theme = slice(), src = delivery();
  const dry = run(theme, src, '--dry-run');
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /copy\s+models\/archer\.glb\s+model/);
  assert.match(dry.stdout, /dry run: nothing written/);
  const done = run(theme, src, '--assemble');
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /copied 4 file\(s\), wrote fragment/);
  assert.match(done.stdout, /4 assets \(4 final, 0 placeholder\)/);
  assert.ok(fs.existsSync(path.join(theme, 'theme.json')));
  assert.deepEqual(checkTheme(theme).errors, []);
  const note = NOTE(); delete note.files[0].seed;
  const bad = run(slice(), delivery({ note }));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /REFUSED models\/archer\.glb: seed missing/);
  assert.match(bad.stdout, /nothing done \(1 problem\(s\)\)/);
  const planOnly = planDelivery(slice(), delivery());
  assert.equal(planOnly.problems.length, 0);
  assert.equal(planOnly.fragment, 'assets/arc_gunner_0311.json');
});
