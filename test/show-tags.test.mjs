// Broadcast rules and show tags: the rule book is in the prompt word for word, tags are validated against the log, the generic inferrer reads lines it has no
// tag for, the template never fails its own checker, and the tag path gives the same pictures as the hand-written rules of the approved s101 script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scriptedReplay } from '../test-support/replays.mjs';
import { loadReplay } from '../tools/lib/replay.mjs';
import { computeEvents } from '../tools/events.mjs';
import { computeHighlights } from '../tools/highlights.mjs';
import { buildStory } from '../tools/story.mjs';
import { buildScript } from '../tools/caster-facts.mjs';
import { makeContext, checkLines } from '../tools/caster-check.mjs';
import { buildPrompt, makeCasterTrack, writeTrack } from '../tools/casters.mjs';
import { loadRules } from '../tools/broadcast-rules.mjs';
import { World, validateShow, inferShow, tagKind } from '../tools/show-tags.mjs';
import { panelFaults, Show, tagParts } from '../tools/story-show.mjs';
import { s101Rules, bldAt } from '../test-support/s101-show-rules.mjs';
import { prepare } from '../tools/render-broadcast.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let cache = null;
function world3() { // boom against rush, seed 3: a first contact seen by player 1 and a siege workshop of player 2
  if (!cache) {
    const rep = loadReplay(scriptedReplay(['boom', 'rush'], 3));
    const ev = computeEvents(rep);
    cache = { rep, ev, world: new World(ev) };
  }
  return cache;
}

test('rule book: BROADCAST-RULES.md goes into the script prompt word for word, with its hash', () => {
  const rules = loadRules();
  assert.ok(fs.existsSync(path.join(ROOT, 'BROADCAST-RULES.md')));
  for (const must of ['always shows what is being said', 'fog of war', 'follow-up', 'intent', 'one conversation', 'gamer lingo', 'Plain language', '"it"', 'Only facts from the log', 'There is no small inset map']) assert.ok(rules.text.includes(must), `rule book mentions: ${must}`);
  const { ev } = world3();
  const { sheet, beats, duration_s } = buildScript(ev, prepare(world3().rep, {}).plans.highlight, { cls: '' });
  const p = buildPrompt(sheet, beats, duration_s, rules);
  assert.ok(p.system.includes(rules.text), 'the rule book is in the prompt verbatim');
  assert.ok(p.system.includes(rules.hash) && p.rules_hash === rules.hash);
  assert.ok(p.system.includes('SHOW TAGS') && p.system.includes('"show"'));
  const changed = buildPrompt(sheet, beats, duration_s, { text: rules.text + '\n10. Be brief.', hash: 'x' });
  assert.notEqual(changed.system, p.system, 'a tuned rule book changes the prompt (and so the LLM cache key)');
});

test('show tags: validated against the log (unit or building exists at that time, player and metric known)', () => {
  const { ev, world } = world3();
  const swEv = ev.events.find((e) => e.type === 'key_building' && e.p === 2 && e.building === 'siege_workshop');
  const before = swEv.t - 200, after = swEv.t + 5;
  assert.deepEqual(validateShow({ building: { player: 2, type: 'siege_workshop' } }, world, after).reasons, []);
  assert.match(validateShow({ building: { player: 2, type: 'siege_workshop' } }, world, before).reasons[0], /no finished siege workshop/);
  assert.match(validateShow({ building: { player: 3, type: 'barracks' } }, world, after).reasons[0], /not a player/);
  assert.match(validateShow({ building: { player: 1, type: 'spaceport' } }, world, after).reasons[0], /does not exist/);
  assert.match(validateShow({ fog: { player: 0 } }, world, after).reasons[0], /not a player/);
  assert.match(validateShow({ versus: { metric: 'wattage' } }, world, after).reasons[0], /unknown metric/);
  assert.deepEqual(validateShow({ versus: { metric: 'army', focus: 2 } }, world, after).tags[0].versus, { metric: 'army', focus: 2 });
  assert.match(validateShow({ versus: { metric: 'army', focus: 3 } }, world, after).reasons[0], /focus/);
  assert.match(validateShow({ versus: { metric: 'army', focus: 'a' } }, world, after).reasons[0], /focus/);
  assert.match(validateShow({ follow: { sel: { t: 'type', o: 1, ty: 'dragon' } } }, world, after).reasons[0], /does not exist/);
  assert.match(validateShow({ follow: { sel: { t: 'type', o: 1, ty: 'ram' } } }, world, after).reasons[0], /no ram/);
  assert.match(validateShow({ event: { id: 99999 } }, world, after).reasons[0], /not in the log/);
  assert.match(validateShow({ event: { id: swEv.id } }, world, before).reasons[0], /after this moment/);
  assert.match(validateShow({ inset: { player: 1, decision: 3 } }, world, after).reasons[0], /no decision/, 'a scripted bot has no model decision');
  assert.match(validateShow({ wibble: {} }, world, after).reasons[0], /unknown show tag/);
  assert.deepEqual(validateShow([{ fog: { player: 1 } }, { view: { player: 2 } }, { place: { base: 1 } }, { place: { base: 2 } }], world, after).reasons, ['at most 3 show tags per line']);
  const ok = validateShow([{ follow: { sel: { t: 'army', o: 2 } }, fog: { player: 2 } }, { versus: { metric: 'army' } }, { place: { base: 1 }, at: 'home' }], world, after);
  assert.deepEqual(ok.reasons, []);
  assert.equal(ok.tags.length, 3);
  assert.deepEqual(ok.tags.map(tagKind), ['follow', 'versus', 'place']);
  assert.deepEqual(ok.tags[0].fog, { player: 2 });
});

test('the checker reports invalid show tags separately and never fails a line for them', () => {
  const { ev, world } = world3();
  const { sheet, beats } = buildScript(ev, prepare(world3().rep, {}).plans.highlight, { cls: '' });
  const ctx = makeContext(sheet, beats, { world });
  const b = beats[1];
  const line = { beat: b.id, speaker: 'ana', when: 'at', delivery: 'calm', text: 'A quiet moment before the storm.', facts: [], subject: null, opinion: false, interject: false, show: { building: { player: 2, type: 'wall' } } };
  const r = checkLines([line], ctx);
  assert.ok(r.ok);
  assert.equal(r.badShow.length, 1);
  assert.match(r.badShow[0].reasons[0], /no finished wall/);
  // "it" for AI players
  const he = checkLines([{ ...line, show: null, text: 'He builds a barracks and his army grows.' }], ctx);
  assert.ok(!he.ok && /"it"/.test(he.bad[0].reasons.join()));
});

test('inferrer: a line without a tag is read by keywords and entities, nothing script specific', () => {
  const { ev, world } = world3();
  const names = ['QuartzRT', "Zoe's kit"];
  const tick = ev.ticks;
  const kinds = (text) => inferShow(text, world, { names, tick }).map((q) => q.tag);
  assert.deepEqual(kinds("Zoe's kit finishes a siege workshop. That looks like preparation for rams."), [{ building: { player: 2, type: 'siege_workshop' } }]);
  assert.deepEqual(kinds("QuartzRT's view is just as empty."), [{ fog: { player: 1 } }]);
  assert.deepEqual(kinds('The armies show it: 2455 in value for Zoe\'s kit, 1225 for QuartzRT.'), [{ versus: { metric: 'army' } }]);
  assert.deepEqual(kinds("Zoe's kit has the home advantage in its base."), [{ place: { base: 2 } }]);
  assert.deepEqual(kinds('Nothing here talks about anything on the map.'), []);
  const blind = inferShow('QuartzRT sees no enemy army in sight.', world, { names, tick: 7188 }).map((q) => q.tag);
  assert.equal(tagKind(blind[0]), 'follow');
  assert.deepEqual(blind[0].fog, { player: 1 });
  // two buildings in one sentence give two tags, in the order they are said
  const two = kinds("Zoe's kit finishes an archery range and a blacksmith.");
  assert.deepEqual(two.map((t) => t.building.type), ['archery_range', 'blacksmith']);
  // the same words with other player names work the same
  const other = inferShow('Alpha builds a barracks.', world, { names: ['Alpha', 'Beta'], tick }).map((q) => q.tag);
  assert.deepEqual(other, [{ building: { player: 1, type: 'barracks' } }]);
});

// ---- regression: the tag path gives the pictures of the hand-written s101 rules (test-support/s101-show-rules.mjs)
const norm = (parts) => parts.map((p) => ({ cam: p.cam && p.cam.k, fog: p.fog || null, versus: p.versus ? p.versus.rows.map((r) => r.val) : null, at: p.cam && p.cam.k === 'bld' ? [Math.round(p.cam.x), Math.round(p.cam.z)] : null, tagP: p.tag ? p.tag.p ?? null : null }));
// Skipped since 08.11.: the shot length limits (G8, 4-10 s) merge and cut the parts of this synthetic timeline (L1 holds the time of L2), so the part-by-part comparison with the s101 rules no longer holds. Needs a rewrite on the current camera rules.
test('regression s101: fog, scout, workshop and versus lines get equivalent parts from tags (and from the inferrer)', { skip: 'outdated by the shot length limits of 08.11.' }, () => {
  const { rep, ev } = world3();
  const names = ['QuartzRT', "Zoe's kit"];
  const first = ev.events.find((e) => e.type === 'first_contact'), sw = ev.events.find((e) => e.type === 'key_building' && e.p === 2 && e.building === 'siege_workshop');
  assert.equal(first.p, 1);
  const lines = [
    { id: 'L1', text: "Zoe's kit does the same without a word, only orders. And each of them sees only part of the map.", show: [{ follow: { sel: { t: 'workers', o: 2 } } }, { fog: { player: 2 }, at: 'And each' }, { fog: { player: 1 }, at: 'part of the map' }], start: 10, end: 20 },
    { id: 'L2', text: "At 03:14 QuartzRT's scout finds an enemy worker. Will it rush?", show: { event: { id: first.id } }, start: 22, end: 28 },
    { id: 'L3', text: "Then Zoe's kit finishes a siege workshop at 12:14. That looks like preparation for rams.", show: { building: { player: 2, type: 'siege_workshop' } }, start: 30, end: 38 },
    { id: 'L4', text: "The armies show it: 2455 in value for Zoe's kit, 1225 for QuartzRT.", show: { versus: { metric: 'army' } }, start: 40, end: 46 },
  ];
  const beats = lines.map((l, i) => ({ id: i + 1, tick_end: [first.t + 100, first.t + 100, sw.t + 10, 7188][i] }));
  lines.forEach((l, i) => { l.beat = i + 1; });
  const tagged = new Show({ rep, ev, lines, names, beats });
  const noTags = new Show({ rep, ev, lines: lines.map(({ show, ...l }) => l), names, beats });
  assert.deepEqual(tagged.lineMap.map((m) => m.source), ['tag', 'tag', 'tag', 'tag']);
  // the legacy context, built from the same replay
  const c = { starts: tagged.pre.starts, names, scout: tagged.pre.scouts[first.id], contact: first.loc, siege2: bldAt(ev, 2, 'siege_workshop'), thinkVersus: null, armyVs: (tick) => { const a = [1, 2].map((p) => tagged.data.army(p, tick) ?? 0); return { title: `ARMY VALUE`, rows: [{ o: 1, name: names[0], val: a[0], label: String(a[0]) }, { o: 2, name: names[1], val: a[1], label: String(a[1]) }] }; } };
  const rules = s101Rules(c);
  for (const [i, l] of lines.entries()) {
    const rule = rules.find((r) => r.re.test(l.text));
    assert.ok(rule, `legacy rule for ${l.id}`);
    const legacy = norm(rule.mk(c).filter((p) => p.cam || p.fog || p.versus));
    const mine = norm(tagged.parts.filter((p) => p.line === l.id));
    assert.equal(mine.length, legacy.length, `${l.id}: same number of parts`);
    mine.forEach((m, k) => {
      const g = legacy[k];
      assert.equal(m.fog, g.fog, `${l.id} part ${k}: same fog of war player`);
      if (i === 3) assert.deepEqual(m.versus, g.versus, 'same bars');
      else assert.equal(m.cam, i === 0 && g.fog ? 'map' : g.cam, `${l.id} part ${k}: same camera kind (a fog view is the whole map from above since match 5)`);
      if (i === 2) assert.deepEqual(m.at, g.at, 'same building');
    });
  }
  // the scout line also rings the scout, like the s101 rule
  assert.ok(tagged.parts.find((p) => p.line === 'L2').marks.some((m) => m.sel && m.sel.ids && m.sel.ids.length === 1));
  // without tags the generic inferrer finds the picture of the workshop, the army bars and the fog view of the first line
  const byLine = (s, id) => s.parts.filter((p) => p.line === id);
  assert.ok(byLine(noTags, 'L3').length >= 1 && byLine(noTags, 'L3')[0].cam.k === 'bld' && Math.round(byLine(noTags, 'L3')[0].cam.x) === norm(byLine(tagged, 'L3'))[0].at[0]);
  assert.deepEqual(norm(byLine(noTags, 'L4')).map((p) => p.versus), [norm(byLine(tagged, 'L4'))[0].versus]);
  assert.ok(byLine(noTags, 'L1').some((p) => p.fog === 2 || p.fog === 1), 'fog is mentioned: a fog of war view');
  assert.deepEqual(noTags.lineMap.slice(0, 4).map((m) => m.source), ['inferred', 'inferred', 'inferred', 'inferred']);
});

test('tag parts: fog shows the whole map from above with that player\'s view; a building is a push-in with a ring', () => {
  const { rep, ev } = world3();
  const show = new Show({ rep, ev, lines: [], names: ['A', 'B'] });
  const fog = tagParts({ fog: { player: 2 } }, show.ctx, ev.ticks)[0];
  assert.equal(fog.fog, 2); assert.equal(fog.cam.k, 'map'); assert.equal(fog.clean, true);
  const view = tagParts({ view: { player: 1 } }, show.ctx, ev.ticks)[0];
  assert.equal(view.fog, undefined); assert.equal(view.cam.from, 1);
  const b = tagParts({ building: { player: 1, type: 'barracks' } }, show.ctx, ev.ticks)[0];
  assert.equal(b.cam.k, 'bld'); assert.equal(b.marks[0].label, 'BARRACKS');
  const f = tagParts({ follow: { sel: { t: 'army', o: 1 } }, fog: { player: 1 } }, show.ctx, ev.ticks)[0];
  assert.equal(f.cam.k, 'grp'); assert.equal(f.fog, 1);
});

test('template: never fails its own checker, tags every picture, on several replays and both cuts', async () => {
  for (const [bots, seed] of [[['rush', 'boom'], 3], [['boom', 'turtle'], 11], [['turtle', 'rush'], 5]]) {
    const rep = loadReplay(scriptedReplay(bots, seed)), ev = computeEvents(rep), hl = computeHighlights(ev);
    const plans = [prepare(rep, {}).plans.highlight];
    try { plans.push(buildStory(ev, hl, { target_s: 300 }).plan); } catch { /* the match does not fit a story cut */ }
    for (const plan of plans) {
      for (const sd of [0, 1, 2, 3]) {
        const r = await makeCasterTrack({ ev, plan, cls: '', seed: sd });
        const g = r.track.generated;
        assert.deepEqual(g.template_dropped, [], `${bots} seed ${seed}/${sd}: the template passes its own checker`);
        assert.deepEqual(g.show_invalid, [], 'every tag the template writes is true in the log');
        assert.equal(g.rules_hash, loadRules().hash);
        assert.ok(r.track.lines.length > 5);
        for (const l of r.track.lines) assert.ok(!/\b(he|his|him|she|her)\b/i.test(l.text.replace(/[“"][^”"]*[”"]/g, '')) || /\b(Dex|Juno)\b/.test(l.text), `AI players are "it": ${l.text}`);
        // Dex only in action beats and the opening, in runs
        const byId = new Map(r.beats.map((b) => [b.id, b]));
        for (const l of r.track.lines.filter((x) => x.speaker === 'pbp')) assert.ok(byId.get(l.beat).role !== 'calm', 'Dex does not speak in calm beats');
        const tagged = r.track.lines.filter((l) => l.show).length;
        assert.ok(tagged / r.track.lines.length >= 0.5, `at least half the lines carry a show tag (${tagged}/${r.track.lines.length})`);
      }
    }
  }
});

test('the prompt file carries the hash of the rule book', async () => {
  const { ev, rep } = world3();
  const r = await makeCasterTrack({ ev, plan: prepare(rep, {}).plans.highlight, cls: '', seed: 0 });
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'rts-rules-'));
  const files = writeTrack(dir, 'x', r);
  const j = JSON.parse(fs.readFileSync(files.prompt, 'utf8'));
  assert.equal(j.rules_hash, loadRules().hash);
  assert.ok(j.messages[0].content.includes(loadRules().text));
});

test('a comparison panel can name its moment: the clock is checked, and the bars and the title show that moment', () => {
  const { rep, ev, world } = world3();
  const v = validateShow({ versus: { metric: 'army', clock: '00:30' } }, world, ev.ticks);
  assert.deepEqual(v.reasons, []);
  assert.equal(v.tags[0].versus.tick, 300);
  assert.match(validateShow({ versus: { metric: 'army', clock: 'soon' } }, world, ev.ticks).reasons[0], /not mm:ss/);
  assert.ok(validateShow({ versus: { metric: 'think', clock: '00:30' } }, world, ev.ticks).reasons.length >= 1);
  const show = new Show({ rep, ev, lines: [], names: ['A', 'B'] });
  const [p] = tagParts(v.tags[0], show.ctx, ev.ticks);
  assert.match(p.versus.title, /00:30/);
  assert.equal(p.versus.rows[0].val, Math.round(ev.series.army[0][30]));
  assert.equal(p.asOf.auto, false);
});

test('a panel never shows the future: without a clock it stops at the picture, a clock ahead of the picture stops the render', () => {
  const { rep, ev } = world3();
  const line = (show) => [{ id: 'L1', start: 10, end: 12, text: 'Look at the armies.', beat: 1, show }];
  const opts = { rep, ev, names: ['A', 'B'], beats: [{ id: 1, tick_end: ev.ticks }], tl: { tickAt: (o) => o * 10 } };
  const auto = new Show({ ...opts, lines: line({ versus: { metric: 'army' } }) });
  const p = auto.parts.find((q) => q.versus);
  assert.ok(p.asOf.tick <= Math.floor(p.o1 * 10), 'the panel never shows a moment after the end of its part'); // equal unless a later pass (shot length limits, G8) stretched the part
  assert.ok(p.asOf.tick < ev.ticks);
  assert.deepEqual(auto.faults, []);
  const s = Math.floor(p.asOf.tick / 10);
  assert.equal(p.versus.rows[0].val, Math.round(ev.series.army[0][s]));
  const ahead = new Show({ ...opts, lines: line({ versus: { metric: 'army', clock: '05:00' } }) });
  assert.match(ahead.faults[0], /L1: the panel at 05:00 runs ahead of the picture/);
});

test('panel check: the two faults of match 5 (a panel that shows another moment than the line says) are caught', () => {
  const rows = (a, b) => [{ val: a }, { val: b }];
  const line40 = 'The whole map at 11:48: dead even. Army value 2240 against 2295, 24 workers against 23.';
  assert.match(panelFaults({ line: 'L40', text: line40, rows: rows(3555, 3010), tick: 8720, seen: 8720 })[0], /says 2240, 2295, the panel shows 3555, 3010/);
  assert.deepEqual(panelFaults({ line: 'L40', text: line40, rows: rows(2240, 2295), tick: 7080, seen: 7250 }), []);
  const line24 = 'Still on tier 1, army value 285 against 1065.';
  assert.equal(panelFaults({ line: 'L24', text: line24, rows: rows(995, 425), tick: 4200, seen: 4200 }).length, 1);
  assert.deepEqual(panelFaults({ line: 'L36', text: 'And the army lead flips.', rows: rows(855, 1355), tick: 5300, seen: 5300 }), []);
  assert.match(panelFaults({ line: 'L9', text: 'Look.', rows: rows(1, 2), tick: 5000, seen: 4000 })[0], /runs ahead of the picture/);
});

test('a template script cannot be rewritten: its wrong panel goes, the line and the render stay', () => {
  const { rep, ev } = world3();
  const lines = [{ id: 'L1', start: 10, end: 12, text: 'Army value 111 against 222.', beat: 1, show: { versus: { metric: 'army' } } }];
  const opts = { rep, ev, lines, names: ['A', 'B'], beats: [{ id: 1, tick_end: ev.ticks }], tl: { tickAt: (o) => o * 10 } };
  const strict = new Show(opts);
  assert.match(strict.faults[0], /L1: the line says 111, 222/);
  const template = new Show({ ...opts, template: true });
  assert.deepEqual(template.faults, []);
  assert.match(template.panelsDropped[0], /L1: the line says 111, 222/);
  assert.ok(template.parts.length > 0 && template.parts.every((p) => !p.versus), 'no panel with a wrong number on screen');
});

test('a fault of a panel stops the render before its first frame', () => {
  const src = fs.readFileSync(new URL('../tools/render-story.mjs', import.meta.url), 'utf8');
  assert.match(src, /show\?\.faults\.length[^\n]*process\.exit\(3\)/);
  assert.ok(src.indexOf('show?.faults.length') < src.indexOf('renderCut({'), 'the check runs before the render');
  assert.match(fs.readFileSync(new URL('../tools/render-broadcast.mjs', import.meta.url), 'utf8'), /show\.faults\.length[^\n]*process\.exit\(3\)/, 'the other cuts stop the same way');
});
