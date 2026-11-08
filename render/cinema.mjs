// Cinematic camera rig, shared by the broadcast director (tools/camera.mjs, Node, one update per output frame) and the
// live spectator auto camera (render/app.mjs). Pure maths, no THREE, no clocks, no randomness: the same inputs give
// the same camera. The caller picks a SHOT (what to look at), the rig turns it into a pose and moves the camera there
// with critically damped springs (continuous position AND velocity). A shot with `cut: true` jumps to its start pose
// when its key changes (a hard cut on action); a shot with `fast: true` flies there with short springs (whip pan).
//
// Look: always low and side-on, like a strategy-game broadcast (about 12-30 degrees above the horizon, long lens).
// `lineAz` is the camera azimuth of the broadcast line: the camera stays on one side of the line between the two bases,
// so base 1 stays on the same side of the picture in every shot (no 180 degree jumps).
//
// Pose = { tx, ty, tz, dist, az, pol }: look-at point (ty = height above the map plane), distance, azimuth, polar angle
// measured from straight down (0 = top-down, pi/2 = horizon). Camera position = look-at + dist * (sin pol * sin az, cos pol, sin pol * cos az).
//
// Shot requests (`key` must change when the shot changes; it restarts the clock e of the shot; `o` = azimuth offset in
// degrees from the line, `len` = planned length in s for the eased moves, `elev` = elevation in degrees, optional):
//   { kind: 'battle',   key, x, z, r, o }               slow orbit sweep around a fight, framed on radius r
//   { kind: 'follow',   key, x, z, r, o, dist }         tracking shot on a moving group (x,z follow the group)
//   { kind: 'chase',    key, x, z, r, hz }              behind a group that marches (hz = heading azimuth, radians)
//   { kind: 'push',     key, x, z, o, len, d0, d1 }     dolly push-in on a building
//   { kind: 'crane',    key, x, z, o, len }             rise reveal of a base (starts near the ground, rises and widens)
//   { kind: 'fly',      key, x, z, x2, z2, o, len }     low fly-over from (x,z) to (x2,z2)
//   { kind: 'low',      key, x, z, o, len }             low close-up on workers / units
//   { kind: 'overview', key, x, z, w, d }               low sweeping fly-over along the line through a w x d box
//   { kind: 'base',     key, x, z }                     medium shot of a base (slow drift)
//   { kind: 'tier',     key, x, z }                     push-in on a town centre
//   { kind: 'collapse', key, x, z, push, pull }         push-in (0..1) to a falling building, then rising pull-back (0..1)
//   { kind: 'finale',   key, x, z, r, len }             finale: low view that rises and swings round a base (radius r) while it falls, over len s
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, u) => a + (b - a) * u;
const ease = (u) => { u = clamp(u, 0, 1); return u * u * u * (u * (u * 6 - 15) + 10); }; // smootherstep
const DEG = Math.PI / 180;
const angDiff = (a, b) => { let d = (a - b) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };
const polOf = (elevDeg) => (90 - elevDeg) * DEG; // elevation above the horizon -> polar angle

export const CINEMA = {
  fov: 26,                     // long lens
  base_az: -Math.PI / 4,       // default broadcast line (the classic RTS view)
  battle_sweep_deg: 22,        // orbit sweeps +-22 deg around the line ...
  battle_orbit_dps: 4,         // ... at a mean of 4 deg/s (slow, no sudden rotation)
  min_clear: 3.2,              // camera stays at least this many tiles above the ground (trees are about 2 tiles)
  clear_ring: 2.5,             // ... checked on a ring of this radius around the camera too
  pol_min: 0,                  // broadcast: 0.96 (no view steeper than 35 deg above the horizon)
  edge: 3,                     // the look-at point stays this far inside the map
  smooth: { pos: 1.0, dist: 0.9, pol: 0.9, az: 1.5 }, // spring times (s), larger = lazier
  fast_smooth: 0.28,           // spring time of a whip pan
  max_pos_speed: 80,           // tiles per second
  safe_aspect: 0.62,           // wide frames: the subject stays in the middle part (HUD panels sit on the sides)
};

// Unity-style SmoothDamp: critically damped spring toward `target`, deterministic for any dt.
function damp(cur, target, vel, smoothT, dt, maxSpeed = Infinity) {
  const om = 2 / Math.max(1e-4, smoothT), x = om * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const maxD = maxSpeed * smoothT;
  const change = clamp(cur - target, -maxD, maxD);
  const tgt = cur - change;
  const tmp = (vel + om * change) * dt;
  let v = (vel - om * tmp) * e;
  let out = tgt + (change + tmp) * e;
  if ((target - cur > 0) === (out > target)) { out = target; v = (out - target) / Math.max(dt, 1e-6); }
  return [out, v];
}

export class Cinema {
  // opts: { size, aspect, heightAt(x,z) -> tiles (optional), fov, lineAz, opts: CINEMA overrides }
  constructor({ size, aspect = 1.3, heightAt = null, fov = CINEMA.fov, lineAz = null, opts = {} }) {
    this.C = { ...CINEMA, ...opts };
    this.size = size;
    this.aspect = aspect;
    this.fov = fov;
    this.hAt = heightAt;
    this.L = lineAz === null ? this.C.base_az : lineAz;
    this.s = { tx: size / 2, ty: 0, tz: size / 2, dist: 90, az: this.L, pol: polOf(24) };
    this.v = { tx: 0, ty: 0, tz: 0, dist: 0, az: 0, pol: 0 };
    this.key = null; this.t0 = 0; this.t = 0;
    this.init = false;
    this.trS = null;           // filtered spring time of the position (longer flights fly slower and ease in and out)
  }

  // distance that frames a w x d tile box (d along the viewing direction) at polar angle pol
  fit(w, d, pol) {
    const vf = (this.fov * Math.PI) / 180;
    const asp = this.aspect > 1.5 ? this.aspect * this.C.safe_aspect : this.aspect;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * asp);
    return Math.max(w / (2 * Math.tan(hf / 2)), (d * Math.max(Math.cos(pol), 0.3) + 9) / (2 * Math.tan(vf / 2)));
  }

  ground(x, z) { return this.hAt ? this.hAt(x, z) || 0 : 0; }

  // Raw target pose of a shot at clock time t (seconds, any monotonic clock).
  pose(shot, t) {
    const C = this.C, L = this.L, e = Math.max(0, t - this.t0);
    const inside = (v) => clamp(v, C.edge, this.size - C.edge);
    const o = (shot.o || 0) * DEG;
    const len = Math.max(1, shot.len || 4), u = ease(e / len);
    const elev = (d) => polOf(shot.elev ?? d);
    let p;
    switch (shot.kind) {
      case 'battle': {
        const A = C.battle_sweep_deg * DEG, om = ((C.battle_orbit_dps * DEG) * Math.PI) / (2 * A);
        const r = clamp(shot.r || 8, 5, 11), pol = elev(21);
        p = { tx: shot.x, tz: shot.z, ty: 1.2, pol: pol - 0.04 * Math.sin(e * 0.5), az: L + o + A * Math.sin(om * e),
          dist: clamp(this.fit(2 * r + 14, 2 * r + 8, pol), 26, 46) * (1 - 0.12 * ease(e / 8)) };
        break;
      }
      case 'overview': { // the whole map from high above: only a slow push-in, the last pose holds all four corners
        const dr = shot.drift ? 1 : 0; // story video (shot.drift): the whole map starts further out and turned a little and settles over 14 s and then sways +-12 degrees (period 24 s; the square map only gets narrower when it turns away from the diamond pose, 3 % more distance for the first seconds, so the corners stay in), so a long map part (fog views, pauses) is not a still picture; without it the old numbers
        p = { tx: shot.x, tz: shot.z, ty: 0, pol: elev(58), az: L + o + dr * DEG * (6 * (1 - ease(e / 14)) + 12 * Math.sin(e * 0.26)), dist: shot.dist * (1 + 0.03 * dr + (0.04 + 0.04 * dr) * (1 - ease(e / (9 + 5 * dr)))) };
        break;
      }
      case 'follow': {
        const r = clamp(shot.r || 6, 4, 10), pol = elev(20);
        p = { tx: shot.x, tz: shot.z, ty: 1.0, pol: pol - 0.03 * Math.sin(e * 0.7), az: L + o + 8 * DEG * Math.sin(e * 0.35),
          dist: shot.dist || clamp(this.fit(2 * r + 12, 2 * r + 8, pol), 22, 60) };
        break;
      }
      case 'chase': {
        const r = clamp(shot.r || 6, 4, 10), pol = elev(17);
        p = { tx: shot.x, tz: shot.z, ty: 1.2, pol, az: (shot.hz ?? L) + Math.PI + (shot.o || 28) * DEG,
          dist: clamp(this.fit(2 * r + 14, 2 * r + 8, pol), 24, 56) };
        break;
      }
      case 'push': {
        const d0 = shot.d0 || 58, d1 = shot.d1 || 26;
        p = { tx: shot.x, tz: shot.z, ty: lerp(1.5, 2.6, u), pol: lerp(elev(24), elev(15), u), az: L + o + (shot.sweep ?? -12) * DEG * u, dist: lerp(d0, d1, u) };
        break;
      }
      case 'crane': {
        p = { tx: shot.x, tz: shot.z, ty: lerp(0.8, 3.4, u), pol: lerp(polOf(8), polOf(27), u), az: L + o + 18 * DEG * (u - 0.5), dist: lerp(34, 62, u) };
        break;
      }
      case 'fly': {
        const x2 = shot.x2 ?? shot.x, z2 = shot.z2 ?? shot.z;
        p = { tx: lerp(shot.x, x2, u), tz: lerp(shot.z, z2, u), ty: lerp(1.8, 2.4, u), pol: elev(22) - 0.05 * Math.sin(e * 0.6), az: L + o + 14 * DEG * (u - 0.5), dist: shot.dist || 58 };
        break;
      }
      case 'look': { // low view along a line (story "show" beats): the target lies ahead, the camera stands behind it at absolute azimuth shot.az (direction target -> camera)
        const pol = polOf(shot.elev ?? 13);
        p = { tx: lerp(shot.x, shot.x2 ?? shot.x, u), tz: lerp(shot.z, shot.z2 ?? shot.z, u), ty: lerp(1.2, 2.2, u), pol: pol - 0.02 * Math.sin(e * 0.5), az: shot.az + (shot.sweep ?? 0) * DEG * (u - 0.5), dist: lerp(shot.d0 || 56, shot.d1 || 48, u) };
        break;
      }
      case 'low': {
        p = { tx: shot.x + 2.5 * (u - 0.5), tz: shot.z, ty: 0.9, pol: lerp(polOf(11), polOf(17), u), az: L + o + 22 * DEG * (u - 0.5), dist: lerp(27, 19, u) };
        break;
      }
      case 'overview': {
        const pol = polOf(21), ax = Math.sin(L + Math.PI / 2), az2 = Math.cos(L + Math.PI / 2); // along the line (screen left-right)
        const span = 0.5 * Math.max(10, (shot.w + shot.d) * 0.5), sw = Math.sin(e * 0.18) * span * 0.35;
        p = { tx: shot.x + ax * sw, tz: shot.z + az2 * sw, ty: 2, pol, az: L + 10 * DEG * Math.sin(e * 0.12), dist: clamp(this.fit(shot.w * 0.8 + 30, 40, pol), 60, 120) };
        break;
      }
      case 'tier': {
        p = { tx: shot.x, tz: shot.z, ty: lerp(1.8, 2.8, u), pol: lerp(elev(25), elev(17), u), az: L + o - 10 * DEG * u, dist: lerp(54, 30, u) };
        break;
      }
      case 'collapse': {
        const uu = ease(shot.push || 0), v = ease(shot.pull || 0);
        p = {
          tx: shot.x, tz: shot.z, ty: lerp(lerp(2, 3, uu), 0.5, v), pol: lerp(lerp(polOf(24), polOf(14), uu), polOf(26), v),
          az: L + o - 20 * DEG * uu + 28 * DEG * v, dist: lerp(lerp(62, 28, uu), 72, v),
        };
        break;
      }
      case 'finale': { // the loser base falls building by building: start low in the dust, rise and swing round until the last one is down
        const r = clamp(shot.r || 8, 6, 26), p0 = polOf(13), p1 = polOf(27);
        p = {
          tx: shot.x, tz: shot.z, ty: lerp(1.6, 3.4, u), pol: lerp(p0, p1, u), az: L + o - 22 * DEG + 44 * DEG * u,
          dist: clamp(lerp(this.fit(2 * r + 6, 2 * r + 4, p0), this.fit(2 * r + 14, 2 * r + 10, p1), u), 30, 100),
        };
        break;
      }
      case 'base':
      default: {
        const pol = elev(25);
        p = { tx: shot.x, tz: shot.z, ty: 2, pol, az: L + o + 4 * DEG * (e - 2) * 0.5, dist: clamp(this.fit(44, 36, pol), 46, 62) };
      }
    }
    p.tx = inside(p.tx); p.tz = inside(p.tz);
    return p;
  }

  // Advance by dt seconds toward `shot`; returns the camera pose (also ground-safe).
  update(dt, shot, t) {
    const C = this.C, s = this.s, v = this.v;
    this.t = t;
    const changed = shot.key !== this.key;
    if (changed) { this.key = shot.key; this.t0 = t; }
    const tg = this.pose(shot, t);
    tg.ty += this.ground(tg.tx, tg.tz);
    if (shot.kind !== 'overview') tg.pol = Math.max(tg.pol, C.pol_min); // only the whole map may look steeper
    if (!this.init) { Object.assign(s, tg); this.init = true; }
    else if (changed && shot.cut) { Object.assign(s, tg); for (const k in v) v[k] = 0; } // hard cut: jump to the start pose
    // a far flight without a cut rises like a crane: the more distance is left, the higher and wider the camera goes
    if (!shot.cut && !shot.fast && !shot.norise) tg.dist += Math.min(Math.hypot(tg.tx - s.tx, tg.tz - s.tz) * 0.55, 80);
    tg.az = s.az + angDiff(tg.az, s.az); // shortest way round
    const sm = C.smooth, f = shot.fast ? C.fast_smooth : 0;
    // a long flight takes a longer spring (about 1.8 s of spring time for 90 tiles); the spring time itself is low-passed, so it never jumps
    const dd = Math.hypot(tg.tx - s.tx, tg.tz - s.tz), base = shot.track ? 0.55 : sm.pos, want = f || base + clamp(dd / 100, 0, 0.9);
    this.trS = this.trS === null || changed && shot.cut ? base : this.trS + (want - this.trS) * (1 - Math.exp(-dt / 0.5));
    const k = shot.tscale || 1; // story "show" shots: shorter springs (still critically damped, no whip) so a flight between the bases is done in about 2.5 s
    const tr = (f || this.trS) * k;
    [s.tx, v.tx] = damp(s.tx, tg.tx, v.tx, tr, dt, C.max_pos_speed);
    [s.tz, v.tz] = damp(s.tz, tg.tz, v.tz, tr, dt, C.max_pos_speed);
    [s.ty, v.ty] = damp(s.ty, tg.ty, v.ty, (f || sm.pos) * k, dt);
    [s.dist, v.dist] = damp(s.dist, tg.dist, v.dist, (f || sm.dist) * k, dt, 120);
    [s.pol, v.pol] = damp(s.pol, tg.pol, v.pol, (f || sm.pol) * k, dt);
    [s.az, v.az] = damp(s.az, tg.az, v.az, (f || sm.az) * k, dt, 3);
    return this.safe(s);
  }

  // Final pose with the safety clamps (does not touch the spring state): inside the map, above the ground (also on a
  // ring around the camera, so it does not scrape hills or tree tops).
  safe(s) {
    const C = this.C, size = this.size;
    const o = { tx: clamp(s.tx, C.edge, size - C.edge), tz: clamp(s.tz, C.edge, size - C.edge), ty: s.ty, dist: clamp(s.dist, 14, 420), az: s.az, pol: clamp(s.pol, Math.max(0.1, Math.min(C.pol_min, s.pol)), 1.38) };
    const R = C.clear_ring;
    for (let i = 0; i < 4; i++) {
      const sp = Math.sin(o.pol), px = o.tx + o.dist * sp * Math.sin(o.az), pz = o.tz + o.dist * sp * Math.cos(o.az);
      let g = 0;
      if (this.hAt) { g = -1e9; for (const [dx, dz] of RING) g = Math.max(g, this.ground(clamp(px + dx * R, 0, size), clamp(pz + dz * R, 0, size))); }
      const need = g + C.min_clear; // lowest allowed camera height
      const cy = o.ty + o.dist * Math.cos(o.pol);
      if (cy >= need) break;
      o.pol = Math.acos(clamp((need - o.ty) / o.dist, -1, 1)) - 0.005; // tilt up until the camera clears the ground
    }
    return o;
  }
}
// The whole map in the picture: where to look and how far away, so that all four corners lie in the free part of the frame.
// top, bottom, side: the share of half the frame that may be used (1 = the edge). The looked-at point may leave the map's middle, because the near edge looks bigger.
export function fitWholeMap({ size, az, elev, fov, aspect, top = 0.92, bottom = 0.75, side = 0.96 }) {
  const pol = polOf(elev), th = Math.tan((fov * Math.PI) / 360), tw = th * aspect, sp = Math.sin(pol), cp = Math.cos(pol), sa = Math.sin(az), ca = Math.cos(az);
  const corners = [[0, 0], [size, 0], [0, size], [size, size]];
  const fits = (dist, s) => corners.every(([x, z]) => {
    const qx = x - (size / 2 + sa * s), qz = z - (size / 2 + ca * s), along = qx * sa + qz * ca, across = qx * ca - qz * sa, depth = dist - along * sp, y = (-along * cp) / depth / th;
    return depth > 0 && Math.abs(across) / depth <= tw * side && y <= top && -y <= bottom;
  });
  let best = null;
  for (let s = -40; s <= 40; s++) for (let d = 100; d <= 420 && (!best || d < best.dist); d++) if (fits(d, s)) best = { x: size / 2 + sa * s, z: size / 2 + ca * s, dist: d };
  return best;
}
const RING = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];

// ---------------- shot selection helpers shared by both cameras ----------------

// robust centre and radius of a set of [x,z] points (radius = distance of the 85th percentile from the median centre)
export function cluster(pts) {
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]).sort((a, b) => a - b), zs = pts.map((p) => p[1]).sort((a, b) => a - b);
  const x = xs[xs.length >> 1], z = zs[zs.length >> 1];
  const ds = pts.map((p) => Math.hypot(p[0] - x, p[1] - z)).sort((a, b) => a - b);
  const r = ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.85))];
  let sx = 0, sz = 0, n = 0;
  for (const p of pts) if (Math.hypot(p[0] - x, p[1] - z) <= Math.max(r, 6)) { sx += p[0]; sz += p[1]; n++; }
  return { x: sx / n, z: sz / n, r, n };
}

// framing box of everything that matters (buildings, army units, starts)
export function overviewBox(snap, starts) {
  let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
  const add = (x, z) => { minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z); };
  if (snap) {
    for (const b of snap.buildings) add(b[3], b[4]);
    for (const u of snap.units) if (u[2] !== 0) add(u[3], u[4]);
  }
  for (const st of starts) add(st.tx, st.ty);
  return { x: (minx + maxx) / 2, z: (minz + maxz) / 2, w: maxx - minx, d: maxz - minz };
}
