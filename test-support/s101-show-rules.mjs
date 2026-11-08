// REGRESSION FIXTURE ONLY (not used by the product): the hand-written "what each line shows" rules of the approved s101 story script,
// matched by regex against the line text. The product reads the structured show tags of each line instead (tools/show-tags.mjs,
// tools/story-show.mjs); test/show-tags.test.mjs checks that the tag path gives equivalent parts for the fog, scout, workshop and versus lines.
// ---------------------------------------------------------------- rules: what each line shows
export const bldAt = (ev, p, type, offs = 1.5) => { const e = ev.events.find((x) => x.type === 'key_building' && x.p === p && x.building === type && x.loc); return e ? { x: e.loc[0] + offs, z: e.loc[1] + offs } : null; };
export const lostAt = (ev, p, type) => { const e = ev.events.find((x) => x.type === 'building_destroyed' && x.p === p && x.building === type && x.loc); return e ? { x: e.loc[0], z: e.loc[1] } : null; };

// each rule: re = regex on the line text, mk(ctx) -> parts [{ f:[from,to] (fraction of the line), cam, fog, tag, marks, versus, inset }]
export function s101Rules(c) {
  const DEF = { t: 'army', o: 1, near: [c.starts[0].x, c.starts[0].z, 45] }, RAMS = { t: 'type', o: 2, ty: 'ram', near: [c.starts[0].x, c.starts[0].z, 45] };
  const B = c.starts, nm = c.names, col = [1, 2];
  const tc = (o) => ({ k: 'bld', x: B[o - 1].x, z: B[o - 1].z, d0: 52, d1: 30, side: o === 1 ? 1 : -1 });
  const lookFrom = (from, to, rot, tag) => ({ cam: { k: 'look', from, to, rot, lateral: from === 1 ? -9 : 9 }, fog: from, tag: { p: from, text: `${nm[from - 1].toUpperCase()}'S VIEW  FOG OF WAR` } });
  const R = [];
  const add = (re, mk) => R.push({ re, mk });
  add(/^In the blue corner/, () => [{ f: [0, 1], cam: tc(1), tag: { p: 1, text: `BLUE CORNER  ${nm[0].toUpperCase()}` }, marks: [{ bld: B[0], o: 1, label: nm[0] }] }]);
  add(/^In the red corner/, () => [{ f: [0, 1], cam: tc(2), tag: { p: 2, text: `RED CORNER  ${nm[1].toUpperCase()}` }, marks: [{ bld: B[1], o: 2, label: nm[1] }] }]);
  add(/^Both use a speed-up trick/, () => [{ f: [0, 1], cam: { k: 'crane', x: B[1].x, z: B[1].z, side: -1 }, tag: { text: 'SAME SPEED-UP TRICK  ENGINE AND HARDWARE DIFFER' } }]);
  add(/needs 1\.7x as long per decision/, () => [{ f: [0, 1], cam: { k: 'crane', x: B[1].x, z: B[1].z, side: -1 }, versus: c.thinkVersus }]);
  add(/^The goal: build an economy/, () => [
    { f: [0, '@build an army'], cam: { k: 'grp', sel: { t: 'workers', o: 2, near: [B[1].x, B[1].z, 25] }, dist: 28, side: -1 }, tag: { p: 2, text: 'BUILD AN ECONOMY' }, marks: [{ sel: { t: 'workers', o: 2, near: [B[1].x, B[1].z, 25] }, o: 2 }] },
    { f: ['@build an army', '@and destroy'], cam: { k: 'crane', x: B[1].x - 2, z: B[1].z - 2, side: 1 }, tag: { p: 2, text: 'BUILD AN ARMY' } },
    { f: ['@and destroy', 1], cam: tc(1), tag: { p: 1, text: 'DESTROY THE ENEMY TOWN CENTER' }, marks: [{ bld: B[0], o: 1, label: 'TOWN CENTER' }] },
  ]);
  add(/^QuartzRT opened with a plan/, () => [{ f: [0, 1], cam: { k: 'grp', sel: { t: 'workers', o: 1, near: [B[0].x, B[0].z, 22] }, dist: 26, side: 1 }, tag: { p: 1, text: 'QUARTZRT  WORKERS FIRST' }, marks: [{ sel: { t: 'workers', o: 1, near: [B[0].x, B[0].z, 22] }, o: 1 }] }]);
  // the fog of war line: from Zoe's corner toward the blue corner with Zoe's fog on, then the same from the blue side
  add(/^Zoe's kit does the same without a word/, () => [
    { f: [0, '@And each'], cam: { k: 'grp', sel: { t: 'workers', o: 2, near: [B[1].x, B[1].z, 22] }, dist: 26, side: -1 }, tag: { p: 2, text: `${nm[1].toUpperCase()}  ORDERS ONLY` }, marks: [{ sel: { t: 'workers', o: 2, near: [B[1].x, B[1].z, 22] }, o: 2 }] },
    { f: ['@And each', (R) => (R('@And each') + 1) / 2 + 0.04], ...lookFrom(2, 1, 12) },
    { f: [(R) => (R('@And each') + 1) / 2 + 0.04, 1], ...lookFrom(1, 2, 12) },
  ]);
  add(/scout finds an enemy worker/, () => [{ f: [0, 1], cam: { k: 'look', from: 1, to: c.contact ? { x: c.contact[0], z: c.contact[1] } : 2, ahead: 'to', lateral: -8, rot: 18, elev: 15, d0: 44, d1: 36, drift: 0, sweep: 6 }, fog: 1, tag: { p: 1, text: `${nm[0].toUpperCase()}'S SCOUT  ENEMY WORKER FOUND` }, marks: [{ sel: { ids: c.scout ? [c.scout] : [] }, o: 1, label: 'SCOUT' }, { sel: { t: 'type', o: 2, ty: 'worker', near: c.contact ? [c.contact[0], c.contact[1], 18] : [60, 60, 18] }, o: 2, label: 'ENEMY WORKER' }] }]);
  add(/^No rush\. QuartzRT spots a problem/, () => [{ f: [0, 1], cam: { k: 'grp', sel: { t: 'workers', o: 1, near: c.camp ? [c.camp.x, c.camp.z, 22] : [B[0].x, B[0].z, 25] }, dist: 28, side: -1 }, tag: { p: 1, text: `${nm[0].toUpperCase()}  WOOD IS THE BOTTLENECK` }, marks: [{ sel: { t: 'workers', o: 1, near: c.camp ? [c.camp.x, c.camp.z, 22] : [B[0].x, B[0].z, 25] }, o: 1, label: 'WOOD' }] }]);
  add(/^It follows up at 05:35/, () => [{ f: [0, 1], cam: c.camp ? { k: 'bld', x: c.camp.x, z: c.camp.z, d0: 34, d1: 22, side: 1 } : tc(1), tag: { p: 1, text: `${nm[0].toUpperCase()}  RESEARCH WOOD AXE AT THE LUMBER CAMP` }, marks: c.camp ? [{ bld: c.camp, o: 1, label: 'LUMBER CAMP' }] : [] }]);
  add(/^Zoe's kit reacts to the scout/, () => [{ f: [0, 1], cam: { k: 'grp', sel: [{ ids: c.spears, near: [B[1].x, B[1].z, 22] }, { ids: c.spears }], dist: 28, side: -1 }, tag: { p: 2, text: `${nm[1].toUpperCase()}  3 SPEARMEN ORDERED` }, marks: [{ sel: { ids: c.spears }, o: 2, label: 'SPEARMEN {n}' }] }]);
  add(/finishes an archery range at 06:25/, () => [
    { f: [0, 0.5], cam: { k: 'bld', ...c.archery, d0: 36, d1: 24, side: -1 }, tag: { p: 2, text: `${nm[1].toUpperCase()}  ARCHERY RANGE` }, marks: [{ bld: c.archery, o: 2, label: 'ARCHERY RANGE' }] },
    { f: [0.5, 1], cam: { k: 'bld', ...c.smith, d0: 36, d1: 24, side: 1 }, tag: { p: 2, text: `${nm[1].toUpperCase()}  BLACKSMITH` }, marks: [{ bld: c.smith, o: 2, label: 'BLACKSMITH' }] },
  ]);
  add(/only gets its first barracks at 08:28/, () => [{ f: [0, 1], cam: { k: 'bld', ...c.barracks1, d0: 36, d1: 24, side: 1 }, tag: { p: 1, text: `${nm[0].toUpperCase()}  FIRST BARRACKS` }, marks: [{ bld: c.barracks1, o: 1, label: 'BARRACKS' }] }]);
  add(/reaches tier 2, and QuartzRT is still behind/, () => [{ f: [0, 1], cam: tc(2), tag: { p: 2, text: `${nm[1].toUpperCase()}  TIER 2` }, marks: [{ bld: B[1], o: 2, label: 'TIER 2' }] }]);
  add(/^QuartzRT's answer comes at 11:13/, () => [
    { f: [0, 0.55], cam: tc(1), tag: { p: 1, text: `${nm[0].toUpperCase()}  ADVANCING TO TIER 2` }, marks: [{ bld: B[0], o: 1, label: 'TIER 2 UPGRADE' }] },
    { f: [0.55, 1], cam: { k: 'bld', ...c.stables1, d0: 36, d1: 24, side: -1 }, tag: { p: 1, text: `${nm[0].toUpperCase()}  STABLES + SIEGE WORKSHOP NEXT` }, marks: [{ bld: c.stables1, o: 1, label: 'STABLES' }] },
  ]);
  add(/^So who is really ahead/, () => [{ f: [0, 1], cam: { k: 'mid', a: { t: 'at', x: B[0].x, z: B[0].z }, b: { t: 'at', x: B[1].x, z: B[1].z }, side: 1, wide: true }, tag: { text: 'BOTH SIDES TOGETHER' }, marks: [{ bld: B[0], o: 1, label: nm[0] }, { bld: B[1], o: 2, label: nm[1] }] }]);
  add(/^QuartzRT reaches tier 2 at 11:58/, () => [{ f: [0, 1], cam: tc(1), tag: { p: 1, text: `${nm[0].toUpperCase()}  TIER 2 AT 11:58` }, marks: [{ bld: B[0], o: 1, label: 'TIER 2' }] }]);
  add(/^The armies show it/, () => [{ f: [0, 1], cam: { k: 'mid', a: { t: 'army', o: 1 }, b: { t: 'army', o: 2 }, side: 1, wide: true }, tag: { text: 'ARMY VALUE  BOTH SIDES' }, versus: c.armyVs(7188), marks: [{ sel: { t: 'army', o: 1 }, o: 1, label: 'ARMY {n}' }, { sel: { t: 'army', o: 2 }, o: 2, label: 'ARMY {n}' }] }]);
  add(/^Then Zoe's kit finishes a siege workshop at 12:14/, () => [{ f: [0, 1], cam: { k: 'bld', ...c.siege2, d0: 38, d1: 22, side: -1 }, tag: { p: 2, text: `${nm[1].toUpperCase()}  SIEGE WORKSHOP` }, marks: [{ bld: c.siege2, o: 2, label: 'SIEGE WORKSHOP' }] }]);
  add(/^Rams are slow, but they tear buildings down/, () => [{ f: [0, 1], cam: { k: 'bld', ...c.siege2, d0: 26, d1: 18, side: 1 }, tag: { p: 2, text: 'RAMS TEAR BUILDINGS DOWN' }, marks: [{ bld: c.siege2, o: 2, label: 'RAMS COME FROM HERE' }] }]);
  add(/^QuartzRT writes at 12:34/, () => [{ f: [0, 1], cam: { k: 'bld', ...c.stables1, d0: 34, d1: 22, side: 1 }, tag: { p: 1, text: `${nm[0].toUpperCase()}  STABLES FOR LIGHT CAVALRY` }, marks: [{ bld: c.stables1, o: 1, label: 'STABLES' }] }]);
  add(/^Zoe's kit orders its first rams at 13:20/, () => [
    { f: [0, 0.5], cam: { k: 'bld', ...c.siege2, d0: 30, d1: 20, side: -1 }, tag: { p: 2, text: `${nm[1].toUpperCase()}  FIRST RAMS` }, marks: [{ bld: c.siege2, o: 2, label: 'SIEGE WORKSHOP' }, { sel: { t: 'type', o: 2, ty: 'ram' }, o: 2, label: 'RAM' }] },
    { f: [0.5, 1], cam: { k: 'bld', ...c.siege1, d0: 34, d1: 22, side: 1 }, tag: { p: 1, text: `${nm[0].toUpperCase()}  SIEGE WORKSHOP + RAMS PLANNED` }, marks: [{ bld: c.siege1, o: 1, label: 'SIEGE WORKSHOP (PLANNED)' }] },
  ]);
  // blind armies: the fog of war of each side shows that the army sees nothing
  add(/^Both models have a big army/, () => [
    { f: [0, 0.55], cam: { k: 'grp', sel: { t: 'army', o: 2 }, dist: 40, side: -1, elev: 18 }, fog: 2, tag: { p: 2, text: `${nm[1].toUpperCase()}'S VIEW  NO ENEMY IN SIGHT` }, marks: [{ sel: { t: 'army', o: 2 }, o: 2, label: 'ARMY {n}' }] },
    { f: [0.55, 1], cam: { k: 'grp', sel: { t: 'army', o: 2 }, dist: 40, side: 1, elev: 18 }, fog: 2, tag: { p: 2, text: `${nm[1].toUpperCase()}'S VIEW  NO ENEMY IN SIGHT` }, marks: [{ sel: { t: 'army', o: 2 }, o: 2, label: 'ARMY {n}' }] },
  ]);
  add(/^QuartzRT's view is just as empty/, () => [{ f: [0, 1], cam: { k: 'grp', sel: { t: 'army', o: 1 }, dist: 40, side: 1, elev: 18 }, fog: 1, tag: { p: 1, text: `${nm[0].toUpperCase()}'S VIEW  NO ENEMY IN SIGHT` }, marks: [{ sel: { t: 'army', o: 1 }, o: 1, label: 'ARMY {n}' }] }]);
  add(/^Zoe's kit finally writes/, () => [{ f: [0, 1], cam: { k: 'grp', sel: { t: 'army', o: 2 }, dist: 38, side: -1 }, fog: 2, tag: { p: 2, text: `${nm[1].toUpperCase()}  MARCHING ON THE ENEMY BASE` }, marks: [{ sel: { t: 'army', o: 2 }, o: 2, label: 'ARMY {n}' }] }]);
  add(/^QuartzRT too: /, () => [{ f: [0, 1], cam: { k: 'grp', sel: { t: 'army', o: 1 }, dist: 38, side: 1 }, fog: 1, tag: { p: 1, text: `${nm[0].toUpperCase()}  ALL-IN ON THE ENEMY TOWN CENTER` }, marks: [{ sel: { t: 'army', o: 1 }, o: 1, label: 'ARMY {n}' }] }]);
  add(/^Blind and all-in/, () => [{ f: [0, 1], cam: { k: 'mid', a: { t: 'army', o: 1 }, b: { t: 'army', o: 2 }, side: 1 }, tag: { text: 'TWO BLIND ARMIES' }, marks: [{ sel: { t: 'army', o: 1 }, o: 1, label: 'ARMY {n}' }, { sel: { t: 'army', o: 2 }, o: 2, label: 'ARMY {n}' }] }]);
  add(/^QuartzRT finishes its own siege workshop at 14:28/, () => [{ f: [0, 1], cam: { k: 'bld', ...c.siege1, d0: 34, d1: 22, side: -1 }, tag: { p: 1, text: `${nm[0].toUpperCase()}  SIEGE WORKSHOP` }, marks: [{ bld: c.siege1, o: 1, label: 'SIEGE WORKSHOP' }] }]);
  add(/^For now the two armies just march toward each other/, () => [{ f: [0, 1], cam: { k: 'mid', a: { t: 'army', o: 1 }, b: { t: 'army', o: 2 }, side: -1 }, tag: { text: 'ARMIES MARCH TOWARD EACH OTHER' }, marks: [{ sel: { t: 'army', o: 1 }, o: 1, label: 'ARMY {n}' }, { sel: { t: 'army', o: 2 }, o: 2, label: 'ARMY {n}' }] }]);
  add(/^After that fight Zoe's kit has a huge army lead/, () => [{ f: [0, 1], cam: { k: 'mid', a: { t: 'army', o: 1 }, b: { t: 'army', o: 2 }, side: -1 }, tag: { text: 'AFTER THE FIGHT' }, versus: c.armyVs(9402), marks: [{ sel: { t: 'army', o: 1 }, o: 1, label: 'ARMY {n}' }, { sel: { t: 'army', o: 2 }, o: 2, label: 'ARMY {n}' }] }]);
  // the model's own view: the 3D view switches to its fog of war, the inset shows exactly what it was given when it decided
  add(/^Through QuartzRT's eyes: /, () => [{ f: [0, 1], cam: { k: 'look', from: 1, to: 2, rot: 10, lateral: -8, ahead: 34 }, fog: 1, tag: { p: 1, text: `THROUGH ${nm[0].toUpperCase()}'S EYES  FOG OF WAR` }, inset: 'p1', marks: [] }]);
  add(/^Its army is nearly gone/, () => [{ f: [0, 1], cam: { k: 'grp', sel: { t: 'army', o: 1 }, dist: 34, side: 1 }, fog: 1, tag: { p: 1, text: `${nm[0].toUpperCase()}  ARMY NEARLY GONE` }, marks: [{ sel: { t: 'army', o: 1 }, o: 1, label: 'ARMY {n}' }] }]);
  add(/^A desperate gamble/, () => [{ f: [0, 1], cam: { k: 'grp', sel: { t: 'army', o: 1 }, dist: 38, side: -1 }, tag: { p: 1, text: `${nm[0].toUpperCase()}  FULL PUSH ON THE ENEMY TOWN CENTER` }, marks: [{ sel: { t: 'army', o: 1 }, o: 1, label: 'ARMY {n}' }] }]);
  add(/^Does a small army have a chance against a big one/, () => [{ f: [0, 1], cam: { k: 'mid', a: { t: 'army', o: 1 }, b: { t: 'army', o: 2 }, side: 1 }, versus: c.armyVs(9793), marks: [{ sel: { t: 'army', o: 1 }, o: 1, label: 'SMALL ARMY {n}' }, { sel: { t: 'army', o: 2 }, o: 2, label: 'BIG ARMY {n}' }] }]);
  add(/^Zoe's kit sees 17 enemy units/, () => [{ f: [0, 1], cam: { k: 'look', from: 2, to: 1, rot: 10, lateral: 8, ahead: 34 }, fog: 2, tag: { p: 2, text: `THROUGH ${nm[1].toUpperCase()}'S EYES  FOG OF WAR` }, inset: 'p2', marks: [] }]);
  add(/^A ram goes straight through QuartzRT's mining camp/, () => [{ f: [0, 1], cam: { k: 'bld', ...c.camp1, d0: 36, d1: 22, side: 1 }, tag: { p: 1, text: `${nm[0].toUpperCase()}  MINING CAMP UNDER ATTACK` }, marks: [{ bld: c.camp1, o: 1, label: 'MINING CAMP' }, { sel: { t: 'type', o: 2, ty: 'ram', near: [c.camp1.x, c.camp1.z, 20] }, o: 2, label: 'RAM' }] }]);
  add(/^QuartzRT's push melts away/, () => [{ f: [0, 1], cam: { k: 'mid', a: { t: 'army', o: 1 }, b: { t: 'army', o: 2 }, side: -1 }, tag: { p: 1, text: `${nm[0].toUpperCase()}'S PUSH MELTS AWAY` }, marks: [{ sel: { t: 'army', o: 1 }, o: 1, label: 'ARMY {n}' }, { sel: { t: 'type', o: 2, ty: 'ram' }, o: 2, label: 'RAM' }] }]);
  add(/^Another ram, another building/, () => [{ f: [0, 1], cam: { k: 'bld', ...c.range1, d0: 34, d1: 20, side: -1 }, tag: { p: 1, text: `${nm[0].toUpperCase()}  ARCHERY RANGE FALLS` }, marks: [{ bld: c.range1, o: 1, label: 'ARCHERY RANGE' }, { sel: { t: 'type', o: 2, ty: 'ram', near: [c.range1.x, c.range1.z, 22] }, o: 2, label: 'RAM' }] }]);
  add(/^At 16:54 QuartzRT sees three rams/, () => [
    { f: [0, '@That.s what'], cam: { k: 'look', from: 1, to: 2, rot: 10, lateral: -6, ahead: 18, d0: 46, d1: 40 }, fog: 1, tag: { p: 1, text: `${nm[0].toUpperCase()}  THREE RAMS HEAD FOR THE BASE` }, marks: [{ sel: RAMS, o: 2, label: 'RAM' }] },
    { f: ['@That.s what', 1], cam: { k: 'bld', ...c.siege2, d0: 46, d1: 26, side: -1 }, tag: { p: 2, text: `${nm[1].toUpperCase()}  SIEGE WORKSHOP FINISHED 12:14` }, marks: [{ bld: c.siege2, o: 2, label: 'SIEGE WORKSHOP' }] },
  ]);
  const duel = (side, tag) => ({ cam: { k: 'mid', a: [DEF, { t: 'at', x: c.barracks1.x, z: c.barracks1.z }], b: RAMS, side, minDist: 44 }, tag: tag && { p: 1, text: tag }, marks: [{ sel: DEF, o: 1, label: 'DEFENDERS' }, { sel: RAMS, o: 2, label: 'RAM' }] });
  add(/^It writes: .Enemy rams pushing my base/, () => [{ f: [0, 1], ...duel(1, `${nm[0].toUpperCase()}  SENDS DEFENDERS AGAINST THE RAMS`) }]);
  add(/^A small trio against three rams/, () => [{ f: [0, 1], ...duel(-1, 'FEW DEFENDERS AGAINST THREE RAMS') }]);
  add(/^Zoe's kit sends its rams at QuartzRT's barracks/, () => [{ f: [0, 1], cam: { k: 'bld', ...c.barracks1, d0: 36, d1: 22, side: 1 }, tag: { p: 2, text: `${nm[1].toUpperCase()}  RAMS AT THE BARRACKS` }, marks: [{ bld: { ...c.barracks1 }, o: 1, label: 'BARRACKS' }, { sel: { ...RAMS, near: [c.barracks1.x, c.barracks1.z, 30] }, o: 2, label: 'RAM' }] }]);
  add(/^Five more units fall/, () => [{ f: [0, 1], cam: { k: 'grp', sel: [{ ...RAMS, near: [c.barracks1.x, c.barracks1.z, 25] }, { t: 'at', x: c.barracks1.x, z: c.barracks1.z }], dist: 34, side: 1 }, tag: { p: 1, text: 'FIVE MORE UNITS FALL' }, marks: [{ sel: DEF, o: 1, label: 'DEFENDERS' }] }]);
  add(/^A small trio has little chance against three rams/, () => [{ f: [0, 1], ...duel(1, 'WITHOUT AN ARMY QUARTZRT CANNOT STOP THEM') }]);
  add(/^There goes the barracks/, () => [{ f: [0, 1], cam: { k: 'bld', ...c.barracks1, d0: 34, d1: 20, side: -1 }, tag: { p: 1, text: `${nm[0].toUpperCase()}  BARRACKS FALLS` }, marks: [{ bld: c.barracks1, o: 1, label: 'BARRACKS' }, { sel: { ...RAMS, near: [c.barracks1.x, c.barracks1.z, 25] }, o: 2, label: 'RAM' }] }]);
  add(/^And the mill goes down too/, () => [{ f: [0, 1], cam: { k: 'bld', ...c.mill1, d0: 36, d1: 22, side: -1 }, tag: { p: 1, text: `${nm[0].toUpperCase()}  MILL FALLS` }, marks: [{ bld: c.mill1, o: 1, label: 'MILL' }] }]);
  add(/^No barracks means no new soldiers/, () => [{ f: [0, 1], cam: { k: 'bld', ...c.barracks1, d0: 40, d1: 28, side: 1 }, tag: { p: 1, text: 'NO BARRACKS  NO NEW SOLDIERS' }, marks: [{ bld: c.barracks1, o: 1, label: 'BARRACKS (LOST)' }] }]);
  add(/^And there's the answer to my question/, () => [{ f: [0, 1], tag: { p: 1, text: `5 UNITS LOST SINCE THE 16:54 NOTE` } }]);
  add(/^So what decided it/, () => [{ f: [0, 1], versus: c.lostVs }]);
  add(/^QuartzRT wrote 47 notes/, () => [{ f: [0, 1], versus: c.notesVs }]);
  return R;
}

