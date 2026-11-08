// Projectile flight for the renderer: arrows, stones and shells fly on ballistic arcs from the shooter (bow height) to the target.
// Render only. The sim still moves a shot in a straight line at a fixed speed and decides the hit; the arc only adds height on top of
// that line, so a shot lands on the same frame as before. The snapshot row is [x, y, tx, ty, owner, speed, splash, shooterType, shooterId, ageTicks].
// Deterministic: no Math.random, the small variety per shot comes from a hash of the shooter id and the tick it fired.

export const ARROW = 0, STONE = 1, SHELL = 2, BALL = 3, BOLT = 4; // BOLT: the glowing shot of a theme (render/shooter-theme.mjs), only used when a theme asks for it

// peak = height of the arc above the straight line launch-to-target for a flight of D tiles; end = height where the shot arrives (above the ground)
const KINDS = [
  { peak: (D) => 0.012 * D * D + 0.05 * D + 0.04, end: 0.9 }, // arrow / bolt: flat, a little higher the further it goes
  { peak: (D) => 0.27 * D + 0.25, end: 0.55 }, // catapult stone: a lob at about 45 degrees
  { peak: (D) => 0.5 * D + 0.5, end: 0.15 }, // mortar shell: steep, drops on the ground
  { peak: (D) => 0.02 * D + 0.1, end: 0.6 }, // ship cannon ball: almost flat
  { peak: (D) => 0.004 * D * D + 0.02 * D + 0.02, end: 0.9 }, // theme bolt: nearly straight (same landing time and point as the arrow, only less height on the way)
];

// kind of a snapshot row; shooterName = unit type name of the shooter ('' for a building)
export function shotKind(q, shooterName) {
  if (q[6] === 1) return q[5] <= 650 ? SHELL : STONE;
  return shooterName === 'war_boat' ? BALL : ARROW;
}

// launch height above the ground for a unit type (hands / bow / barrel); buildings pass their own height
export function launchHeight(name, buildingH) {
  if (!name) return Math.max(0.9, (buildingH || 2) * 0.8);
  return LAUNCH[name] ?? 1.2;
}
const LAUNCH = { archer: 1.3, skirmisher: 1.25, catapult: 1.2, mortar: 0.95, war_boat: 1.1 };

export function hash32(a, b = 0) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

// Pure arc: s = 0..1 progress along the ground line, returns height and the climb per tile of ground distance (for the nose direction)
export function arc(y0, y1, peak, s, D) {
  const y = y0 + (y1 - y0) * s + peak * 4 * s * (1 - s);
  const slope = ((y1 - y0) + peak * 4 * (1 - 2 * s)) / Math.max(D, 0.5);
  return { y, slope };
}

export class Shots {
  constructor(hAt) {
    this.hAt = hAt;
    this.rec = new Map(); // one record per shot in the air: where it was fired from
    this.stamp = 0;
    this.out = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, s: 0, D: 0, adv: 0, seed: 0, fresh: false, ox: 0, oz: 0, y0: 0 };
  }
  begin() { this.stamp++; }
  end() { for (const [k, r] of this.rec) if (r.stamp !== this.stamp) this.rec.delete(k); }

  // q: snapshot row, snapT: tick of that snapshot, el: game seconds since it (position is extrapolated like before), h0: launch height
  pose(q, snapT, el, kind, h0) {
    const K = KINDS[kind], hAt = this.hAt, o = this.out;
    const dx = q[2] - q[0], dz = q[3] - q[1];
    const d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d;
    const adv = Math.min(d, (q[5] / 100) * el);
    const px = q[0] + ux * adv, pz = q[1] + uz * adv, rem = d - adv;
    const fireT = snapT - q[9], key = q[8] * 100003 + fireT;
    let r = this.rec.get(key);
    const fresh = !r; // first frame in which this shot is drawn (the muzzle flash of a theme)
    if (!r) { // first sight: walk back along the line by the distance covered since the shot was fired (q[5] / 1000 tiles per tick)
      const back = (q[9] * q[5]) / 1000;
      const ox = q[0] - ux * back, oz = q[1] - uz * back;
      r = { ox, oz, y0: hAt(ox, oz) + h0, seed: hash32(q[8], fireT), stamp: 0 };
      this.rec.set(key, r);
    }
    r.stamp = this.stamp;
    const tr = Math.hypot(px - r.ox, pz - r.oz), D = tr + rem;
    const s = D > 1e-3 ? Math.min(1, tr / D) : 1;
    const y1 = hAt(q[2], q[3]) + K.end;
    const peak = K.peak(D) * (0.92 + 0.16 * ((r.seed & 255) / 255)); // a little variety, same on every render
    const a = arc(r.y0, y1, peak, s, D);
    const y = Math.max(a.y, hAt(px, pz) + 0.12); // never through the hill
    // nose along the tangent of the flight path
    const il = 1 / Math.hypot(1, a.slope);
    o.x = px; o.y = y; o.z = pz; o.dx = ux * il; o.dy = a.slope * il; o.dz = uz * il;
    o.s = s; o.D = D; o.adv = adv; o.seed = r.seed; o.fresh = fresh; o.ox = r.ox; o.oz = r.oz; o.y0 = r.y0; // (origin of the shot: where the muzzle flash sits)
    return o;
  }
}
