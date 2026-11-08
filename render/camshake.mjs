// Camera shake for big events (a building collapses). Pure function of the output time, no randomness:
// the same events at the same times always give the same offsets, so broadcast renders stay frame exact.
// Strength falls off with the distance from the camera target to the event and decays within about 1.5 s.
const DUR = 1.6, HZ = [7.3, 11.9, 17.1];
const hash = (x, z) => { let h = Math.imul((x * 131) | 0, 374761393) ^ Math.imul((z * 197) | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

export class CamShake {
  constructor() { this.ev = []; this.on = true; }
  // x, z: world position, size: building size in tiles, t: output time (s). Same hit twice at the same time is ignored.
  hit(x, z, size, t) {
    if (this.ev.some((e) => e.x === x && e.z === z && Math.abs(e.t - t) < 0.5)) return;
    this.ev.push({ x, z, t, mag: Math.min(1.2, Math.max(0.25, size / 5)), ph: hash(x, z) * 6.2832 });
    if (this.ev.length > 16) this.ev.shift();
  }
  // returns {x, y, z} world offset for the camera at time t; tx, tz: camera target, dist: camera distance
  offset(t, tx, tz, dist) {
    const o = { x: 0, y: 0, z: 0 };
    if (!this.on) return o;
    this.ev = this.ev.filter((e) => t - e.t < DUR || t < e.t);
    for (const e of this.ev) {
      const age = t - e.t;
      if (age < 0 || age > DUR) continue;
      const near = 1 / (1 + ((Math.hypot(e.x - tx, e.z - tz)) / (14 + e.mag * 18)) ** 2);
      const a = e.mag * near * Math.exp(-age * 3.4) * Math.min(1, age * 40) * 0.0055 * dist;
      o.x += a * Math.sin(age * HZ[0] * 6.2832 + e.ph);
      o.y += a * 0.8 * Math.sin(age * HZ[1] * 6.2832 + e.ph * 1.7);
      o.z += a * Math.sin(age * HZ[2] * 6.2832 + e.ph * 2.3);
    }
    return o;
  }
}
