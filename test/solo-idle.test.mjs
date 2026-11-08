// Solo mode, package A1a: level 0 "idle", the thinking-rate scaffold and the seat-independent miss hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runMatch } from '../tools/run-match.mjs';
import { firstDivergence, playerSignature } from '../tools/seat-bias.mjs';
import { createBot, BOT_NAMES, STYLE_BOT_NAMES } from '../agents/scripted/index.mjs';
import { ScriptedBot } from '../agents/scripted/common.mjs';
import { profile as boomProfile } from '../agents/scripted/boom.mjs';
import { WORKER_CAP } from '../agents/scripted/idle.mjs';
import { deterministicMiss, missHash } from '../agents/scripted/miss.mjs';
import { LiveMatch, loadSpec } from '../server/live-match.mjs';
import { loadSim, recordGolden } from '../sim-versions/lib.mjs';
import { Game } from '../sim/game.mjs';
import { observe } from '../sim/observe.mjs';
import { resolveRules } from '../sim/rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const NO_SD = { preset: 'fast', suddenDeath: 0, wonder: false, shrines: false }; // nothing but a base that falls ends the match early
const ALLOWED_BUILDS = new Set(['house', 'mill', 'farm', 'lumber_camp', 'mining_camp']);

// every command one player issued, read from the match log (with the result of the sim)
function playLog(opts) {
  const dir = tmp('rts-idle-');
  const log = path.join(dir, 'log.jsonl');
  const r = runMatch({ ...opts, log });
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { r, cmds: lines.filter((l) => l.type === 'cmd') };
}

// ---------------------------------------------------------------- registration and the four places that check bot names
test('idle is a registered bot, comes last, and the style bots stay the four old ones', () => {
  assert.deepEqual(BOT_NAMES, ['rush', 'boom', 'turtle', 'towers', 'idle']);
  assert.deepEqual(STYLE_BOT_NAMES, ['rush', 'boom', 'turtle', 'towers']);
  const b = createBot('idle');
  assert.equal(b.name, 'idle');
  assert.throws(() => createBot('nope'), /unknown bot "nope" \(have: rush, boom, turtle, towers, idle\)/);
});

test('server/live-match.mjs:25-27 accepts idle by its plain and by its scripted: name, and still refuses others', () => {
  assert.deepEqual(loadSpec('idle'), { kind: 'bot', bot: 'idle' });
  assert.deepEqual(loadSpec('scripted:idle'), { kind: 'bot', bot: 'idle' });
  assert.throws(() => loadSpec('scripted:nope'), /unknown scripted bot "nope" \(have: rush, boom, turtle, towers, idle\)/);
});

test('a real-time LiveMatch with idle on either seat runs to the cutoff (no winner) and names it "Idle"', () => {
  for (const specs of [['idle', 'boom'], ['scripted:boom', 'scripted:idle']]) {
    const m = new LiveMatch({ seed: 2, specs, record: false, rules: 'fast', maxGameSeconds: 150 });
    while (!m.finished) m.tick();
    assert.equal(m.result.reason, 'cutoff');
    const i = specs.findIndex((s) => s.endsWith('idle'));
    assert.equal(m.names[i], 'Idle');
    assert.equal(m.result.agents[i].name, 'idle');
    assert.ok(m.result.agents[i].commands > 5, 'idle works');
  }
});

test('server/spectate.mjs:145 lets idle through (no "unknown bot" exit)', async () => {
  const { args, Match } = await import('../server/spectate.mjs');
  Object.assign(args, { p1: 'idle', p2: 'boom', seed: 3, 'no-record': true });
  const log = console.log; console.log = () => {};
  try {
    const m = new Match();
    for (let i = 0; i < 60; i++) m.tick();
    assert.deepEqual(m.botNames, ['idle', 'boom']);
    assert.ok(m.game.t >= 60);
  } finally { console.log = log; }
});

test('tools/match-headless.mjs:12 lets idle through', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/match-headless.mjs'), '--p1', 'idle', '--p2', 'boom', '--seed', '1', '--preset', 'fast'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /P1 idle team 1/);
  assert.match(r.stdout, /P2 boom team 2/);
});

test('server/arena.mjs:215 keeps the name idle (it was turned into boom silently before) and lists it last', async () => {
  const data = tmp('rts-idle-arena-'), replays = tmp('rts-idle-replays-');
  const child = spawn(process.execPath, [path.join(ROOT, 'server/arena.mjs'), '--port', '0', '--data', data, '--replays', replays], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('arena did not start')), 15000);
      child.stdout.on('data', (d) => { const m = /Arena: (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(m[1]); } });
      child.on('exit', () => reject(new Error('arena exited')));
    });
    const call = async (p, body) => {
      const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const st = await call('/api/state');
    assert.deepEqual(st.body.bots, BOT_NAMES);
    assert.equal(st.body.bots.at(-1), 'idle', 'last: the default seat picks of the setup page (index modulo length) do not change');
    const m = await call('/api/matches', { seed: 1, rules: { time_limit_min: 2, speed: 64 }, players: [{ type: 'bot', bot: 'idle' }, { type: 'bot', bot: 'boom' }] });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.equal(m.body.players[0].bot, 'idle');
    assert.equal(m.body.players[0].display, 'Idle');
    assert.equal(m.body.players[1].bot, 'boom');
  } finally { child.kill('SIGTERM'); }
});

test('tools/balance.mjs plays the four style bots only (idle never joins a balance run on its own)', () => {
  const out = path.join(tmp('rts-idle-bal-'), 'balance.json');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/balance.mjs'), '--games', '1', '--threads', '2', '--preset', 'fast', '--json', out], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
  assert.equal(r.status, 0, r.stderr.slice(-400));
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  const seen = new Set(j.out.matchups.flatMap((m) => [m.a, m.b]));
  assert.deepEqual([...seen].sort(), [...STYLE_BOT_NAMES].sort());
  assert.equal(j.out.matchups.length, 10);
  assert.ok(j.results.every((x) => x.bots.every((b) => STYLE_BOT_NAMES.includes(b))));
  assert.ok(!/idle/i.test(r.stdout), 'idle does not show up in the report');
});

// ---------------------------------------------------------------- what idle does
test('idle never attacks: it issues only worker training, economy buildings and gather orders', () => {
  let games = 0;
  const builds = new Set();
  for (const seed of [1, 2]) for (const bots of [['idle', 'idle'], ['idle', 'boom'], ['rush', 'idle']]) {
    const { r, cmds } = playLog({ seed, bots, rules: NO_SD, maxMinutes: 30 });
    bots.forEach((b, i) => {
      if (b !== 'idle') return;
      const mine = cmds.filter((c) => c.p === i + 1);
      assert.ok(mine.length > 10);
      for (const c of mine) {
        const k = c.cmd.cmd;
        if (k === 'train') assert.equal(c.cmd.unit_type, 'worker', `seed ${seed} ${bots}: trains ${c.cmd.unit_type}`);
        else if (k === 'build') { assert.ok(ALLOWED_BUILDS.has(c.cmd.building_type), `builds ${c.cmd.building_type}`); builds.add(c.cmd.building_type); }
        else assert.equal(k, 'gather', `seed ${seed} ${bots}: ${k}`);
      }
      // the bot also never tiers up, researches or trains a soldier: the sim says so as well
      const p = r.game.players[i + 1];
      assert.equal(p.tier, 1);
      assert.deepEqual(Object.keys(p.trained).filter((u) => !['worker', 'light_cavalry'].includes(u) && p.trained[u]), []);
      assert.ok((p.trained.light_cavalry || 0) <= 1, 'only the scout of the fast start');
    });
    games++;
  }
  assert.equal(games, 6);
  // all economy buildings of the plan show up over the games (a lumber camp only when the trees near the town center run out)
  assert.deepEqual([...builds].sort(), [...ALLOWED_BUILDS].sort());
});

test('idle builds its economy up to the cap and holds it: 16 workers, tier 1, camps, houses, farms, no army', () => {
  for (const seed of [1, 2, 3]) {
    let top = 0, at600 = null;
    runMatch({ seed, bots: ['idle', 'idle'], rules: NO_SD, maxMinutes: 12, onTick: (g) => {
      if (g.t % 10) return;
      for (const pid of [1, 2]) {
        let w = 0;
        for (const u of g.units.values()) if (u.owner === pid && u.type === 'worker') w++;
        top = Math.max(top, w);
      }
      if (g.t === 6000) {
        const p = g.players[1], by = {};
        for (const b of g.buildings.values()) if (b.owner === 1) by[b.type] = (by[b.type] || 0) + 1;
        const soldiers = [...g.units.values()].filter((u) => u.owner === 1 && u.type !== 'worker' && u.type !== 'light_cavalry').length;
        let w = 0; for (const u of g.units.values()) if (u.owner === 1 && u.type === 'worker') w++;
        at600 = { w, tier: p.tier, by, soldiers };
      }
    } });
    assert.ok(at600, 'reached minute 10');
    assert.equal(top, WORKER_CAP, `seed ${seed}: never more than the cap, and it gets there`);
    assert.equal(at600.w, WORKER_CAP, `seed ${seed}: workers at minute 10`);
    assert.equal(at600.tier, 1);
    assert.equal(at600.soldiers, 0);
    assert.ok((at600.by.lumber_camp || 0) + (at600.by.mining_camp || 0) >= 1, `seed ${seed}: camps ${JSON.stringify(at600.by)}`);
    assert.ok(at600.by.farm >= 1 && at600.by.house >= 1, `seed ${seed}: food and houses ${JSON.stringify(at600.by)}`);
    for (const k of Object.keys(at600.by)) assert.ok(['town_center', ...ALLOWED_BUILDS].includes(k), `no ${k}`);
  }
});

test('idle survives 30 game minutes against boom and rush on seeds 1-3, from either seat, without a crash or a command storm', () => {
  for (const seed of [1, 2, 3]) for (const other of ['boom', 'rush']) for (const idleSeat of [1, 2]) {
    const bots = idleSeat === 1 ? ['idle', other] : [other, 'idle'];
    const { r, cmds } = playLog({ seed, bots, rules: 'fast', maxMinutes: 30 });
    assert.ok(r.ticks > 3000, `${bots} seed ${seed} ended at tick ${r.ticks}`);
    const mine = cmds.filter((c) => c.p === idleSeat);
    const bad = mine.filter((c) => !c.ok);
    assert.ok(mine.length > 20, `${bots} seed ${seed}: ${mine.length} commands`);
    assert.ok(bad.length <= 3, `${bots} seed ${seed}: ${bad.length} refused commands, first: ${JSON.stringify(bad[0])}`);
    let w = 0; for (const u of r.game.units.values()) if (u.owner === idleSeat && u.type === 'worker') w++;
    assert.ok(w <= WORKER_CAP);
  }
});

test('idle for the full 30 minutes (no sudden death) does not crash and ends on the time limit', () => {
  const r = runMatch({ seed: 4, bots: ['idle', 'idle'], rules: NO_SD, maxMinutes: 31 });
  assert.equal(r.result.over, true);
  assert.match(r.result.reason, /^time limit/);
  assert.equal(r.result.seconds, 1800);
});

// ---------------------------------------------------------------- mirror: seat 1 and seat 2 play alike
test('mirror: two idle bots stay exactly point-symmetric tick by tick (fast and classic)', () => {
  for (const seed of [1, 2]) assert.equal(firstDivergence({ bot: 'idle', seed, minutes: 8, rules: 'fast' }), null, `fast seed ${seed}`);
  assert.equal(firstDivergence({ bot: 'idle', seed: 4, minutes: 6 }), null, 'classic');
});

test('mirror: idle on seat 1 against a bot equals idle on seat 2 against it, mirrored, until the first contact', () => {
  const run = (bots, seat, mirror) => {
    const sig = new Map();
    let contact = null;
    runMatch({ seed: 3, bots, rules: 'fast', maxMinutes: 12, onTick: (g) => {
      if (g.t % 100 === 0) sig.set(g.t, JSON.stringify(playerSignature(g, seat, mirror)));
      if (contact === null) { let k = 0; for (const p of g.players) if (p) k += p.kills + p.lostValue; if (k > 0) contact = g.t; }
    } });
    return { sig, contact };
  };
  for (const other of ['boom', 'turtle', 'towers']) {
    const a = run(['idle', other], 1, false), b = run([other, 'idle'], 2, true);
    // 30 game seconds of margin before the first blow: the bots' own scouting is not mirrored to the tick
    const lim = Math.min(a.contact ?? Infinity, b.contact ?? Infinity, 7200) - 300;
    let n = 0;
    for (const [t, s] of a.sig) {
      if (t >= lim) break;
      assert.equal(b.sig.get(t), s, `${other}: idle seat 1 and idle seat 2 (mirrored) differ at tick ${t}`);
      n++;
    }
    assert.ok(n >= 30, `${other}: only ${n} checkpoints compared`);
  }
});

test('mirror: boom beats idle from either seat on seeds 1-3 (the style bot wins whichever side it plays)', () => {
  for (const seed of [1, 2, 3]) for (const bots of [['idle', 'boom'], ['boom', 'idle']]) {
    const r = runMatch({ seed, bots, rules: 'fast', maxMinutes: 31 });
    assert.equal(r.result.winnerTeam, bots.indexOf('boom') + 1, `${bots} seed ${seed}: ${r.result.reason}`);
    assert.equal(r.end.cls, 'destroyed');
  }
});

// ---------------------------------------------------------------- level 3 = the style bots, unchanged
// Fingerprints of recorded games (every command with arguments, a state hash every 10 s, the result) on the frozen sim sim-5b029590482b.
// Recorded 02.11.2026 with the bot code of commit 69a7aae (before A1a); the same recorder as the golden replays (sim-versions/lib.mjs).
// The frozen sim never changes, so a later sim change does not touch this table: only a change of the bots (or of the data tables
// they read) does. If you changed a style bot ON PURPOSE, record the table again and say so in the commit.
const BASE_SIM = 'sim-5b029590482b';
const LEVEL3 = [
  [['rush', 'boom'], 1, 'fast', 'ca0c0536a1c1eda0', 670],
  [['boom', 'rush'], 2, 'fast', '187823b7ac5283b0', 612],
  [['turtle', 'towers'], 1, 'fast', '637288d156e98ac9', 903],
  [['towers', 'turtle'], 1, 'fast', '1679af3784b34f61', 917],
  [['rush', 'towers'], 1, 'fast', '47e3ef14a051edc1', 728],
  [['towers', 'boom'], 1, 'fast', '56bbdbf3bb92c973', 941],
  [['turtle', 'rush'], 1, 'fast', '23da52eda193c4d8', 613],
  [['boom', 'turtle'], 2, 'fast', '8c337354f91cefcd', 832],
  [['rush', 'boom'], 3, null, '90c84e81d9f547bd', 606],
  [['turtle', 'towers'], 3, null, 'bc1a27144262aeaf', 772],
];

test('level 3 (rush, boom, turtle, towers) plays exactly as before A1a: same commands, same state hashes', () => {
  const sim = loadSim(BASE_SIM);
  const seen = new Set();
  for (const [bots, seed, preset, want, nCmds] of LEVEL3) {
    const lines = recordGolden(sim, createBot, { bots, seed, preset, maxTicks: 9000 });
    const got = crypto.createHash('sha256').update(lines.map((l) => JSON.stringify(l)).join('\n')).digest('hex').slice(0, 16);
    assert.equal(lines.filter((l) => l.type === 'cmd').length, nCmds, `${bots} seed ${seed}: number of commands`);
    assert.equal(got, want, `${bots} seed ${seed} ${preset}: the game changed`);
    for (const b of bots) seen.add(b);
  }
  assert.deepEqual([...seen].sort(), [...STYLE_BOT_NAMES].sort());
});

// ---------------------------------------------------------------- thinking rate: ingest always, decide only now and then
test('gateThink(): a profile without thinkEvery decides on every observation, untouched', () => {
  const b = new ScriptedBot({ ...boomProfile });
  const o = { t: 4, events: [{ type: 'attacked', x: 1, y: 2, t: 4 }] };
  assert.equal(b.gateThink(o), o);
  assert.equal(b.s.heldEvents, undefined);
});

test('gateThink(): events of skipped observations reach the next decision, in order, once', () => {
  const b = new ScriptedBot({ ...boomProfile, thinkEvery: 10 });
  const ev = (type, t) => ({ type, t, x: 5, y: 5 });
  const a = b.gateThink({ t: 0, events: [ev('a', 0)] });
  assert.deepEqual(a.events.map((e) => e.type), ['a']);
  assert.equal(b.gateThink({ t: 2, events: [ev('attacked', 2)] }), null);
  assert.equal(b.gateThink({ t: 4 }), null); // an observation without an events key
  assert.equal(b.gateThink({ t: 8, events: [ev('building_lost', 8)] }), null);
  const m = b.gateThink({ t: 10, events: [ev('c', 10)] });
  assert.deepEqual(m.events.map((e) => e.type), ['attacked', 'building_lost', 'c']);
  assert.equal(m.t, 10);
  assert.equal(b.gateThink({ t: 12, events: [ev('d', 12)] }), null);
  const m2 = b.gateThink({ t: 20, events: [] });
  assert.deepEqual(m2.events.map((e) => e.type), ['d'], 'nothing is handed over twice');
  assert.equal(b.gateThink({ t: 22 }), null);
  assert.equal(b.s.nextThinkT, 30);
});

test('gateThink(): a long skip keeps the newest 200 events only', () => {
  const b = new ScriptedBot({ ...boomProfile, thinkEvery: 1000 });
  b.gateThink({ t: 0 });
  for (let t = 1; t <= 150; t++) b.gateThink({ t, events: [{ type: 'attacked', t, x: 0, y: 0 }, { type: 'attacked', t, x: 1, y: 1 }] });
  const m = b.gateThink({ t: 1000, events: [] });
  assert.equal(m.events.length, 200);
  assert.equal(m.events.at(-1).t, 150);
  assert.equal(m.events[0].t, 51);
});

test('thinkEvery: ingest runs on every observation, decisions only every N seconds, and the match stays deterministic', () => {
  const play = () => {
    const g = new Game({ seed: 5, rules: resolveRules('fast') });
    const slow = new ScriptedBot({ ...boomProfile, thinkEvery: 10 }), fast = createBot('boom');
    let ingests = 0, decisions = 0, calls = 0;
    const ingest = slow.ingest.bind(slow), eco = slow.eco.bind(slow);
    slow.ingest = (o) => { ingests++; return ingest(o); };
    slow.eco = (o) => { decisions++; return eco(o); };
    const last = [-1, -1];
    while (g.t < 3000 && !g.over) {
      if (g.t % 20 === 0) {
        [slow, fast].forEach((bot, i) => {
          const o = JSON.parse(JSON.stringify(observe(g, i + 1, { sinceTick: last[i] })));
          last[i] = g.t;
          if (i === 0) calls++;
          for (const c of bot.think(o)) g.command(i + 1, c);
        });
      }
      g.step();
    }
    return { hash: g.hash(), ingests, decisions, calls };
  };
  const a = play(), b = play();
  assert.deepEqual(a, b);
  assert.equal(a.calls, 150, '300 s, one observation every 2 s');
  assert.equal(a.ingests, a.calls, 'ingest ran on every observation, skipped or not');
  assert.equal(a.decisions, 30, 'one decision every 10 s');
});

// ---------------------------------------------------------------- the seat-independent miss
test('deterministicMiss: same inputs, same answer; 0 never misses, 1 always misses', () => {
  for (let i = 0; i < 200; i++) {
    assert.equal(deterministicMiss(7, i, i % 5, 0.3), deterministicMiss(7, i, i % 5, 0.3));
    assert.equal(deterministicMiss(7, i, 3, 0), false);
    assert.equal(deterministicMiss(7, i, 3, 1), true);
    assert.equal(deterministicMiss(7, i, 3, -0.5), false);
    assert.equal(deterministicMiss(7, i, 3, NaN), false);
  }
  assert.equal(deterministicMiss.length, 4, '(seed, t, n, rate): there is no player number to hash');
});

test('deterministicMiss: the share of misses follows the rate (12 % and 25 %, the rates of levels 2 and 1)', () => {
  for (const rate of [0.12, 0.25]) {
    let miss = 0, N = 0;
    for (let t = 0; t < 2000; t += 2) for (let n = 0; n < 40; n++) { N++; if (deterministicMiss(42, t, n, rate)) miss++; }
    assert.ok(Math.abs(miss / N - rate) < 0.012, `rate ${rate}: got ${(miss / N).toFixed(4)} of ${N}`);
  }
});

test('deterministicMiss: neighbouring commands do not miss together (no clustering by n or by t)', () => {
  const rate = 0.25;
  let both = 0, first = 0, bothT = 0, firstT = 0;
  for (let t = 0; t < 4000; t += 2) for (let n = 0; n < 20; n++) {
    if (deterministicMiss(9, t, n, rate)) { first++; if (deterministicMiss(9, t, n + 1, rate)) both++; }
    if (deterministicMiss(9, t, n, rate)) { firstT++; if (deterministicMiss(9, t + 2, n, rate)) bothT++; }
  }
  assert.ok(Math.abs(both / first - rate) < 0.03, `next n: ${(both / first).toFixed(3)}`);
  assert.ok(Math.abs(bothT / firstT - rate) < 0.03, `next t: ${(bothT / firstT).toFixed(3)}`);
});

test('deterministicMiss: the seed changes the pattern', () => {
  let same = 0;
  for (let n = 0; n < 400; n++) if (deterministicMiss(1, 100, n, 0.5) === deterministicMiss(2, 100, n, 0.5)) same++;
  assert.ok(same > 140 && same < 260, `${same} of 400 equal`);
  assert.notEqual(missHash(1, 100, 0), missHash(2, 100, 0));
});

test('deterministicMiss: both seats of a mirrored game get the same misses and so the same rate', () => {
  // A mirrored game: both seats decide at the same game seconds and issue the same number of commands per decision,
  // so both walk the same (t, n) stream. The hash has no seat in it, hence the same verdicts.
  const seat = (seed, rate) => {
    const out = [];
    let n = 0;
    for (let t = 0; t < 1800; t += 2) for (let k = 0; k < 1 + (t % 7); k++) out.push(deterministicMiss(seed, t, n++, rate));
    return out;
  };
  for (const seed of [1, 42, 977]) for (const rate of [0.12, 0.25]) {
    const s1 = seat(seed, rate), s2 = seat(seed, rate);
    assert.deepEqual(s1, s2);
    const r1 = s1.filter(Boolean).length / s1.length, r2 = s2.filter(Boolean).length / s2.length;
    assert.equal(r1, r2);
    assert.ok(Math.abs(r1 - rate) < 0.02, `seed ${seed} rate ${rate}: ${r1.toFixed(4)}`);
  }
});
