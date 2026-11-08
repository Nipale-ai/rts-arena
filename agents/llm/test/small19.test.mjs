// rts-llm-1.9: shorter prompt and observation (compact.mjs), a queue for held purchases, every empty reply retried, HUD figures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmPlayer, HOLD_MAX_TICKS, HOLD_QUEUE_MAX } from '../player.mjs';
import { startMock } from '../mock-server.mjs';
import { buildSystemPrompt, PROMPT_VERSION } from '../prompt.mjs';
import { compactObs, expandObs, factsOfPrompt, OBS_FIELDS } from '../compact.mjs';
import { LiveMatch } from '../../../server/live-match.mjs';
import { srcName, invalidSplit } from '../../../render/hud.mjs';
import { richGame } from '../../../test-support/helpers.mjs';

const cfg = (name, url, extra = {}) => ({ name, base_url: url, model: name.toLowerCase(), hardware: 'mock', timeout_s: 8, ...extra });
const round0 = { n: 1, startTick: 0, since: -1, attempt: 1, lostBase: null, game_s: 0, pre: { feedback: [], toolErrors: [], lastError: null } };

// a mid-game observation from a real (short) match: the long form as observe() + the harness gives it, and what the model is sent now
let cached = null;
const midGame = () => (cached ||= midGameRun());
async function midGameRun() {
  const m = await startMock({ delayMs: 5, strategy: 'rush' });
  try {
    const live = new LiveMatch({ seed: 5, p1: cfg('Mid', m.url), p2: 'scripted:rush', record: false, maxGameSeconds: 240 });
    await live.run({ speed: 60 });
    const agent = live.slots[0].agent;
    agent.feedback = [{ cmd: 'attack_move', args: { units: 'army', target: [60, 60] }, ok: true, units: 5 }, { cmd: 'say', args: { text: 'hello' }, ok: true }, { cmd: 'train', args: { unit_type: 'archer', count: 2 }, ok: false, error: 'insufficient_resources', message: 'x' }];
    agent.lastNote = 'plan: raid, then tier 2';
    agent.turns = [{ n: 1, game_s: 100, note: 'a', orders: ['train 2x archer: ok', 'say: ok'] }, { n: 2, game_s: 120, note: '', orders: ['gather wood: ok'] }];
    const round = { ...round0, n: 7, startTick: live.game.t, since: live.game.t - 200, pre: { feedback: agent.feedback, toolErrors: [], lastError: null } };
    const long = agent.buildObs(live.game, round);
    return { long, bodies: m.stats.bodies, system: agent.system };
  } finally { await m.close(); }
}

test('observation 1.9: clearly shorter than the long form, nothing empty, no static data', async () => {
  const { long, bodies } = await midGame();
  const a = JSON.stringify(long), c = JSON.stringify(compactObs(long));
  console.log(`# observation chars: long ${a.length} -> compact ${c.length} (${(100 * (1 - c.length / a.length)).toFixed(1)} % less), ~tokens ${Math.round(a.length / 3.5)} -> ${Math.round(c.length / 3.5)}`);
  assert.ok(c.length <= a.length * 0.8, `compact ${c.length} vs long ${a.length}`);
  assert.ok(c.length < 5500, 'a mid-game observation stays small: ' + c.length);
  // what the model really gets is the compact form
  const sent = JSON.parse(bodies[bodies.length - 1].messages[1].content);
  assert.ok(sent.pop && sent.pop.max === undefined && sent.preset === undefined && sent.team === undefined);
  assert.ok(typeof sent.map.grid === 'string' && sent.map.grid.split('/').length === 16 && sent.map.starts === undefined);
  const empty = (v) => v === null || v === '' || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && v && Object.keys(v).length === 0);
  const walk = (o, path) => { for (const [k, v] of Object.entries(o)) { assert.ok(!empty(v), `empty ${path}${k}`); if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path + k + '.'); } };
  walk(compactObs(long), '');
  const o = compactObs(long);
  assert.ok(!('bounty_gold' in (o.caravans || {})) && !('effect' in (o.weather || {})), 'weather effect and caravan rule are in the prompt, not here');
  assert.ok(!JSON.stringify(o.units).includes('"hp":100') && !JSON.stringify(o.buildings).includes('"hp":100'));
  assert.ok(Object.values(o.resource_clusters).every((l) => l.every((r) => r.length === 6)), 'clusters are [id, x, y, amount, d, camp]');
  assert.ok(o.last_commands.every((f) => f.ok === undefined) && !o.last_commands.some((f) => f.cmd === 'say'));
  assert.ok(o.last_commands.some((f) => f.error === 'insufficient_resources'));
  assert.deepEqual(o.turn_before.orders, ['train 2x archer: ok'], 'say: ok is left out');
});

test('observation 1.9: expandObs gives the scripted bots the long form back (units, buildings, clusters, map, pop, workers)', async () => {
  const { long, system } = await midGame();
  const back = expandObs(compactObs(long), factsOfPrompt(system));
  for (const k of ['t', 'you', 'res', 'pop', 'tier', 'army_value', 'units', 'buildings', 'minor_buildings', 'enemy_units', 'enemy_buildings', 'enemy_minor_buildings']) assert.deepEqual(back[k], long[k], k);
  assert.deepEqual(back.workers, { ...long.workers }, 'workers');
  assert.deepEqual(back.map, { ...long.map }, 'map');
  assert.deepEqual([...back.resource_clusters].sort((x, y) => x.id - y.id), [...long.resource_clusters].sort((x, y) => x.id - y.id), 'clusters');
  assert.equal(back.preset, long.preset);
  assert.deepEqual(back.victory, long.victory, 'victory');
  assert.equal(back.weather?.effect, long.weather?.effect);
});

test('observation 1.9: every field the prompt documents exists, and every field the model gets is documented', async () => {
  const { long } = await midGame();
  const o = compactObs(long);
  const prompt = buildSystemPrompt('fast');
  const section = prompt.slice(prompt.indexOf('OBSERVATION.'), prompt.indexOf('SERVER HELPERS'));
  // a) every documented field name is in the OBSERVATION part of the prompt
  for (const f of OBS_FIELDS) assert.ok(new RegExp(`\\b${f}\\b`).test(section), `prompt does not document ${f}`);
  // b) every field of a real observation is documented
  for (const k of Object.keys(o)) assert.ok(OBS_FIELDS.includes(k), `undocumented field ${k}`);
  // c) the fields that always exist do exist
  for (const k of ['t', 'you', 'res', 'pop', 'tier', 'workers', 'army_value', 'buildings', 'resource_clusters', 'map', 'clock', 'meta', 'last_commands', 'last_note', 'turn_before']) assert.ok(k in o, `missing ${k}`);
  // a field is missing exactly when it is empty
  for (const k of ['units', 'enemy_units', 'enemy_buildings', 'enemy_minor_buildings', 'minor_buildings', 'since_last_round', 'standing_orders', 'events']) assert.equal(k in o, !!long[k] && (Array.isArray(long[k]) ? long[k].length > 0 : Object.keys(long[k]).length > 0), k);
  // d) sub-fields named in the prompt
  for (const w of ['stuck_ids', 'idle_ids', 'seen_ago', 'next_in', 'time_left_s', 'sudden_death_in_s', 'enemy_starts', 'queued_since_set', 'secs_left', 'going_to', 'units_near', 'explored_pct', 'then =']) assert.ok(prompt.includes(w), `prompt does not name ${w}`);
  assert.ok('time_left_s' in o.clock && 'start' in o.map && 'enemy_starts' in o.map && 'explored_pct' in o.map && o.map.size > 0);
  assert.ok((o.standing_orders || []).every((l) => /^#\d+ (auto_train|attack_wave|auto_build_houses)/.test(l)));
  // e) the prompt text does not name the old shapes
  assert.ok(!/obs\.|"effect"|ok:true/.test(prompt));
});

test('system prompt 1.9: version, size, no duplicated rules', () => {
  assert.equal(PROMPT_VERSION, 'rts-llm-1.9');
  const p = buildSystemPrompt('fast');
  console.log(`# system prompt chars: ${p.length}, ~tokens ${Math.round(p.length / 3.5)}`);
  assert.ok(p.length < 17000, 'shorter than the 18.2k of rts-llm-1.8: ' + p.length);
  const count = (re) => (p.match(re) || []).length;
  assert.equal(count(/mirrored/g), 1, 'the map is said to be mirrored once');
  assert.equal(count(/auto_train\(/g), 0, 'the standing order arguments are in the tool descriptions, not repeated');
  for (const w of ['last_note', 'turn_before', 'since_last_round', 'saving_for', 'time_left_s', 'queued_since_set', 'HOLDS', 'stuck_ids', 'second request', 'WEATHER', 'CARAVANS', 'CHAT', 'MARKET', 'WONDER', 'RELIC SHRINES', 'Counters:', 'Tiers:']) assert.ok(p.includes(w), w);
  assert.ok(p.includes('Rule preset: fast'));
});

// ---------- held purchases: a queue ----------
function fakeGame(res, standing) {
  const units = { spearman: { cost: { food: 50, wood: 25 } }, worker: { cost: { food: 50 } } };
  return { t: 100, over: false, rules: { timeLimitS: 1800, suddenDeath: 1320 }, players: { 1: { alive: true, res, standing, faction: { units }, events: [], killFeed: [], unitStats: {} } } };
}
const player = (extra = {}) => new LlmPlayer({ name: 'H', base_url: 'http://127.0.0.1:1/v1', model: 'm', ...extra }, { pid: 1 });
const fail = (need) => ({ ok: false, error: 'insufficient_resources', message: 'x', need });
const issue = (p, cmd, need, tick = 100) => { p.batches.push({ req: 3, expected: 1, results: [], round: null }); p.recordResult(cmd, fail(need), tick); return p.feedback[p.feedback.length - 1]; };
const run = (p, g) => { const out = p.takeCommands(g); for (const x of out) p.recordResult(x.cmd, { ok: true, tier: 2 }, g.t); return out; };

test('held purchases: a second held order does not replace the first; both are bought, one after the other, and the standing orders resume once', () => {
  const g = fakeGame({ food: 44, wood: 10, gold: 5 }, [{ kind: 'train', id: 7, unit: 'spearman', bid: 85, btype: 'barracks', keep: 2, until: null }]);
  const p = player();
  p.takeCommands(g);
  const f1 = issue(p, { cmd: 'advance_tier' }, { food: 400, gold: 150 });
  assert.match(f1.held, /^HELD: auto_train spearman at 85/);
  const f2 = issue(p, { cmd: 'build', building_type: 'barracks', near: [20, 20] }, { wood: 140 });
  assert.match(f2.held, /^HELD/);
  assert.equal(p.holds.length, 2);
  assert.equal(p.m.held, 2);
  // cancel_standing for the spearman order, once
  let out = run(p, g);
  assert.deepEqual(out.map((x) => x.cmd.cmd), ['cancel_standing']);
  // first becomes affordable: only the first is placed
  g.t += 20; g.players[1].res = { food: 500, wood: 300, gold: 200 };
  out = run(p, g);
  assert.deepEqual(out.map((x) => x.cmd.cmd), ['advance_tier']);
  assert.equal(p.holds.length, 1, 'the second one is next');
  assert.ok(p.feedback.some((f) => f.cmd === 'advance_tier' && /next held order/.test(f.note || '')));
  assert.deepEqual(run(p, g).map((x) => x.cmd.cmd), ['build'], 'no standing order resumes yet: one is still held');
  assert.equal(p.holds.length, 0);
  out = run(p, g);
  assert.deepEqual(out.map((x) => x.cmd.cmd), ['auto_train'], 'after the last one the paused standing order runs again');
  assert.equal(p.m.hold_bought, 2);
});

test('held purchases: re-issuing the same order keeps its timer; a different count only updates the order', () => {
  const g = fakeGame({ food: 44, wood: 10, gold: 5 }, [{ kind: 'train', id: 7, unit: 'spearman', bid: 85, btype: 'barracks', keep: 2, until: null }]);
  const p = player();
  p.takeCommands(g);
  issue(p, { cmd: 'train', building_id: 85, unit_type: 'spearman', count: 3 }, { food: 150 });
  const until = p.hold.until;
  g.t += 600;
  const f = issue(p, { cmd: 'train', building_id: 85, unit_type: 'spearman', count: 5 }, { food: 250 }, g.t);
  assert.match(f.held, /HELD already/);
  assert.equal(p.holds.length, 1, 'still one');
  assert.equal(p.hold.until, until, 'timer not reset');
  assert.equal(p.hold.cmd.count, 5);
  assert.equal(p.hold.need.food, 250);
  assert.equal(p.m.held, 1);
  // after the original time is up it expires, although the model asked again later
  g.t = until + 1;
  p.takeCommands(g);
  assert.equal(p.holds.length, 0);
  assert.equal(p.m.hold_expired, 1);
});

test('held purchases: each has its own timer; an expired one is reported by name, the others stay; a model that buys the held order itself ends only that hold', () => {
  const g = fakeGame({ food: 44, wood: 10, gold: 5 }, [{ kind: 'train', id: 7, unit: 'spearman', bid: 85, btype: 'barracks', keep: 2, until: null }]);
  const p = player();
  p.takeCommands(g);
  issue(p, { cmd: 'advance_tier' }, { food: 400, gold: 150 });
  g.t += 1000;
  issue(p, { cmd: 'research', tech: 'plough' }, { food: 50, wood: 80 }, g.t);
  g.t = 100 + HOLD_MAX_TICKS + 1; // the first one is over its time, the second is not
  const out = run(p, g);
  assert.equal(p.holds.length, 1);
  assert.match(p.holds[0].cmd.tech, /plough/);
  assert.ok(p.feedback.some((f) => f.error === 'hold_expired' && f.cmd === 'advance_tier'));
  assert.ok(!out.some((x) => x.cmd.cmd === 'auto_train'), 'still one hold: the standing order stays paused');
  // the model buys it itself
  p.batches.push({ req: 9, expected: 1, results: [], round: null });
  p.recordResult({ cmd: 'research', tech: 'plough' }, { ok: true }, g.t);
  assert.equal(p.holds.length, 0);
  assert.deepEqual(run(p, g).map((x) => x.cmd.cmd), ['auto_train']);
  // an unrelated successful order of the same kind does not end a hold
  issue(p, { cmd: 'train', unit_type: 'archer', building_id: 1 }, { food: 400, gold: 150 }, g.t);
  p.batches.push({ req: 11, expected: 1, results: [], round: null });
  p.recordResult({ cmd: 'train', unit_type: 'worker' }, { ok: true }, g.t);
  assert.equal(p.holds.length, 1);
});

test('held purchases: more than the queue holds is refused openly, not dropped silently', () => {
  const g = fakeGame({ food: 1, wood: 1, gold: 1 }, [{ kind: 'train', id: 7, unit: 'spearman', bid: 85, btype: 'barracks', keep: 2, until: null }]);
  const p = player();
  p.takeCommands(g);
  const techs = ['plough', 'mining_1', 'carry_1', 'wood_axe', 'fletching'];
  const fb = techs.map((t) => issue(p, { cmd: 'research', tech: t }, { food: 100, wood: 100 }));
  assert.equal(p.holds.length, HOLD_QUEUE_MAX);
  assert.ok(fb.slice(0, HOLD_QUEUE_MAX).every((f) => /^HELD/.test(f.held)));
  assert.match(fb[HOLD_QUEUE_MAX].held, /^NOT HELD/);
  assert.equal(p.m.hold_refused, 1);
});

test('held purchases: saving_for shows the held order and the ones waiting behind it', () => {
  const g = richGame(2);
  const p = player();
  p.takeCommands(g);
  assert.ok(g.command(1, { cmd: 'auto_train', unit_type: 'worker' }).ok);
  g.players[1].res = { food: 44, wood: 10, stone: 0, gold: 5 };
  issue(p, { cmd: 'advance_tier' }, { food: 400, gold: 150 }, g.t);
  issue(p, { cmd: 'build', building_type: 'barracks', near: [20, 20] }, { wood: 140 }, g.t);
  assert.equal(p.holds.length, 2);
  const obs = p.buildObs(g, { ...round0, startTick: g.t, pre: { feedback: [], toolErrors: [], lastError: null } });
  assert.match(obs.saving_for.order, /advance_tier/);
  assert.equal(obs.saving_for.then.length, 1);
  assert.match(obs.saving_for.then[0].order, /build barracks/);
  assert.equal(obs.saving_for.then[0].need.wood, 140);
  assert.ok(obs.saving_for.seconds_left > 0 && obs.saving_for.then[0].seconds_left > 0);
  const c = compactObs(obs);
  assert.ok(c.saving_for.info === undefined && c.saving_for.then.length === 1 && /auto_train worker/.test(c.saving_for.paused_standing_orders[0]));
});

// ---------- every empty reply is retried ----------
test('retry: an empty reply after a failed retry is retried as well (prompt: every empty reply gets a second request)', async () => {
  const m = await startMock({ delayMs: 3, emptyEvery: 1, strategy: 'boom' });
  try {
    const live = new LiveMatch({ seed: 9, p1: cfg('E', m.url), p2: 'scripted:turtle', record: false, maxGameSeconds: 40 });
    await live.run({ speed: 40 });
    const s = live.result.agents[0];
    assert.ok(s.empty_replies >= 4);
    assert.ok(s.retries >= s.empty_replies - 1, `retries ${s.retries}, empty ${s.empty_replies}`); // only the reply that is still open when the match ends may miss its retry
    assert.ok(s.retry_failed >= s.retries - 1 && s.retry_ok === 0);
  } finally { await m.close(); }
});

// ---------- HUD ----------
test('HUD: tok/s source and the invalid-order split are short and only list what happened', () => {
  assert.equal(srcName('stream-decode'), 'stream');
  assert.equal(srcName('wall-latency'), 'wall');
  assert.equal(srcName('server'), 'server');
  assert.equal(srcName(null), '-');
  assert.equal(invalidSplit({ resources: 2, target: 0, args: 1, other: 0, parse: 3 }), 'resources 2 · args 1 · parse 3');
  assert.equal(invalidSplit({ resources: 0, target: 0, args: 0, other: 0, parse: 0 }), '');
  assert.equal(invalidSplit(null), '');
  assert.ok(invalidSplit({ resources: 120, target: 99, args: 99, other: 99, parse: 99 }).length < 70, 'wraps to two lines at most on a 250 px card');
});

test('HUD: the agent reports source, empty replies and the invalid split', async () => {
  const m = await startMock({ delayMs: 3, emptyEvery: 3, badRate: 0.5, strategy: 'boom' });
  try {
    const live = new LiveMatch({ seed: 9, p1: cfg('Hud', m.url), p2: 'scripted:turtle', record: false, maxGameSeconds: 60 });
    await live.run({ speed: 40 });
    const h = live.slots[0].agent.hud();
    assert.ok(['stream-decode', 'wall-latency'].includes(h.tokSource));
    assert.ok(h.empty >= 1);
    assert.deepEqual(Object.keys(h.invalidBy), ['resources', 'target', 'args', 'other', 'parse']);
    assert.ok(h.invalid >= 1);
  } finally { await m.close(); }
});

test('log tools: subjects and entity lists from the compact observation equal those from the long form (owner is left out in a 1v1)', async () => {
  const { resolveSubjects, entitiesOf } = await import('../../../tools/subjects.mjs');
  const long = {
    t: 968, you: 1, team: 1,
    units: [{ type: 'swordsman', n: 3, xy: [38, 40], ids: '267,271,275', hp: 100 }, { type: 'archer', n: 2, xy: [22, 25], ids: '281,295', hp: 100 }],
    buildings: [{ id: 45, type: 'town_center', xy: [18, 18], hp: 100 }, { id: 236, type: 'stables', xy: [20, 30], hp: 100 }],
    enemy_units: [{ type: 'archer', n: 9, xy: [49, 51], owner: 2, ids: '1,2', hp: 100 }, { type: 'ram', n: 2, xy: [36, 36], owner: 2, ids: '254,262', hp: 80 }],
    enemy_buildings: [{ id: 46, type: 'town_center', xy: [106, 106], owner: 2, hp: 100, vis: true }, { id: 47, type: 'barracks', xy: [90, 100], owner: 2, seen_ago: 30, vis: false }],
    enemy_minor_buildings: [{ id: 48, type: 'tower', xy: [60, 60], owner: 2, n: 1 }],
    map: { size: 128, explored_pct: 30, start: [18, 18], starts: [{ player: 1, xy: [18, 18], rel: 'you' }, { player: 2, xy: [106, 106], rel: 'enemy' }], grid: Array(16).fill('................') },
  };
  const c = compactObs(long);
  assert.ok(c.enemy_units.every((e) => e.owner === undefined), 'the model is not sent the owner in a 1v1');
  const cmds = [
    [{ cmd: 'attack_move', units: 'army', target: 46 }, { cmd: 'note', text: 'Full push on enemy TC' }],
    [{ cmd: 'attack_move', units: '267', target: [37, 37] }],
    [{ cmd: 'train', building_id: 236, unit_type: 'light_cavalry' }, { cmd: 'note', text: 'Rams are coming' }],
    [{ cmd: 'attack_move', units: 'army', target: 47 }],
  ];
  for (const p of [1, 2]) for (const cm of cmds) {
    const foe = p === 1 ? 2 : 1; // the long form names the opponent; the compact one does not
    const own = (l) => l.map((e) => ('owner' in e ? { ...e, owner: foe } : e));
    const lp = { ...long, you: p, enemy_units: own(long.enemy_units), enemy_buildings: own(long.enemy_buildings), enemy_minor_buildings: own(long.enemy_minor_buildings) };
    const a = resolveSubjects(JSON.stringify(lp), cm, p);
    const b = resolveSubjects(JSON.stringify(compactObs(lp)), cm, p);
    assert.deepEqual(b, a);
  }
  assert.equal(resolveSubjects(JSON.stringify(c), cmds[0], 1).find((s) => s.role === 'target').owner, 2, 'enemy town center keeps owner 2');
  assert.deepEqual(entitiesOf(c), entitiesOf(long));
  // with an ally or more opponents the owner stays in the observation (it cannot be inferred)
  const team = { ...long, map: { ...long.map, starts: [...long.map.starts, { player: 3, xy: [50, 18], rel: 'ally' }] } };
  assert.ok(compactObs(team).enemy_units.every((e) => e.owner === 2));
  // and the real mid-game observation (long vs compact) gives the same subjects
  const mid = (await midGame()).long;
  for (const cm of cmds) assert.deepEqual(resolveSubjects(JSON.stringify(compactObs(mid)), cm, mid.you), resolveSubjects(JSON.stringify(mid), cm, mid.you));
});
