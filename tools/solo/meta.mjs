// Shared bits of the solo tools: the run-meta file next to a replay, stable JSON, short hashes.
// runMeta.json is the companion of result.json. result.json stays exactly as LiveMatch writes it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RUN_META_FILE = 'runMeta.json';
export const RUN_META_SCHEMA = 'solo-run-meta-1';

// JSON with sorted keys: the same object always gives the same text (hash input)
export function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const shortHash = (v, n = 16) => sha256(typeof v === 'string' ? v : stableStringify(v)).slice(0, n);

export function readRunMeta(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, RUN_META_FILE), 'utf8'));
    return m && m.schema === RUN_META_SCHEMA ? m : null;
  } catch {
    return null;
  }
}

// write and rename: a reader never sees half a file
export function writeRunMeta(dir, meta) {
  const file = path.join(dir, RUN_META_FILE), tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 1));
  fs.renameSync(tmp, file);
}
