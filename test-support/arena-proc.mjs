// Starts server/arena.mjs as a child process on a free port with its own data folder (tests of the HTTP side).
// `prepare(dataDir)` runs before the start (write settings.json, players ...); `env` is added to the child's environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startArena({ prepare, env = {} } = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-arena-'));
  const replays = path.join(data, 'replays');
  if (prepare) prepare(data);
  const child = spawn(process.execPath, [path.join(ROOT, 'server/arena.mjs'), '--port', '0', '--data', data, '--replays', replays], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const base = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('arena did not start')), 15000);
    child.stdout.on('data', (d) => { const m = /Arena: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(m[1]); } });
    child.on('exit', () => reject(new Error('arena exited')));
  });
  const call = async (p, body, method, headers = {}) => {
    const r = await fetch(base + p, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, type: r.headers.get('content-type') || '', text, body: json };
  };
  return { base, data, call, stop: () => child.kill('SIGTERM') };
}
