// Fragments of a theme (package C7): read the parts/ folder of a theme, merge the fragments, put the result in one canonical order and one text form.
// The text form is what tools/theme-assemble.mjs writes as theme.json: the same fragments always give the same bytes (so the same theme hash),
// whatever order the agents wrote them in. Pure functions over data, plus a reader for the folder. No Math.random, no deletes.
//
// A fragment is a JSON file anywhere below parts/ (names with a leading dot are skipped, as tools/theme-check.mjs skips them). It is a PARTIAL theme.json:
//   parts/units/archer.json    { "units": { "archer": { "name": "Arc Gunner", ... } } }
//   parts/assets/arc_gunner.json   { "assets": { "models/archer.glb": { "kind": "model", "status": "final", ... } } }
// Merge rule: objects merge key by key. A value (string, number, list) that two fragments give to the same path must be the same, else it is a conflict
// with both file names (nobody overwrites anybody silently). One exception, in assets only: a "final" entry replaces a "placeholder" entry of the same file
// (a delivery keeps its promise); two different "final" entries of one file are a conflict (a final file is never edited, THEME-VERTRAG.md section 2).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TOP_KEYS, SLOT_FIELDS, SOUND_EVENTS, PROVENANCE_FIELDS } from '../../render/theme/theme-schema.mjs';

export const PARTS_DIR = 'parts';
export const PARTS_DIR_HIDDEN = '.parts'; // same job; theme-check skips dot folders, so it is the folder to use until theme-check also skips parts/
export const LINE_WIDTH = 160; // an object or list that fits into this many characters stays on one line

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // code unit order: the same on every machine (no locale)
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// "assets["models/archer.glb"]", "units.archer.model.file": the path of a value inside a theme, as theme-check prints paths
export const pathStr = (segs) => segs.map((s, i) => (typeof s === 'number' ? `[${s}]` : i === 0 ? String(s) : IDENT.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`)).join('');
const short = (v) => { const t = JSON.stringify(v); return t === undefined ? 'undefined' : t.length > 70 ? `${t.slice(0, 67)}...` : t; };
export const hashOf = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16); // the theme hash: first 16 hex digits of the sha256 of the bytes of theme.json

// ---------------------------------------------------------------------------------------------------------------------
// reading
// every *.json file below `dir`, relative POSIX paths, in code unit order
export function listParts(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile() && e.name.endsWith('.json')) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort(cmp);
}

// the folder of the fragments of a theme: parts/ or .parts/ (never both); `exists` tells whether it is there
export function resolvePartsDir(themeDir) {
  const a = path.join(themeDir, PARTS_DIR), b = path.join(themeDir, PARTS_DIR_HIDDEN);
  const ea = fs.existsSync(a), eb = fs.existsSync(b);
  if (ea && eb) return { dir: a, exists: true, problem: `both ${PARTS_DIR}/ and ${PARTS_DIR_HIDDEN}/ exist in ${themeDir}: keep one of them` };
  return { dir: eb ? b : a, exists: ea || eb, problem: null };
}

// { fragments: [{ file, data }], problems: [text] }: unreadable or non-object fragments are listed, not thrown (the caller shows all of them at once)
export function readParts(dir) {
  const problems = [], fragments = [];
  if (!fs.existsSync(dir)) return { fragments, problems };
  for (const file of listParts(dir)) {
    let text = fs.readFileSync(path.join(dir, file), 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let data;
    try { data = JSON.parse(text); } catch (e) { problems.push(`${file}: not valid JSON (${e.message})`); continue; }
    if (!isObj(data)) { problems.push(`${file}: a fragment is a JSON object, a partial theme.json`); continue; }
    fragments.push({ file, data });
  }
  return { fragments, problems };
}

// ---------------------------------------------------------------------------------------------------------------------
// merging
// the key "__proto__" would set the prototype when it is copied: a fragment that has it anywhere is refused
function forbidden(v, segs, out) {
  if (Array.isArray(v)) v.forEach((x, i) => forbidden(x, [...segs, i], out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) { if (k === '__proto__') out.push(pathStr(segs)); else forbidden(x, [...segs, k], out); }
}

// -> { theme, conflicts: [{ path, files: [first, second], message }], problems: [text], origin: Map(path -> first fragment that set it) }
// The fragments are taken in the order given (readParts gives code unit order of the file names): "first" is the fragment that comes first in that order.
export function mergeParts(fragments) {
  const theme = {}, origin = new Map(), conflicts = [], problems = [];
  const clash = (segs, a, b, file, what) => conflicts.push({ path: pathStr(segs), files: [origin.get(pathStr(segs)) || 'an earlier fragment', file], message: `${pathStr(segs)}: ${what} (${origin.get(pathStr(segs)) || 'an earlier fragment'} says ${short(a)}, ${file} says ${short(b)})` });
  const mark = (v, segs, file) => { origin.set(pathStr(segs), file); if (isObj(v)) for (const [k, x] of Object.entries(v)) mark(x, [...segs, k], file); };
  const put = (dst, k, v, segs, file) => { dst[k] = structuredClone(v); mark(v, segs, file); };
  const into = (dst, src, segs, file) => {
    for (const [k, v] of Object.entries(src)) {
      const here = [...segs, k];
      if (!Object.prototype.hasOwnProperty.call(dst, k)) { put(dst, k, v, here, file); continue; }
      const cur = dst[k];
      if (segs.length === 1 && segs[0] === 'assets') { // one manifest entry is one value: final beats placeholder
        if (isDeepStrictEqual(cur, v)) continue;
        if (isObj(cur) && isObj(v) && cur.status === 'placeholder' && v.status === 'final') put(dst, k, v, here, file);
        else if (isObj(cur) && isObj(v) && cur.status === 'final' && v.status === 'placeholder') continue;
        else clash(here, cur, v, file, isObj(cur) && isObj(v) && cur.status === 'final' && v.status === 'final' ? 'two different final entries (a final file is never edited, make a new theme version)' : 'two different entries');
      } else if (isObj(cur) && isObj(v)) into(cur, v, here, file);
      else if (!isDeepStrictEqual(cur, v)) clash(here, cur, v, file, 'two different values');
    }
  };
  for (const { file, data } of fragments) {
    const bad = [];
    forbidden(data, [], bad);
    if (bad.length) { for (const b of bad) problems.push(`${file}: the key "__proto__" at ${b || 'the top'} is not allowed`); continue; } // the fragment is left out
    into(theme, data, [], file);
  }
  return { theme, conflicts, problems, origin };
}

// ---------------------------------------------------------------------------------------------------------------------
// canonical order
// slot model and nature entry share one list: an object with a string `file` is a model entry
const MODEL_ORDER = ['file', 'lods', 'atlas', 'rig', 'tiers', 'damage', 'damage_t2', 'damage_t3', 'rot', 'weight', 'brightness', 'scale'];
const EFFECT_ORDER = ['fx', 'color', 'size', 'life_s', 'sprite', 'anchor'];
const PROJECTILE_ORDER = ['shape', 'mesh', 'color', 'glow', 'length', 'width', 'trail'];
// the keys of an object in the order humans read them; every other key follows in code unit order
function keyOrder(segs, o) {
  const [a, , c] = segs;
  if (!segs.length) return TOP_KEYS;
  if (a === 'assets') return segs.length === 2 ? ['kind', 'status', ...PROVENANCE_FIELDS] : [];
  if (a === 'legal') return segs.length === 1 ? ['name_check'] : ['status', 'date', 'source', 'note'];
  if (Object.hasOwn(SLOT_FIELDS, a)) {
    if (segs.length === 2) return SLOT_FIELDS[a];
    if (segs.length === 3 && c === 'sound') return Object.hasOwn(SOUND_EVENTS, a) ? SOUND_EVENTS[a] : [];
    if (segs.length === 3 && c === 'projectile') return PROJECTILE_ORDER;
    if (segs.length === 3 && (c === 'muzzle' || c === 'hit')) return EFFECT_ORDER;
    if (segs.length === 4 && c === 'projectile') return ['color', 'size'];
  }
  return typeof o.file === 'string' ? MODEL_ORDER : [];
}
export function canonicalize(v, segs = []) {
  if (Array.isArray(v)) return v.map((x, i) => canonicalize(x, [...segs, i]));
  if (!isObj(v)) return v;
  const known = keyOrder(segs, v), keys = [...known.filter((k) => k in v), ...Object.keys(v).filter((k) => !known.includes(k)).sort(cmp)];
  const out = {};
  for (const k of keys) out[k] = canonicalize(v[k], [...segs, k]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// text form: two-space JSON; objects and lists that fit into LINE_WIDTH stay on one line ({ "a": 1 }, [1, 2]); every entry of assets is one line
function inline(v) {
  if (Array.isArray(v)) return v.length ? `[${v.map(inline).join(', ')}]` : '[]';
  if (isObj(v)) { const e = Object.entries(v); return e.length ? `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}'; }
  return JSON.stringify(v);
}
function pretty(v, indent, lead) { // lead: what stands on the line before the value
  const one = inline(v);
  if (typeof v !== 'object' || v === null || lead.length + one.length + 1 <= LINE_WIDTH) return one;
  const pad = ' '.repeat(indent + 2), end = ' '.repeat(indent);
  if (Array.isArray(v)) return `[\n${v.map((x, i) => `${pad}${pretty(x, indent + 2, pad)}${i < v.length - 1 ? ',' : ''}`).join('\n')}\n${end}]`;
  const e = Object.entries(v);
  return `{\n${e.map(([k, x], i) => { const l = `${pad}${JSON.stringify(k)}: `; return `${l}${pretty(x, indent + 2, l)}${i < e.length - 1 ? ',' : ''}`; }).join('\n')}\n${end}}`;
}
export function formatTheme(theme) {
  const c = canonicalize(theme), e = Object.entries(c);
  const body = e.map(([k, v], i) => {
    const lead = `  ${JSON.stringify(k)}: `;
    let text;
    if (k === 'assets' && isObj(v) && Object.keys(v).length) {
      const a = Object.entries(v);
      text = `{\n${a.map(([f, x], j) => `    ${JSON.stringify(f)}: ${inline(x)}${j < a.length - 1 ? ',' : ''}`).join('\n')}\n  }`;
    } else text = pretty(v, 2, lead);
    return `${lead}${text}${i < e.length - 1 ? ',' : ''}`;
  }).join('\n');
  return `{\n${body}\n}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// split: one theme.json -> fragments (the one-time step from a hand-written theme.json to parts/). Map(relative file -> fragment object)
const ID = /^[a-z][a-z0-9_]*$/;
export function splitTheme(t) {
  if (!isObj(t)) throw new Error('theme.json must be a JSON object');
  const out = new Map();
  const { assets, units, buildings, techs, ground, nature, light, event_sounds: eventSounds, ...base } = t;
  out.set('base.json', base);
  if (isObj(assets) && Object.keys(assets).length) out.set('assets/initial.json', { assets });
  for (const [kind, m] of [['units', units], ['buildings', buildings]]) {
    if (m === undefined) continue;
    if (!isObj(m)) { out.set(`${kind}/_invalid.json`, { [kind]: m }); continue; }
    for (const [id, slot] of Object.entries(m)) {
      if (!ID.test(id)) throw new Error(`cannot split: ${kind} id "${id}" is not a sim id (lower-case snake_case)`);
      out.set(`${kind}/${id}.json`, { [kind]: { [id]: slot } });
    }
  }
  for (const [key, v] of [['techs', techs], ['ground', ground], ['nature', nature], ['light', light], ['event_sounds', eventSounds]]) if (v !== undefined) out.set(`${key}.json`, { [key]: v });
  return out;
}

// the JSON paths of `a` (objects only; lists are values) that `b` does not have: what an assembly would drop
export function lostPaths(a, b, segs = []) {
  const out = [];
  if (!isObj(a)) return out;
  for (const [k, v] of Object.entries(a)) {
    const here = [...segs, k];
    if (!isObj(b) || !Object.prototype.hasOwnProperty.call(b, k)) out.push(pathStr(here));
    else out.push(...lostPaths(v, b[k], here));
  }
  return out;
}
