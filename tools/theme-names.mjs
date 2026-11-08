#!/usr/bin/env node
// Names of a theme: the fragment, the lexicon of the code, theme.json (package C1).
//
// The words of a theme (name, plural, description of every unit, building and tech) live in ONE fragment, a piece of theme.json:
//     render/assets/themes-src/<theme>/parts/names.json          { units: { <id>: { name, plural, description } }, buildings: {...}, techs: {...} }
//     render/assets/themes-src/<theme>/parts/names-status.json   where each name comes from (owner | proposal | placeholder), one line per id
// The fragment sits OUTSIDE the theme folder on purpose: tools/theme-check.mjs wants every file of a theme folder in the manifest, and a fragment is no asset.
// The assembly of theme.json (package C7) reads it like any other part; until then the two places that read words are kept in step by this tool:
//     render/theme/display-name.mjs     the block between "BEGIN GENERATED" and "END GENERATED" (the lexicon of the theme id; ids passed as a string need it, and a loaded
//                                       theme without the slot answers from it). Never edit that block by hand.
//     render/assets/themes/<theme>/theme.json   the name fields of the slots (only with --theme-json; the day this runs, the lexicon block is emptied with --no-lexicon)
//
//   node tools/theme-names.mjs check  [theme]                   exit 0 = fragment complete (60 ids), valid for the schema, lexicon block and theme.json agree with it
//   node tools/theme-names.mjs write  [theme] [--theme-json] [--no-lexicon]   regenerate the lexicon block (and theme.json name fields)
//   node tools/theme-names.mjs import <names-dustmoon.json> [theme] [--as proposal|placeholder] [--keep-owner]   take names from the N1 file (schema names-dustmoon-1)
// theme defaults to dustmoon-v1. The lexicon block exists for dustmoon-v1 only (another theme answers from its theme.json: no code).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNITS, BUILDINGS, TECHS } from '../sim/data.mjs';
import { validateTheme } from '../render/theme/theme-schema.mjs';
import { simCatalog } from './theme-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KINDS = ['units', 'buildings', 'techs'];
export const LEX_KIND = { units: 'unit', buildings: 'building', techs: 'tech' };
export const STATUSES = ['owner', 'proposal', 'placeholder']; // owner = a name the owner gave (02.11.), proposal = from the N1 file (name check still open), placeholder = not from the final N1 file
export const DEFAULT_THEME = 'dustmoon-v1';
export const BEGIN = (theme) => `// ---- BEGIN GENERATED ${theme} names (node tools/theme-names.mjs write; source: render/assets/themes-src/${theme}/parts/names.json). Do not edit by hand.`;
export const END = (theme) => `// ---- END GENERATED ${theme} names`;

export const paths = (theme = DEFAULT_THEME, root = ROOT) => ({
  names: path.join(root, 'render/assets/themes-src', theme, 'parts/names.json'),
  status: path.join(root, 'render/assets/themes-src', theme, 'parts/names-status.json'),
  themeJson: path.join(root, 'render/assets/themes', theme, 'theme.json'),
  lexicon: path.join(root, 'render/theme/display-name.mjs'),
});

export const simIds = () => ({ units: Object.keys(UNITS), buildings: Object.keys(BUILDINGS), techs: Object.keys(TECHS) });
const rj = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const regularPlural = (w) => (/cavalry|infantry|sheep|s$/.test(w) ? w : /man$/.test(w) ? w.replace(/man$/, 'men') : `${w}s`); // the rule of display-name.mjs

// ------------------------------------------------------------------ serialisation: one slot per line, ids in the order of sim/data.mjs
export function serializeNames(names) {
  const ids = simIds(), out = [];
  for (const k of KINDS) {
    const rows = [...ids[k], ...Object.keys(names[k] || {}).filter((i) => !ids[k].includes(i)).sort()].filter((i) => names[k]?.[i]);
    out.push(`  ${JSON.stringify(k)}: {\n${rows.map((i) => `    ${JSON.stringify(i)}: ${JSON.stringify({ name: names[k][i].name, plural: names[k][i].plural, description: names[k][i].description })}`).join(',\n')}\n  }`);
  }
  return `{\n${out.join(',\n')}\n}\n`;
}
export function serializeStatus(status, note) {
  const ids = simIds(), rows = [];
  for (const k of KINDS) for (const i of ids[k]) if (status[`${LEX_KIND[k]}/${i}`]) rows.push(`    ${JSON.stringify(`${LEX_KIND[k]}/${i}`)}: ${JSON.stringify(status[`${LEX_KIND[k]}/${i}`])}`);
  return `{\n  "note": ${JSON.stringify(note)},\n  "values": ${JSON.stringify(STATUSES)},\n  "status": {\n${rows.join(',\n')}\n  }\n}\n`;
}

// ------------------------------------------------------------------ checks
// Problems of a names fragment: [] = fine. Uses the schema itself (validateTheme) on a theme made of the fragment, so the rules cannot drift.
export function problemsOf(names) {
  const ids = simIds(), out = [], warn = [];
  for (const k of KINDS) {
    for (const i of ids[k]) if (!names[k]?.[i]) out.push(`${k}.${i}: no name`);
    for (const i of Object.keys(names[k] || {})) {
      if (!ids[k].includes(i)) out.push(`${k}.${i}: not a sim id`);
      const s = names[k][i];
      const extra = Object.keys(s || {}).filter((f) => !['name', 'plural', 'description'].includes(f));
      if (extra.length) out.push(`${k}.${i}: fields other than name, plural, description: ${extra.join(', ')}`);
    }
  }
  // a theme that has nothing but these words (the words are the only thing a fragment carries)
  const merged = { schema: 'rts-theme-1', id: 'names', version: 1, name: 'Names', description: 'names fragment', fallback: 'classic', status: 'slice', legal: { name_check: { status: 'unverified' } }, assets: {}, units: {}, buildings: {}, techs: {} };
  for (const k of KINDS) for (const [i, s] of Object.entries(names[k] || {})) merged[k][i] = { name: s.name, plural: s.plural, description: s.description };
  const cat = simCatalog(); // the sim ids and which types shoot, as tools/theme-check.mjs knows them
  const rep = validateTheme(merged, { units: cat.units, buildings: cat.buildings, techs: cat.techs });
  for (const e of rep.errors) if (/^(units|buildings|techs)\./.test(e.path)) out.push(`${e.path}: ${e.message}`);
  for (const w of rep.warnings) if (/^(units|buildings|techs)\./.test(w.path)) warn.push(`${w.path}: ${w.message}`);
  // names are unique inside a kind of thing (two units with one name would be one word on the screen)
  for (const k of KINDS) {
    const seen = new Map();
    for (const [i, s] of Object.entries(names[k] || {})) { const n = String(s.name).toLowerCase(); if (seen.has(n)) out.push(`${k}.${i}: the name "${s.name}" is also the name of ${seen.get(n)}`); else seen.set(n, i); }
  }
  return { errors: out, warnings: warn };
}

// ------------------------------------------------------------------ the lexicon block of display-name.mjs
export function renderBlock(theme, names) {
  const ids = simIds(), q = JSON.stringify;
  const kindBlock = (k) => ids[k].filter((i) => names[k]?.[i]).map((i) => `    ${i}: E(${q(names[k][i].name)}, ${q(names[k][i].plural)}, ${q(names[k][i].description)}),`).join('\n');
  return [BEGIN(theme), 'const DUSTMOON = {', '  unit: {', kindBlock('units'), '  },', '  building: {', kindBlock('buildings'), '  },', '  tech: {', kindBlock('techs'), '  },', '};', END(theme)].filter((l) => l !== '').join('\n'); // (an empty kind leaves no blank line)
}
export function blockOf(src, theme) {
  const a = src.indexOf(BEGIN(theme)), b = src.indexOf(END(theme));
  return a < 0 || b < a ? null : { a, b: b + END(theme).length, text: src.slice(a, b + END(theme).length) };
}
export function spliceBlock(src, theme, block) {
  const cur = blockOf(src, theme);
  if (!cur) throw new Error(`display-name.mjs has no "BEGIN GENERATED ${theme} names" ... "END GENERATED" block`);
  return src.slice(0, cur.a) + block + src.slice(cur.b);
}
export const emptyNames = () => ({ units: {}, buildings: {}, techs: {} });

// ------------------------------------------------------------------ theme.json: the name fields of the slots, in the order of the sim ids; every other field of a slot stays
export function mergeIntoThemeJson(themeJson, names) {
  const ids = simIds(), out = { ...themeJson };
  for (const k of KINDS) {
    const old = themeJson[k] || {}, next = {};
    for (const i of [...ids[k], ...Object.keys(old).filter((x) => !ids[k].includes(x))]) {
      const s = names[k]?.[i], o = old[i];
      if (!s && !o) continue;
      next[i] = s ? { name: s.name, plural: s.plural, description: s.description, ...Object.fromEntries(Object.entries(o || {}).filter(([f]) => !['name', 'plural', 'description'].includes(f))) } : o;
    }
    out[k] = next;
  }
  return out;
}

// ------------------------------------------------------------------ import of the N1 file (schema names-dustmoon-1: units/buildings/techs: id -> { name, plural, description, ... })
export function importNames(raw, current, { as = 'proposal', keepOwner = true, ownerIds = null } = {}) {
  if (!STATUSES.includes(as) || as === 'owner') throw new Error(`--as must be proposal or placeholder, not ${as}`);
  const ids = simIds(), names = structuredClone(current.names), status = { ...current.status };
  const owner = new Set(ownerIds || Object.entries(status).filter(([, v]) => v === 'owner').map(([k]) => k));
  const taken = [], skipped = [];
  for (const k of KINDS) for (const [i, s] of Object.entries(raw[k] || {})) {
    if (!ids[k].includes(i)) { skipped.push(`${k}.${i}: not a sim id`); continue; }
    const key = `${LEX_KIND[k]}/${i}`;
    if (keepOwner && owner.has(key)) { skipped.push(`${key}: owner name kept`); continue; }
    if (typeof s?.name !== 'string' || typeof s?.description !== 'string') { skipped.push(`${key}: no name or description`); continue; }
    names[k][i] = { name: s.name, plural: typeof s.plural === 'string' ? s.plural : (k === 'techs' ? s.name : regularPlural(s.name)), description: s.description };
    status[key] = as;
    taken.push(key);
  }
  return { names, status, taken, skipped };
}

// ------------------------------------------------------------------ load / save
export function load(theme = DEFAULT_THEME, root = ROOT) {
  const p = paths(theme, root);
  return { names: fs.existsSync(p.names) ? rj(p.names) : emptyNames(), status: fs.existsSync(p.status) ? rj(p.status).status : {}, note: fs.existsSync(p.status) ? rj(p.status).note : '' };
}
export function save(theme, { names, status, note }, root = ROOT) {
  const p = paths(theme, root);
  fs.mkdirSync(path.dirname(p.names), { recursive: true });
  fs.writeFileSync(p.names, serializeNames(names));
  fs.writeFileSync(p.status, serializeStatus(status, note));
}

export function check(theme = DEFAULT_THEME, root = ROOT) {
  const p = paths(theme, root), cur = load(theme, root), res = { errors: [], warnings: [], info: [] };
  if (!fs.existsSync(p.names)) { res.errors.push(`${path.relative(root, p.names)} does not exist`); return res; }
  const themeJson = fs.existsSync(p.themeJson) ? rj(p.themeJson) : null;
  const pr = problemsOf(cur.names);
  res.errors.push(...pr.errors); res.warnings.push(...pr.warnings);
  const ids = simIds();
  for (const k of KINDS) for (const i of ids[k]) if (cur.names[k]?.[i] && !cur.status[`${LEX_KIND[k]}/${i}`]) res.errors.push(`${k}.${i}: no line in names-status.json`);
  const count = (v) => Object.values(cur.status).filter((x) => x === v).length;
  res.info.push(`${Object.keys(cur.status).length} names: ${count('owner')} owner, ${count('proposal')} proposal, ${count('placeholder')} placeholder`);
  // theme.json: a slot that has name fields must say the same as the fragment
  if (themeJson) for (const k of KINDS) for (const [i, s] of Object.entries(themeJson[k] || {})) {
    for (const f of ['name', 'plural', 'description']) if (s[f] !== undefined && cur.names[k]?.[i] && s[f] !== cur.names[k][i][f]) res.errors.push(`theme.json ${k}.${i}.${f}: "${s[f]}" differs from the fragment "${cur.names[k][i][f]}"`);
  }
  // the lexicon block
  if (theme === DEFAULT_THEME) {
    const src = fs.readFileSync(p.lexicon, 'utf8'), have = blockOf(src, theme);
    if (!have) res.errors.push('display-name.mjs: no generated block');
    else if (have.text !== renderBlock(theme, cur.names) && have.text !== renderBlock(theme, emptyNames())) res.errors.push('display-name.mjs: the generated block differs from the fragment (run: node tools/theme-names.mjs write)');
  }
  return res;
}

// ------------------------------------------------------------------ CLI
function main(argv) {
  const [cmd, ...rest] = argv, flags = new Set(rest.filter((a) => a.startsWith('--') && !['--as'].includes(a))), args = rest.filter((a) => !a.startsWith('--'));
  const asIdx = rest.indexOf('--as'), as = asIdx >= 0 ? rest[asIdx + 1] : 'proposal';
  const positional = asIdx >= 0 ? args.filter((a) => a !== rest[asIdx + 1]) : args;
  if (cmd === 'check') {
    const theme = positional[0] || DEFAULT_THEME, r = check(theme);
    for (const l of r.info) console.log(`info  ${l}`);
    for (const l of r.warnings) console.log(`warn  ${l}`);
    for (const l of r.errors) console.log(`ERROR ${l}`);
    console.log(`theme-names ${theme}: ${r.errors.length} error(s), ${r.warnings.length} warning(s) -> ${r.errors.length ? 'FAIL' : 'OK'}`);
    return r.errors.length ? 1 : 0;
  }
  if (cmd === 'write') {
    const theme = positional[0] || DEFAULT_THEME, p = paths(theme), cur = load(theme);
    const pr = problemsOf(cur.names);
    if (pr.errors.length) { for (const e of pr.errors) console.log(`ERROR ${e}`); return 1; }
    if (theme === DEFAULT_THEME) {
      const src = fs.readFileSync(p.lexicon, 'utf8');
      fs.writeFileSync(p.lexicon, spliceBlock(src, theme, renderBlock(theme, flags.has('--no-lexicon') ? emptyNames() : cur.names)));
      console.log(`display-name.mjs: block ${flags.has('--no-lexicon') ? 'emptied (the names come from theme.json)' : 'written'}`);
    }
    if (flags.has('--theme-json')) {
      const tj = rj(p.themeJson);
      fs.writeFileSync(p.themeJson, `${JSON.stringify(mergeIntoThemeJson(tj, cur.names), null, 2)}\n`);
      console.log(`${path.relative(ROOT, p.themeJson)}: name fields of ${KINDS.map((k) => Object.keys(cur.names[k]).length).join(' + ')} slots written`);
    }
    return 0;
  }
  if (cmd === 'import') {
    const file = positional[0], theme = positional[1] || DEFAULT_THEME;
    if (!file) { console.error('usage: node tools/theme-names.mjs import <names-dustmoon.json> [theme] [--as proposal|placeholder] [--keep-owner]'); return 2; }
    const raw = rj(path.resolve(file)), cur = load(theme);
    const r = importNames(raw, cur, { as, keepOwner: !flags.has('--overwrite-owner') });
    const pr = problemsOf(r.names);
    if (pr.errors.length) { for (const e of pr.errors) console.log(`ERROR ${e}`); console.log('nothing written'); return 1; }
    save(theme, { names: r.names, status: r.status, note: cur.note });
    console.log(`imported ${r.taken.length} names as ${as}; skipped ${r.skipped.length}: ${r.skipped.slice(0, 12).join('; ')}`);
    return 0;
  }
  console.error('usage: node tools/theme-names.mjs check|write|import ...');
  return 2;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) process.exitCode = main(process.argv.slice(2));
