// Victory paths besides conquest and score (content 2). Both are switched by the rules preset (rules.wonder, rules.shrines).
//
// WONDER. A very expensive tier 3 building (BUILDINGS.wonder, one per player). When it is finished its countdown starts
// (rules.wonderSecs) and EVERY player is told ("wonder_started", with the place and the time left, also under fog). If it still stands
// when the countdown ends, its owner's team wins ("wonder_completed"). Destroying it cancels the countdown ("wonder_destroyed").
// The countdown lives on the building (b.wt, ticks left), so it is part of the state hash and nothing else has to be saved.
//
// RELIC SHRINES. Map objects (map.shrines, placed point symmetric by the generator, by the world editor or by hand). A shrine belongs to
// a team after soldiers of that team stood next to it for captureS seconds without any enemy unit there (any unit of another team
// there stops the clock; a finished own outpost next to the shrine counts as outpostWeight soldiers standing there, which holds it).
// Every second each held shrine gives its team one victory point; the first team at rules.shrineTarget points wins ("control_victory").
// At the time limit the victory points count into the score.
//
// All of it is plain tick arithmetic on the state, no randomness: the same seed and command log give the same match.
import { BUILDINGS, VICTORY } from './data.mjs';
import { hashStep, TICK_HZ } from './util.mjs';

const SHRINE_STEP = 5; // ticks between two presence checks (progress is counted in ticks, so it is exact)

export function installVictory(Game) {
  const methods = {
    // ---------- setup ----------
    initVictory(mapObj) {
      this.shrines = [];
      this.vp = [0, 0, 0, 0, 0]; // victory points per team id (1..4)
      this.announcements = [];
      if (!this.rules.shrines) return;
      const S = VICTORY.shrine.size;
      for (const s of mapObj.shrines || []) {
        const sh = {
          id: this.nextId++, tx: s.tx, ty: s.ty, cx: (s.tx + S / 2) * 1000, cy: (s.ty + S / 2) * 1000,
          own: 0, cand: 0, prog: 0, flips: 0, near: [0, 0, 0, 0, 0],
        };
        this.shrines.push(sh);
        for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) this.blk[(s.ty + j) * this.W + s.tx + i] = 1; // the shrine itself is an obstacle
      }
    },

    // ---------- announcements (told to every player, also under fog) ----------
    announce(ev) {
      ev.t = this.t;
      this.announcements.push(ev);
      if (this.announcements.length > 80) this.announcements.shift();
      for (const p of this.players) if (p) this.event(p, { ...ev, global: true, mine: p.id === ev.owner, ally: p.team === ev.team });
    },

    // a building has just been finished (or placed finished)
    onBuilt(b) {
      const d = this.players[b.owner].faction.buildings[b.type];
      if (d.wonder && this.rules.wonder && b.wt === undefined) {
        b.wt = this.rules.wonderSecs * TICK_HZ;
        b.ww = false;
        this.announce({ type: 'wonder_started', owner: b.owner, team: this.team[b.owner], x: b.tx, y: b.ty, size: b.size, id: b.id, secs: this.rules.wonderSecs });
      }
    },

    // a building has just been removed from the game (cleanup)
    onBuildingGone(b) {
      if (b.wt !== undefined && b.wt > 0) {
        this.announce({ type: 'wonder_destroyed', owner: b.owner, team: this.team[b.owner], x: b.tx, y: b.ty, id: b.id, secs_left: Math.ceil(b.wt / TICK_HZ), by: b.kby || 0 });
      }
    },

    // ---------- per tick ----------
    victoryStep() {
      if (this.rules.wonder) {
        for (const b of this.buildings.values()) {
          if (b.wt === undefined || b.wt <= 0 || b.dead || !this.players[b.owner].alive) continue;
          b.wt--;
          if (!b.ww && b.wt <= VICTORY.wonderWarnS * TICK_HZ) {
            b.ww = true;
            this.announce({ type: 'wonder_warning', owner: b.owner, team: this.team[b.owner], x: b.tx, y: b.ty, id: b.id, secs_left: VICTORY.wonderWarnS });
          }
        }
      }
      if (this.shrines.length && this.t % SHRINE_STEP === 0) this.shrineStep();
      if (this.shrines.length && this.t % TICK_HZ === 0) for (const sh of this.shrines) if (sh.own) this.vp[sh.own]++;
    },

    shrineStep() {
      const R = Math.round(VICTORY.shrine.radius * 1000);
      const CAP = VICTORY.shrine.captureS * TICK_HZ;
      for (const sh of this.shrines) {
        // presence per team: [any unit, soldiers] and who of the team stands there most (for the announcement)
        const any = [0, 0, 0, 0, 0], mil = [0, 0, 0, 0, 0], per = new Map();
        this.unitsNear(sh.cx, sh.cy, R, (e) => {
          if (e.owner === 0) return;
          const tm = this.team[e.owner];
          any[tm]++;
          const st = this.players[e.owner].stats[e.type];
          if (e.type !== 'worker' && !st.noArmy && !st.noAtk) mil[tm]++;
          per.set(e.owner, (per.get(e.owner) || 0) + 1);
        });
        for (const b of this.buildings.values()) {
          if (b.dead || !b.built || b.type !== 'outpost') continue;
          const dx = (b.tx + b.size / 2) * 1000 - sh.cx, dy = (b.ty + b.size / 2) * 1000 - sh.cy;
          const r2 = Math.round(VICTORY.shrine.outpostRadius * 1000) ** 2;
          if (dx * dx + dy * dy <= r2) { const tm = this.team[b.owner]; any[tm] += VICTORY.shrine.outpostWeight; mil[tm] += VICTORY.shrine.outpostWeight; }
        }
        sh.near = any;
        let solo = 0, n = 0;
        for (let tm = 1; tm <= 4; tm++) if (any[tm] > 0) { n++; solo = tm; }
        if (n !== 1) continue; // empty or contested: nothing happens
        if (solo === sh.own) {
          if (sh.cand) { sh.prog -= SHRINE_STEP; if (sh.prog <= 0) { sh.cand = 0; sh.prog = 0; } } // the owner pushes the attempt back
          continue;
        }
        if (sh.cand !== solo) {
          if (sh.cand) { sh.prog -= SHRINE_STEP; if (sh.prog > 0) continue; }
          sh.cand = solo; sh.prog = 0;
        }
        if (!mil[solo]) continue; // workers and scouts alone cannot take a shrine
        sh.prog += SHRINE_STEP;
        if (sh.prog >= CAP) {
          const from = sh.own;
          sh.own = solo; sh.cand = 0; sh.prog = 0; sh.flips++;
          let who = 0, best = -1;
          for (const [pid, c] of [...per.entries()].sort((a, b) => a[0] - b[0])) if (this.team[pid] === solo && c > best) { best = c; who = pid; }
          this.announce({ type: 'control_point_captured', owner: who, team: solo, from_team: from, x: sh.tx, y: sh.ty, id: sh.id, vp: this.vp[solo] });
        }
      }
    },

    // Called by checkVictory: a wonder that ran out, or a team at the shrine target. Returns {team, reason, ...} or null.
    victoryPathWinner() {
      let best = null;
      if (this.rules.wonder) {
        for (const b of this.buildings.values()) {
          if (b.wt === undefined || b.wt > 0 || b.dead || !this.players[b.owner].alive) continue;
          if (!best || b.wt < best.wt || (b.wt === best.wt && b.id < best.b.id)) best = { wt: b.wt, b };
        }
        if (best) return { team: this.team[best.b.owner], owner: best.b.owner, reason: 'wonder', b: best.b };
      }
      if (this.shrines.length) {
        let top = null;
        for (let tm = 1; tm <= 4; tm++) if (this.vp[tm] >= this.rules.shrineTarget && (!top || this.vp[tm] > this.vp[top])) top = tm;
        if (top) return { team: top, owner: 0, reason: 'shrines' };
      }
      return null;
    },

    // share of the victory points of a team that one of its players carries in the score
    teamVp(team) {
      return this.vp ? this.vp[team] || 0 : 0;
    },

    // ---------- views ----------
    // everything a spectator page / observation needs, in tile units (mirror: raw map coordinates)
    victoryView() {
      const v = { wonder: this.rules.wonder, shrines: this.rules.shrines };
      if (this.rules.wonder) {
        v.wonders = [];
        for (const b of this.buildings.values()) {
          if (b.dead || !b.type || !this.players[b.owner].faction.buildings[b.type].wonder) continue;
          v.wonders.push({ id: b.id, owner: b.owner, team: this.team[b.owner], x: b.tx, y: b.ty, size: b.size, built: b.built, secs_left: b.wt === undefined ? null : Math.ceil(Math.max(0, b.wt) / TICK_HZ), total: this.rules.wonderSecs });
        }
      }
      if (this.rules.shrines) {
        v.target = this.rules.shrineTarget;
        v.vp = this.vp.slice(1);
        v.points = this.shrines.map((s) => ({ id: s.id, x: s.tx, y: s.ty, team: s.own, cand: s.cand, pct: s.cand ? Math.min(100, Math.round((100 * s.prog) / (VICTORY.shrine.captureS * TICK_HZ))) : 0 }));
      }
      return v;
    },

    hashVictory(h) {
      if (!this.rules.wonder && !this.rules.shrines) return h;
      for (const b of this.buildings.values()) if (b.wt !== undefined) { h = hashStep(h, b.id); h = hashStep(h, b.wt); }
      for (const sh of this.shrines) { h = hashStep(h, sh.own); h = hashStep(h, sh.cand); h = hashStep(h, sh.prog); }
      for (let tm = 1; tm <= 4; tm++) h = hashStep(h, this.vp[tm]);
      return h;
    },
  };
  Object.assign(Game.prototype, methods);
}

export const wonderBuildings = () => Object.keys(BUILDINGS).filter((k) => BUILDINGS[k].wonder);
