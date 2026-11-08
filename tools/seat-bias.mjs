#!/usr/bin/env node
// Seat bias diagnostics for mirror matches (same bot on both seats, point-symmetric map).
//   node tools/seat-bias.mjs rates --bots boom,turtle,rush --games 300 [--seed0 1000] [--threads 6]
//       seat-1 win rate with a 95 % Wilson confidence interval (seat 1 = player id 1). Games are
//       played on many seeds; the map is point symmetric, so seat 1 vs seat 2 is the only difference.
//   node tools/seat-bias.mjs sym --bot boom --seed 1 [--minutes 12]
//       perfect symmetry check: after every tick, state of player 1 vs the point-mirrored state of
//       player 2. Prints the first tick and field where they differ.
//   node tools/seat-bias.mjs sym --bots boom,turtle,rush --seeds 5
// Run long jobs niced: nice -n 10 node tools/seat-bias.mjs rates ...
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { runMatch } from './run-match.mjs';
import { BOT_NAMES } from '../agents/scripted/index.mjs';
import { botOptions } from '../agents/scripted/common.mjs';

// ---------- statistics ----------
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}

// ---------- symmetry check ----------
// Canonical, order-free description of everything a player owns, in point-mirrored coordinates.
// mirror=false describes the player as is, mirror=true maps it through the 180 degree rotation.
export function playerSignature(g, pid, mirror) {
  const W = g.W, H = g.H, p = g.players[pid];
  const mx = (x) => (mirror ? W * 1000 - x : x), my = (y) => (mirror ? H * 1000 - y : y);
  const units = [];
  for (const u of g.units.values()) {
    if (u.owner !== pid) continue;
    const o = u.ord;
    let tgt = '';
    if (o.node) {
      if (o.node.k === 't') {
        const i = o.node.idx, x = i % W, y = (i / W) | 0;
        tgt = ` tree@${mirror ? W - 1 - x : x},${mirror ? H - 1 - y : y}`;
      } else {
        const e = g.get(o.node.id);
        if (e && e.kind === 3) tgt = ` node@${mirror ? W - e.tx - e.size : e.tx},${mirror ? H - e.ty - e.size : e.ty}`;
        else if (e) tgt = ` bld@${mirror ? W - e.tx - e.size : e.tx},${mirror ? H - e.ty - e.size : e.ty}`;
      }
    } else if (o.t === 'attack' || o.t === 'build') {
      const e = g.get(o.id);
      if (e && e.kind === 1) tgt = ` unit@${mx(e.x)},${my(e.y)}`;
      else if (e) tgt = ` ent@${mirror ? W - e.tx - e.size : e.tx},${mirror ? H - e.ty - e.size : e.ty}`;
    } else if (o.t === 'move' || o.t === 'amove') tgt = ` to${mx(o.x)},${my(o.y)}`;
    units.push(`${u.type} x${mx(u.x)} y${my(u.y)} hp${u.hp} cd${u.cd} amt${u.amt} gp${u.gp} res${u.res} ord:${o.t}${o.res ? ':' + o.res : ''}${o.st ? ':' + o.st : ''}${tgt}`);
  }
  const buildings = [];
  for (const b of g.buildings.values()) {
    if (b.owner !== pid) continue;
    const tx = mirror ? W - b.tx - b.size : b.tx, ty = mirror ? H - b.ty - b.size : b.ty;
    buildings.push(`${b.type} @${tx},${ty} hp${b.hp} built${b.built ? 1 : 0} prog${b.prog} q[${b.queue.map((q) => q.type + ':' + q.t).join(',')}] r${b.research ? b.research.t : '-'} cd${b.cd}`);
  }
  units.sort();
  buildings.sort();
  return {
    resources: JSON.stringify(p.res),
    pop: `${p.pop}/${p.cap} tier${p.tier} techs[${[...p.techs].sort()}]`,
    gathered: JSON.stringify(p.gathered),
    kills: `${p.kills}/${p.losses} ${p.killValue}/${p.lostValue}`,
    units, buildings,
  };
}

// Whole-map symmetry of shared things: resource nodes and wood.
export function sharedSignature(g, mirror) {
  const W = g.W, H = g.H;
  const nodes = [];
  for (const n of g.nodes.values()) {
    const tx = mirror ? W - n.tx - n.size : n.tx, ty = mirror ? H - n.ty - n.size : n.ty;
    nodes.push(`${n.res} @${tx},${ty} amt${n.amt} gat${n.gat}`);
  }
  nodes.sort();
  const trees = [];
  for (let i = 0; i < W * H; i++) {
    if (g.terrain[i] !== 1 && !g.treeGat[i]) continue;
    const x = i % W, y = (i / W) | 0;
    trees.push(`${mirror ? W - 1 - x : x},${mirror ? H - 1 - y : y} t${g.terrain[i]} w${g.wood[i]} gat${g.treeGat[i]}`);
  }
  trees.sort();
  return { nodes, trees };
}

// Compare player 1 with the mirrored player 2. Returns null or { field, a, b }.
export function symmetryDiff(g) {
  if (g.numPlayers !== 2) throw new Error('symmetry check needs a 2 player game');
  const a = playerSignature(g, 1, false), b = playerSignature(g, 2, true);
  for (const f of Object.keys(a)) {
    const x = a[f], y = b[f];
    if (Array.isArray(x)) {
      if (x.length !== y.length) return { field: f + '.count', a: x.length, b: y.length, detail: firstOnly(x, y) };
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return { field: f, a: x[i], b: y[i], detail: firstOnly(x, y) };
    } else if (x !== y) return { field: f, a: x, b: y };
  }
  // fog of war: vision and explored tiles of player 1 against the rotated ones of player 2
  const NN = g.W * g.H, p1 = g.players[1], p2 = g.players[2];
  for (const f of ['vis', 'expl'])
    for (let i = 0; i < NN; i++)
      if (p1[f][i] !== p2[f][NN - 1 - i]) return { field: f, a: `tile ${i % g.W},${(i / g.W) | 0} = ${p1[f][i]}`, b: `mirror tile = ${p2[f][NN - 1 - i]}` };
  const s1 = sharedSignature(g, false).nodes, s2 = sharedSignature(g, true).nodes;
  if (s1.length !== s2.length) return { field: 'nodes.count', a: s1.length, b: s2.length };
  for (let i = 0; i < s1.length; i++) if (s1[i] !== s2[i]) return { field: 'nodes', a: s1[i], b: s2[i] };
  const t1 = sharedSignature(g, false).trees, t2 = sharedSignature(g, true).trees;
  if (t1.length !== t2.length) return { field: 'trees.count', a: t1.length, b: t2.length, detail: firstOnly(t1, t2) };
  for (let i = 0; i < t1.length; i++) if (t1[i] !== t2[i]) return { field: 'trees', a: t1[i], b: t2[i], detail: firstOnly(t1, t2) };
  return null;
}
function firstOnly(x, y) {
  const sy = new Set(y);
  const only = x.filter((s) => !sy.has(s)).slice(0, 2);
  const sx = new Set(x);
  return { onlyP1: only, onlyP2mirrored: y.filter((s) => !sx.has(s)).slice(0, 2) };
}

// Static check of the map itself: terrain, node set, start tiles.
export function mapDiff(g) {
  const W = g.W, H = g.H;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (g.terrain[y * W + x] !== g.terrain[(H - 1 - y) * W + (W - 1 - x)]) return { field: 'terrain', a: `${x},${y}`, b: 'mirror differs' };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (g.wood[y * W + x] !== g.wood[(H - 1 - y) * W + (W - 1 - x)]) return { field: 'wood', a: `${x},${y}`, b: 'mirror differs' };
  const [s1, s2] = g.starts;
  if (s1.tx + s2.tx + 4 !== W || s1.ty + s2.ty + 4 !== H) return { field: 'starts', a: JSON.stringify(s1), b: JSON.stringify(s2) };
  return null;
}

// Runs one mirror game and returns { tick, field, a, b } of the first divergence (or null).
export function firstDivergence({ bot, seed, minutes = 12, rules }) {
  let found = null;
  const stop = new Error('stop');
  botOptions.roleJitter = false; // the bots vary their economy per game; the symmetry check needs two identical copies
  try {
    runMatch({
      seed, bots: [bot, bot], maxMinutes: minutes, rules,
      onTick: (g) => {
        if (g.t === 1) {
          const m = mapDiff(g);
          if (m) { found = { tick: 0, ...m }; throw stop; }
        }
        const d = symmetryDiff(g);
        if (d) { found = { tick: g.t, ...d }; throw stop; }
      },
    });
  } catch (e) {
    if (e !== stop) throw e;
  } finally {
    botOptions.roleJitter = true;
  }
  return found;
}

// ---------- CLI ----------
// --preset fast | classic | '{"preset":"fast","treasure":null}' (JSON overrides)
function parsePreset(p) {
  if (!p) return 'classic';
  return String(p).trim().startsWith('{') ? JSON.parse(p) : p;
}
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
    else a._.push(argv[i]);
  }
  return a;
}

async function rates(args) {
  const games = +(args.games ?? 300), seed0 = +(args.seed0 ?? 1000);
  const threads = +(args.threads ?? Math.max(1, Math.min(6, os.cpus().length - 2)));
  const bots = args.bots ? args.bots.split(',') : ['boom', 'turtle', 'rush'];
  const jobs = [];
  for (const b of bots) for (let g = 0; g < games; g++) jobs.push({ id: jobs.length, seed: seed0 + g, bots: [b, b], rules: parsePreset(args.preset) });
  const results = new Array(jobs.length);
  let next = 0, done = 0;
  await new Promise((resolve) => {
    const workers = [];
    const feed = (w) => { if (next < jobs.length) w.postMessage(jobs[next++]); };
    for (let i = 0; i < threads; i++) {
      const w = new Worker(new URL('./balance-worker.mjs', import.meta.url));
      w.on('message', (m) => {
        results[m.id] = m;
        if (++done === jobs.length) { for (const x of workers) x.terminate(); resolve(); } else feed(w);
      });
      workers.push(w);
      feed(w);
    }
  });
  const out = {};
  console.log('mirror matches (same bot on both seats): seat-1 share of decided games, 95 % Wilson CI, OK = CI holds 50 % and rate within 45-55 %');
  for (const b of bots) {
    const rs = results.filter((r) => r.bots[0] === b && r.bots[1] === b);
    const w1 = rs.filter((r) => r.winnerTeam === 1).length, w2 = rs.filter((r) => r.winnerTeam === 2).length;
    const dr = rs.length - w1 - w2;
    // main number: seat-1 share of the decided games; draws (equal score at the time limit) are listed apart
    const n = w1 + w2, k = w1;
    const [lo, hi] = wilson(k, n);
    const half = rs.length ? (w1 + dr / 2) / rs.length : 0;
    const ok = n > 0 && lo <= 0.5 && hi >= 0.5 && k / n >= 0.45 && k / n <= 0.55;
    out[b] = { games: rs.length, seat1: w1, seat2: w2, draws: dr, rate: n ? k / n : 0, lo, hi, rateDrawsHalf: half, ok };
    console.log(`  ${b.padEnd(7)} games ${rs.length}  seat1 ${w1}  seat2 ${w2}  draws ${dr}  seat-1 rate ${(100 * k / n).toFixed(1)}%  CI [${(100 * lo).toFixed(1)}, ${(100 * hi).toFixed(1)}]  (draws as half: ${(100 * half).toFixed(1)}%)  ${ok ? 'OK' : 'BIASED'}`);
  }
  return out;
}

function sym(args) {
  const bots = args.bots ? args.bots.split(',') : [args.bot || 'boom'];
  const seeds = args.seed ? [+args.seed] : Array.from({ length: +(args.seeds ?? 3) }, (_, i) => 1 + i);
  for (const bot of bots)
    for (const seed of seeds) {
      const d = firstDivergence({ bot, seed, minutes: +(args.minutes ?? 12), rules: parsePreset(args.preset) });
      if (!d) console.log(`${bot} seed ${seed}: symmetric for the whole run`);
      else console.log(`${bot} seed ${seed}: first divergence at tick ${d.tick} (${(d.tick / 10).toFixed(1)}s), field ${d.field}\n    P1:        ${typeof d.a === 'string' ? d.a : JSON.stringify(d.a)}\n    P2 mirror: ${typeof d.b === 'string' ? d.b : JSON.stringify(d.b)}${d.detail ? '\n    ' + JSON.stringify(d.detail) : ''}`);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'rates';
  if (cmd === 'rates') await rates(args);
  else if (cmd === 'sym') sym(args);
  else { console.error('usage: seat-bias.mjs rates|sym ...'); process.exit(1); }
  void BOT_NAMES;
}
