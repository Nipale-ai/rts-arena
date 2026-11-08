#!/usr/bin/env node
// node tools/match-headless.mjs --p1 rush --p2 boom --seed 42 --log out.jsonl [--p3 x --p4 y --teams 1,1,2,2] [--map file.json]
import fs from 'node:fs';
import { runMatch } from './run-match.mjs';
import { BOT_NAMES } from '../agents/scripted/index.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const bots = [args.p1 || 'rush', args.p2 || 'boom'];
if (args.p3) bots.push(args.p3);
if (args.p4) bots.push(args.p4);
for (const b of bots) if (!BOT_NAMES.includes(b)) {
  console.error(`unknown bot ${b}; available: ${BOT_NAMES.join(', ')}`);
  process.exit(1);
}
const teams = args.teams ? args.teams.split(',').map(Number) : undefined;
const map = args.map ? JSON.parse(fs.readFileSync(args.map, 'utf8')) : undefined;
const r = runMatch({ seed: +(args.seed ?? 1), bots, teams, map, log: args.log, rules: args.preset || (args.rules ? JSON.parse(args.rules) : undefined) });
const res = r.result;
console.log(`seed ${args.seed ?? 1}: ${res.reason}, winner team ${res.winnerTeam || 'none'} after ${Math.floor(res.seconds / 60)}m${Math.floor(res.seconds % 60)}s game time`);
console.log(`wall ${(r.wallMs / 1000).toFixed(2)}s (${(res.seconds / (r.wallMs / 1000)).toFixed(0)}x real time), first fight at ${r.firstAttack ?? '-'}s, hash ${r.game.hash()}`);
for (const p of res.players) console.log(`  P${p.id} ${bots[p.id - 1]} team ${p.team}: ${p.alive ? 'alive' : 'out'} score ${p.score} kills-value ${p.killValue} tier ${p.tier} trained ${JSON.stringify(p.trained)}`);
