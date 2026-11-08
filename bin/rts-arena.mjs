#!/usr/bin/env node
// One command to start the arena: picks a free port and a data folder, starts server/arena.mjs, opens the browser.
//
//   npx rts-arena [--port 8800] [--data <dir>] [--no-open] [--help]   (or: npm start, node bin/rts-arena.mjs)
//
// Every other option goes to the arena server unchanged (for example --allow-host). The server binds 127.0.0.1 only.
// This file avoids newer syntax on purpose: on an old Node it must still get as far as the version message.
import '../server/local-env.mjs'; // machine-local RTS_* defaults (local-env.json) before anything reads them
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIN_NODE = 22;
export const DEFAULT_PORT = 8800;
export const PORT_TRIES = 10; // after the wanted port, this many more are tried
const HOST = '127.0.0.1';

export const HELP = `RTS Arena: language models play a real-time strategy game against each other.

Usage: rts-arena [options]      (also: npm start -- [options], node bin/rts-arena.mjs [options])

Options:
  --port <n>     Port to listen on (default ${DEFAULT_PORT}). If it is busy, the next ${PORT_TRIES} ports are tried.
  --data <dir>   Where matches, players and settings are kept. Default: $RTS_ARENA_DATA, else <package folder>/data
                 in a git checkout, else ~/.rts-arena
  --no-open      Do not open the browser.
  --help         Show this text.

Any other option is passed to the arena server (for example --allow-host name1,name2). It listens on ${HOST} only.
`;

export class UsageError extends Error {}

export const nodeOk = (version = process.versions.node) => Number(String(version).split('.')[0]) >= MIN_NODE;

// argv without node and script. Own flags are taken out, everything else stays in `rest` in its order.
export function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, data: null, open: true, help: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], inline = null;
    const eq = /^(--(?:port|data))=(.*)$/.exec(a);
    if (eq) { a = eq[1]; inline = eq[2]; }
    const value = () => { // the next token, unless it is another flag
      const v = inline !== null ? inline : argv[i + 1];
      if (v === undefined || v === '' || (inline === null && v.startsWith('--'))) throw new UsageError(`${a} needs a value`);
      if (inline === null) i++;
      return v;
    };
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--no-open') out.open = false;
    else if (a === '--port') {
      const v = value();
      if (!/^\d+$/.test(v) || +v < 1 || +v > 65535) throw new UsageError(`--port must be a number from 1 to 65535 (got "${v}")`);
      out.port = +v;
    } else if (a === '--data') out.data = value();
    else out.rest.push(argv[i]);
  }
  return out;
}

// --data, else $RTS_ARENA_DATA, else <package folder>/data in a git checkout, else ~/.rts-arena (an npx install lives in a cache that can vanish)
export function resolveDataDir({ flag = null, env = {}, root = ROOT, home = os.homedir(), cwd = process.cwd(), exists = fs.existsSync } = {}) {
  const wanted = flag || env.RTS_ARENA_DATA;
  if (wanted) return path.resolve(cwd, wanted);
  return exists(path.join(root, '.git')) ? path.join(root, 'data') : path.join(home, '.rts-arena');
}

function portFree(port, host = HOST) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

// the first free port from `start` on, at most `tries` more after it; null when none is free
export async function findFreePort(start, { tries = PORT_TRIES, host = HOST } = {}) {
  for (let p = start; p <= Math.min(65535, start + tries); p++) if (await portFree(p, host)) return p;
  return null;
}

// [command, args] that opens a URL in the default browser
export function openCommand(platform, url) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]]; // the empty argument is the window title that start wants first
  return ['xdg-open', [url]];
}

function openBrowser(url, onFail) {
  const [cmd, args] = openCommand(process.platform, url);
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', onFail);
    p.on('exit', (code) => { if (code) onFail(); });
    p.unref();
  } catch (e) { onFail(); }
}

// resolves true when the arena answers on the port, false when it did not within the time
function waitUntilUp(port, child, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    child.once('exit', () => finish(false));
    const t0 = Date.now();
    const poll = () => {
      if (done) return;
      const req = http.get({ host: HOST, port, path: '/', timeout: 1000 }, (res) => { res.resume(); finish(true); });
      const again = () => { if (Date.now() - t0 > timeoutMs) finish(false); else setTimeout(poll, 150); };
      req.on('error', again);
      req.on('timeout', () => { req.destroy(); });
    };
    poll();
  });
}

export async function main(argv = process.argv.slice(2)) {
  if (!nodeOk()) {
    console.error(`RTS Arena needs Node ${MIN_NODE} or newer. You have Node ${process.versions.node}.\nInstall a current Node from https://nodejs.org/ and run this command again.`);
    return 1;
  }
  let o;
  try { o = parseArgs(argv); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\nRun "rts-arena --help" for the options.`);
    return 1;
  }
  if (o.help) { process.stdout.write(HELP); return 0; }

  const dataDir = resolveDataDir({ flag: o.data, env: process.env });
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {
    console.error(`Cannot create the data folder ${dataDir} (${e.code || e.message}).\nChoose another one with --data <dir> or RTS_ARENA_DATA.`);
    return 1;
  }
  const port = await findFreePort(o.port);
  if (port === null) {
    console.error(`No free port from ${o.port} to ${o.port + PORT_TRIES}. Free one of them or choose another with --port <n>.`);
    return 1;
  }
  if (port !== o.port) console.log(`Port ${o.port} is busy, using ${port}.`);

  // the arena keeps replays in <package folder>/replays by default; away from a git checkout they go with the data (a cache can vanish)
  const replays = o.rest.includes('--replays') || dataDir === path.join(ROOT, 'data') ? [] : ['--replays', path.join(dataDir, 'replays')];
  const child = spawn(process.execPath, [path.join(ROOT, 'server/arena.mjs'), '--port', String(port), '--data', dataDir, ...replays, ...o.rest], { stdio: 'inherit' });
  let exited = false, stopping = false;
  const code = new Promise((resolve) => {
    child.once('exit', (c) => { exited = true; resolve(c === null ? (stopping ? 0 : 1) : c); }); // c is null when a signal ended it
    child.once('error', (e) => { exited = true; console.error(`Could not start the arena server: ${e.message}`); resolve(1); });
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { if (!exited) { stopping = true; child.kill(sig); } });
  process.on('exit', () => { if (!exited) child.kill(); });

  const url = `http://${HOST}:${port}/`;
  if (await waitUntilUp(port, child)) {
    console.log(`\nRTS Arena is running: ${url}\nData folder: ${dataDir}\nPress Ctrl+C to stop.\n`);
    if (o.open) openBrowser(url, () => console.log(`Could not open a browser. Open ${url} yourself.`));
  } else if (!exited) {
    console.error(`The arena did not answer on ${url} within 20 seconds.`);
  }
  const c = await code;
  if (c !== 0) console.error(`The arena stopped with exit code ${c}.`);
  return c;
}

// run only when started as a command (npm links bin files, so compare real paths)
const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch (e) { return false; } })();
if (isMain) main().then((c) => process.exit(c), (e) => { console.error(e.stack || e.message); process.exit(1); });
