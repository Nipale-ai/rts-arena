// Lightning of the storm weather, on the output clock: the picture flashes with it (render/world-fx.mjs), the live page and the broadcast mix (tools/audio-mix.mjs) play the thunder after it.
export const STORM_LOOK = 0.6, STORM_RISE_S = 2.4; // the darkness of a storm and how fast it closes in
export function flashAt(T, seed) {
  // lightning: in every 7 s cell there may be one strike (70 %): bright, a quick flicker, gone in under a second
  const cell = Math.floor(T / 7);
  let f = 0;
  for (const c of [cell - 1, cell]) {
    let h = Math.imul(c | 0, 374761393) ^ Math.imul(seed | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177); h = (h ^ (h >>> 16)) >>> 0;
    const r = h / 4294967296;
    if (r > 0.7) continue;
    const t0 = c * 7 + (r / 0.7) * 5.5, d = T - t0;
    if (d >= 0 && d < 0.9) f = Math.max(f, Math.exp(-d * 6.5) * (d < 0.1 ? 1 : 0.65 + 0.35 * Math.sin(d * 70)));
  }
  return f;
}
export const flashOf = (T, seed, storm) => (storm > 0.55 ? flashAt(T, seed) * storm : 0);
export const newStrike = (flash, last) => flash > 0.4 && last < 0.15;
export const closeStrike = (n) => n % 3 === 1; // the first strike and every third one after it: a clap overhead; the others roll in from afar
// the strikes the picture shows in an output of `duration` seconds; stormAt(t) = is it a thunderstorm at output second t (same steps as WorldFx.update)
export function strikesOver(duration, seed, stormAt, fps = 60) {
  const out = [], k = 1 - Math.exp(-1 / fps / STORM_RISE_S);
  let c = 0, last = 0, n = 0;
  for (let f = 0; f < duration * fps; f++) {
    const t = f / fps;
    c += ((stormAt(t) ? STORM_LOOK : 0) - c) * k;
    const flash = flashOf(t, seed, c);
    if (newStrike(flash, last)) { n++; out.push({ t, n, close: closeStrike(n) }); }
    last = flash;
  }
  return out;
}
