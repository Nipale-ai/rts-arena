// Display names (R1 of the reskin way). The ONE place that turns a game id (unit, building, tech) into the words a viewer reads.
//
//   displayName(kind, id, theme)    "archer" | "Arc Gunner"        the name as it stands in a sentence
//   displayPlural(kind, id, theme)  "archers" | "Arc Gunners"
//   displayRole(kind, id, theme)    one sentence that names the ROLE ("Ranged unit ...") so that a reader (later: a model) understands the type
//   lexiconOf(theme)                the whole table, theme over classic
//
// kind: 'unit' | 'building' | 'tech' | 'any'  ('any' looks in that order; use it where a string may be a unit or a building, e.g. "what the scout spotted").
// theme: undefined | null | 'classic' | 'dustmoon-v1' | { id } | a loaded Theme of render/theme/theme-loader.mjs.  An unknown theme and 'classic' give the classic words.
//        A loaded Theme answers with the names of its theme.json first (then the lexicon, then classic).
//        undefined and null mean "not said": the ACTIVE theme answers (setActiveTheme below; until one is set that is classic, so nothing changes).
//        Only an explicit 'classic' (or { id: 'classic' }) forces the classic words whatever is active: the places that match what a model wrote ask for it.
//   setActiveTheme(theme)           the theme of this page / process, set once by the owner of the match (package C2: Pack.init, tools/render-story.mjs --theme)
//   getActiveTheme(), activeThemeId()   what is set (null / 'classic' = none)
//
// RULES (they are what makes this safe to use everywhere):
//   1. classic is byte-identical to the old copies String(id).replace(/_/g, ' '). That is also what an id without an entry gets (a tech, a wild unit,
//      "berries", a made-up word): the fallback IS the old formula. A theme entry that is missing falls back to classic, never to a half-themed text.
//   2. The ids stay canonical. A theme changes WORDS only. Bots, the sim, tool calls and logs keep "archer". Never use a display name as a key.
//   3. Two kinds of place exist. A place that SHOWS a name (HUD, feed, captions, labels) asks for the theme. A place that MATCHES text a model wrote
//      (tools/subjects.mjs, the show-tag inferrer) asks for 'classic' explicitly, because in Phase 1 the model still sees and writes classic words.
//   4. Pure and deterministic: no imports, no DOM, no Date, no Math.random. It runs in the browser (render/, ui/) and in Node (tools/, server/). The only state is the active theme, set by the match owner.
//   5. Names are English. Classic names are lower case (as before); a theme names its things like proper names (Title Case), as a unit is called in its world.
//
// Texts that come out of sim/ (the action feed of sim/intent.mjs, the chips of sim/standing.mjs, error texts of sim/commands.mjs, the director texts of
// sim/director.mjs) and the model prompt (agents/llm/prompt.mjs) are NOT built here: sim/ is frozen (sim version) and the prompt hash must not move.
// They show the classic words in Phase 1.

export const DEFAULT_THEME = 'classic';

// The old formula, the only copy that is left. Do not use it outside this file: ask displayName.
const underscoreToSpace = (id) => String(id).replace(/_/g, ' ');

// Regular plural of a game word, the same rule as pluralOf in tools/lib/names.mjs (the test compares them for every classic id).
// Words that already end in s stay ("barracks"), so do mass nouns ("light cavalry"); "-man" becomes "-men".
const regularPlural = (w) => (/cavalry|infantry|sheep|s$/.test(w) ? w : /man$/.test(w) ? w.replace(/man$/, 'men') : `${w}s`);

const E = (name, plural, role) => Object.freeze({ name, plural, role });

// ------------------------------------------------------------------ classic: the words the game has always shown
const CLASSIC = {
  unit: {
    worker: E('worker', 'workers', 'Gathers resources and constructs buildings. Weak in a fight.'),
    spearman: E('spearman', 'spearmen', 'Basic infantry with a spear. Very strong against cavalry.'),
    swordsman: E('swordsman', 'swordsmen', 'Heavy infantry. Strong in melee and against siege units.'),
    archer: E('archer', 'archers', 'Ranged unit that shoots arrows. Strong against infantry, weak when caught in melee.'),
    skirmisher: E('skirmisher', 'skirmishers', 'Light ranged unit. Strong against other ranged units and hard to hurt with arrows.'),
    light_cavalry: E('light cavalry', 'light cavalry', 'Fast mounted raider. Strong against ranged and siege units, weak against spearmen.'),
    heavy_cavalry: E('heavy cavalry', 'heavy cavalry', 'Heavy mounted unit with high health, armour and damage. Costs extra population.'),
    ram: E('ram', 'rams', 'Siege unit that attacks buildings only. Very strong against buildings and nearly immune to arrows.'),
    catapult: E('catapult', 'catapults', 'Long-range siege unit with splash damage. Strong against buildings, fragile up close.'),
    scout: E('scout', 'scouts', 'Fast, cheap explorer with very wide sight. Weak in a fight and not part of the army.'),
    healer: E('healer', 'healers', 'Support unit with no attack. Heals wounded friendly units nearby, except siege units.'),
    mortar: E('mortar', 'mortars', 'Siege unit that lobs shells with splash damage over a very long range. Needs the blackpowder tech, must set up before it fires and cannot hit close targets.'),
    sapper: E('sapper', 'sappers', 'Siege unit that runs to a building, plants a charge and is consumed by the blast, which also hurts everything around it.'),
    bulwark: E('bulwark', 'bulwarks', 'Slow, heavily armoured infantry from the castle. Arrows barely hurt it and it is strong against ranged units.'),
    fishing_boat: E('fishing boat', 'fishing boats', 'Ship that fishes food from shoals. Coast maps only.'),
    war_boat: E('war boat', 'war boats', 'Warship with a ranged attack. Strong against other ships and against buildings on the shore.'),
    transport: E('transport', 'transports', 'Ship that carries land units across the water. No attack.'),
  },
  building: {
    town_center: E('town center', 'town centers', 'Main building. Trains workers and scouts, takes every resource, advances the tier and shoots at nearby enemies.'),
    house: E('house', 'houses', 'Raises the population cap.'),
    lumber_camp: E('lumber camp', 'lumber camps', 'Drop-off point for wood. Researches the wood gathering techs.'),
    mining_camp: E('mining camp', 'mining camps', 'Drop-off point for stone and gold. Researches the mining techs.'),
    mill: E('mill', 'mills', 'Drop-off point for food. Researches the farming techs.'),
    farm: E('farm', 'farms', 'Field that a worker farms for food.'),
    barracks: E('barracks', 'barracks', 'Trains spearmen, swordsmen and healers.'),
    archery_range: E('archery range', 'archery ranges', 'Trains archers and skirmishers.'),
    stables: E('stables', 'stables', 'Trains light and heavy cavalry and researches the bloodlines tech.'),
    siege_workshop: E('siege workshop', 'siege workshops', 'Trains rams, catapults, mortars and sappers.'),
    blacksmith: E('blacksmith', 'blacksmiths', 'Researches attack, armour, range and building upgrades.'),
    tower: E('tower', 'towers', 'Defensive building that shoots enemies in range. Trains nothing.'),
    wall: E('wall', 'walls', 'Cheap wall segment that blocks movement and shrugs off arrows.'),
    gate: E('gate', 'gates', 'Wall segment that its owner and allies can pass through. Enemies cannot.'),
    market: E('market', 'markets', 'Trades resources at prices that move with use and sends tribute to allies.'),
    castle: E('castle', 'castles', 'Fortress that shoots further and harder than a tower and trains the bulwark. Limited per player.'),
    wonder: E('wonder', 'wonders', 'Very expensive monument. Once finished a countdown starts, and if it still stands at the end its owner team wins.'),
    outpost: E('outpost', 'outposts', 'Cheap watch post that sees far and does not shoot. Next to a relic shrine it helps hold the shrine.'),
    harbor: E('harbor', 'harbors', 'Coastal building that trains ships and takes food from fishing boats.'),
  },
  tech: {},
};

// ------------------------------------------------------------------ dustmoon-v1: the words of our own science-fiction world
// A convoy of colonists stranded on a dust moon. Status: WORKING NAMES, nothing here is final. The name check against known brands is open: a person has to do it
// (no trademark register has been read yet). The findings of the first web search are kept outside the code (RESKIN-STAND.md).
// The words are NOT written here. They live in the fragment of the theme, render/assets/themes-src/dustmoon-v1/parts/names.json (a piece of theme.json: name, plural, description
// of every unit, building and tech, with a line per id in names-status.json that says whether it is an owner name, a proposal of the name package or a placeholder), and
// `node tools/theme-names.mjs write` copies them into the block below. The block is the lexicon of the theme id: an id passed as a string ('dustmoon-v1') and a loaded theme that
// lacks a slot answer from it. The day theme.json carries every name (the assembly of the parts), `node tools/theme-names.mjs write --no-lexicon` empties the block and the
// names are in no code at all; a second world then needs no code either. `node tools/theme-names.mjs check` and test/theme-names.test.mjs keep the three places in step.
// ---- BEGIN GENERATED dustmoon-v1 names (node tools/theme-names.mjs write; source: render/assets/themes-src/dustmoon-v1/parts/names.json). Do not edit by hand.
const DUSTMOON = {
  unit: {
    worker: E("Convoy Hand", "Convoy Hands", "Colonist who gathers resources and builds structures. Weak in a fight."),
    spearman: E("Spike Guard", "Spike Guards", "Basic infantry with a braced spike. Very strong against cavalry."),
    swordsman: E("Scrap Cutter", "Scrap Cutters", "Heavy melee infantry. Hits hard and is strong against siege units."),
    archer: E("Arc Gunner", "Arc Gunners", "Ranged laser infantry. Fires bolts from a distance and is strong against infantry, but weak when caught in melee."),
    skirmisher: E("Needle Runner", "Needle Runners", "Light ranged unit that is strong against other ranged units and hard to hurt with bolts and arrows."),
    light_cavalry: E("Drift Sled", "Drift Sleds", "Fast hover raider. Strong against ranged and siege units, weak against Spike Guards."),
    heavy_cavalry: E("Grav Lancer", "Grav Lancers", "Heavy hover unit with high health, armour and damage, at the cost of extra population."),
    ram: E("Auger Rig", "Auger Rigs", "Siege machine that attacks buildings only; very strong against buildings and nearly immune to bolts and arrows."),
    catapult: E("Ore Hurler", "Ore Hurlers", "Long-range siege unit with splash damage; strong against buildings but fragile up close."),
    scout: E("Glint Rider", "Glint Riders", "Fast, cheap explorer with very wide sight; weak in a fight and not part of the army."),
    healer: E("Triage Tech", "Triage Techs", "Support unit with no attack. Patches up wounded friendly units nearby, except siege units."),
    mortar: E("Crater Mortar", "Crater Mortars", "Siege unit that lobs shells with splash damage over a very long range; needs Crater Charges, must set up before firing and cannot hit close targets."),
    sapper: E("Demolition Drone", "Demolition Drones", "Siege drone that flies to a building, plants a charge and is consumed by the blast, which also hurts everything around it."),
    bulwark: E("Slab Guard", "Slab Guards", "Slow, heavily armoured infantry from the Dust Redoubt; bolts and arrows barely hurt it and it is strong against ranged units."),
    fishing_boat: E("Net Skiff", "Net Skiffs", "Boat that hauls food out of fish shoals; coast maps only."),
    war_boat: E("Arc Barge", "Arc Barges", "Armed boat with a ranged attack; strong against other boats and against buildings on the shore."),
    transport: E("Haul Barge", "Haul Barges", "Boat that carries land units across the water; it has no attack."),
  },
  building: {
    town_center: E("Landing Core", "Landing Cores", "Main building. Trains Convoy Hands and scouts, takes every resource, advances the tier and shoots at nearby enemies."),
    house: E("Bunk Pod", "Bunk Pods", "Shelter that raises the population cap."),
    lumber_camp: E("Timber Depot", "Timber Depots", "Drop-off point for wood that researches the wood gathering upgrades."),
    mining_camp: E("Pit Camp", "Pit Camps", "Drop-off point for stone and gold that researches the mining upgrades."),
    mill: E("Ration Silo", "Ration Silos", "Drop-off point for food that researches the farming upgrades."),
    farm: E("Hydro Plot", "Hydro Plots", "Field that a Convoy Hand works for food."),
    barracks: E("Muster Bay", "Muster Bays", "Trains Spike Guards, Scrap Cutters and Triage Techs."),
    archery_range: E("Arc Range", "Arc Ranges", "Trains Arc Gunners and Needle Runners."),
    stables: E("Sled Yard", "Sled Yards", "Trains Drift Sleds and Grav Lancers and researches the Gyro Frames upgrade."),
    siege_workshop: E("Breach Foundry", "Breach Foundries", "Trains Auger Rigs, Ore Hurlers, Crater Mortars and Demolition Drones."),
    blacksmith: E("Rivet Forge", "Rivet Forges", "Researches attack, armour, range and building upgrades."),
    tower: E("Pulse Tower", "Pulse Towers", "Defensive building that fires pulses at enemies in range. Trains nothing."),
    wall: E("Dust Berm", "Dust Berms", "Cheap barrier that blocks movement and shrugs off bolts and arrows."),
    gate: E("Berm Gate", "Berm Gates", "Opening in a Dust Berm that its owner and allies can pass through; enemies cannot."),
    market: E("Haggle Hall", "Haggle Halls", "Trades resources at prices that move with use and sends tribute to allies."),
    castle: E("Dust Redoubt", "Dust Redoubts", "Fortress that shoots further and harder than a Pulse Tower and trains the Slab Guard; limited per player."),
    wonder: E("Homecoming Spire", "Homecoming Spires", "Very expensive monument; once it is finished a countdown starts, and if it still stands at the end its owner team wins."),
    outpost: E("Signal Mast", "Signal Masts", "Cheap watch post that sees far and does not shoot; next to a relic shrine it helps hold the shrine."),
    harbor: E("Landing Quay", "Landing Quays", "Coastal building that trains boats and takes food from Net Skiffs."),
  },
  tech: {
    wood_axe: E("Mono-Edge Saws I", "Mono-Edge Saws I", "Wood gatherers work faster."),
    wood_axe_2: E("Mono-Edge Saws II", "Mono-Edge Saws II", "Wood gatherers work faster again; needs Mono-Edge Saws I."),
    plough: E("Bloom Racks I", "Bloom Racks I", "Field work and berry picking get faster."),
    plough_2: E("Bloom Racks II", "Bloom Racks II", "Field work and berry picking get faster again; needs Bloom Racks I."),
    mining_1: E("Seam Lasers I", "Seam Lasers I", "Gold and stone mining gets faster."),
    mining_2: E("Seam Lasers II", "Seam Lasers II", "Gold and stone mining gets faster again; needs Seam Lasers I."),
    carry_1: E("Pack Frames I", "Pack Frames I", "Gatherers carry more resources per trip."),
    carry_2: E("Pack Frames II", "Pack Frames II", "Gatherers carry even more per trip; needs Pack Frames I."),
    melee_attack_1: E("Charged Edges I", "Charged Edges I", "Raises the melee attack of infantry and cavalry."),
    melee_attack_2: E("Charged Edges II", "Charged Edges II", "Raises the melee attack of infantry and cavalry again; needs Charged Edges I."),
    ranged_attack_1: E("Capacitor Banks I", "Capacitor Banks I", "Raises the attack of ranged units and of every building that shoots."),
    ranged_attack_2: E("Capacitor Banks II", "Capacitor Banks II", "Once more raises the attack of ranged units and of every building that shoots; needs Capacitor Banks I."),
    melee_armour_1: E("Girder Plating I", "Girder Plating I", "Adds melee armour to infantry and cavalry."),
    melee_armour_2: E("Girder Plating II", "Girder Plating II", "Adds more melee armour to infantry and cavalry; needs Girder Plating I."),
    pierce_armour_1: E("Foil Mesh I", "Foil Mesh I", "Adds protection against bolts and arrows to infantry, cavalry and Convoy Hands."),
    pierce_armour_2: E("Foil Mesh II", "Foil Mesh II", "Adds more protection against bolts and arrows to infantry, cavalry and Convoy Hands; needs Foil Mesh I."),
    fletching: E("Beam Optics", "Beam Optics", "Extends the range of ranged units and of every building that shoots."),
    masonry: E("Slab Casting", "Slab Casting", "Raises the hit points of all buildings."),
    bloodlines: E("Gyro Frames", "Gyro Frames", "Raises the hit points of cavalry."),
    blackpowder: E("Crater Charges", "Crater Charges", "Unlocks the Crater Mortar, which is trained at the Breach Foundry."),
    field_medicine_1: E("Weld Foam I", "Weld Foam I", "Makes Triage Techs heal faster."),
    field_medicine_2: E("Weld Foam II", "Weld Foam II", "Makes Triage Techs heal faster and over a wider range; needs Weld Foam I."),
    siege_craft: E("Breach Calibration", "Breach Calibration", "Raises the attack of siege units."),
    trade_charter: E("Convoy Charter", "Convoy Charter", "Lowers the fee that the Haggle Hall takes on every trade."),
  },
};
// ---- END GENERATED dustmoon-v1 names

const freezeKinds = (t) => Object.freeze({ unit: Object.freeze(t.unit), building: Object.freeze(t.building), tech: Object.freeze(t.tech) });
export const LEXICON = Object.freeze({ [DEFAULT_THEME]: freezeKinds(CLASSIC), 'dustmoon-v1': freezeKinds(DUSTMOON) });
export const THEMES = Object.freeze(Object.keys(LEXICON));
export const KINDS = Object.freeze(['unit', 'building', 'tech']);

// 'dustmoon-v1' | { id: 'dustmoon-v1' } | 'classic' | undefined | anything unknown  ->  a theme id that exists
export function themeIdOf(theme) {
  const id = typeof theme === 'string' ? theme : theme && typeof theme === 'object' && typeof theme.id === 'string' ? theme.id : DEFAULT_THEME;
  return Object.hasOwn(LEXICON, id) ? id : DEFAULT_THEME;
}

const kindsOf = (kind) => (KINDS.includes(kind) ? [kind] : KINDS); // 'any' and a kind nobody knows both search all kinds
const findIn = (themeTable, kinds, key) => { for (const k of kinds) if (Object.hasOwn(themeTable[k], key)) return themeTable[k][key]; return null; };

// A loaded Theme (render/theme/theme-loader.mjs, package R2a) brings its own names with it (theme.json). It is recognised by its methods and read
// through them, with no import: if the loader changes or is missing, this can only mean "classic", never a crash.
const LOADED_KINDS = { unit: ['units'], building: ['buildings'], tech: ['techs'] };
function loadedEntry(theme, kind, key) {
  if (!theme || typeof theme.has !== 'function' || typeof theme.slot !== 'function') return null;
  for (const k of LOADED_KINDS[kind] || ['units', 'buildings', 'techs']) {
    if (!theme.has(k, key)) continue;
    const s = theme.slot(k, key);
    if (s && typeof s.name === 'string') return E(s.name, typeof s.plural === 'string' ? s.plural : regularPlural(s.name), typeof s.description === 'string' ? s.description : '');
  }
  return null;
}

// ------------------------------------------------------------------ the active theme (shim, package C0)
// One theme belongs to a match (theme-loader.mjs createMatchTheme). The match owner tells this module once, and every place that shows a name and was not handed a theme
// (render/hud.mjs, render/god.mjs, ui/editor.js, server/spectate.mjs, tools/*) speaks that theme. Without the call everything is classic, as before.
let ACTIVE = null; // a theme argument as accepted above, or null = classic
export function setActiveTheme(theme) { ACTIVE = theme === undefined || theme === null ? null : theme; return ACTIVE; }
export const getActiveTheme = () => ACTIVE;
export const activeThemeId = () => themeIdOf(ACTIVE);
// the theme that answers: the one asked for, or the active one when none was said (undefined and null)
const asked = (theme) => (theme === undefined || theme === null ? ACTIVE : theme);

// The entry (whole: name, plural, role) of the theme, else of classic, else null. A theme entry is never mixed with classic words.
function entryOf(kind, id, theme0) {
  const theme = asked(theme0);
  const key = String(id), kinds = kindsOf(kind), t = themeIdOf(theme);
  const own = loadedEntry(theme, kind, key) || findIn(LEXICON[t], kinds, key);
  return own || (t === DEFAULT_THEME ? null : findIn(LEXICON[DEFAULT_THEME], kinds, key));
}

export function displayName(kind, id, theme) {
  const e = entryOf(kind, id, theme);
  return e ? e.name : underscoreToSpace(id);
}

export function displayPlural(kind, id, theme) {
  const e = entryOf(kind, id, theme);
  return e ? e.plural : regularPlural(underscoreToSpace(id));
}

// '' when nothing is known about the id (no invented text)
export function displayRole(kind, id, theme) {
  const e = entryOf(kind, id, theme);
  return e ? e.role : '';
}

// Theme over classic, per id: { unit: { archer: { name, plural, role }, ... }, building: {...}, tech: {...} }. A copy: the caller may keep it.
export function lexiconOf(theme0) {
  const t = themeIdOf(asked(theme0)), out = {};
  for (const k of KINDS) out[k] = { ...LEXICON[DEFAULT_THEME][k], ...(t === DEFAULT_THEME ? {} : LEXICON[t][k]) };
  return out;
}
