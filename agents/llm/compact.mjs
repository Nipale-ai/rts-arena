// The observation the LLM players get (rts-llm-1.9): the full observe() object, written shorter. Same information, fewer characters.
//   compactObs(obs)          -> new object (the input is never changed); it is JSON.stringify-ed into the user message
//   expandObs(compact, sys)  -> the long form again, for the scripted bots behind agents/llm/mock-server.mjs (they read the long form)
//
// What is left out, and where the model finds it instead (all of it is in the system prompt, see prompt.mjs):
//   - nothing that is empty: no null, no "", no [] and no {} (prompt: "A field that is missing is empty")
//   - things that never change in a match: pop.max, preset, wonder countdown, shrine target, caravan bounty and rule text,
//     weather effect text, fee, the sea note, the "info" text of saving_for
//   - defaults: hp 100 (hp is only written when below 100), owner (only written when the match has more than two players),
//     zero counts of workers (build, other), units_near 0/0 of a shrine, ok:true of an order
//   - one more copy of the same thing: map.starts is map.start plus enemy_starts / ally_starts
// And these are written in a denser form: resource_clusters as lists per resource, minor_buildings as {type: n},
// standing_orders as one line each, the map grid as one string, ok/error of an order as the presence of "error".
import { POP_MAX } from '../../sim/data.mjs';
import { WEATHER, CARAVAN } from '../../sim/world-data.mjs';

// every top-level field of the observation, in the order of the prompt (prompt.mjs documents each of them; test/small19 checks both ways)
export const OBS_FIELDS = ['t', 'you', 'team', 'res', 'pop', 'tier', 'advancing', 'techs', 'income_per_min', 'army_value', 'workers', 'units', 'scouts', 'ships', 'buildings', 'minor_buildings',
  'enemy_units', 'enemy_buildings', 'enemy_minor_buildings', 'ally_units_visible', 'resource_clusters', 'map', 'standing_orders', 'clock', 'events', 'since_last_round', 'last_commands', 'last_note',
  'turn_before', 'tool_errors', 'request_error', 'saving_for', 'meta', 'victory', 'weather', 'caravans', 'chat', 'market', 'sea', 'treasure_chests'];

const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.keys(v).length === 0);

// hp is a percentage; 100 is the normal case and is not written
const noFullHp = (e) => {
  if (e && e.hp === 100) { const { hp, ...rest } = e; void hp; return rest; }
  return e;
};
const without = (e, key) => {
  if (!e || !(key in e)) return e;
  const { [key]: gone, ...rest } = e;
  void gone;
  return rest;
};

const standingLine = (s) => {
  const { id, order, ...rest } = s;
  return `#${id} ${order}` + Object.entries(rest).map(([k, v]) => ` ${k}=${v !== null && typeof v === 'object' ? JSON.stringify(v) : v}`).join('');
};

function clustersOf(list) {
  const out = {};
  for (const c of list) (out[c.res] ||= []).push([c.id, c.xy[0], c.xy[1], c.amt, c.d, c.camp ? 1 : 0]); // [id, x, y, amount, distance from your start, camp]
  return out;
}

function mapOf(m) {
  const r = { size: m.size, explored_pct: m.explored_pct, start: m.start };
  if (m.type) r.type = m.type;
  const starts = m.starts || [];
  const enemy = starts.filter((s) => s.rel === 'enemy').map((s) => s.xy);
  const ally = starts.filter((s) => s.rel === 'ally').map((s) => s.xy);
  if (enemy.length) r.enemy_starts = enemy;
  if (ally.length) r.ally_starts = ally;
  r.grid = Array.isArray(m.grid) ? m.grid.join('/') : m.grid;
  return r;
}

function victoryOf(v) {
  const r = {};
  if (v.wonder && v.wonder.running && v.wonder.running.length) r.wonder = { running: v.wonder.running };
  if (v.shrines) {
    r.shrines = {
      vp: v.shrines.vp,
      points: (v.shrines.points || []).map((p) => (p.units_near && (p.units_near.yours || p.units_near.enemy) ? p : without(p, 'units_near'))),
    };
  }
  return r;
}

const SINCE = { your_units_lost: 'lost', enemy_units_killed: 'killed', enemy_buildings_destroyed: 'destroyed', your_units_trained: 'trained' };
const SINCE_BACK = Object.fromEntries(Object.entries(SINCE).map(([k, v]) => [v, k]));

export function compactObs(obs) {
  const starts = (obs.map && obs.map.starts) || [];
  const oneEnemy = starts.filter((s) => s.rel === 'enemy').length === 1;
  const hasAlly = starts.some((s) => s.rel === 'ally');
  const dropOwner = (e) => (oneEnemy && !hasAlly ? without(e, 'owner') : e); // two players only: the one opponent is the other id (tools/subjects.mjs reads old and new logs)
  const FIX = {
    team: (v) => (hasAlly ? v : undefined),
    preset: () => undefined,
    pop: (v) => ({ used: v.used, cap: v.cap }),
    workers: (w) => Object.fromEntries(Object.entries(w).filter(([k, v]) => k === 'n' || k === 'idle' || v)),
    units: (l) => l.map(noFullHp),
    scouts: (l) => l.map(noFullHp),
    ships: (l) => l.map(noFullHp),
    buildings: (l) => l.map(noFullHp),
    market: (m) => ({ price_index: Object.fromEntries(Object.entries(m.price_index).map(([k, v]) => [k, Math.round(v * 100) / 100])), sell100: m.sell100 }),
    victory: victoryOf,
    minor_buildings: (l) => Object.fromEntries(l.map((m) => [m.type, m.n])),
    enemy_units: (l) => l.map((e) => dropOwner(noFullHp(e))),
    enemy_buildings: (l) => l.map((e) => dropOwner(noFullHp(without(e, 'vis')))), // in sight = no seen_ago
    enemy_minor_buildings: (l) => l.map(dropOwner),
    resource_clusters: clustersOf,
    map: mapOf,
    weather: (w) => without(w, 'effect'),
    caravans: (c) => (c.seen && c.seen.length ? { seen: c.seen } : undefined),
    sea: (s) => ({ fishing_spots: s.fishing_spots }),
    standing_orders: (l) => l.map(standingLine),
    last_commands: (l) => l.filter((f) => !(f.cmd === 'say' && f.ok)).map((f) => without(f, 'ok')),
    turn_before: (t) => ({ t: t.game_s, ...(t.note ? { note: t.note } : {}), orders: t.orders.filter((x) => x !== 'say: ok') }),
    since_last_round: (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [SINCE[k] || k, v])),
    saving_for: (s) => without(s, 'info'),
    meta: (m) => ({ round: m.round, ...(m.last_round_took_game_s == null ? {} : { last_round_s: Math.round(m.last_round_took_game_s) }), ...(m.retry ? { retry: true } : {}) }),
  };
  const out = {};
  for (const [k, v] of Object.entries(obs)) {
    const nv = FIX[k] ? FIX[k](v) : v;
    if (!isEmpty(nv)) out[k] = nv;
  }
  return out;
}

// ---- the long form again (mock server only) ----
// sys: facts the long form had that are now only in the system prompt: { preset, wonder: {countdown_s}|null, shrineTarget, caravans } (see factsOfPrompt)
export function factsOfPrompt(text) {
  const num = (re) => { const m = re.exec(text); return m ? +m[1] : null; };
  const preset = /Rule preset: (\w+)/.exec(text);
  return {
    preset: preset && preset[1] !== 'classic' ? preset[1] : null,
    wonder: /WONDER \(/.test(text) ? { countdown_s: num(/countdown of (\d+)s/) } : null,
    shrineTarget: /RELIC SHRINES/.test(text) ? num(/first side at (\d+) points/) : null,
    caravans: /CARAVANS\./.test(text),
  };
}

export function expandObs(c, sys = {}) {
  const o = { ...c };
  const you = c.you ?? 1;
  const enemyIds = [], allyIds = [];
  const others = [1, 2, 3, 4].filter((i) => i !== you);
  const m = c.map || {};
  (m.enemy_starts || []).forEach(() => enemyIds.push(others.shift()));
  (m.ally_starts || []).forEach(() => allyIds.push(others.shift()));
  const owner = enemyIds.length === 1 ? enemyIds[0] : undefined;
  const full = (e) => ({ ...e, hp: e.hp ?? 100 });
  const own = (e) => (owner !== undefined && e.owner === undefined ? { ...e, owner } : e);
  if (sys.preset) o.preset = sys.preset;
  o.pop = { ...c.pop, max: c.pop?.max ?? POP_MAX };
  o.workers = { n: 0, idle: 0, food: 0, wood: 0, stone: 0, gold: 0, build: 0, other: 0, ...c.workers };
  o.units = (c.units || []).map(full);
  o.buildings = (c.buildings || []).map(full);
  if (c.scouts) o.scouts = c.scouts.map(full);
  if (c.ships) o.ships = c.ships.map(full);
  o.minor_buildings = Object.entries(c.minor_buildings || {}).map(([type, n]) => ({ type, n }));
  o.enemy_units = (c.enemy_units || []).map((e) => own(full(e)));
  o.enemy_buildings = (c.enemy_buildings || []).map((e) => own(e.seen_ago === undefined ? { ...full(e), vis: true } : { ...e, vis: false }));
  o.enemy_minor_buildings = (c.enemy_minor_buildings || []).map(own);
  const cl = [];
  for (const [res, list] of Object.entries(c.resource_clusters || {})) for (const [id, x, y, amt, d, camp] of list) cl.push({ id, res, xy: [x, y], amt, d, camp: !!camp });
  o.resource_clusters = cl.map((e, i) => [e, i]).sort((a, b) => a[0].d - b[0].d || a[1] - b[1]).map((e) => e[0]);
  const starts = [{ player: you, xy: m.start, rel: 'you' }];
  (m.enemy_starts || []).forEach((xy, i) => starts.push({ player: enemyIds[i], xy, rel: 'enemy' }));
  (m.ally_starts || []).forEach((xy, i) => starts.push({ player: allyIds[i], xy, rel: 'ally' }));
  o.map = { size: m.size, explored_pct: m.explored_pct, start: m.start, starts: starts.sort((a, b) => a.player - b.player), grid: String(m.grid || '').split('/') };
  if (m.type) o.map.type = m.type;
  const v = c.victory;
  if (sys.wonder || sys.shrineTarget) {
    o.victory = {};
    if (sys.wonder) o.victory.wonder = { countdown_s: sys.wonder.countdown_s, running: (v && v.wonder && v.wonder.running) || [] };
    if (sys.shrineTarget && v && v.shrines) o.victory.shrines = { target: sys.shrineTarget, vp: v.shrines.vp, points: v.shrines.points.map((p) => ({ ...p, units_near: p.units_near || { yours: 0, enemy: 0 } })) };
  }
  if (c.since_last_round) o.since_last_round = Object.fromEntries(Object.entries(c.since_last_round).map(([k, v]) => [SINCE_BACK[k] || k, v]));
  if (c.weather) o.weather = { ...c.weather, effect: WEATHER[c.weather.kind]?.text };
  if (sys.caravans) o.caravans = { ...(c.caravans || {}), bounty_gold: CARAVAN.bounty, trade_gold: CARAVAN.trade, rule: '' };
  return o;
}
