#!/usr/bin/env node
// Measures the real-time pace of the match driver with mock LLM servers (slow answers): ticks per wall second.
//   nice -n 10 node tools/pace.mjs [--seconds 300] [--delay 4000] [--speed 1]
import { startMock } from '../agents/llm/mock-server.mjs';
import { LiveMatch } from '../server/live-match.mjs';

const A = {};
for (let i = 2; i < process.argv.length; i += 2) A[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const secs = +(A.seconds ?? 300), delay = +(A.delay ?? 4000), speed = +(A.speed ?? 1);
const m1 = await startMock({ delayMs: delay, jitterMs: delay / 3, strategy: 'boom', seed: 1 });
const m2 = await startMock({ delayMs: Math.round(delay * 1.7), jitterMs: delay / 2, strategy: 'rush', seed: 2 });
const cfg = (n, u) => ({ name: n, base_url: u, model: n, hardware: 'mock', timeout_s: 60 });
const live = new LiveMatch({ seed: 7, p1: cfg('SlowA', m1.url), p2: cfg('SlowB', m2.url), record: false, maxGameSeconds: 3600 });
const t0 = performance.now();
let lastT = t0, lastTick = 0;
const stopAt = t0 + secs * 1000;
const timer = setInterval(() => {
  const now = performance.now();
  if (now >= stopAt) { live.finished = true; return; }
  if (now - lastT >= 30000) { console.log(`t+${Math.round((now - t0) / 1000)}s  ${((live.game.t - lastTick) / ((now - lastT) / 1000) / speed).toFixed(3)} ticks/s per speed (window)`); lastT = now; lastTick = live.game.t; }
}, 1000);
await live.run({ speed });
clearInterval(timer);
const el = (performance.now() - t0) / 1000;
console.log(`total: ${live.game.t} ticks in ${el.toFixed(1)} s = ${(live.game.t / el / speed).toFixed(3)} ticks/s at ${speed}x (dropped ${live.pacer.dropped}); LLM requests ${live.slots.map((s) => s.agent.m.requests).join(' / ')}`);
await m1.close(); await m2.close();
process.exit(0);
