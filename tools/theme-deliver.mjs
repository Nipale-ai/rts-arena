#!/usr/bin/env node
// Delivers finished files into a theme folder (package C7, step S12b of ASSET-AUFTRAG-ARC-GUNNER.md): copies them, computes the sha256 and turns the work note
// PROVENANCE.json of the delivery into the six provenance fields of the contract (THEME-VERTRAG.md 3.2) as a fragment parts/assets/<name>.json. theme.json
// itself is not touched: node tools/theme-assemble.mjs builds it from the fragments (--assemble does that in the same go).
//   node tools/theme-deliver.mjs <theme-id | folder> <delivery folder | PROVENANCE.json> [--name <fragment name>] [--parts <dir>] [--dry-run] [--assemble]
// PROVENANCE.json (work note, one record per file; sources and prompt files are read relative to the note) -> six fields:
//   generator = generator + model_version      prompt = prompt, or the text of prompt_file (for sounds made by code: the recipe)
//   seed = seed (null only for hand-made work; the key must be there)      license = licence_note (or license)      credits = credits      sha256 = of the file
//   `file` is the target path inside the theme folder (models/archer.glb); `source` (optional) is the file in the delivery when it has another name.
//   reference, settings, date, job_id, modified_by and any other field stay in the work note. Shapes: a list of records, or { defaults: {...}, files: [...] }.
// All or nothing: every record is checked first, nothing is copied when one is wrong. Files are copied, never moved or overwritten (a final file is never edited:
// another file under the same name is an error, make a new theme version). Run again with the same files: nothing changes.
// Exit code 0 = delivered (or --dry-run: would deliver), 1 = refused, 2 = usage error.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ASSET_KINDS, pathProblem } from '../render/theme/theme-schema.mjs';
import { THEMES_DIR } from './theme-check.mjs';
import { glbStats, pngSize, imageSize, oggInfo } from './lib/glb-stats.mjs';
import { resolvePartsDir, readParts, mergeParts } from './lib/theme-parts.mjs';
import { main as assembleMain } from './theme-assemble.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// the manifest kind of a target path: the folder and the extension decide (models/x.glb = model, models/x.png = atlas, audio/x.ogg = sound ...)
export function kindOfPath(file) {
  return Object.entries(ASSET_KINDS).find(([, k]) => typeof file === 'string' && file.startsWith(k.dir) && k.exts.some((e) => file.endsWith(e)))?.[0] || null;
}

// the work note in its two shapes -> { records, defaults } or a problem text
export function readNote(json) {
  if (Array.isArray(json)) return { records: json, defaults: {} };
  if (isObj(json) && Array.isArray(json.files)) return { records: json.files, defaults: isObj(json.defaults) ? json.defaults : {} };
  if (isObj(json) && isObj(json.files)) return { records: Object.entries(json.files).map(([file, r]) => ({ file, ...(isObj(r) ? r : {}) })), defaults: isObj(json.defaults) ? json.defaults : {} };
  return { problem: 'PROVENANCE.json must be a list of records or { "defaults": {...}, "files": [...] }' };
}

// one work note record -> { fields: { generator, prompt, seed, license, credits }, problems }
export function sixFields(r, base) {
  const problems = [];
  let generator = text(r.generator);
  const version = text(r.model_version);
  if (!generator) problems.push('generator missing');
  else if (version && !generator.includes(version)) generator = version.includes(generator) ? version : `${generator} ${version}`; // "Hunyuan3D" + "2.1" = "Hunyuan3D 2.1"; nothing is said twice
  let prompt = text(r.prompt);
  if (prompt && r.prompt_file !== undefined) problems.push('give prompt or prompt_file, not both');
  else if (!prompt && r.prompt_file !== undefined) {
    try { prompt = text(fs.readFileSync(path.resolve(base, String(r.prompt_file)), 'utf8')); } catch (e) { problems.push(`prompt_file ${r.prompt_file} cannot be read (${e.code || e.message})`); }
    if (!prompt && !problems.length) problems.push(`prompt_file ${r.prompt_file} is empty`);
  } else if (!prompt) problems.push('prompt missing (the prompt text, or prompt_file; for a sound made by code the recipe)');
  if (!('seed' in r)) problems.push('seed missing (an integer, or null for hand-made work)');
  else if (r.seed !== null && !Number.isInteger(r.seed)) problems.push('seed must be an integer or null');
  const license = text(r.licence_note) || text(r.license);
  if (!license) problems.push('licence_note missing (what licence the file is under, or "to verify")');
  const credits = text(r.credits);
  if (!credits) problems.push('credits missing (the credit line)');
  return { fields: { generator, prompt, seed: 'seed' in r ? r.seed : undefined, license, credits }, problems };
}

// does the file have the container format its kind needs? (the real checks of size, triangles and the like are node tools/theme-check.mjs)
function formatProblem(kind, f) {
  try {
    if (kind === 'model') { const st = glbStats(f); return st.empty ? 'the glb has no triangles' : null; }
    if (kind === 'atlas' || kind === 'sprite') return pngSize(f) ? null : 'not a PNG file';
    if (kind === 'texture' || (kind === 'concept' && !f.endsWith('.webp'))) return imageSize(f) ? null : 'not a PNG or JPEG file';
    if (kind === 'sound') { const o = oggInfo(f); return !o ? 'not an Ogg file' : !o.opus ? 'Ogg file without an Opus stream' : null; }
  } catch (e) { return `cannot read the file (${e.message})`; }
  return null;
}

// Checks a delivery against the theme and plans what to copy. Nothing is written.
//   -> { items: [{ file, kind, src, dst, bytes, sha256, action, entry }], problems, base, partsDir, fragment }
//   action: copy (new file), adopt (the same bytes are there, only the entry is new), unchanged (final and the same), restore (final entry, file missing)
export function planDelivery(themeDir, noteArg, { name = null, partsDir = null } = {}) {
  const dir = path.resolve(themeDir), plan = { items: [], problems: [], base: null, partsDir: null, fragment: null };
  const notePath = fs.existsSync(noteArg) && fs.statSync(noteArg).isDirectory() ? path.join(noteArg, 'PROVENANCE.json') : noteArg;
  if (!fs.existsSync(notePath)) { plan.problems.push(`${notePath} does not exist (a delivery folder needs a PROVENANCE.json)`); return plan; }
  plan.base = path.dirname(path.resolve(notePath));
  let note;
  try { note = readNote(JSON.parse(fs.readFileSync(notePath, 'utf8'))); } catch (e) { plan.problems.push(`${notePath}: not valid JSON (${e.message})`); return plan; }
  if (note.problem) { plan.problems.push(note.problem); return plan; }
  if (!note.records.length) { plan.problems.push('PROVENANCE.json has no record'); return plan; }

  const pd = partsDir ? { dir: path.resolve(partsDir), exists: fs.existsSync(partsDir), problem: null } : resolvePartsDir(dir);
  plan.partsDir = pd.dir;
  if (pd.problem) { plan.problems.push(pd.problem); return plan; }
  const read = pd.exists ? readParts(pd.dir) : { fragments: [], problems: [] };
  if (read.problems.length) { plan.problems.push(...read.problems); return plan; }
  if (!read.fragments.length) { plan.problems.push(`the theme has no fragments yet (${pd.dir}): run node tools/theme-assemble.mjs ${path.basename(dir)} --split once, then deliver`); return plan; }
  const merged = mergeParts(read.fragments);
  if (merged.conflicts.length || merged.problems.length) { plan.problems.push('the fragments of the theme disagree; fix that first (node tools/theme-assemble.mjs --dry-run shows it)'); return plan; }
  const have = isObj(merged.theme.assets) ? merged.theme.assets : {};

  const frag = (name || path.basename(plan.base)).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!frag) { plan.problems.push('cannot make a fragment name from the delivery folder: give --name'); return plan; }
  plan.fragment = `assets/${frag}.json`;

  const seen = new Map();
  note.records.forEach((rec, i) => {
    const r = { ...note.defaults, ...(isObj(rec) ? rec : {}) }, label = typeof r.file === 'string' ? r.file : `record ${i + 1}`;
    const bad = (m) => plan.problems.push(`${label}: ${m}`);
    if (!isObj(rec)) return bad('is not an object');
    if (typeof r.file !== 'string') return bad('file missing (the target path inside the theme folder, like models/archer.glb)');
    const kind = typeof r.kind === 'string' ? r.kind : kindOfPath(r.file);
    if (!kind || !ASSET_KINDS[kind]) return bad(`no asset kind for this path (${Object.entries(ASSET_KINDS).map(([k, v]) => `${k}: ${v.dir}*${v.exts.join('|')}`).join(', ')})`);
    const pp = pathProblem(r.file, kind);
    if (pp) return bad(`path ${pp}`);
    if (seen.has(r.file)) return bad(`listed twice (records ${seen.get(r.file)} and ${i + 1})`);
    seen.set(r.file, i + 1);
    const six = sixFields(r, plan.base);
    for (const p of six.problems) bad(p);
    const src = path.resolve(plan.base, typeof r.source === 'string' ? r.source : r.file);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return bad(`source file ${path.relative(plan.base, src) || src} not found`);
    const fp = formatProblem(kind, src);
    if (fp) bad(fp);
    if (six.problems.length || fp) return;
    const sha = sha256File(src), dst = path.join(dir, r.file), cur = have[r.file], there = fs.existsSync(dst);
    const sameThere = there && fs.statSync(dst).isFile() && sha256File(dst) === sha;
    let action;
    if (cur?.status === 'final') {
      if (cur.sha256 !== sha) return bad(`is final in the theme with another sha256 (${String(cur.sha256).slice(0, 12)}... there, ${sha.slice(0, 12)}... here): a final file is never edited, make a new theme version`);
      action = sameThere ? 'unchanged' : there ? null : 'restore';
      if (!action) return bad('the final entry matches the delivery but a different file lies in the theme folder');
    } else if (there && !sameThere) return bad(`a different file is already in the theme folder (${r.file}): not overwritten`);
    else action = there ? 'adopt' : 'copy';
    plan.items.push({ file: r.file, kind, src, dst, bytes: fs.statSync(src).size, sha256: sha, action, entry: { kind, status: 'final', generator: six.fields.generator, prompt: six.fields.prompt, seed: six.fields.seed, license: six.fields.license, credits: six.fields.credits, sha256: sha } });
  });
  // the fragment: one entry per file that is new to the theme; a name that is taken by other content is found now, before a file is copied
  plan.entries = Object.fromEntries(plan.items.filter((it) => it.action !== 'unchanged' && it.action !== 'restore').map((it) => [it.file, it.entry]));
  plan.fragmentExists = false;
  const target = path.join(plan.partsDir, plan.fragment);
  if (Object.keys(plan.entries).length && fs.existsSync(target)) {
    let old = null;
    try { old = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { /* compared below */ }
    if (isDeepStrictEqual(old, { assets: plan.entries })) plan.fragmentExists = true;
    else plan.problems.push(`${plan.fragment} exists with other content: give this delivery another --name`);
  }
  return plan;
}

// Plans, then copies and writes the fragment. -> the plan plus { wrote: [files], fragmentWritten }. Nothing is written when the plan has a problem or `dryRun` is set.
export function deliver(themeDir, noteArg, { name = null, partsDir = null, dryRun = false } = {}) {
  const plan = planDelivery(themeDir, noteArg, { name, partsDir });
  plan.wrote = []; plan.fragmentWritten = false;
  if (plan.problems.length || dryRun) return plan;
  try {
    for (const it of plan.items) {
      if (it.action !== 'copy' && it.action !== 'restore') continue;
      fs.mkdirSync(path.dirname(it.dst), { recursive: true });
      fs.copyFileSync(it.src, it.dst, fs.constants.COPYFILE_EXCL);
      plan.wrote.push(it.file);
      if (sha256File(it.dst) !== it.sha256) { plan.problems.push(`${it.file}: the copy differs from the source (sha256 check after copying)`); return plan; }
    }
    if (Object.keys(plan.entries).length && !plan.fragmentExists) {
      const target = path.join(plan.partsDir, plan.fragment);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify({ assets: plan.entries }, null, 2)}\n`, { flag: 'wx' }); // 'wx': never over an existing file
      plan.fragmentWritten = true;
    }
  } catch (e) { plan.problems.push(`stopped: ${e.message}`); }
  return plan;
}

const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export function main(argv) {
  const flag = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] || '' : null; };
  const name = val('--name'), partsArg = val('--parts');
  const args = argv.filter((a, i) => !a.startsWith('--') && !['--name', '--parts'].includes(argv[i - 1]));
  if (args.length !== 2 || name === '' || partsArg === '') { console.error('usage: node tools/theme-deliver.mjs <theme-id | folder> <delivery folder | PROVENANCE.json> [--name <fragment name>] [--parts <dir>] [--dry-run] [--assemble]'); return 2; }
  const dir = fs.existsSync(args[0]) ? path.resolve(args[0]) : path.join(THEMES_DIR, args[0]);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error(`${args[0]} is not a theme folder`); return 2; }
  const id = path.basename(dir);
  const res = deliver(dir, args[1], { name, partsDir: partsArg, dryRun: flag('--dry-run') });
  for (const p of res.problems) console.log(`REFUSED ${p}`);
  if (res.problems.length) { console.log(`theme-deliver ${id}: nothing ${res.wrote.length ? 'more ' : ''}done (${res.problems.length} problem(s))${res.wrote.length ? `; already copied: ${res.wrote.join(', ')}` : ''}`); return 1; }
  console.log(`theme-deliver ${id} <- ${res.base}: ${res.items.length} file(s)`);
  for (const it of res.items) console.log(`  ${it.action.padEnd(9)} ${it.file}  ${it.kind}  ${mb(it.bytes)}  sha256 ${it.sha256.slice(0, 16)}...`);
  if (flag('--dry-run')) { console.log('dry run: nothing written'); return 0; }
  console.log(`copied ${res.wrote.length} file(s)${res.fragmentWritten ? `, wrote fragment ${path.relative(dir, path.join(res.partsDir, res.fragment))}` : ', no new fragment'}`);
  if (flag('--assemble')) return assembleMain([dir, ...(partsArg ? ['--parts', partsArg] : [])]);
  console.log(`next: node tools/theme-assemble.mjs ${id}   then   node tools/theme-check.mjs ${id}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
