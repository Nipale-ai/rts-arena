// Machine-local defaults for the RTS_* environment variables (pause file, voice folders, notify script), read once from
// `<repo root>/local-env.json`. That file is git-ignored and never exported, so private paths stay out of the code.
// A real environment variable always wins; only RTS_* keys with string values are taken. Modules that read these
// variables import this file first (child processes inherit the result).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'local-env.json');

const WARNED = 'RTS_LOCAL_ENV_WARNED'; // set after the warning, so child processes (arena -> video tool) do not repeat it

// `warn` gets one line. A missing file is the normal case and stays silent; a file that is there but cannot be used is said once.
export function applyLocalEnv(file = LOCAL_ENV_FILE, env = process.env, warn = (m) => console.error(m)) {
  const complain = (why) => {
    if (env[WARNED] === file) return;
    env[WARNED] = file;
    warn(`RTS Arena: ignoring ${file}: ${why}. It must hold one JSON object such as { "RTS_VOICES_DIR": "/path/to/voices" }; fix it or delete it.`);
  };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') complain(`it cannot be read (${e.code || e.message})`); return []; }
  let o;
  try { o = JSON.parse(text); } catch (e) { complain(`it is not valid JSON (${e.message})`); return []; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) { complain('it is not a JSON object'); return []; }
  const set = [];
  for (const [k, v] of Object.entries(o)) {
    if (/^RTS_[A-Z0-9_]+$/.test(k) && typeof v === 'string' && env[k] === undefined) { env[k] = v; set.push(k); }
  }
  return set;
}

applyLocalEnv();
