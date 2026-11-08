// What the broadcast shows as "the model's thought". The LLM player derives a thought line when a model wrote no note
// (agents/llm/parse.mjs deriveThought: "[reasoning] <first sentence of its reasoning>" or "[reply] <first sentence of its answer>").
// The tag is for the log; a viewer must never see it, and a first sentence that says nothing ("Let me analyze the situation.")
// is no thought at all: the card stays away instead of showing filler. Pure function, no clock.

import { stripToolMarkup } from '../../render/note-text.mjs';

export const NOTE_MAX = 120; // the cap of the note tool (sim/commands.mjs, agents/llm/validate.mjs)
const TAG = /^\s*\[(?:reasoning|reply|thinking|thought)\]\s*/i;
// a sentence ends in . ! ? followed by a space, or at the end of the text; "6.5", "2.5x" and "v1.2" stay inside their sentence
const SENTENCES = (t) => t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
const OPENER = /^(?:let me|let us|let's|lets|okay|ok|alright|all right|hmm+|well|so|now|first|i need to|i should|i'll|i will|i want to|i'm going to|time to|ok so|okay so)\b/i;
const GENERIC = /\b(?:start|starts|starting|begin|begins|beginning|analy[sz]e|analy[sz]ing|analysis|think|thinking|look|looking|see|check|checking|figure|figuring|grasp|understand|assess|assessing|review|reviewing|consider|considering|examine|evaluate|break (?:it|this) down|situation|current state|state of|where we|get started|go through|go over|take a look|work (?:it|this) out)\b/i;

export function hasSubstance(sentence) {
  const s = String(sentence ?? '').trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  if (words.length < 4 && OPENER.test(s)) return false; // "Let me start." "Okay, now." ("Pushing enemy base." is a thought)
  if (/[:,;—-]$/.test(s)) return false; // cut off in the middle of a thought
  if (/\d/.test(s)) return true; // a figure from the game is substance
  if (words.length <= 10 && OPENER.test(s) && GENERIC.test(s)) return false;
  return true;
}

// "[reasoning] Let me analyze the situation." -> null; "Let me think. Boom to 30 workers." -> "Boom to 30 workers."; "[reasoning] I'm at 303 seconds with low food." -> "I'm at 303 seconds with low food."
export function cleanThought(text) {
  if (text == null) return null;
  let t = stripToolMarkup(String(text).replace(TAG, '').replace(/\s+/g, ' ')); // a tool call written into the note is no thought
  if (!t) return null;
  // cut by the cap in the middle of a word ("... so base force s"): back to the last whole word, the dots say it goes on
  if (String(text).trim().length >= NOTE_MAX && !/[.!?]$/.test(t)) t = `${t.replace(/\s+\S*$/, '').replace(/[\s,;:—-]+$/, '')}…`;
  const ss = SENTENCES(t), i = ss.findIndex(hasSubstance);
  return i < 0 ? null : ss.slice(i).join(' '); // leading filler sentences go, the rest of a real note stays word for word
}
