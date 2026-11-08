// The broadcast rule book (BROADCAST-RULES.md at the repo root): one text for the script prompt (LLM and template writers) and the renderer.
// The prompt contains the file verbatim; its hash is stored in the prompt file and in the script (generated.rules_hash), so a changed rule book is visible.
// A kit user can point RTS_BROADCAST_RULES at another file, or edit the shipped one.
import '../server/local-env.mjs'; // machine-local RTS_* defaults (local-env.json) before anything reads them
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const RULES_FILE = process.env.RTS_BROADCAST_RULES ? path.resolve(process.env.RTS_BROADCAST_RULES) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'BROADCAST-RULES.md');
export function loadRules(file = RULES_FILE) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
  return { text, hash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 12), file };
}
