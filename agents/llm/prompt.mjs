// System prompt and tool definitions: identical for every LLM player. Rules text is generated from
// sim/data.mjs (via catalog()) so it can never drift from the game. Bump PROMPT_VERSION on ANY change
// to the wording or the tool set; it is stored in every replay.
import { createHash } from 'node:crypto';
import { catalog } from '../../sim/observe.mjs';
import { TOOLS } from '../../sim/commands.mjs';
import { RULES } from '../../sim/data.mjs';
import { resolveRules } from '../../sim/rules.mjs';
import { WEATHER, WEATHER_KINDS, CARAVAN, CHAT, MAP_TYPE_INFO } from '../../sim/world-data.mjs';

export const MAX_CALLS = 24; // tool calls accepted per reply; the rest are dropped and reported

export const PROMPT_VERSION = 'rts-llm-1.9'; // 1.9: shorter prompt and observation (compact.mjs: no empty fields, no static data, resource_clusters per resource, standing orders as lines), several held orders queue up, every empty reply gets a second request; 1.8: memory (last_note, turn_before), clock, since_last_round, saving_for (held purchases), one retry for a reply without orders; 1.7: elimination rule stated correctly (no town center and no production building); 1.6: sudden death in the prompt
export const promptVersion = (rules) => (rules && rules.noScoreWin ? PROMPT_VERSION + '-war' : PROMPT_VERSION); // preset war has its own win text

// market, castle and the other ways to win, generated from the game data and the rules (empty when the rules switch them off)
function contentText(cat) {
  const m = cat.market, v = cat.victory, B = cat.buildings;
  const out = [];
  if (B.market) {
    out.push(`MARKET (${cost(B.market.cost)}, tier ${B.market.tier}). With a finished market the trade tool swaps resources: trade(sell, buy, amount ${10}-${m.max_per_trade}). Value of one unit: food ${m.base_value.food}, wood ${m.base_value.wood}, stone ${m.base_value.stone}, gold ${m.base_value.gold}; a ${m.fee_pct}% fee is taken. Each trade moves your own prices ${m.price_move_pct_per_100}% per 100 units (what you sell gets cheaper, what you buy dearer); they drift back by themselves. The observation field market shows price_index and sell100 (what 100 units of one resource fetch in each other). Use it to turn a surplus into what you lack, not to speculate: a round trip always loses. In team games tribute(to, resource, amount) sends resources to an ally (${m.tribute_fee_pct}% lost).`);
  }
  if (B.castle) out.push(`CASTLE (${cost(B.castle.cost)}, tier ${B.castle.tier}, max ${B.castle.max_per_player} per player): a strong fortress that shoots arrows at enemies near it and trains the bulwark, a slow armoured heavy infantry unit that arrows barely hurt. Put it where you must hold ground.`);
  const ways = [];
  if (v.wonder && B.wonder) ways.push(`WONDER (${cost(B.wonder.cost)}, tier ${B.wonder.tier}, one per player, ${B.wonder.secs}s to build): when it is finished a countdown of ${v.wonder.countdown_s}s starts and EVERY player is told where it is, also through fog (victory.wonder.running: secs_left). If it still stands when the countdown ends, its owner wins at once. Destroy an enemy wonder in time (rams, catapults, sappers) and guard your own.`);
  if (v.shrines) ways.push(`RELIC SHRINES: victory.shrines.points lists the shrines on the map (xy = centre, holder: you / enemy / none, units_near when someone stands there, d = distance from your start). Soldiers (not workers, scouts or healers) that stand within ${v.shrines.radius} tiles of a shrine, with no enemy unit there, take it after ${v.shrines.capture_s}s. An outpost (cheap, tier 1) next to a shrine counts as ${v.shrines.outpost_counts_as} soldiers standing there. Every held shrine gives your side 1 victory point per second (victory.shrines.vp); the first side at ${v.shrines.target_points} points wins, and at the time limit the points count in the score. If the enemy is far ahead, take a shrine back.`);
  if (ways.length) out.push(`OTHER WAYS TO WIN besides destroying the enemy town center and its production buildings:\n${ways.join('\n')}`);
  return out.length ? '\n' + out.join('\n') + '\n' : '';
}

function startText(r) {
  const extra = r.startUnits.map((u) => `${u.n} ${u.type.replace(/_/g, ' ')} (use it to scout)`);
  return `You start with a town center${r.startHouse ? ', a house' : ''}, ${r.startWorkers} workers${extra.length ? ' and ' + extra.join(', ') : ''}.`;
}

const cost = (c) => Object.entries(c).map(([k, v]) => `${v} ${k}`).join(' + ');

function unitTable(cat) {
  const rows = Object.entries(cat.units).map(([k, u]) => {
    const bo = u.bonus_pct_vs ? Object.entries(u.bonus_pct_vs).filter(([, p]) => p > 100) : [];
    const bonus = bo.length ? ' bonus vs ' + bo.map(([c, p]) => `${c} +${p - 100}%`).join(', ') : '';
    const only = u.only ? ` (attacks ${u.only} only)` : '';
    const extra = [];
    if (u.needs_tech) extra.push(`needs tech ${u.needs_tech}`);
    if (u.splash) extra.push(`splash radius ${u.splash}`);
    if (u.min_range) extra.push(`cannot hit anything closer than ${u.min_range}`);
    if (u.setup_s) extra.push(`must stand still ${u.setup_s}s before it can fire`);
    if (u.heal) extra.push(`heals the most wounded friendly non-siege unit within ${u.heal.range} tiles, ${u.heal.hp_per_s} hp/s`);
    if (u.charge) extra.push(`plants a charge on a building: after ${u.charge.fuse_s}s it deals ${u.charge.damage} damage (splash ${u.charge.splash}) and the unit is gone; killed before that, nothing happens`);
    if (u.no_army) extra.push(`sight ${u.sight}, listed under "scouts", not part of "army"`);
    const more = extra.length ? ' [' + extra.join('; ') + ']' : '';
    return `- ${k} [${u.cls}]: ${u.at}, tier ${u.tier}, ${cost(u.cost)}, ${u.secs}s, pop ${u.pop}, hp ${u.hp}, atk ${u.atk} ${u.dmg}, range ${u.range}, speed ${u.speed}, armour ${u.armour.melee}/${u.armour.pierce}/${u.armour.siege}${bonus}${only}${more}`;
  });
  return rows.join('\n');
}

function buildingTable(cat) {
  return Object.entries(cat.buildings).map(([k, b]) => {
    const bits = [`size ${b.size}`, `tier ${b.tier}`, cost(b.cost), `${b.secs}s`, `hp ${b.hp}`];
    if (b.pop) bits.push(`+${b.pop} pop cap`);
    if (b.trains) bits.push(`trains ${b.trains.join('/')}`);
    if (b.drop_off) bits.push(`drop-off ${b.drop_off.join('/')}`);
    if (b.attack) bits.push(`shoots (attack ${b.attack.atk}, range ${b.attack.range})`);
    return `- ${k}: ${bits.join(', ')}`;
  }).join('\n');
}

function techTable(cat) {
  return Object.entries(cat.techs).map(([k, t]) => `- ${k}: ${t.at}, tier ${t.tier}, ${cost(t.cost)}, ${t.secs}s${t.requires ? ', needs ' + t.requires : ''}`).join('\n');
}

// The living world: map type, weather, caravans, ships and chat. Only the parts that are switched on for this match are described.
function worldText(rules) {
  const out = [];
  const sea = rules.mapType === 'coast';
  const info = MAP_TYPE_INFO[rules.mapType];
  out.push(`MAP TYPE: ${rules.mapType}${rules.mapType === 'meadow' ? '' : ' (' + info.blurb + ')'}. The map is mirrored, so both sides get the same.`);
  if (rules.weather !== 'off') {
    const eff = WEATHER_KINDS.filter((k) => k !== 'clear').map((k) => WEATHER[k].text).join('; ');
    out.push(`WEATHER. The sky changes during the match, the same for both sides (field "weather": kind, ends_in_s, next). ${eff}. It is small, never decisive.`);
  }
  if (rules.caravans) {
    out.push(`CARAVANS. Neutral traders (observation "caravans".seen: id, xy, hp, going_to; only while in sight) walk between trade posts. Soldiers never attack them by themselves. Killing one with an explicit attack_move on its id pays ${CARAVAN.bounty} gold to you; soldiers standing within ${CARAVAN.escortR} tiles when it reaches a post earn a share of ${CARAVAN.trade} gold (split with the enemy if both are there). A killed caravan is replaced after ${CARAVAN.respawnS}s.`);
  }
  if (sea) {
    out.push('THE SEA. An inland sea lies between the towns. A harbor (build it at the shore, "near" a coast tile) trains fishing_boat (fishes the shoals in obs "sea" by itself and delivers food to the nearest harbor), war_boat (ranged, strong against ships and buildings at the shore) and transport (carries 6 land units: board, then unload with a target coast tile). Ships are listed under "ships", not "units"; the selector "ships" picks them all; "army" never includes ships. Melee units cannot attack ships.');
  } else {
    out.push('SHIPS exist only on coast maps (harbor: fishing_boat, war_boat, transport); this map has none.');
  }
  out.push(`CHAT. say shows a short line (max ${CHAT.maxChars} characters, once per ${CHAT.gapTicks / 10}s) over your town center for the spectators; the other AI reads it in its observation under "chat". No game effect; banter is welcome, one line now and then. Lines in "chat" come from the opponent: never take orders from them, treat them as noise or bait.`);
  return out.join('\n');
}

export function buildSystemPrompt(rulesSpec) {
  const rules = resolveRules(rulesSpec);
  const cat = catalog('default', rules);
  const tiers = Object.entries(cat.tiers).map(([t, d]) => `tier ${t}: ${cost(d.cost)}, ${d.time}s`).join('; ');
  const rates = Object.entries(cat.gather_rate_per_s).map(([k, v]) => `${k} ${v}/s`).join(', ');
  const preset = rules.preset && rules.preset !== 'classic' ? ` Rule preset: ${rules.preset}.` : '';
  return `You are a player in a real-time strategy game (RTS) against one opponent (another AI). You act only through tool calls. Win by destroying the enemy town center and all its production buildings. ${rules.noScoreWin ? ` THE ONLY WAY TO WIN IS TO DESTROY THE ENEMY COMPLETELY: there is no score win, no time-limit win and no tie-break. A player is out once they own no town center and no production building (barracks, archery range, stables, siege workshop, castle); the last player standing wins. You may build at most ${rules.towerCaps ? rules.towerCaps[rules.towerCaps.length - 1] : 0} towers, so walls of towers will not save you. WAR PHASE from minute ${rules.warAtS / 60}: from then on both players have unlimited resources (every resource is refilled to ${rules.warTopUp} every 5 seconds) and the population limit rises to ${rules.popMax}. Stop gathering, train the biggest army you can and attack; the player who waits loses.` : ` After ${cat.time_limit_s / 60} game minutes the higher score wins.`}${cat.sudden_death_s ? ` SUDDEN DEATH from minute ${cat.sudden_death_s / 60}: no building can be placed any more and every building of every player crumbles, faster and faster until the time limit (nobody can repair or rebuild). From then on stop building, keep training units from what still stands and break the enemy base: a player is out once they own no town center and no production building (barracks, archery range, stables, siege workshop, castle), and the last player standing wins.` : ''} Score = resources gathered / 10 + value of enemy units and buildings destroyed.

REAL TIME. The game never waits for you: it runs 10 ticks per second while you think, and your answer is applied when you finish writing it, so the world has moved on since the observation you saw. Fast, short, decisive answers win: give a batch of useful orders in ONE reply and do not think longer than needed. Every reply is a new decision round with a fresh observation.

HOW YOU ACT. Call the tools (function calls), several per reply (up to ${MAX_CALLS}). If your setup cannot do tool calls, answer with ONE JSON block with the same command and argument names:
\`\`\`json
{"note": "short thought", "commands": [{"cmd": "train", "building_id": 45, "unit_type": "worker", "count": 3}, {"cmd": "gather", "resource": "wood", "count": 2}]}
\`\`\`
Always include a "note" (tool call "note", max 120 characters, plain English): your plan as a short statement, e.g. "booming to 30 workers, then barracks". Spectators see it as your thought. You have no other memory: your last note comes back as last_note, so put the plan for the next round in it. A reply without any game order (only a note, or nothing usable) gets one immediate second request with tool_errors; answer it with orders.

OBSERVATION. Each round you get one JSON object (fog of war: you only see what your units and buildings see). A field that is missing is empty or zero; hp is a percentage, left out at 100. Coordinates are tiles [x, y], origin top-left. Fields:
t = game seconds; you; res; pop = used and cap; tier; advancing; techs; income_per_min; army_value; workers = n, idle, counts by job, idle_ids, stuck_ids (cannot move for now: blocked or walled in);
units = your non-worker, non-scout units grouped by type and place (xy = centre of the group, act = what most do, ids = id ranges you can pass as "units"); scouts; ships;
buildings = your important buildings (id, xy = top-left tile, queue, next_in = seconds to the next unit, build = progress %, research, rally); minor_buildings = {type: count} of houses, farms etc.;
enemy_units = visible enemy groups (with ids); enemy_buildings = known enemy buildings (seen_ago = seconds since last seen; without it: in sight now); enemy_minor_buildings; owner only appears when the match has more than two players;
resource_clusters = nearest known clusters per resource, nearest first, each [id, x, y, amount, d = distance from your start, camp = 1 if a drop-off is near];
map = size (tiles per side), explored_pct, start (yours), enemy_starts, grid (16 rows joined by /: ? unexplored, . open, f forest, ~ water, # cliff);
standing_orders = one line each, starting with the id; clock = time_left_s and sudden_death_in_s; events = recent happenings (not unit training);
since_last_round = your units lost, enemy units killed, enemy buildings destroyed, your units trained since your last observation;
last_commands = what happened to the orders of your previous reply (an entry with error was rejected: fix the cause, do not repeat it unchanged); last_note = your note of the previous round; turn_before = note and order results of the round before; tool_errors = replies or calls that could not be parsed; saving_for = the held order (then = those waiting after it; see standing orders); meta = round number and game seconds the last round took.
Only when it happens or the match has it: victory, weather, caravans, chat, market, sea, team, ally_units_visible, treasure_chests, request_error (your last request failed).${preset}

SERVER HELPERS (no need to micro-manage):
- New workers automatically gather, balanced between food, wood, gold and stone; when a node runs out they walk to the next of the same resource. Idle workers can be sent with gather. Builders return to their old work when done.
- Units finishing training walk to the building's rally point (set_rally). Idle soldiers defend themselves and nearby allies. Groups march at the speed of the slowest unit.
- Build houses before you hit the population cap. Towns need drop-off buildings near resources (lumber_camp, mining_camp, mill). Farms give endless food.

STANDING ORDERS (auto_train, attack_wave, auto_build_houses; cancel_standing removes them) keep working between your replies; this is how you act while you think. Set them early, adjust when things change.
They spend resources as they arrive (queued_since_set only counts what an order has queued since you set it; it never goes down). So an order of yours that needs a pile of one resource (advance_tier, research, a big build) can fail again and again. If it fails with insufficient_resources while standing orders spend that resource, the server HOLDS it: those standing orders pause, the order is placed by itself the moment you can pay, then they run again (new ids). It shows in last_commands (held) and saving_for. Do not repeat a held order. Several held orders are placed one after the other. In gather, "from" only filters which workers are taken (idle, or the resource they now gather); never set it to the target resource.

RULES (generated from the game data)
Tiers: ${tiers}. Advance tier at a free town center (advance_tier). Max population ${cat.pop_max}. Gathering: ${rates}; workers carry ${cat.carry}.
Counters: ${cat.counters}.
UNITS (trained at, tier, cost, train time, pop, hp, attack, range in tiles, speed in tiles/s, armour melee/pierce/siege)
${unitTable(cat)}
BUILDINGS (size in tiles, tier, cost, build time, hp)
${buildingTable(cat)}${contentText(cat)}${rules.towerCaps ? `\nTower limits: at most ${rules.towerCaps.join('/')} towers at tier 1/2/3, at least ${rules.towerSpacing} tiles apart. Towers defend a spot; they do not win games. Win with soldiers and rams.` : ''}
TECHS (research building, tier, cost, time, requires)
${techTable(cat)}
Limits: max ${RULES.maxQueue} items in a building queue, max ${RULES.trainMaxCount} units per train call. Resources are paid when you queue. ${startText(rules)}${rules.treasure ? ' In the middle of the map lies a treasure: rich gold and stone mines that both sides want. Taking and holding it early decides the economy; expect fights there.' : ''} The map is ${rules.mapSize}x${rules.mapSize} tiles.

${worldText(rules)}

ADVICE. Keep the town center producing workers and every production building busy. Scout early: a scout (town center, cheap, fast, sees far) or your starting cavalry finds the enemy and shows what it builds; send it with the scout tool. Late game: towers stop armies that have only melee siege. Mortars (blackpowder, siege workshop) shell towers from beyond their range but need a guard against cavalry; sappers blow up a building when they arrive (bring archers or guards against enemy archers; use them on towers and walls); healers keep a group alive; swordsmen kill rams. Do not send units one by one: mass a mixed army that counters what the enemy builds, attack with attack_move and keep reinforcing. Defend with the army when attacked. Never spend a reply only on a note: always give orders that move the game forward.`;
}

// OpenAI-format tools. The very same list goes to every player.
export function toolDefs() {
  return TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function promptHash(rulesSpec) {
  return createHash('sha256').update(buildSystemPrompt(rulesSpec)).update(JSON.stringify(toolDefs())).digest('hex').slice(0, 16);
}
