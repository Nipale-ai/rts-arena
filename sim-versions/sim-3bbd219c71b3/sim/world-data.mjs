// Numbers of the living world: map types, weather, caravans, ships, chat. Pure data (no imports from the sim), so data.mjs, rules.mjs,
// the generator, the bots and the renderer can all read it. Balancing the world only edits this file.
// Units: seconds, tiles, tiles per second, percent.

export const MAP_TYPES = ['meadow', 'forest', 'desert', 'winter', 'coast'];
export const MAP_TYPE_INFO = {
  meadow: { label: 'Meadow', blurb: 'Green hills, scattered woods and a lake or two. The classic map.' },
  forest: { label: 'Forest', blurb: 'Dense woods with winding trails: wood everywhere, little open ground, ambushes.' },
  desert: { label: 'Desert', blurb: 'Dunes, mesas and cactus. Wood only from a few palm oases, so every grove is worth a fight.' },
  winter: { label: 'Winter', blurb: 'Snow and spruce, frozen lakes and cliffs. Hunting is good, farms are thin.' },
  coast: { label: 'Coast', blurb: 'An inland sea between the two towns. Harbors, fishing boats, war boats and transports.' },
};
export const isMapType = (t) => MAP_TYPES.includes(t);

// ---------------------------------------------------------------- weather
// kind -> effect (all symmetric: the same sky for both sides, nobody is favoured). Percent of the normal value.
//   move: speed of land units, sea: speed of ships, sight: vision radius, food: gathering of food, all: gathering of everything
export const WEATHER_KINDS = ['clear', 'rain', 'fog', 'snow', 'storm'];
export const WEATHER = {
  clear: { move: 100, sea: 100, sight: 100, food: 100, all: 100, text: 'clear sky, no effect' },
  rain: { move: 100, sea: 100, sight: 100, food: 90, all: 100, text: 'rain: food gathering -10 %' },
  fog: { move: 100, sea: 100, sight: 75, food: 100, all: 100, text: 'fog: sight range -25 %' },
  snow: { move: 92, sea: 100, sight: 100, food: 95, all: 100, text: 'snow: land units -8 % speed, food gathering -5 %' },
  storm: { move: 95, sea: 85, sight: 90, food: 100, all: 85, text: 'storm: gathering -15 %, land units -5 % speed, ships -15 % speed, sight -10 %' },
};
// how often each kind follows (weights) per map type; a kind never follows itself. Desert has no rain or snow (its "storm" is a sand storm),
// winter has snow instead of rain.
export const WEATHER_MIX = {
  meadow: { clear: 45, rain: 30, fog: 15, storm: 10 },
  forest: { clear: 35, rain: 35, fog: 25, storm: 5 },
  desert: { clear: 78, fog: 4, storm: 18 },
  winter: { clear: 32, snow: 50, fog: 10, storm: 8 },
  coast: { clear: 38, rain: 24, fog: 16, storm: 22 },
};
export const WEATHER_TIMING = {
  firstClearS: [90, 180], // the opening is calm
  clearS: [100, 260],
  otherS: [60, 160],
  stormS: [35, 80],
};

// ---------------------------------------------------------------- caravans (neutral traders, owner 0)
export const CARAVAN = {
  hp: 150, armour: { melee: 3, pierce: 5, siege: 0 }, speed: 1.35, sight: 6,
  bounty: 140, // gold for the team whose unit lands the killing blow
  trade: 90, // gold for the team(s) with an escort when the caravan reaches the end of a leg (split if both are there)
  escortR: 4.5, // tiles: units this close to the caravan count as its escort
  respawnS: 75, // a destroyed caravan is replaced at its first post after this long
  stopS: 6, // it waits this long at a post
  stuckS: 30, // no progress for this long: the caravan is replaced
};

// ---------------------------------------------------------------- ships and the harbor (coast maps)
export const FISH = { amount: 360, shoalsPerSide: 5, rate: 0.8, carry: 16 };
export const NAVAL_UNITS = {
  fishing_boat: {
    cls: 'naval', naval: 'fisher', from: 'harbor', tier: 1, cost: { wood: 60 }, time: 14, pop: 1,
    hp: 60, atk: 0, dmg: 'siege', cd: 2.0, range: 1.0, speed: 2.0,
    armour: { melee: 0, pierce: 1, siege: 0 }, sight: 7, noArmy: true,
  },
  war_boat: {
    cls: 'naval', naval: 'war', from: 'harbor', tier: 2, cost: { wood: 130, gold: 70 }, time: 28, pop: 2,
    hp: 140, atk: 10, dmg: 'siege', cd: 2.2, range: 7.0, speed: 2.3,
    armour: { melee: 2, pierce: 3, siege: 0 }, sight: 9, projectile: 10, bonus: { naval: 140, building: 110 },
  },
  transport: {
    cls: 'naval', naval: 'transport', from: 'harbor', tier: 2, cost: { wood: 120, gold: 30 }, time: 22, pop: 2,
    hp: 140, atk: 0, dmg: 'siege', cd: 2.0, range: 1.0, speed: 1.9,
    armour: { melee: 1, pierce: 3, siege: 0 }, sight: 7, noArmy: true, cargo: 6,
  },
};
export const NAVAL_BUILDINGS = {
  harbor: {
    size: 4, tier: 1, cost: { wood: 160 }, time: 45, hp: 900, crew: 2,
    armour: { melee: 5, pierce: 10, siege: 0 }, sight: 6, drop: ['food'], train: ['fishing_boat', 'war_boat', 'transport'], coastal: true, noMargin: true,
  },
};

// ---------------------------------------------------------------- chat (the `say` tool)
export const CHAT = { maxChars: 100, gapTicks: 150, keep: 40, inbox: 6 }; // one line per 15 s and player; the last 40 lines are kept; 6 show in an observation

// owner-0 unit types (neutral, not part of any player's army); the renderer and the spectator protocol list them after the player units
export const WILD_UNITS = ['wolf', 'caravan'];
