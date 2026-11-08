// A small synthetic match for the tests of the broadcast words (package C1): 10 minutes, two LLM players, key buildings of every production kind, an expansion, a wonder,
// a battle, two key decisions, a ram that razes a building, the base falls. The shape is the one of test/casters.test.mjs (events.json of tools/events.mjs).
// It takes the tools it needs as arguments, so the same match can be run through any copy of the code (the pin of the classic words was recorded on the C0 base).
//   const { ev, plan } = makeFixture({ digestObservation, buildPlan, addSlowMotion, detectMoments });

const obs = (o) => JSON.stringify({ t: 100, you: 1, tier: 1, res: { food: 10, wood: 20, stone: 30, gold: 40 }, pop: { used: 10, cap: 20 }, army_value: 500, workers: { n: 8, idle: 1 }, units: [{ type: 'archer', n: 4, xy: [20, 20] }], enemy_units: [], enemy_buildings: [], enemy_minor_buildings: [], map: { start: [18, 18], explored_pct: 10 }, ...o });
export const PLAYERS = [
  { id: 1, kind: 'llm', name: 'Qwen3.8-27B NVFP4+MTP3 (QuartzRT)', model: 'qwen3.8-27b', hardware: '1x RTX 5090 32 GB' },
  { id: 2, kind: 'llm', name: 'Qwen3.8-27B EXL3 4.0bpw+MTP (Zoe kit TP2)', model: 'qwen3.8-27b-exl3-4.0bpw', hardware: '2x RTX 5060 Ti 16 GB (TP2)' },
];

export function makeFixture({ digestObservation, buildPlan, addSlowMotion, detectMoments }, { players = PLAYERS } = {}) {
  const raid = obs({ army_value: 1055, enemy_units: [{ type: 'archer', n: 5, xy: [30, 20] }], events: [{ type: 'attacked', what: 'house' }] });
  const dec = (id, t, p, user, thought, summary = 'train 2x archer') => ({ id, t, type: 'llm_decision', p, n: id, start_tick: t - 50, thought, orders: ['train'], summary, latency_ms: 4000, completion_tokens: 400, tok_s: 100, errors: [], seen: digestObservation(user) });
  const secs = 601;
  const events = [
    { t: 600, type: 'first_contact', p: 1, other: 2, loc: [60, 60], what: 'worker' },
    { t: 900, type: 'key_building', p: 1, building: 'archery_range', loc: [30, 30] },
    { t: 1200, type: 'expansion', p: 2, loc: [120, 120], count: 2 },
    { t: 1500, type: 'key_building', p: 2, building: 'barracks', loc: [100, 100] },
    { t: 1800, type: 'key_building', p: 2, building: 'siege_workshop', loc: [104, 104] },
    { t: 2100, type: 'key_building', p: 1, building: 'stables', loc: [34, 34] },
    { t: 2500, type: 'tier_up', p: 1, tier: 2 },
    dec(1, 1000, 1, obs({}), 'Boom economy first, barracks next round.'),
    dec(2, 3000, 2, obs({}), null, 'attack, train 3x ram'),
    { t: 5600, type: 'battle', t_end: 5900, loc: [50, 50], value: 2540, kills: 34, peak_value_per_s: 225, peak_tick: 5700, participants: { 1: { lost_units: 34, lost_value: 2540, lost_buildings: 0, lost_by_type: { spearman: 20, archer: 14 }, peak_fighting: 10 }, 2: { lost_units: 0, lost_value: 0, lost_buildings: 0, lost_by_type: {}, peak_fighting: 10 } } },
    dec(3, 4400, 1, raid, 'Full push on enemy TC with whole army; queue more archers', 'attack, train 2x archer'),
    { t: 5300, type: 'base_destroyed', p: 1, loc: [20, 20], by: 2, value: 550, src: 'ram' },
    { t: 5500, type: 'building_destroyed', p: 1, building: 'barracks', loc: [20, 28], by: 2, value: 140, src: 'ram' },
    { t: 5550, type: 'building_destroyed', p: 1, building: 'archery_range', loc: [30, 30], by: 2, value: 140, src: 'ram' },
    { t: 6000, type: 'victory', winner: 2, winner_team: 2, reason: 'victory' },
  ];
  events.sort((a, b) => a.t - b.t);
  events.forEach((e, i) => { e.id = i + 1; });
  const army = [new Array(secs).fill(500), new Array(secs).fill(900)];
  const ev = {
    version: 1, replay: 'fixture', seed: 101, ticks: 6000, seconds: 600, players, events,
    final: [{ p: 1, kills: 3, losses: 40, kill_value: 300, lost_value: 3000, gathered: 1000, score: 100, tier: 2, alive: false }, { p: 2, kills: 40, losses: 3, kill_value: 3000, lost_value: 300, gathered: 2000, score: 900, tier: 2, alive: true }],
    result: { winner_team: 2, reason: 'victory', tick: 6000 }, series: { army, lost: [[], []], fighting: [[], []], destroyed: [], focus_x: [], focus_y: [], focus_spread: [] },
  };
  const hl = { scenes: [{ id: 1, rank: 1, start: 5200, end: 5950, kind: 'victory', title: '', focus: null, score: 5 }] };
  let plan = buildPlan(ev, hl, { mode: 'highlight', params: { tail_s: 10.5 } });
  plan = addSlowMotion(plan, detectMoments(ev, { max: 3 }));
  return { ev, plan };
}
