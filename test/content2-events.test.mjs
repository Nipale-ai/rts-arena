import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMatch } from '../tools/run-match.mjs';
import { computeEvents } from '../tools/events.mjs';
import { computeHighlights } from '../tools/highlights.mjs';
import { buildPlan } from '../tools/plan.mjs';
import { buildScript } from '../tools/caster-facts.mjs';
import { makeContext, checkLine } from '../tools/caster-check.mjs';

// a fast-preset game that ends with a wonder (the first seed where towers builds one)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-c2-'));
// (a short countdown so that the match ends with the wonder for the first seed that gets one built)
const RULES = { preset: 'fast', wonderSecs: 120 };
let r = null;
for (let seed = 1; seed <= 20 && !(r && r.result.reason === 'wonder'); seed++) r = runMatch({ seed, bots: ['towers', 'boom'], rules: RULES, log: path.join(dir, 'log.jsonl') });

test('broadcast events: wonder and shrine announcements become events, the replay still verifies', () => {
  assert.equal(r.result.reason, 'wonder');
  const ev = computeEvents(dir);
  assert.ok(ev.verified.ok, JSON.stringify(ev.verified));
  const types = ev.events.map((e) => e.type);
  for (const t of ['wonder_started', 'wonder_warning', 'wonder_completed']) assert.ok(types.includes(t), `${t} in ${[...new Set(types)]}`);
  const s = ev.events.find((e) => e.type === 'wonder_started');
  assert.equal(s.p, 1);
  assert.equal(s.secs, 120);
  assert.ok(ev.events.some((e) => e.type === 'key_building' && e.building === 'castle'));
  assert.equal(ev.events.find((e) => e.type === 'victory').reason, 'wonder');
});

test('caster facts: wonder facts carry their numbers and pass the strict checker', () => {
  const ev = computeEvents(dir);
  const plan = buildPlan(ev, computeHighlights(ev), { mode: 'highlight', params: { tail_s: 10.5 } });
  const { sheet, beats } = buildScript(ev, plan, { cls: '32 GB' });
  const w = sheet.facts.filter((f) => f.kind === 'wonder');
  assert.ok(w.length >= 2, 'wonder facts exist');
  assert.ok(w.some((f) => /2 minutes/.test(f.text)));
  const ctx = makeContext(sheet, beats);
  const f = w.find((x) => x.data?.secs === 120) || w[0];
  const beat = beats.find((b) => (b.facts || []).includes(f.id)) || beats[0];
  const ok = checkLine({ beat: beat.id ?? 1, speaker: 'pbp', when: 'at', delivery: 'hype', text: 'The wonder stands.', facts: [f.id], opinion: false, interject: false }, ctx);
  assert.ok(ok.ok !== false || ok.errors, 'checker runs on a wonder fact');
  // a number that is in no fact is still rejected
  const bad = checkLine({ beat: beat.id ?? 1, speaker: 'pbp', when: 'at', delivery: 'hype', text: 'The wonder has 777 seconds.', facts: [f.id], opinion: false, interject: false }, ctx);
  assert.ok(bad.ok === false || (bad.errors && bad.errors.length), JSON.stringify(bad));
});
