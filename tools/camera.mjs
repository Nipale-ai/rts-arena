// Director camera for the broadcast render. Runs in Node, one update per output frame, fully deterministic: every
// decision comes from the match log (events.json, plan scenes, key decisions) and the snapshot of the current tick.
//
// Look: always low and side-on (about 12-30 degrees above the horizon, long lens), like a strategy-game broadcast.
// The camera stays on one side of the line between the two bases ("broadcast line"), so base 1 is always on the same
// side of the picture: cuts never jump 180 degrees. Only a chase shot (behind a marching army) may leave the line,
// and it does so because the army walks along it.
//
// Shot types (render/cinema.mjs has the maths): battle orbit, follow (tracking), chase (behind a marching army),
// push (dolly push-in on a building), crane (rise reveal of a base), fly (low sweeping fly-over), low (close-up on
// workers), whip (fast pan to the other base), base, tier, collapse (push-in to a falling base, then pull-back).
//
// Priority (a higher one may cut in after the running shot played at least MIN_S, otherwise shots run their length):
//   9 base destroyed / victory      push-in to the falling building, then a rising pull-back; from the victory on: the finale shot
//                                   (render/finale.mjs: the loser's buildings fall one after the other), held to the end of the cut
//   7 battle scene (plan)           4.2 s segments: orbit, low close-up on the fighters, chase, orbit from the other side
//   6 key decision (commentary)     orbit on the action the model reacted to; cut to a low close-up when the order lands
//   5 tier-up                       push-in on that player's town centre
//   4 events                        key building (push-in), expansion (crane), first contact (tracking), building lost (orbit)
//   3 other fights                  the same four shots on the biggest group of fighters, 3.6 s segments
//   1 quiet                         cycle of 8 shots of 3-5 s: crane base 1, base 2, workers, whip to the other base,
//                                   fly-over, scout / army tracking, building going up, fly-over back
import '../server/local-env.mjs'; // machine-local RTS_* defaults (local-env.json) before anything reads them
import { Cinema, cluster, fitWholeMap } from '../render/cinema.mjs';
import { mainGroup, GROUP_LINK_TILES } from '../render/mark-hull.mjs';
const GROUP_STAY = 14; // tiles: a shot stays with units this close to where it looks
import { momentWindows } from './commentary.mjs';
import { UNITS, BUILDINGS, VICTORY } from '../sim/data.mjs';
import { WILD_UNITS } from '../sim/world-data.mjs';
import { liveSubject } from './subjects.mjs';
import { selectUnits } from './story-show.mjs';

export const CAMERA = {
  fov: 26,            // long lens
  lead_s: 1.7,        // output seconds before a scene starts that the camera already heads there
  hold_s: 0.8,        // output seconds after it ends
  fight_radius: 30,   // tiles around the scene focus that count as "the fight"
  min_s: 1.8,         // a running shot plays at least this long before a higher priority one cuts in
  seg_s: 4.2,         // battle segment length (planned scenes)
  tier_lead_s: 0.4, tier_s: 3.4,
  event_lead_s: 0.3, event_s: 3.2, event_gap_s: 9, // at most one event shot per 9 s, apart from first contact and expansions
  finale_s: 7, // finale: length of the rising, swinging shot over the falling base (the last pose is held after it)
  push_s: 7, pull_s: 4.5, // collapse: push-in length before the building falls, pull-back length after
  whip_s: 0.9,        // length of the fast pan at the start of a whip shot
  idle_lens: [3.0, 3.4, 2.6, 3.8, 2.8, 3.6, 2.6, 4.2], // quiet shot lengths (output seconds)
  max_elev: 35,       // never steeper than this above the horizon
  cut_far: 105,       // a hard cut only when the next subject is further away than this many tiles (else a long eased flight) ...
  cut_hit: 45,        // ... or on a big hit (base falls) further than this
  look_dwell_s: 1.0,  // the occlusion check runs this often while a subject is on screen
  fg_free: 0.2,       // a tall object between camera and subject (relic shrine) may fill this share of the frame height ...
  fg_cost: 25,        // ... every share above it costs this much when the view is chosen (a tree right in the way costs 10)
  subject_lp_s: 0.45, // low-pass of the followed subject point (no jitter when single units die)
};

const BNAMES = Object.keys(BUILDINGS);
// tall objects that must not loom in front of the lens: relic shrines as [centre x, centre z, height, width] in tiles (the model is
// fitted to 1.6 x its 2 tile footprint, render/shrines.mjs, and stands about 4.5 tiles high)
export const tallObjects = (game) => (game.shrines || []).map((s) => { const S = VICTORY.shrine.size; return [s.tx + S / 2, s.ty + S / 2, 4.5, S * 1.6]; });

const UN = [...Object.keys(UNITS), ...WILD_UNITS];
const isArmyIdx = (i) => UN[i] !== 'worker' && !WILD_UNITS.includes(UN[i]) && UNITS[UN[i]]?.cls !== 'naval';
const isCavIdx = (i) => UNITS[UN[i]]?.cls === 'cavalry';
const angDiff = (a, b) => { let d = (a - b) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };

export const SHOW_MID = { near: 30, pad: 14, far: 40, focus: 34, cap: 56, fit: 0.23, slew: 18 }; // 'mid' shots of the story show (tiles): closest distance, margin, farthest distance that still holds two groups; cap: farthest distance for one big group that must fit whole (fit: tiles of group radius per tile of distance); slew: fastest move of a following target (tiles per second), distance on the bigger group when they are further apart
// 'mid' shots: the free part of the picture (1 = frame edge; the plan cards sit in the top corners, the line of text and the panels at the bottom). An army (second group with at least minN units) lies whole inside it or wholly outside the frame, never cut by an edge.
// margin/pad: the outline of a group is larger than its radius r (r * margin + pad tiles); step: distance and centre are searched in these steps, so the camera does not twitch.
export const SHOW_FRAME = { x: 0.94, top: 0.6, bottom: -0.78, minN: 4, margin: 1.15, pad: 1.5, stepD: 3, stepW: 0.1, maxD: 62, tol: 0.35 };
export const SHOW_WHIP = { len: 5, far: 35 }; // story parts: shorter than len seconds and further than far tiles

export class Director {
  // size: map tiles, starts: [{tx,ty}], aspect: canvas aspect, scenes: plan.scenes (selected ones are followed),
  // timeline: Timeline, events: events.json events (optional), moments: plan.moments, tall: tallObjects(game)
  constructor({ size, starts, aspect, scenes, timeline, events = [], moments = [], focus = null, subjects = [], show = null, treeAt = null, tall = [], opts = {} }) {
    this.C = { ...CAMERA, ...opts };
    this.size = size;
    this.starts = starts;
    this.tl = timeline;
    this.scenes = scenes.filter((s) => s.selected !== false).map((s) => ({ ...s, o0: timeline.outAt(s.start), o1: timeline.outAt(s.end) }));
    this.tiers = events.filter((e) => e.type === 'tier_up').map((e) => ({ o: timeline.outAt(e.t), p: e.p }));
    this.falls = events.filter((e) => e.type === 'base_destroyed' && e.loc).map((e) => ({ o: timeline.outAt(e.t), x: e.loc[0], z: e.loc[1], p: e.p }));
    // finale: from the victory on every building of the loser falls (render/app.mjs, planned from the last snapshot); the camera frames that base
    const vic = events.find((e) => e.type === 'victory' && e.winner && !/^(time limit|cutoff)/.test(e.reason || '') && e.t <= timeline.b);
    this.vic = vic ? { o: timeline.outAt(vic.t), winner: vic.winner } : null;
    this.moms = moments.filter((m) => m.focus).map((m) => ({ m, w: momentWindows(m, timeline) }));
    // action events that get a short shot of their own (in output time order)
    this.acts = [];
    for (const e of events) {
      if (!e.loc) continue;
      const o = timeline.outAt(e.t);
      if (e.type === 'key_building') this.acts.push({ o, kind: 'push', x: e.loc[0] + 1.5, z: e.loc[1] + 1.5, id: e.id ?? e.t });
      else if (e.type === 'expansion') this.acts.push({ o, kind: 'crane', x: e.loc[0] + 1.5, z: e.loc[1] + 1.5, id: e.t });
      else if (e.type === 'first_contact') this.acts.push({ o, kind: 'contact', x: e.loc[0], z: e.loc[1], id: e.t });
      else if (e.type === 'building_destroyed') this.acts.push({ o, kind: 'lost', x: e.loc[0], z: e.loc[1], id: e.t });
    }
    this.acts.sort((a, b) => a.o - b.o);
    // broadcast line: the camera sits on the side of the line between the bases that is closest to the classic view
    let L = -Math.PI / 4;
    if (starts.length >= 2) {
      const ax = starts[1].tx - starts[0].tx, az = starts[1].ty - starts[0].ty;
      const a1 = Math.atan2(-az, ax), a2 = Math.atan2(az, -ax);
      L = Math.abs(angDiff(a1, -Math.PI / 4)) <= Math.abs(angDiff(a2, -Math.PI / 4)) ? a1 : a2;
    }
    this.L = L;
    this.rig = new Cinema({ size, aspect, fov: this.C.fov, lineAz: L, opts: { pol_min: (90 - this.C.max_elev) * Math.PI / 180 } }); // ground clearance is applied page-side (Cinema.safe in render/app.mjs)
    // commentary coupling: focus segments [{o0, o1, subject}] from the caster lines, subjects by id (from the log, see tools/subjects.mjs)
    this.focus = focus ? focus.map((f, i) => ({ ...f, i })) : null;
    if (this.focus) this.C.push_s = Math.min(this.C.push_s, 4.5); // the talk keeps the camera until shortly before the base falls
    this.subjects = new Map(subjects.map((q) => [q.id, q]));
    this.treeAt = treeAt;
    this.tall = tall; this.aspect = aspect;
    this.show = show; // tools/story-show.mjs: camera parts that show what the casters say (they win over the focus segments)
    this.ctx = { UN, isArmy: isArmyIdx, size: (idx) => BUILDINGS[BNAMES[idx]]?.size || 3 };
    this.lookS = null; this.sp = { key: null, x: 0, z: 0 };
    this.mode = 'quiet';
    this.cur = null;          // running shot: { key, prio, t0, len, mk, fast }
    this.lastFight = null;
    this.latch = new Map();   // per-shot decisions that must not flip while the shot runs
    this.trk = { key: null, x: 0, z: 0, vx: 0, vz: 0, hz: L + Math.PI / 2 }; // heading estimate of the tracked group
    this.idleCum = [];
    let c = 0;
    for (const l of this.C.idle_lens) { c += l; this.idleCum.push(c); }
    this.idleTotal = c;
  }

  activeScene(outT) {
    for (const s of this.scenes) if (outT >= s.o0 - this.C.lead_s && outT <= s.o1 + this.C.hold_s) return s;
    return null;
  }

  base(p) { const st = this.starts[(p - 1) % this.starts.length] || this.starts[0]; return { x: st.tx + 1.5, z: st.ty + 1.5 }; }

  // the base of the loser (centre and radius of its buildings in the snapshot) while it falls; null when there is none to show
  finale(outT, snap) {
    if (!this.vic || outT < this.vic.o || !snap) return null;
    const pts = [];
    for (const b of snap.buildings) if (b[1] !== this.vic.winner) pts.push([b[3] + 1, b[4] + 1]);
    const c = pts.length ? cluster(pts) : null;
    return c ? { kind: 'finale', key: 'finale', x: c.x, z: c.z, r: c.r, len: this.C.finale_s } : null;
  }

  // victory scenes without a base_destroyed event fall back to the scene focus
  collapse(outT, sc) {
    const C = this.C;
    for (const f of this.falls) {
      if (outT >= f.o - C.push_s && outT <= f.o + C.pull_s) {
        return { kind: 'collapse', key: `fall${f.o.toFixed(2)}`, x: f.x, z: f.z, push: (outT - (f.o - C.push_s)) / C.push_s, pull: (outT - f.o) / C.pull_s, end: f.o + C.pull_s, cut: true };
      }
    }
    if (sc && sc.kind === 'victory' && sc.focus && !this.falls.length) {
      const dur = Math.max(1, sc.o1 - sc.o0);
      return { kind: 'collapse', key: `win${sc.id}`, x: sc.focus.x, z: sc.focus.y, push: (outT - sc.o0) / dur, pull: (outT - sc.o1) / C.pull_s, end: sc.o1 + C.pull_s, cut: true };
    }
    return null;
  }

  // fighters (state 4) near a point, or everywhere when `at` is null
  fighters(snap, at, radius) {
    const pts = [];
    for (const u of snap.units) {
      if (u[6] !== 4 || u[1] === 0) continue;
      if (at && Math.hypot(u[3] - at.x, u[4] - at.z) > radius) continue;
      pts.push([u[3], u[4]]);
    }
    return pts.length >= 3 ? cluster(pts) : null;
  }

  // centre of one player's army (or only cavalry), null when there is none
  group(snap, owner, cavOnly) {
    const pts = [];
    for (const u of snap.units) if (u[1] === owner && (cavOnly ? isCavIdx(u[2]) : isArmyIdx(u[2]))) pts.push([u[3], u[4]]);
    return pts.length ? cluster(pts) : null;
  }

  workersAt(snap, owner) {
    const b = this.base(owner), pts = [];
    for (const u of snap.units) if (u[1] === owner && UN[u[2]] === 'worker' && Math.hypot(u[3] - b.x, u[4] - b.z) < 22) pts.push([u[3], u[4]]);
    return pts.length >= 2 ? cluster(pts) : b;
  }

  // the newest building under construction of a player (not the town centre)
  building(snap, owner) {
    let best = null;
    for (const b of snap.buildings) if (b[1] === owner && b[6] < 100 && (!best || b[0] > best[0])) best = b;
    return best ? { x: best[3] + 1.5, z: best[4] + 1.5 } : null;
  }

  // ---- candidates: { prio, key, len, mk(snap) -> shot request } ----
  candidate(outT, snap) {
    const C = this.C;
    const sc = this.activeScene(outT);
    const fin = this.finale(outT, snap);
    if (fin) return { prio: 9, key: fin.key, len: 1e6, mk: () => fin };
    const col = this.collapse(outT, sc);
    if (col) return { prio: 9, key: col.key, len: Math.max(0.2, col.end - outT) + 0.01, mk: () => col };
    if (this.show) {
      const sp = this.show.partAt(outT);
      if (sp && sp.cam) { const key = `sh${sp.key}`; return { prio: 8, key, len: Math.max(0.2, sp.o1 - outT), mk: (sn) => this.showShot(sn, sp, key, outT) }; }
    }
    if (this.focus) {
      const fs = this.focusAt(outT);
      if (fs) { const key = `f${fs.i}`; return { prio: 8, key, len: Math.max(0.2, fs.o1 - outT), mk: (sn) => this.focusShot(sn, fs, key, outT) }; }
    }
    if (sc && sc.kind !== 'tier_up') {
      const seg = Math.floor(Math.max(0, outT - (sc.o0 - C.lead_s)) / C.seg_s);
      const key = `b${sc.id}s${seg}`;
      return { prio: 7, key, len: C.seg_s, mk: (sn) => this.fightShot(sn, sc, seg, key, outT) };
    }
    for (const t of this.tiers) {
      if (outT >= t.o - C.tier_lead_s && outT <= t.o - C.tier_lead_s + C.tier_s) {
        const b = this.base(t.p), key = `t${t.o.toFixed(2)}`;
        return { prio: 5, key, len: C.tier_s, mk: () => ({ kind: 'tier', key, x: b.x, z: b.z, o: t.p === 1 ? 12 : -12, len: C.tier_s, cut: true }) };
      }
    }
    for (const { m, w } of this.moms) {
      if (outT >= w.o0 - 0.6 && outT <= w.o1 - 0.8) {
        const landed = outT >= w.land - 0.3, key = `d${m.id}${landed ? 'b' : 'a'}`;
        return { prio: 6, key, len: landed ? Math.max(2, w.o1 - w.land) : Math.max(2, w.land - w.o0), mk: (sn) => this.decisionShot(sn, m, landed, key) };
      }
    }
    for (let i = this.acts.length - 1; i >= 0; i--) {
      const a = this.acts[i];
      if (outT >= a.o - C.event_lead_s && outT <= a.o - C.event_lead_s + C.event_s) {
        // not event after event: a shot of the quiet cycle runs between two event shots (first contact and expansions always count)
        const key = `e${a.kind}${a.id}`;
        if (this.lastAct && this.lastAct.key !== key && outT - this.lastAct.t < C.event_gap_s && a.kind !== 'contact' && a.kind !== 'crane') continue;
        if (!this.lastAct || this.lastAct.key !== key) this.lastAct = { key, t: outT };
        return { prio: 4, key, len: C.event_s, mk: () => this.eventShot(a, key) };
      }
    }
    // a fight that is not a planned scene (fast-forwarded battles): follow it, 3.6 s segments like a scene
    const fb = this.fighters(snap, null, 0);
    if (fb && fb.n >= 5) {
      const seg = Math.floor(outT / 3.6), key = `q${seg}`;
      return { prio: 3, key, len: 3.6, mk: (sn) => this.fightShot(sn, { id: 'q', o0: -1e9, focus: null }, seg, key, outT) };
    }
    // quiet: the cycle
    const ph = outT % this.idleTotal, cyc = Math.floor(outT / this.idleTotal);
    let k = 0;
    while (k < this.idleCum.length - 1 && ph >= this.idleCum[k]) k++;
    const n = cyc * this.idleCum.length + k, len = C.idle_lens[k], t0 = (k ? this.idleCum[k - 1] : 0) + cyc * this.idleTotal;
    const key = `i${n}`;
    return { prio: 1, key, len: Math.max(0.5, t0 + len - outT), mk: (sn) => this.idleShot(sn, n, k, len, key) };
  }

  focusAt(outT) {
    for (const f of this.focus) if (outT >= f.o0 && outT < f.o1) return f;
    return null;
  }

  // how much of the view from the camera to the subject is blocked by trees (0..1): the ray rises from the subject (height 0.8) toward
  // the camera, trees count when the ray is lower than a tree (2.6 tiles) there; three samples across the ray
  occlusion(x, z, az, dist, elevDeg) {
    if (!this.treeAt) return 0;
    const pol = ((90 - elevDeg) * Math.PI) / 180, sp = Math.sin(pol), cp = Math.cos(pol);
    const rx = sp * Math.sin(az), rz = sp * Math.cos(az);
    let blocked = 0, n = 0;
    for (let d = 1.5; d <= Math.min(14, dist * 0.45); d += 0.75) {
      const h = 0.8 + d * (cp / sp);
      for (const lat of [-1.6, 0, 1.6]) {
        n++;
        if (h < 2.6 && this.treeAt(x + rx * d / sp - rz * lat, z + rz * d / sp + rx * lat)) blocked++;
      }
    }
    return n ? blocked / n : 0;
  }

  // how large the biggest tall object between the camera and the subject looms in the frame (share of the frame height, 0..1, times the
  // share of its width inside the frame): a shrine right in front of the lens hides the action even when the line of sight is free.
  // Camera as in render/cinema.mjs: subject + (sin az, cos az) * dist * cos(elev) on the ground, dist * sin(elev) high, looking at the subject.
  foreground(x, z, az, dist, elevDeg) {
    const e = (elevDeg * Math.PI) / 180, ce = Math.cos(e), se = Math.sin(e), sa = Math.sin(az), ca = Math.cos(az);
    const D = dist * ce, cx = x + sa * D, cy = dist * se, cz = z + ca * D, th = Math.tan((this.C.fov * Math.PI) / 360);
    let worst = 0;
    for (const [ox, oz, h, w] of this.tall) {
      const vx = ox - cx, vz = oz - cz, g = -(vx * sa + vz * ca); // g: ground distance in front of the camera along the view
      if (g < 1 || g > D - 4) continue; // behind the camera, or next to / behind the subject (that is context, not foreground)
      const db = g * ce + cy * se, dt = g * ce - (h - cy) * se; // depth of its foot and its top
      if (dt < 1) continue;
      const yb = (g * se - cy * ce) / (db * th), yt = (g * se + (h - cy) * ce) / (dt * th); // frame height -1..1
      const vs = (Math.min(1, yt) - Math.max(-1, yb)) / 2;
      if (vs <= 0) continue;
      const dm = (db + dt) / 2, nx = (vx * ca - vz * sa) / (dm * th * this.aspect), hw = w / 2 / (dm * th * this.aspect);
      worst = Math.max(worst, (vs * Math.max(0, Math.min(1, nx + hw) - Math.max(-1, nx - hw))) / (2 * hw));
    }
    return worst;
  }

  // view cost of the tall objects over the azimuths the shot sweeps through (sweep: degrees to either side, an orbit or a drift)
  fgCost(x, z, az, dist, elevDeg, sweep) {
    if (!this.tall.length) return 0;
    let fg = 0;
    for (const k of sweep ? [-1, -0.5, 0, 0.5, 1] : [0]) fg = Math.max(fg, this.foreground(x, z, az + (k * sweep * Math.PI) / 180, dist, elevDeg));
    return Math.max(0, fg - this.C.fg_free) * this.C.fg_cost;
  }

  // how much of the frame behind the subject (away from the camera) shows the flat plane beyond the map edge: the top of the frame
  // reaches `far` tiles behind the subject (a steeper view reaches less far), the edge is `dEdge` tiles behind it
  edgeExposure(x, z, az, elevDeg, dist) {
    const dx = -Math.sin(az), dz = -Math.cos(az), size = this.size, e = (elevDeg * Math.PI) / 180;
    const far = Math.min(200, (dist * Math.sin(e)) / Math.tan((Math.max(1.5, elevDeg - 12) * Math.PI) / 180) - dist);
    let dEdge = Infinity;
    for (let d = 0; d <= 160; d += 2) { const px = x + dx * d, pz = z + dz * d; if (px < 1 || pz < 1 || px > size - 1 || pz > size - 1) { dEdge = d; break; } }
    return dEdge <= far ? Math.min(1, 0.3 + (far - dEdge) / 40) : 0;
  }

  // azimuth offset (degrees from the broadcast line) and elevation that see the subject without a tree in front and without a shrine
  // looming in the foreground; re-checked about once a second
  lookFor(key, x, z, o0, elev0, dist, outT, sweep = 0) {
    const C = this.C, L = this.lookS;
    if (L && L.key === key && outT - L.t < C.look_dwell_s) return L;
    let best = null;
    for (const dEl of [0, 4, 8]) for (const off of [0, 12, -12, 24, -24, 38, -38, 52, -52]) {
      const o = o0 + off;
      if (Math.abs(o) > 70 || elev0 + dEl > 30) continue;
      if (L && L.key === key && Math.abs(o - L.o) > 26) continue; // re-checks only nudge the azimuth
      const az = this.L + (o * Math.PI) / 180, oc = this.occlusion(x, z, az, dist, elev0 + dEl);
      const cost = oc * 10 + this.edgeExposure(x, z, az, elev0 + dEl, dist) * 6 + this.fgCost(x, z, az, dist, elev0 + dEl, sweep) + Math.abs(off) * 0.04 + dEl * 0.1;
      if (!best || cost < best.cost) best = { key, t: outT, o, elev: elev0 + dEl, cost, oc };
    }
    if (L && L.key === key) { // hysteresis: keep the running view unless the new one is clearly better
      const caz = this.L + (L.o * Math.PI) / 180, cur = this.occlusion(x, z, caz, dist, L.elev) * 10 + this.edgeExposure(x, z, caz, L.elev, dist) * 6 + this.fgCost(x, z, caz, dist, L.elev, sweep) + Math.abs(L.o - o0) * 0.04 + (L.elev - elev0) * 0.1;
      if (cur <= best.cost + 1.5) best = { ...L, t: outT, cost: cur };
    }
    this.lookS = best;
    return best;
  }

  // the shot for a caster line's subject: a continuous move (no cut): fight -> slow orbit, units -> tracking, building -> dolly push-in, army -> tracking
  focusShot(snap, fs, key, outT) {
    const sub = this.subjects.get(fs.subject);
    if (!sub) { const b = this.base(1); return { kind: 'base', key, x: b.x, z: b.z }; }
    const C = this.C;
    let lv = liveSubject(snap, sub, this.ctx);
    if (sub.kind === 'fight') { const cl = this.fighters(snap, { x: sub.x, z: sub.z }, 30); if (cl) lv = { x: cl.x, z: cl.z, r: Math.max(6, cl.r), n: cl.n, found: true }; }
    // low-passed subject point
    const P = this.sp;
    if (P.key !== key) { P.key = key; P.x = lv.x; P.z = lv.z; } else { const a = 1 - Math.exp(-(1 / 60) / C.subject_lp_s); P.x += (lv.x - P.x) * a; P.z += (lv.z - P.z) * a; }
    const x = P.x, z = P.z, side = fs.i % 2 ? -1 : 1, len = Math.max(3, fs.o1 - fs.o0);
    const isTC = sub.type === 'town_center';
    if (sub.kind === 'building' && !isTC) {
      const lk = this.lookFor(key, x, z, 14 * side, 21, 32, outT, 8);
      return { kind: 'push', key, x, z, o: lk.o, elev: lk.elev, len, d0: 38, d1: 25, sweep: -8 * side };
    }
    if (sub.kind === 'building') {
      const lk = this.lookFor(key, x, z, 12 * side, 22, 44, outT, 8);
      return { kind: 'push', key, x, z, o: lk.o, elev: lk.elev, len, d0: 46, d1: 32, sweep: -8 * side };
    }
    if (sub.kind === 'fight') {
      const lk = this.lookFor(key, x, z, 8 * side, 22, 36, outT, this.rig.C.battle_sweep_deg);
      return { kind: 'battle', key, x, z, r: lv.r, o: lk.o, elev: lk.elev, track: true, len };
    }
    const dist = Math.max(24, Math.min(42, 18 + lv.r * 1.3));
    const lk = this.lookFor(key, x, z, 14 * side, 21, dist, outT, 8);
    return { kind: 'follow', key, x, z, r: lv.r, o: lk.o, elev: lk.elev, dist, track: true, len };
  }

  // where a selection ({t:'army'|'ids'|'type'|'base'|'fight'|'at', ...}) is right now: { x, z, r, n } or null
  // Where ground points land in the picture for a follow shot (target tx tz, distance, elevation, azimuth): x right and y up, 1 = frame edge. The pinhole model of fitWholeMap in render/cinema.mjs.
  ndcOf(tx, tz, dist, elev, az, pts) {
    const pol = ((90 - elev) * Math.PI) / 180, th = Math.tan((this.C.fov * Math.PI) / 360), tw = th * this.aspect, sp = Math.sin(pol), cp = Math.cos(pol), sa = Math.sin(az), ca = Math.cos(az);
    return pts.map(([x, z]) => { const qx = x - tx, qz = z - tz, along = qx * sa + qz * ca, across = qx * ca - qz * sa, depth = dist - along * sp; return depth > 1 ? [across / depth / tw, (-along * cp) / depth / th] : [9, 9]; });
  }

  // 'bld' push-ins: the building stays in the picture, an army near it lies whole in the free part or wholly outside the frame. The target is shifted by a few tiles (the same steps for the whole push).
  reframePush(sh, groups) {
    const F = SHOW_FRAME, DEG = Math.PI / 180, ring = (g) => { const R = g.r * F.margin + F.pad, pts = []; for (let i = 0; i < 12; i++) pts.push([g.x + Math.cos(i * Math.PI / 6) * R, g.z + Math.sin(i * Math.PI / 6) * R]); return pts; };
    const near = groups.filter((g) => g && g.n >= F.minN && Math.hypot(g.x - sh.x, g.z - sh.z) < g.r + 26);
    if (!near.length) return sh;
    const rings = near.map(ring), us = [0, 0.5, 1];
    const over = (q) => Math.max(0, Math.abs(q[0]) - F.x) + Math.max(0, q[1] - F.top) + Math.max(0, F.bottom - q[1]), toOut = (q) => Math.max(0, 1.03 - Math.max(Math.abs(q[0]), Math.abs(q[1])));
    const viol = (tx, tz, k = 1) => {
      let v = 0;
      for (const u of us) {
        const d = (sh.d0 + (sh.d1 - sh.d0) * u) * k, az = this.L + (sh.o || 0) * DEG + (sh.sweep ?? -12) * DEG * u;
        const bq = this.ndcOf(tx, tz, d, sh.elev, az, [[sh.x, sh.z]])[0]; // the building itself stays in the middle part of the picture
        v += 3 * (Math.max(0, Math.abs(bq[0]) - 0.7) + Math.max(0, bq[1] - 0.5) + Math.max(0, -0.5 - bq[1]));
        for (const rg of rings) { const q = this.ndcOf(tx, tz, d, sh.elev, az, rg); v += Math.min(q.reduce((t, p) => t + over(p), 0), q.reduce((t, p) => t + toOut(p), 0)); }
      }
      return v;
    };
    const v0 = viol(sh.x, sh.z);
    let best = null, bc = Infinity;
    // a big army does not fit at the push distance: the whole push may stand further back (factor k on both ends), as little as needed
    for (const k of [1, 1.15, 1.3, 1.5]) for (let ix = -4; ix <= 4; ix++) for (let iz = -4; iz <= 4; iz++) {
      const tx = sh.x + ix * 3, tz = sh.z + iz * 3, v = viol(tx, tz, k), cost = v * 100 + Math.hypot(ix, iz) * 3 + (k - 1) * 60;
      if (cost < bc) { bc = cost; best = { x: tx, z: tz, v, k }; }
    }
    if (process.env.RTS_SHOWLOG) console.error('reframePush', 'groups', near.length, best ? 'x ' + best.x.toFixed(1) + ' z ' + best.z.toFixed(1) + ' v ' + best.v.toFixed(2) : 'none', '(was ' + v0.toFixed(2) + ')');
    return best && best.v < v0 ? { ...sh, x: best.x, z: best.z, d0: sh.d0 * best.k, d1: sh.d1 * best.k } : sh;
  }

  // 'mid' shots must not cut an army through its outline. Looks for the centre (on the line between the two groups, with the aside shift kept) and the distance (up to SHOW_MID.cap)
  // so that the group the camera stays with (the bigger one, or a when both are held) lies whole in the free part of the picture and the other group lies whole in it too or wholly outside the frame. Nothing found: the shot stays as it was.
  reframe(sh, a, b, wa2, wdist) {
    const F = SHOW_FRAME, DEG = Math.PI / 180, az = this.L + (sh.o || 0) * DEG, sway = 8 * DEG;
    const ring = (g) => { const R = g.r * F.margin + F.pad, pts = []; for (let i = 0; i < 12; i++) pts.push([g.x + Math.cos(i * Math.PI / 6) * R, g.z + Math.sin(i * Math.PI / 6) * R]); return pts; };
    const pa = wa2 >= 0.5 ? ring(a) : ring(b), pb = wa2 >= 0.5 ? ring(b) : ring(a), dx = sh.x - (a.x * wa2 + b.x * (1 - wa2)), dz = sh.z - (a.z * wa2 + b.z * (1 - wa2));
    // violation of a candidate: how far the outlines reach out of the free part (0 = none). Group b may instead lie wholly outside the frame: it counts the cheaper of both.
    const over = (q) => Math.max(0, Math.abs(q[0]) - F.x) + Math.max(0, q[1] - F.top) + Math.max(0, F.bottom - q[1]);
    const toOut = (q) => Math.max(0, 1.03 - Math.max(Math.abs(q[0]), Math.abs(q[1])));
    const viol = (w, d) => {
      const cx = a.x * w + b.x * (1 - w) + dx, cz = a.z * w + b.z * (1 - w) + dz;
      let va = 0, vb = 0;
      for (const a2 of [az - sway, az, az + sway]) { // the camera swings a little around the azimuth: it must hold at both ends
        va = Math.max(va, this.ndcOf(cx, cz, d, sh.elev, a2, pa).reduce((t, q) => t + over(q), 0));
        const nb = this.ndcOf(cx, cz, d, sh.elev, a2, pb);
        vb = Math.max(vb, Math.min(nb.reduce((t, q) => t + over(q), 0), nb.reduce((t, q) => t + toOut(q), 0)));
      }
      return { x: cx, z: cz, dist: d, v: 3 * va + vb };
    };
    const orig = viol(wa2, wdist);
    let best = null, bestCost = Infinity;
    for (let d = Math.max(SHOW_MID.near, Math.min(wdist, F.maxD)); d <= F.maxD; d += F.stepD) {
      for (let k = 0; k <= 10; k++) {
        const w = Math.max(0, Math.min(1, Math.round(wa2 / F.stepW) * F.stepW + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * F.stepW)), r = viol(w, d);
        const cost = r.v * 100 + (d - wdist) + 40 * Math.abs(w - wa2);
        if (cost < bestCost) { bestCost = cost; best = r; }
      }
    }
    if (best && best.v >= orig.v) best = null; // nothing better than the shot as it is: leave it
    // two armies that do not fit whole even at the largest distance: hold the line of contact, i.e. the front half of both outlines (the side that faces the other group), the backs may leave the picture
    if ((!best ? orig.v : best.v) > F.tol) {
      const front = (g, o) => { const R = g.r * F.margin + F.pad, ang = Math.atan2(o.z - g.z, o.x - g.x), pts = []; for (let i = -3; i <= 3; i++) pts.push([g.x + Math.cos(ang + i * Math.PI / 6) * R, g.z + Math.sin(ang + i * Math.PI / 6) * R]); return pts; };
      const fa = wa2 >= 0.5 ? front(a, b) : front(b, a), fb = wa2 >= 0.5 ? front(b, a) : front(a, b);
      const viol2 = (w, d) => {
        const cx = a.x * w + b.x * (1 - w) + dx, cz = a.z * w + b.z * (1 - w) + dz;
        let v = 0;
        for (const a2 of [az - sway, az, az + sway]) v = Math.max(v, this.ndcOf(cx, cz, d, sh.elev, a2, fa).reduce((t, q) => t + over(q), 0) * 3 + this.ndcOf(cx, cz, d, sh.elev, a2, fb).reduce((t, q) => t + over(q), 0));
        return { x: cx, z: cz, dist: d, v };
      };
      let b2 = null, c2 = Infinity;
      for (let d = Math.max(SHOW_MID.near, Math.min(wdist, F.maxD)); d <= F.maxD; d += F.stepD) for (let k = 0; k <= 10; k++) {
        const w = Math.max(0, Math.min(1, Math.round(wa2 / F.stepW) * F.stepW + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * F.stepW)), r = viol2(w, d), cost = r.v * 100 + (d - wdist) + 40 * Math.abs(w - wa2);
        if (cost < c2) { c2 = cost; b2 = r; }
      }
      if (b2 && b2.v < Math.min(orig.v, best ? best.v : Infinity) * 0.8) { best = b2; if (process.env.RTS_SHOWLOG) console.error('reframe front', b2.v.toFixed(2)); }
    }
    if (process.env.RTS_SHOWLOG) console.error('reframe', 'a', a.n, a.r.toFixed(1), a.x.toFixed(1), a.z.toFixed(1), 'b', b.n, b.r.toFixed(1), b.x.toFixed(1), b.z.toFixed(1), 'wa2', wa2.toFixed(2), 'wdist', wdist.toFixed(0), best ? 'found d ' + best.dist + ' x ' + best.x.toFixed(1) + ' v ' + best.v.toFixed(2) + ' (was ' + orig.v.toFixed(2) + ')' : 'none (was ' + orig.v.toFixed(2) + ')');
    return best ? { ...sh, x: best.x, z: best.z, dist: best.dist } : sh;
  }

  locate(snap, sel, prev = null) {
    if (!sel) return null;
    if (Array.isArray(sel)) { for (const q of sel) { const l = this.locate(snap, q, prev); if (l) return l; } return null; }
    if (sel.t === 'at') return { x: sel.x, z: sel.z, r: sel.r || 5, n: 1 };
    if (sel.t === 'base') { const b = this.base(sel.o); return { x: b.x, z: b.z, r: 8, n: 1 }; }
    if (sel.t === 'fight') { const cl = this.fighters(snap, null, 0); return cl ? { x: cl.x, z: cl.z, r: Math.max(6, cl.r), n: cl.n || 0 } : null; }
    const pts = selectUnits(snap, sel).map((u) => [u[3], u[4]]);
    if (!pts.length) return null;
    // the biggest group, not the middle of all: with two groups apart the middle is empty ground. A running shot stays with the group it is on (prev)
    const stay = prev ? pts.filter((p) => Math.hypot(p[0] - prev.x, p[1] - prev.z) <= GROUP_STAY) : [];
    const c = cluster(mainGroup(stay.length ? stay : pts, GROUP_LINK_TILES));
    return c ? { x: c.x, z: c.z, r: Math.max(3, c.r), n: pts.length } : null;
  }

  // the shot of a story "show" part: always a continuous move (never a cut), so the picture follows the line it illustrates
  showShot(snap, sp, key, outT) {
    const c = sp.cam, len = Math.max(2.5, sp.o1 - sp.o0), side = c.side ?? 1;
    const keep = (sel, fb) => { const l = this.locate(snap, sel, this.showLast && this.showLast.key === key ? this.showLast.l : null); if (l) this.showLast = { key, l }; return l || (this.showLast && this.showLast.key === key ? this.showLast.l : fb); };
    const base = (o) => { const b = this.base(o); return { x: b.x, z: b.z, r: 8, n: 1 }; };
    let sh;
    switch (c.k) {
      case 'look': { // from one base across the map toward the other (low side view); the fog of war of the viewer is switched on by the part
        const A = this.base(c.from), B = typeof c.to === 'object' ? c.to : this.base(c.to), dx = B.x - A.x, dz = B.z - A.z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d, ah = c.ahead === 'to' ? d : c.ahead ?? 30; // 'to': the target is the point itself
        // camera stands behind the base (away from the other one); the target lies `ahead` tiles in front of the base; a slight side offset shows the depth of the map
        const sx = -uz * (c.lateral ?? 10), sz = ux * (c.lateral ?? 10);
        const x = A.x + ux * ah + sx, z = A.z + uz * ah + sz;
        const x2 = A.x + ux * (ah + (c.drift ?? 14)) + sx, z2 = A.z + uz * (ah + (c.drift ?? 14)) + sz;
        sh = { kind: 'look', x, z, x2, z2, az: Math.atan2(-ux, -uz) + (c.rot ?? 14) * Math.PI / 180, elev: c.elev ?? 12, d0: c.d0 ?? 60, d1: c.d1 ?? 50, sweep: c.sweep ?? 8 };
        break;
      }
      case 'bld': { // dolly push-in on a building (position from the log)
        const lk = this.lookFor(key, c.x, c.z, 14 * side, 21, c.d0 ?? 34, outT, 8);
        sh = { kind: 'push', x: c.x, z: c.z, o: lk.o, elev: lk.elev, d0: c.d0 ?? 40, d1: c.d1 ?? 24, sweep: -8 * side };
        { const D0 = c.d0 ?? 40, D1 = c.d1 ?? 24;
          sh = this.reframePush(sh, [this.locate(snap, { t: 'army', o: 1 }), this.locate(snap, { t: 'army', o: 2 })]); // no army cut by the frame edge
          const T = this.pushT; // the shifted target moves at most 8 tiles per second (the distance factor 0.6 up / 0.2 down per second), so the push does not twitch when the army moves
          let kk = sh.d0 / D0;
          if (T && T.key === key && outT > T.t) { const mx = 8 * (outT - T.t), dx = sh.x - T.x, dz = sh.z - T.z, d = Math.hypot(dx, dz); if (d > mx) { sh.x = T.x + dx / d * mx; sh.z = T.z + dz / d * mx; } const dt2 = outT - T.t; kk = Math.max(T.k - 0.2 * dt2, Math.min(T.k + 0.6 * dt2, kk)); }
          sh.d0 = D0 * kk; sh.d1 = D1 * kk;
          this.pushT = { key, t: outT, x: sh.x, z: sh.z, k: kk }; }
        break;
      }
      case 'crane': sh = { kind: 'crane', x: c.x, z: c.z, o: 14 * side }; break;
      case 'grp': { // follow a selection of units live
        const g = keep(c.sel, base(1)), lk = this.lookFor(key, g.x, g.z, 14 * side, c.elev ?? 21, c.dist ?? 32, outT, 8);
        sh = { kind: 'follow', x: g.x, z: g.z, r: g.r, o: lk.o, elev: lk.elev, dist: c.dist ?? Math.max(26, Math.min(44, 18 + g.r * 1.3)), track: true };
        break;
      }
      case 'map': { // the whole map from high above, all four corners in the picture
        const v = (this.mapView ??= fitWholeMap({ size: this.rig.size, az: this.L, elev: 58, fov: this.C.fov, aspect: this.aspect }));
        sh = { kind: 'overview', x: v.x, z: v.z, elev: 58, dist: v.dist, drift: 1 };
        break;
      }
      case 'mid': { // wide view on the middle between two selections (comparison of two armies, two armies marching)
        const a = keep(c.a, base(1)), b = this.locate(snap, c.b) || a;
        // weighted (a fight): the camera stays with the bigger group, a few stray units of the other side do not pull it onto the empty ground between them
        const wa = c.weighted ? a.n / ((a.n + b.n) || 1) : 0.5, sp2 = Math.hypot(a.x - b.x, a.z - b.z) * (c.weighted ? 2 * Math.min(wa, 1 - wa) : 1);
        // far apart (two bases): a high wide view that holds both; close together: a normal view
        const wide = c.wide || sp2 > 70;
        // video: a unit must be readable. Wide shots used to stand at 44 to 184 tiles (a unit 30 pixels high or less at 1080 wide, "ultra pixelated").
        // Now: both groups are held only while that fits within SHOW_MID.far tiles (and never closer than SHOW_MID.near); further apart, the camera stays with the bigger group at SHOW_MID.focus.
        // a big group must be in the picture whole (its outline): the distance grows with its radius, but not beyond SHOW_MID.cap
        const fitD = (g) => (g.r + 3) / SHOW_MID.fit, need = Math.max(sp2 * (wide ? 1.9 : 1.15) + SHOW_MID.pad, fitD(a), c.weighted ? 0 : fitD(b)), hold = need <= SHOW_MID.far;
        // two groups of nearly the same size must not take turns as 'the bigger one' (the camera would fly 30 tiles back and forth, the army hanging at the edge on the way): the line speaks of a, so the camera stays with a until b is more than 30 % bigger, and returns when it is less than 15 % bigger
        let ua = a.n >= b.n; { const P = this.midPick; if (!hold) { ua = P && P.key === key && !P.ua ? a.n * 1.15 >= b.n : a.n * 1.3 >= b.n; this.midPick = { key, ua }; } }
        const wa2 = hold ? wa : (ua ? 1 : 0), wdist = hold ? Math.max(Math.min(c.minDist ?? SHOW_MID.near, SHOW_MID.near), need) : Math.min(SHOW_MID.cap, Math.max(SHOW_MID.focus, fitD(ua ? a : b)));
        // wide: the target moves aside so that the army stands clear of the HUD cards: x preset (view about 1.1:1, kill feed and cards on the left) to the left of the army, wide landscape to its right
        const az0 = this.L + 10 * side * Math.PI / 180, sx = wide ? Math.min(wdist * 0.1, Math.max(0, wdist * 0.3 - ((hold ? Math.max(a.r, b.r) : (ua ? a : b).r) + 3))) * (this.aspect < 1.4 ? -1 : 1) : 0; // the shift only as far as the group still fits whole
        sh = { kind: 'follow', x: a.x * wa2 + b.x * (1 - wa2) + Math.cos(az0) * sx, z: a.z * wa2 + b.z * (1 - wa2) - Math.sin(az0) * sx, r: 8, o: 10 * side, elev: wide ? 33 : c.elev ?? 26, dist: wdist, track: true };
        if (b !== a && b.n >= SHOW_FRAME.minN && a.n >= SHOW_FRAME.minN) sh = this.reframe(sh, a, b, wa2, wdist); // no army cut by the frame edge
        break;
      }
      case 'fight': { const g = keep({ t: 'fight' }, base(1)); sh = { kind: 'battle', x: g.x, z: g.z, r: g.r, o: 8 * side, elev: 22, track: true }; break; }
      default: { const b = base(c.p || 1); sh = { kind: 'crane', x: b.x, z: b.z, o: 14 * side }; }
    }
    // a following target moves at most SHOW_MID.slew tiles per second: when the biggest group of the selection flips for a few frames (a split, a new group), the camera does not fly off and back
    if (sh.kind === 'follow' && sh.x != null) {
      const T = this.showTgt;
      if (T && T.key === key && outT > T.t) { const mx = SHOW_MID.slew * (outT - T.t), dx = sh.x - T.x, dz = sh.z - T.z, d = Math.hypot(dx, dz); if (d > mx) { sh.x = T.x + dx / d * mx; sh.z = T.z + dz / d * mx; } }
      this.showTgt = { key, t: outT, x: sh.x, z: sh.z };
    }
    if (process.env.RTS_SHOWLOG) console.error('show', key, c.k, +outT.toFixed(2), sh.x?.toFixed?.(1), sh.z?.toFixed?.(1), sh.dist?.toFixed?.(0));
    // a short part far away: a whip pan. The slow flight between the bases takes about 2.5 s, a line of 2 s would be over before the picture arrives
    if (this.showFlight?.key !== key) this.showFlight = { key, fast: c.k !== 'map' && len < SHOW_WHIP.len && sh.x != null && Math.hypot(sh.x - this.rig.s.tx, sh.z - this.rig.s.tz) > SHOW_WHIP.far };
    const fast = this.showFlight.fast && outT - sp.o0 < this.C.whip_s;
    return { ...sh, key, len, cut: false, fast, norise: c.k === 'look' || c.k === 'map', tscale: fast ? 1 : 0.62 };
  }

  fightShot(snap, sc, seg, key, outT) {
    const C = this.C;
    const at = sc.focus ? { x: sc.focus.x, z: sc.focus.y } : null;
    const cl = outT >= sc.o0 - 0.3 ? this.fighters(snap, at, C.fight_radius) : null;
    let f = cl ? { x: cl.x, z: cl.z, r: cl.r } : sc.focus ? { x: sc.focus.x, z: sc.focus.y, r: Math.max(8, (sc.focus.spread || 5) * 1.5) } : this.lastFight;
    if (!f) { const b = this.base(1); f = { x: b.x, z: b.z, r: 10 }; }
    if (cl) this.lastFight = f;
    const v = seg % 4, side = seg % 2 ? -1 : 1;
    const sh = { key, cut: true, track: true, x: f.x, z: f.z, r: f.r, len: C.seg_s };
    if (v === 1) return { ...sh, kind: 'follow', o: 16 * side, elev: 20, dist: Math.max(24, Math.min(40, 20 + f.r * 1.2)) };
    if (v === 2 && !this.latch.has(key)) this.latch.set(key, Math.hypot(this.trk.vx, this.trk.vz) > 0.8);
    if (v === 2 && this.latch.get(key)) return { ...sh, kind: 'chase', hz: this.trk.hz, o: 24 * side };
    if (v === 2) return { ...sh, kind: 'battle', o: 22 * side };
    return { ...sh, kind: 'battle', o: v === 3 ? -14 : 0 };
  }

  decisionShot(snap, m, landed, key) {
    const f = m.focus, at = { x: f.x, z: f.y };
    const cl = this.fighters(snap, at, 24);
    const x = cl ? cl.x : f.x, z = cl ? cl.z : f.y, r = cl ? Math.max(6, cl.r) : 9;
    if (!landed) return { kind: 'battle', key, cut: true, track: true, x, z, r, o: 0, len: 4 };
    return { kind: 'follow', key, cut: true, track: true, x, z, r, o: 18, elev: 20, dist: Math.max(26, Math.min(44, 20 + r)), len: 4 };
  }

  eventShot(a, key) {
    const C = this.C, o = (a.id % 2 ? 1 : -1) * 14;
    if (a.kind === 'push') return { kind: 'push', key, cut: true, x: a.x, z: a.z, o, len: C.event_s, d0: 50, d1: 24 };
    if (a.kind === 'crane') return { kind: 'crane', key, cut: true, x: a.x, z: a.z, o, len: C.event_s + 0.6 };
    if (a.kind === 'contact') return { kind: 'follow', key, cut: true, track: true, x: a.x, z: a.z, r: 5, o: 10, elev: 24, dist: 34, len: C.event_s };
    return { kind: 'battle', key, cut: true, x: a.x, z: a.z, r: 8, o, len: C.event_s };
  }

  idleShot(snap, n, k, len, key) {
    const flip = (n >> 3) & 1, A = flip ? 2 : 1, B = flip ? 1 : 2;
    const side = (n & 1 ? -1 : 1);
    const sh = { key, cut: true, len };
    const baseA = this.base(A), baseB = this.base(B);
    const mid = { x: (this.starts[0].tx + this.starts[this.starts.length - 1].tx) / 2 + 1.5, z: (this.starts[0].ty + this.starts[this.starts.length - 1].ty) / 2 + 1.5 };
    const toward = (b, m, f) => ({ x: b.x + (m.x - b.x) * f, z: b.z + (m.z - b.z) * f });
    switch (k) {
      case 0: return { ...sh, kind: 'crane', x: baseA.x, z: baseA.z, o: 14 * side };
      case 1: return { ...sh, kind: 'crane', x: baseB.x, z: baseB.z, o: -14 * side, len: len + 0.6 };
      case 2: { const w = this.workersAt(snap, A); return { ...sh, kind: 'low', x: w.x, z: w.z, o: 12 * side }; }
      case 3: { const w = this.workersAt(snap, B); return { ...sh, kind: 'low', x: w.x, z: w.z, o: -12 * side }; }
      case 4: { const e = toward(baseA, mid, 0.55); return { ...sh, kind: 'fly', x: baseA.x + 6 * Math.sign(mid.x - baseA.x), z: baseA.z + 6 * Math.sign(mid.z - baseA.z), x2: e.x, z2: e.z, o: 8 * side, dist: 56 }; }
      case 5: {
        const g = this.group(snap, 1, true) || this.group(snap, 2, true) || this.group(snap, A, false) || this.group(snap, B, false);
        if (g) return { ...sh, kind: 'follow', track: true, x: g.x, z: g.z, r: Math.max(4, g.r), o: 14 * side, elev: 16, dist: 30 };
        const w = this.workersAt(snap, B); return { ...sh, kind: 'low', x: w.x, z: w.z, o: 10 * side };
      }
      case 6: {
        const b = this.building(snap, k % 2 ? A : B) || this.building(snap, A) || this.building(snap, B) || (flip ? baseB : baseA);
        return { ...sh, kind: 'push', x: b.x, z: b.z, o: 12 * side, d0: 46, d1: 22, sweep: -10 };
      }
      default: { const e = toward(baseB, mid, 0.55); return { ...sh, kind: 'fly', x: baseB.x + 6 * Math.sign(mid.x - baseB.x), z: baseB.z + 6 * Math.sign(mid.z - baseB.z), x2: e.x, z2: e.z, o: -8 * side, dist: 56 }; }
    }
  }

  shot(outT, snap, dt = 1 / 60) {
    const C = this.C;
    const cand = this.candidate(outT, snap);
    let cur = this.cur;
    if (!cur) cur = this.cur = { ...cand, t0: outT };
    else if (cand.key !== cur.key) {
      const played = outT - cur.t0;
      if (outT >= cur.t0 + cur.len || (cand.prio > cur.prio && played >= C.min_s) || (cand.prio === cur.prio && cur.prio >= 7 && played >= Math.min(cur.len, C.min_s))) cur = this.cur = { ...cand, t0: outT };
      else if (cur.prio === 1 && cand.prio === 1) cur = this.cur = { ...cand, t0: outT };
      else if (cur.prio === 9) { /* never leave the collapse early */ }
    }
    // the running shot is rebuilt every frame from the current snapshot (tracking), not from the candidate that is queued
    const run = cur.key === cand.key ? cand : { ...cur, mk: cur.mk };
    // heading of the tracked group (smoothed), used by chase shots
    const req = run.mk(snap);
    const T = this.trk;
    if (T.key !== req.key) { if (Math.hypot(req.x - T.x, req.z - T.z) > 15) { T.vx = 0; T.vz = 0; } T.key = req.key; T.x = req.x; T.z = req.z; }
    else {
      const a = 1 - Math.exp(-dt / 0.8);
      T.vx += ((req.x - T.x) / dt - T.vx) * a; T.vz += ((req.z - T.z) / dt - T.vz) * a;
      T.x = req.x; T.z = req.z;
      if (Math.hypot(T.vx, T.vz) > 0.8) T.hz += angDiff(Math.atan2(T.vx, T.vz), T.hz) * a;
    }
    // hard cuts are rare: only when the next subject is very far away, or on a big hit
    if (req.cut) { const j = Math.hypot(req.x - this.rig.s.tx, req.z - this.rig.s.tz); req.cut = cur.prio >= 9 ? j > C.cut_hit : j > C.cut_far; }
    // whip: the first whip_s seconds of the shot fly there fast, then it is a normal shot
    if (req.fast === 'whip') req.fast = outT - cur.t0 < C.whip_s;
    this.mode = cur.prio >= 9 ? 'collapse' : cur.prio === 8 ? 'talk' : cur.prio === 7 ? 'battle' : cur.prio === 6 ? 'decision' : cur.prio === 5 ? 'tier' : cur.prio === 4 ? 'event' : 'quiet';
    return req;
  }

  update(outT, dt, snap) {
    const sh = this.shot(outT, snap, dt);
    const c = this.rig.update(dt, sh, outT);
    return { tx: c.tx, ty: c.ty, tz: c.tz, dist: c.dist, az: c.az, pol: c.pol, fov: this.C.fov, mode: this.mode };
  }
}
