// Names in broadcast text. One place decides how a name becomes a possessive, so the templates (casters, action feed,
// banners, highlights) never write "Zoe's's TensorFold recipe".
//   poss("QuartzRT")                    -> "QuartzRT's"
//   poss("James")                     -> "James'"      (a name that ends in s gets only the apostrophe)
//   poss("Zoe's TensorFold recipe")   -> "Zoe's TensorFold recipe's"   (the head noun takes the s, the inner possessive stays)
//   poss("Zoe's")                     -> "Zoe's"       (a name that already is a possessive form: nothing is appended twice)
const ENDS_POSS = /['’]s?$/i;
export function poss(name) {
  const n = String(name ?? '').trim();
  if (!n) return n;
  if (ENDS_POSS.test(n)) return n;
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

// The article that fits the word: "an archer", "a ram", "a unit", "an 8B model". One place, so no template writes "a archer".
export function withArticle(word) {
  const w = String(word ?? '').trim();
  const an = (/^[aeio]/i.test(w) && !/^(?:one|once)\b/i.test(w)) || (/^u/i.test(w) && !/^(?:uni|use|usa|uti)/i.test(w)) || /^(?:8|11|18)(?!\d)/.test(w);
  return `${an ? 'an' : 'a'} ${w}`;
}

// The spoken short form of a long name: "Zoe kit TP2" -> "Zoe's kit", "Zoe's TensorFold recipe" -> "Zoe's TensorFold recipe".
// Code words (digits, or all capitals such as TP2) and single letters are dropped; the first word takes the possessive
// only when it has none yet, and only when there is something after it. A name of one word stays as it is.
export function sayName(short) {
  const s = String(short);
  const parts = s.split(/\s+/).filter(Boolean);
  const plain = parts.filter((w) => !/\d/.test(w) && !/^[A-Z]+$/.test(w));
  if (plain.length < 2) return s;
  return `${poss(plain[0])} ${plain.slice(1).join(' ')}`;
}

// Plural of a game word. Words that already end in s stay ("barracks"), so do mass nouns ("light cavalry").
export const pluralOf = (word) => (/cavalry|infantry|sheep|s$/.test(word) ? word : /man$/.test(word) ? word.replace(/man$/, 'men') : `${word}s`);
