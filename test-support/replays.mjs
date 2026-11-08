import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMatch } from '../tools/run-match.mjs';

// records a bot-vs-bot game as a replay directory (log.jsonl) in the temp dir
export function scriptedReplay(bots = ['rush', 'boom'], seed = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-bc-scripted-'));
  runMatch({ seed, bots, log: path.join(dir, 'log.jsonl') });
  return dir;
}

