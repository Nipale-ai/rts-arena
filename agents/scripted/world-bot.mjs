// What the scripted bots do with the living world: now and then a taunt (the `say` tool); on coast maps a harbor with fishing boats and war boats,
// and a transport that lands a small party at the enemy coast; a few soldiers raid a caravan that passes near home (the bounty).
// Weather needs no code: it works for everybody. Everything here reads only the observation, like the rest of the bots.
// The taunt lines are original and short; a line is chosen by a hash of (game second, seat), never by a random number.
import { NAVAL_UNITS, NAVAL_BUILDINGS, CHAT } from '../../sim/world-data.mjs';
import { stringToIds, idsToString } from '../../sim/util.mjs';
import { SQUAD_TYPES, tune } from './common.mjs';

const LINES = {
  open: {
    rush: ['Blades out early today.', 'No time to build a wall. Good.', 'Do not unpack, you will not stay long.'],
    boom: ['Slow and fat wins the long game.', 'Take your time. I will take the whole map.', 'Farms first, speeches later.'],
    turtle: ['My walls are ready when you are.', 'Knock if you must. The gate is stubborn.', 'Safe is a fine colour on a map.'],
    towers: ['Every hill gets a tower.', 'Come within sight. I dare you.', 'Stone beats hope.'],
  },
  contact: ['I see you out there.', 'Nice scout. It will not find much.', 'Wave back, my archers are friendly.'],
  attack: ['Here we come. Mind the dust.', 'The army knocks. Open up.', 'This is the part where it gets loud.'],
  hurt: ['Lucky hit. Count it while you can.', 'That wall had a name, you know.', 'You will pay for that brick.'],
  late: ['Still standing? I am impressed.', 'Late game, thin patience.', 'One more push and we are done here.'],
  sea: ['The water is mine too.', 'Fish for dinner, boats for breakfast.', 'Your shore looks lonely.'],
};

const hash = (a, b) => {
  let h = (Math.imul(a + 0x9e37, 0x85ebca6b) ^ Math.imul(b + 0x51ed, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 15;
  return Math.imul(h, 0x2c1b3c6d) >>> 0;
};
const pick = (list, t, you) => list[hash(t, you) % list.length];

function chat(bot, o) {
  const s = bot.s, w = (s.world ||= { said: 0, lastSay: -999, contact: false, attacked: false, hurt: 0, late: false, opened: false, sea: false });
  if (o.t - w.lastSay < 70 || w.said >= 6) return;
  let line = null;
  const you = o.you;
  if (!w.opened && o.t >= 20) { w.opened = true; line = pick(LINES.open[bot.name] || LINES.open.boom, o.t, you); }
  else if (!w.contact && o.enemy_units.length && o.t > 60) { w.contact = true; line = pick(LINES.contact, o.t, you); }
  else if (!w.attacked && s.state === 'attack') { w.attacked = true; line = pick(LINES.attack, o.t, you); }
  else if (w.hurt < 1 && (o.events || []).some((e) => e.type === 'building_lost')) { w.hurt++; line = pick(LINES.hurt, o.t, you); }
  else if (!w.sea && (o.ships || []).some((x) => x.type === 'war_boat') && o.t > 200) { w.sea = true; line = pick(LINES.sea, o.t, you); }
  else if (!w.late && o.t > 900) { w.late = true; line = pick(LINES.late, o.t, you); }
  if (!line) return;
  w.said++;
  w.lastSay = o.t;
  bot.send({ cmd: 'say', text: line.slice(0, CHAT.maxChars) });
}

// coast maps only: one harbor, two fishing boats, a few war boats (profile.boats = war boats wanted at tier 2+, default 2)
function navy(bot, o) {
  if (!o.map || o.map.type !== 'coast') return;
  const s = bot.s, P = bot.profile;
  if (P.navy === false) return; // the rush bot spends nothing on ships
  const harbors = o.buildings.filter((b) => b.type === 'harbor');
  const ready = harbors.find((b) => b.build === undefined);
  const costH = NAVAL_BUILDINGS.harbor.cost;
  if (!harbors.length) {
    if (o.workers.n < (P.harborAt || 14) || o.t < 120 || !bot.can(costH, bot.reserve) || !bot.cooled('harbor', o, 45)) return;
    // the nearest sea block of the coarse grid (explored, mostly water) is where the shore is
    const grid = o.map.grid, B = Math.ceil(o.map.size / 16);
    let best = null, bd = Infinity;
    for (let by = 0; by < 16; by++) for (let bx = 0; bx < 16; bx++) {
      if (grid[by][bx] !== '~') continue;
      const cx = bx * B + B / 2, cy = by * B + B / 2, d = (cx - s.home[0]) ** 2 + (cy - s.home[1]) ** 2;
      if (d < bd || (d === bd && (s.flip ? bx + by * 16 > best.k : bx + by * 16 < best.k))) { bd = d; best = { k: bx + by * 16, xy: [Math.floor(cx), Math.floor(cy)] }; }
    }
    if (!best || bd > 34 * 34) return;
    bot.pay(costH);
    bot.send({ cmd: 'build', building_type: 'harbor', near: best.xy, worker_ids: 'auto' });
    return;
  }
  if (!ready) return;
  const have = { fishing_boat: 0, war_boat: 0 };
  for (const x of o.ships || []) have[x.type] = (have[x.type] || 0) + 1;
  const q = (ready.queue || []).reduce((a, x) => { const m = /^(.*)x(\d+)$/.exec(x); if (m) a[m[1]] = (a[m[1]] || 0) + +m[2]; return a; }, {});
  const fishLeft = (o.sea && o.sea.fishing_spots ? o.sea.fishing_spots.reduce((a, f) => a + f.amount, 0) : 0);
  const wantFish = fishLeft > 300 ? (P.fishers ?? 2) : 0;
  const free = o.pop.cap - o.pop.used;
  const tryTrain = (type, n) => {
    const d = NAVAL_UNITS[type];
    if (n <= 0 || free < d.pop || (ready.queue || []).length >= 2 || !bot.can(d.cost, bot.reserve)) return false;
    bot.pay(d.cost);
    o.pop.used += d.pop;
    bot.send({ cmd: 'train', building_id: ready.id, unit_type: type, count: 1 });
    return true;
  };
  if (have.fishing_boat + (q.fishing_boat || 0) < wantFish && tryTrain('fishing_boat', 1)) return;
  const wantWar = o.tier >= 2 ? (P.boats ?? 1) : 0;
  if (have.war_boat + (q.war_boat || 0) < wantWar && o.workers.n >= 16) tryTrain('war_boat', 1);
  // war boats stay near the harbor and guard the water; with three or more they raid an enemy harbor they know of
  const war = (o.ships || []).filter((x) => x.type === 'war_boat');
  const foe = (o.enemy_buildings || []).find((b) => b.type === 'harbor');
  if (war.length >= 3 && foe && bot.cooled('navyAttack', o, 40)) bot.send({ cmd: 'attack_move', units: war.map((x) => x.id), target: foe.id });
}

// idle soldiers of the free army as whole groups, in an order that looks the same from both seats (like the shrine squad), up to `max`
function idleSoldiers(bot, o, max) {
  const s = bot.s, key = (g) => (s.flip ? [s.size - g.xy[0], s.size - g.xy[1]] : g.xy), pick = [];
  const cand = bot.freeGroups(o).filter((g) => SQUAD_TYPES.has(g.type) && g.act === 'idle').sort((x, y) => (x.type < y.type ? -1 : x.type > y.type ? 1 : key(x)[0] - key(y)[0] || key(x)[1] - key(y)[1]));
  for (const g of cand) { const ids = stringToIds(g.ids) || []; if (pick.length + ids.length <= max) pick.push(...ids); }
  return pick;
}

// Coast maps, tier 2: a transport takes up to six idle soldiers aboard at the harbor, sails to the enemy coast and lands them beside the enemy
// town; ashore they go for the nearest enemy building. The landing spot is the point mirror of our own harbor (the two-player maps are point
// symmetric, so that is the same stretch of coast at the other town). One party at a time, the next one a few minutes after the last is gone.
const LAND_MAX = 6;
function landing(bot, o) {
  if (!o.map || o.map.type !== 'coast' || bot.profile.navy === false || bot.profile.landing === false) return;
  const s = bot.s, L = (s.land ||= { phase: 'wait', next: tune('land_from', 600), t: 0 });
  const foes = (o.map.starts || []).filter((x) => x.rel === 'enemy');
  const harbor = o.buildings.find((b) => b.type === 'harbor' && b.build === undefined);
  const tr = (o.ships || []).find((x) => x.type === 'transport');
  const ashore = () => o.units.reduce((a, g) => a + (stringToIds(g.ids) || []).filter((id) => s.party.has(id)).length, 0);
  const done = (gap) => { s.party.clear(); L.phase = 'wait'; L.next = o.t + gap; };
  if (L.phase === 'wait') {
    if (foes.length !== 1 || o.tier < 2 || s.sudden || o.t < L.next || !harbor) return;
    if (!tr) {
      const d = NAVAL_UNITS.transport, queued = (harbor.queue || []).some((q) => q.startsWith('transport'));
      if (queued || o.pop.cap - o.pop.used < d.pop || bot.armyN < tune('land_army', 12) || !bot.can(d.cost, bot.reserve) || !bot.cooled('transport', o, 30)) return;
      bot.pay(d.cost);
      o.pop.used += d.pop;
      bot.send({ cmd: 'train', building_id: harbor.id, unit_type: 'transport', count: 1 });
      return;
    }
    if (tr.cargo || bot.armyN < tune('land_army', 12) || !bot.cooled('landrecruit', o, 10)) return;
    const pick = idleSoldiers(bot, o, LAND_MAX);
    if (pick.length < 4) return;
    for (const id of pick) s.party.add(id);
    bot.send({ cmd: 'board', units: idsToString(pick), transport_id: tr.id });
    const hs = NAVAL_BUILDINGS.harbor.size / 2, N = o.map.size; // the centre of the harbor: its xy is a corner, and corners are not mirror images of each other
    Object.assign(L, { phase: 'board', t: o.t, ship: tr.id, dock: tr.xy, to: [bot.tileOf(N - harbor.xy[0] - hs), bot.tileOf(N - harbor.xy[1] - hs)] });
    return;
  }
  if (!tr || tr.id !== L.ship) { done(tune('land_gap', 300)); return; } // the transport sank (with whoever was aboard)
  const aboard = tr.cargo ? (stringToIds(tr.cargo) || []).length : 0;
  if (L.phase === 'board') {
    const left = ashore();
    // soldiers that stopped at the shore out of reach (beside the harbor the nearest beach can lie a few tiles off): the ship comes to them, then they board
    const waiting = o.units.filter((g) => g.act === 'idle' && (stringToIds(g.ids) || []).some((id) => s.party.has(id)));
    if (waiting.length && bot.cooled('landfix', o, 6)) {
      let cx = 0, cy = 0, n = 0;
      for (const g of waiting) { cx += g.xy[0] * g.n; cy += g.xy[1] * g.n; n += g.n; }
      const ids = waiting.flatMap((g) => (stringToIds(g.ids) || []).filter((id) => s.party.has(id)));
      if (tr.act === 'idle' && Math.hypot(tr.xy[0] - cx / n, tr.xy[1] - cy / n) > 3) bot.send({ cmd: 'move', units: String(tr.id), to: [bot.tileOf(cx / n + 0.5), bot.tileOf(cy / n + 0.5)] });
      else if (tr.act === 'idle') bot.send({ cmd: 'board', units: idsToString(ids), transport_id: tr.id });
    }
    if (aboard && (!left || o.t - L.t > 60)) {
      bot.send({ cmd: 'unload', transport_id: tr.id, to: L.to });
      for (const id of [...s.party]) if (!(stringToIds(tr.cargo) || []).includes(id)) s.party.delete(id); // who missed the boat goes back to the army
      Object.assign(L, { phase: 'sail', t: o.t });
    } else if (o.t - L.t > 80) done(120); // nobody got aboard: give up for now
    return;
  }
  if (L.phase === 'sail') {
    if (!aboard) { Object.assign(L, { phase: 'ashore', t: o.t }); bot.send({ cmd: 'move', units: String(tr.id), to: L.dock }); return; }
    if (tr.act === 'idle' && o.t - L.t > 10 && bot.cooled('landretry', o, 20)) bot.send({ cmd: 'unload', transport_id: tr.id }); // no water by the landing spot: put them ashore where the ship is
    return;
  }
  // ashore: the party fights its way to the nearest enemy building (the town centre when none is in sight)
  if (!ashore()) { done(tune('land_gap', 300)); return; }
  if (!bot.cooled('landcmd', o, 10)) return;
  let cx = 0, cy = 0, n = 0;
  for (const g of o.units) { const k = (stringToIds(g.ids) || []).filter((id) => s.party.has(id)).length; cx += g.xy[0] * k; cy += g.xy[1] * k; n += k; }
  const c = [cx / n, cy / n], N1 = o.map.size, tk = (b) => { const q = s.flip ? [N1 - b.xy[0], N1 - b.xy[1]] : b.xy; return q[0] * 4096 + q[1]; };
  const d2 = (b) => (b.xy[0] - c[0]) ** 2 + (b.xy[1] - c[1]) ** 2;
  const near = [...o.enemy_buildings.map((b) => ({ ...b, xy: bot.cornerOf(b.xy, b.type) })), ...(o.enemy_minor_buildings || [])].filter((b) => b.type !== 'wall' && b.type !== 'gate').sort((a, b) => d2(a) - d2(b) || tk(a) - tk(b))[0];
  bot.send({ cmd: 'attack_move', units: idsToString([...s.party]), target: near ? near.id : [bot.tileOf(foes[0].xy[0]), bot.tileOf(foes[0].xy[1])] });
}

// A caravan in sight and close to home, no enemy soldiers beside it: up to four idle soldiers go for the bounty (an explicit attack order;
// soldiers never attack a caravan by themselves). The profile can switch it off (raid: false).
function caravanRaid(bot, o) {
  const seen = o.caravans && o.caravans.seen;
  if (!seen || !seen.length || bot.profile.raid === false || bot.s.sudden || o.t < 240 || bot.armyN < tune('raid_army', 8)) return;
  const s = bot.s, d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const fromHome = (xy) => Math.hypot(xy[0] + 0.5 - s.home[0] - 2, xy[1] + 0.5 - s.home[1] - 2); // tile centre to the centre of the town centre: the same number from both seats
  const key = (c) => (s.flip ? [s.size - c.xy[0], s.size - c.xy[1]] : c.xy);
  const cv = seen.filter((c) => fromHome(c.xy) < tune('raid_r', 22) && !o.enemy_units.some((e) => e.owner !== 0 && d(e.xy, c.xy) < 8)).sort((a, b) => fromHome(a.xy) - fromHome(b.xy) || key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1])[0];
  if (!cv || !bot.cooled('raid', o, 45)) return;
  const pick = idleSoldiers(bot, o, 4);
  if (pick.length >= 2) bot.send({ cmd: 'attack_move', units: idsToString(pick), target: cv.id });
}

// Process-wide switch of the taunts. The solo runner turns the chat off: the opening line names the style of a bot (plan A1). Default on, so
// every other user (arena, balance, matches) plays as before.
export const worldOptions = { chat: true };

export function worldBehaviour(bot, o) {
  if (o.t < 5) return;
  if (worldOptions.chat) chat(bot, o);
  navy(bot, o);
  landing(bot, o);
  caravanRaid(bot, o);
}
