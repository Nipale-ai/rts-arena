#!/usr/bin/env node
// Builds theme.json of a theme from the fragments in its parts/ folder (package C7). Many agents deliver to one theme at the same time (names, models, sounds,
// the rig key, the ground): each writes small fragment files of its own, nobody edits theme.json, and this script puts them together. The result is the same
// bytes for the same fragments (keys in one canonical order, assets sorted), so the same theme hash, whatever order the fragments were written in.
//   node tools/theme-assemble.mjs <theme-id | folder> [--dry-run] [--check] [--strict] [--force] [--allow-drop] [--parts <dir>]
//   node tools/theme-assemble.mjs <theme-id | folder> --split [--hidden] [--dry-run]     (one time: a hand-written theme.json becomes fragments)
// The merge rule, the file layout and what a delivery looks like: tools/THEME-DELIVERY.md.
// Safe by default: it writes nothing when two fragments disagree, when the result breaks the schema (--force writes anyway), or when the new theme.json would
// lose a key that the old one has (--allow-drop). It never deletes anything.
// Exit code 0 = done (or --check: theme.json is what the fragments give), 1 = refused or out of date, 2 = usage error.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { validateTheme, parseThemeId } from '../render/theme/theme-schema.mjs';
import { THEMES_DIR, simCatalog, checkTheme } from './theme-check.mjs';
import { PARTS_DIR_HIDDEN, resolvePartsDir, readParts, mergeParts, formatTheme, splitTheme, lostPaths, hashOf } from './lib/theme-parts.mjs';

const themeFile = (dir) => path.join(dir, 'theme.json');
const count = (o) => (o && typeof o === 'object' ? Object.keys(o).length : 0);

// Assembles the fragments of a theme folder. Returns everything it found; writes theme.json only when `write` is set and nothing is wrong.
//   { ok, wrote, changed, text, hash, previousHash, theme, files, conflicts, problems, errors, warnings, lost, partsDir }
export function assembleTheme(themeDir, { partsDir = null, strict = false, force = false, allowDrop = false, write = false, catalog = null } = {}) {
  const dir = path.resolve(themeDir);
  const res = { dir, partsDir: null, partsExist: false, files: [], conflicts: [], problems: [], errors: [], warnings: [], lost: [], theme: null, text: null, hash: null, previousHash: null, changed: null, wrote: false, ok: false };
  const pd = partsDir ? { dir: path.resolve(partsDir), exists: fs.existsSync(partsDir), problem: null } : resolvePartsDir(dir);
  res.partsDir = pd.dir; res.partsExist = pd.exists;
  if (pd.problem) res.problems.push(pd.problem);
  if (!pd.exists) { res.problems.push(`no fragments folder (${path.relative(process.cwd(), pd.dir) || pd.dir}): nothing to assemble. A hand-written theme.json becomes fragments with --split`); return res; }
  const read = readParts(pd.dir);
  res.problems.push(...read.problems);
  res.files = read.fragments.map((f) => f.file);
  if (!read.fragments.length && !read.problems.length) res.problems.push(`${pd.dir} has no .json fragment`);
  if (res.problems.length) return res;
  const merged = mergeParts(read.fragments);
  res.conflicts = merged.conflicts; res.problems.push(...merged.problems); res.theme = merged.theme;
  if (merged.conflicts.length || merged.problems.length) return res;

  const cat = catalog || simCatalog();
  const rep = validateTheme(merged.theme, { units: cat.units, buildings: cat.buildings, techs: cat.techs, soundEvents: cat.soundEvents, clipKeys: cat.clipKeys, strict });
  res.errors = [...rep.errors]; res.warnings = [...rep.warnings];
  const pid = parseThemeId(path.basename(dir));
  if (!pid) res.errors.push({ path: '', message: `the folder name "${path.basename(dir)}" must be <id>-v<number>, like dustmoon-v1` });
  else if (`${merged.theme.id}-v${merged.theme.version}` !== pid.folder) res.errors.push({ path: '', message: `the folder is ${path.basename(dir)} but the fragments say ${merged.theme.id}-v${merged.theme.version}` });

  res.text = formatTheme(merged.theme); res.hash = hashOf(res.text);
  const tfile = themeFile(dir);
  if (fs.existsSync(tfile)) {
    const old = fs.readFileSync(tfile, 'utf8');
    res.previousHash = hashOf(old); res.changed = old !== res.text;
    try { res.lost = lostPaths(JSON.parse(old), merged.theme); } catch { /* an unreadable theme.json is simply replaced */ }
  } else res.changed = true;
  res.ok = (!res.errors.length || force) && (!res.lost.length || allowDrop);
  if (write && res.ok && res.changed) { fs.writeFileSync(tfile, res.text); res.wrote = true; }
  return res;
}

// One time: the hand-written theme.json becomes fragments (base.json, assets/initial.json, units/<id>.json, buildings/<id>.json, techs.json, ground.json ...).
// Refuses when the folder has fragments already, and checks that the fragments give back the same theme before it writes one.
export function splitThemeDir(themeDir, { partsDir = null, hidden = false, write = false } = {}) {
  const dir = path.resolve(themeDir), res = { dir, partsDir: null, files: [], problems: [], wrote: false };
  const tfile = themeFile(dir);
  if (!fs.existsSync(tfile)) { res.problems.push(`${tfile} is missing`); return res; }
  const pd = partsDir ? { dir: path.resolve(partsDir), exists: fs.existsSync(partsDir), problem: null } : resolvePartsDir(dir);
  res.partsDir = hidden && !pd.exists ? path.join(dir, PARTS_DIR_HIDDEN) : pd.dir;
  if (pd.problem) { res.problems.push(pd.problem); return res; }
  if (pd.exists && readParts(pd.dir).fragments.length) { res.problems.push(`${pd.dir} has fragments already: the theme is split, edit the fragments (or move the folder away to split again)`); return res; }
  let theme, parts;
  try { theme = JSON.parse(fs.readFileSync(tfile, 'utf8')); parts = splitTheme(theme); } catch (e) { res.problems.push(`cannot split ${tfile}: ${e.message}`); return res; }
  const back = mergeParts([...parts].map(([file, data]) => ({ file, data })));
  if (back.conflicts.length || back.problems.length || !isDeepStrictEqual(back.theme, theme)) { res.problems.push('the fragments would not give back the same theme.json (not written)'); return res; }
  res.files = [...parts.keys()].sort();
  if (write) {
    for (const [file, data] of parts) {
      const target = path.join(res.partsDir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' }); // 'wx': never over an existing file
    }
    res.wrote = true;
  }
  return res;
}

const rel = (p) => { const r = path.relative(process.cwd(), p); return r && !r.startsWith('..') ? r : p; }; // inside the working folder: short; elsewhere: the full path
const summary = (theme) => {
  const a = theme.assets || {}, st = Object.values(a).map((x) => x?.status);
  return `${st.length} assets (${st.filter((s) => s === 'final').length} final, ${st.filter((s) => s === 'placeholder').length} placeholder), ${count(theme.units)} units, ${count(theme.buildings)} buildings, ${count(theme.techs)} techs`;
};

export function main(argv) {
  const flag = (f) => argv.includes(f);
  const pi = argv.indexOf('--parts');
  const partsArg = pi >= 0 ? argv[pi + 1] : null;
  const args = argv.filter((a, i) => !a.startsWith('--') && !(pi >= 0 && i === pi + 1));
  if (args.length !== 1 || (pi >= 0 && !partsArg)) { console.error('usage: node tools/theme-assemble.mjs <theme-id | folder> [--dry-run] [--check] [--strict] [--force] [--allow-drop] [--parts <dir>]\n       node tools/theme-assemble.mjs <theme-id | folder> --split [--hidden] [--dry-run]'); return 2; }
  const dir = fs.existsSync(args[0]) ? path.resolve(args[0]) : path.join(THEMES_DIR, args[0]);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error(`${args[0]} is not a theme folder`); return 2; }
  const name = path.basename(dir);

  if (flag('--split')) {
    const r = splitThemeDir(dir, { partsDir: partsArg, hidden: flag('--hidden'), write: !flag('--dry-run') });
    for (const p of r.problems) console.log(`REFUSED ${p}`);
    if (r.problems.length) return 1;
    console.log(`theme-assemble ${name} --split: ${r.files.length} fragments ${r.wrote ? 'written to' : 'would go to'} ${rel(r.partsDir)}/`);
    for (const f of r.files) console.log(`  ${f}`);
    if (r.wrote) {
      console.log(`next: node tools/theme-assemble.mjs ${name}   (theme.json then comes from the fragments; only the order of the assets changes)`);
      const listed = checkTheme(dir).errors.filter((e) => e.path.startsWith(`${path.basename(r.partsDir)}/`));
      if (listed.length) console.log(`NOTE tools/theme-check.mjs reports the ${listed.length} fragment file(s) as "not listed in assets" (it skips dot folders only). Until it also skips ${path.basename(r.partsDir)}/ (one line, tools/THEME-DELIVERY.md) keep the fragments in ${PARTS_DIR_HIDDEN}/: split again with --hidden (move ${path.basename(r.partsDir)}/ away first), or rename the folder.`);
    }
    return 0;
  }

  const res = assembleTheme(dir, { partsDir: partsArg, strict: flag('--strict'), force: flag('--force'), allowDrop: flag('--allow-drop'), write: !flag('--dry-run') && !flag('--check') });
  if (flag('--check') && !res.partsExist && !res.problems.some((p) => !p.startsWith('no fragments folder'))) { console.log(`theme-assemble ${name} --check: no fragments folder, theme.json is hand-written: nothing to compare`); return 0; }
  for (const p of res.problems) console.log(`REFUSED ${p}`);
  for (const c of res.conflicts) console.log(`REFUSED conflict ${c.message}`);
  if (res.problems.length || res.conflicts.length) { console.log(`theme-assemble ${name}: nothing written (${res.problems.length + res.conflicts.length} problem(s))`); return 1; }
  for (const e of res.errors) console.log(`${flag('--force') ? 'ERROR (forced)' : 'REFUSED schema'} ${e.path ? `${e.path}: ` : ''}${e.message}`);
  for (const w of res.warnings) console.log(`warn  ${w.path ? `${w.path}: ` : ''}${w.message}`);
  for (const l of res.lost.slice(0, 20)) console.log(`${flag('--allow-drop') ? 'drop ' : 'REFUSED would drop'} ${l}  (the old theme.json has it, no fragment does)`);
  if (res.lost.length > 20) console.log(`  ... and ${res.lost.length - 20} more`);
  console.log(`theme-assemble ${name}: ${res.files.length} fragments in ${rel(res.partsDir)}/ -> ${summary(res.theme)}`);
  console.log(`  theme.json hash ${res.previousHash ? `${res.previousHash} -> ` : ''}${res.hash}${res.changed ? '' : ' (unchanged)'}`);
  if (flag('--check')) { if (res.ok && !res.changed) { console.log('  up to date'); return 0; } console.log(`  OUT OF DATE: run node tools/theme-assemble.mjs ${name}`); return 1; }
  if (!res.ok) { console.log(`  nothing written${res.errors.length && !flag('--force') ? ' (schema errors: fix the fragments, or --force to write anyway)' : ''}${res.lost.length && !flag('--allow-drop') ? ' (--allow-drop to remove those keys)' : ''}`); return 1; }
  if (flag('--dry-run')) { console.log(`  dry run: ${res.changed ? 'theme.json would change' : 'theme.json is already this'}`); return 0; }
  console.log(res.wrote ? `  wrote ${rel(themeFile(dir))}` : '  theme.json already has this content, not written');
  console.log(`next: node tools/theme-check.mjs ${name}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
