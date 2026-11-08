// Per-tick behaviour: orders, movement, gathering, building, production, combat, projectiles.
import { GATHER, RULES, ARMOUR_STEP_PCT } from './data.mjs';
import { INF, TICK_HZ } from './util.mjs';

const REACH2 = 1500 * 1500; // distance from a node/building edge at which a worker can work
const BUILD_ADD = [1000, 600, 450, 350, 300];
const KEY_ENT = 1000000;
// Round half away from zero: rnd(-v) === -rnd(v), so a point-mirrored move rounds to the mirrored step.
const rnd = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));
const SEP_R = 650; // milli-tiles
const SEP_STEP = 28; // max milli-tiles per tick (2.8 tiles/s)
const SEP_DIR = Array.from({ length: 16 }, (_, k) => [Math.round(1000 * Math.cos((k * Math.PI) / 8)), Math.round(1000 * Math.sin((k * Math.PI) / 8))]);
for (let k = 0; k < 8; k++) { SEP_DIR[k + 8] = [-SEP_DIR[k][0], -SEP_DIR[k][1]]; } // exact opposites (mirror seat)
const WALL_TYPES = new Set(['wall', 'gate']);

function costValue(c) {
  let v = 0;
  for (const k in c) v += c[k];
  return v;
}

export function installLogic(Game) {
  const methods = {
    // ---------------- helpers ----------------
    distSq(x, y, e) {
      if (e.kind === 1) {
        const dx = e.px - x, dy = e.py - y; // positions of others are the ones from the start of the tick
        return dx * dx + dy * dy;
      }
      const x0 = e.tx * 1000, y0 = e.ty * 1000, x1 = x0 + e.size * 1000, y1 = y0 + e.size * 1000;
      const dx = Math.max(x0 - x, 0, x - x1), dy = Math.max(y0 - y, 0, y - y1);
      return dx * dx + dy * dy;
    },

    setOrder(u, ord) {
      this.releaseNode(u);
      u.ord = ord;
      u.wp = null;
      u.tgt = 0;
    },

    releaseNode(u) {
      const o = u.ord;
      if (o.t === 'gather' && o.slot) {
        if (o.slot.k === 'e') {
          const e = this.get(o.slot.id);
          if (e && e.gat > 0) e.gat--;
        } else if (this.treeGat[o.slot.idx] > 0) this.treeGat[o.slot.idx]--;
        o.slot = null;
      }
    },

    // ---------------- movement ----------------
    moveStep(u, tx, ty, speed) {
      const dx = tx - u.x, dy = ty - u.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= speed * speed) {
        u.x = tx;
        u.y = ty;
        return true;
      }
      const len = Math.sqrt(d2);
      u.x += rnd((dx * speed) / len);
      u.y += rnd((dy * speed) / len);
      return false;
    },

    // Straight steering with axis sliding. Returns false if completely blocked.
    stepDirect(u, tx, ty, cap) {
      let sp = this.pl(u.owner).stats[u.type].speed;
      if (this.storms.length) sp = this.stormSpeed(u, sp);
      if (this.wxSlow) sp = this.worldSpeed(u, sp);
      if (cap && cap < sp) sp = cap;
      const dx = tx - u.x, dy = ty - u.y;
      const d2 = dx * dx + dy * dy;
      if (d2 === 0) return true;
      let nx, ny;
      if (d2 <= sp * sp) {
        nx = tx;
        ny = ty;
      } else {
        const len = Math.sqrt(d2);
        nx = u.x + rnd((dx * sp) / len);
        ny = u.y + rnd((dy * sp) / len);
      }
      const P = this.paths, W = this.W;
      const o = u.owner, tnx = this.tileMilli(o, nx), tny = this.tileMilli(o, ny);
      if (P.canPass(o, tny * W + tnx)) {
        u.x = nx;
        u.y = ny;
        return true;
      }
      if (P.canPass(o, this.tileMilli(o, u.y) * W + tnx) && nx !== u.x) {
        u.x = nx;
        return true;
      }
      if (P.canPass(o, tny * W + this.tileMilli(o, u.x)) && ny !== u.y) {
        u.y = ny;
        return true;
      }
      return false;
    },

    // Follow the cached flow field of goal `key`. Returns 'ok' or 'stuck'.
    moveToGoal(u, key, seedsFn, cap) {
      const P = this.paths, W = this.W;
      const ui = this.tileMilli(u.owner, u.y) * W + this.tileMilli(u.owner, u.x);
      const f = P.get(u.owner, key, ui, seedsFn);
      if (f.dist[ui] >= INF) {
        if (!P.canPass(u.owner, ui)) {
          this.unstick(u);
          return 'ok';
        }
        return 'stuck';
      }
      if (u.wp && !P.canPass(u.owner, this.tileMilli(u.owner, u.wp[1]) * W + this.tileMilli(u.owner, u.wp[0]))) {
        u.wp = null;
        P.invalidate(u.owner, key);
      }
      if (!u.wp) {
        u.wp = P.waypoint(u.owner, f, u.x, u.y);
        if (!u.wp) return 'stuck';
      }
      let sp = this.pl(u.owner).stats[u.type].speed;
      if (this.storms.length) sp = this.stormSpeed(u, sp);
      if (this.wxSlow) sp = this.worldSpeed(u, sp);
      if (cap && cap < sp) sp = cap;
      if (this.moveStep(u, u.wp[0], u.wp[1], sp)) u.wp = null;
      return 'ok';
    },

    // A unit standing on a blocked tile (building placed over it, ...) is moved to the nearest free tile.
    // Inside one ring the tile closest to the unit wins; exact ties go by tieKey (not by scan order).
    unstick(u) {
      const W = this.W, H = this.H;
      const tx = this.tileMilli(u.owner, u.x), ty = this.tileMilli(u.owner, u.y);
      for (let r = 1; r <= 8; r++) {
        let best = null, bd = Infinity;
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = tx + dx, y = ty + dy;
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            if (!this.paths.canPass(u.owner, y * W + x)) continue;
            const d = (x * 1000 + 500 - u.x) ** 2 + (y * 1000 + 500 - u.y) ** 2;
            if (d < bd || (d === bd && this.tieKey(u.owner, x, y) < this.tieKey(u.owner, best[0], best[1]))) {
              bd = d;
              best = [x, y];
            }
          }
        if (best) {
          u.x = best[0] * 1000 + 500;
          u.y = best[1] * 1000 + 500;
          u.wp = null;
          return;
        }
      }
    },

    tileSeeds(idx) {
      return () => [idx];
    },
    entSeeds(e) {
      return () => this.footprintTiles(e.tx, e.ty, e.size);
    },

    // Move toward a world point (milli). Returns 'arrived' | 'ok' | 'stuck'.
    goPoint(u, x, y, r) {
      const dx = x - u.x, dy = y - u.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r) return 'arrived';
      const cap = u.ord.cap || 0; // group march speed: a group walks at the pace of its slowest unit
      if (d2 < 2200 * 2200 && this.paths.losClear(u.owner, u.x, u.y, x, y)) {
        return this.stepDirect(u, x, y, cap) ? 'ok' : 'stuck';
      }
      const idx = this.tileOf(x, y);
      return this.moveToGoal(u, idx, this.tileSeeds(idx), cap);
    },

    // ---------------- dispatch ----------------
    updateUnit(u) {
      if (u.dead || u.boarded) return;
      if (u.cd > 0) u.cd--;
      if (u.ship) { this.updateShip(u); return; }
      if (u.fuse > 0) { this.tickFuse(u); return; } // a sapper with a lit charge stands still
      const st = this.pl(u.owner).stats[u.type];
      if (st.setup) { // mortar: the set-up time restarts whenever the unit has moved since the last tick
        if (u.x !== u.sx || u.y !== u.sy) { u.dep = 0; u.sx = u.x; u.sy = u.y; } else if (u.dep < st.setup) u.dep++;
      }
      const o = u.ord;
      switch (o.t) {
        case 'idle': if (this.rules.separation) this.separate(u); this.idleLogic(u); break;
        case 'move': this.doMove(u, o); break;
        case 'amove': this.doAttackMove(u, o); break;
        case 'attack': this.doAttackOrder(u, o); break;
        case 'gather': this.doGather(u, o); break;
        case 'build': this.doBuild(u, o); break;
        case 'board': this.doBoard(u, o); break;
      }
    },

    doMove(u, o) {
      const r = o.fm ? this.formGo(u, o) : this.goPoint(u, o.x, o.y, o.r);
      if (r !== 'ok') this.setOrder(u, { t: 'idle' });
    },

    // Soft separation of idle units: units standing closer than SEP_R push each other apart, slowly and smoothly
    // (damped, capped step), so a stack settles instead of twitching. Deterministic and point-mirror equivariant:
    // only positions from the start of the tick are read, rounding is odd-symmetric, and exactly coincident units
    // pick their direction from a 16-way table indexed by the per-owner creation counter (rotated by 8 for the
    // mirrored seat). Only used when rules.separation is set (the classic rules keep the old behaviour).
    separate(u) {
      let fx = 0, fy = 0;
      const R = SEP_R;
      this.unitsNear(u.px, u.py, R, (e) => {
        if (e === u) return;
        const dx = u.px - e.px, dy = u.py - e.py, d2 = dx * dx + dy * dy;
        if (d2 >= R * R) return;
        if (d2 === 0) {
          const k = (u.ph * 5 + 3 + (this.sgn[u.owner] < 0 ? 8 : 0)) & 15;
          fx += SEP_DIR[k][0] * R / 1000;
          fy += SEP_DIR[k][1] * R / 1000;
          return;
        }
        const d = Math.sqrt(d2), m = R - d;
        fx += (dx / d) * m;
        fy += (dy / d) * m;
      });
      const len = Math.sqrt(fx * fx + fy * fy);
      if (len < 24) return;
      const step = Math.min(len * 0.2, SEP_STEP);
      const nx = u.x + rnd((fx / len) * step), ny = u.y + rnd((fy / len) * step);
      const P = this.paths, W = this.W, o = u.owner, lim = W * 1000, EDGE = 600; // stay clear of the map border (symmetric under the point mirror)
      if (nx < EDGE || ny < EDGE || nx > lim - EDGE || ny > lim - EDGE) return;
      if (P.canPass(o, this.tileMilli(o, ny) * W + this.tileMilli(o, nx))) { u.x = nx; u.y = ny; }
      else if (P.canPass(o, this.tileMilli(o, u.y) * W + this.tileMilli(o, nx))) u.x = nx;
      else if (P.canPass(o, this.tileMilli(o, ny) * W + this.tileMilli(o, u.x))) u.y = ny;
    },

    // ---------------- combat ----------------
    acquire(u, r, unitsOnly = false, walls = false) {
      const st = this.pl(u.owner).stats[u.type];
      const myTeam = this.team[u.owner];
      let best = null, bs = Infinity;
      if (st.only !== 'buildings') {
        this.unitsNear(u.x, u.y, r, (e) => {
          if (this.team[e.owner] === myTeam) return;
          const dx = e.px - u.x, dy = e.py - u.y;
          let s = dx * dx + dy * dy;
          const c = this.pl(e.owner).stats[e.type].cls;
          if (e.owner === 0 && c === 'trader') return; // caravans are only attacked on an explicit order (escort or raid is the player's choice)
          if (c === 'naval' && st.range < 3000) return; // melee cannot reach a ship
          if (c === 'worker') s += 9000000;
          if (s < bs || (s === bs && this.tieKey(u.owner, e.px, e.py) < this.tieKey(u.owner, best.px, best.py))) {
            bs = s;
            best = e;
          }
        });
        if (best || unitsOnly) return best;
      }
      if (unitsOnly) return null;
      const r2 = r * r;
      for (const b of this.buildings.values()) {
        if (b.dead || this.team[b.owner] === myTeam) continue;
        if (!walls && WALL_TYPES.has(b.type)) continue;
        if (st.charge && b.maxhp < 300) continue; // a sapper does not waste its charge on farms and huts
        const d2 = this.distSq(u.x, u.y, b);
        if (d2 <= r2 && (d2 < bs || (d2 === bs && this.tieKey(u.owner, 2 * b.tx + b.size, 2 * b.ty + b.size) < this.tieKey(u.owner, 2 * best.tx + best.size, 2 * best.ty + best.size)))) {
          bs = d2;
          best = b;
        }
      }
      return best;
    },

    idleLogic(u) {
      const hst = this.pl(u.owner).stats[u.type];
      if (hst.heal) { this.healerIdle(u, hst); return; }
      if (u.type === 'worker') {
        // server helper: idle workers finish unfinished buildings of their own side close by
        if ((this.t + u.ph) % 10 !== 0 || this.t - (u.stuck ?? -9999) < 300) return;
        let best = null, bd = 9000 * 9000;
        for (const b of this.buildings.values()) {
          if (b.built || b.dead || this.team[b.owner] !== this.team[u.owner]) continue;
          const d2 = this.distSq(u.x, u.y, b);
          if (d2 < bd || (d2 === bd && best && this.tieKey(u.owner, 2 * b.tx + b.size, 2 * b.ty + b.size) < this.tieKey(u.owner, 2 * best.tx + best.size, 2 * best.ty + best.size))) {
            bd = d2;
            best = b;
          }
        }
        if (best) this.setOrder(u, { t: 'build', id: best.id, next: [], last: 0 });
        return;
      }
      if ((this.t + u.ph) % 4 !== 0) return;
      const st = this.pl(u.owner).stats[u.type];
      let tgt = null;
      if (u.hitBy && this.t - u.hitT < 30) {
        const a = this.get(u.hitBy);
        if (a && !a.dead && this.team[a.owner] !== this.team[u.owner] && a.kind === 1 && st.only !== 'buildings') {
          const dx = a.px - u.x, dy = a.py - u.y;
          if (dx * dx + dy * dy < 12000 * 12000) tgt = a;
        }
      }
      if (!tgt) tgt = this.acquire(u, Math.max(st.range + RULES.idleAcquireBonus * 1000, 5000));
      if (tgt) this.setOrder(u, { t: 'attack', id: tgt.id, auto: true, hx: u.x, hy: u.y });
    },

    // chase/attack. returns 'ok' or 'lost'
    engage(u, e) {
      const st = this.pl(u.owner).stats[u.type];
      const d2 = this.distSq(u.x, u.y, e);
      const rg = e.kind === 1 ? st.range : st.range + 500; // buildings are big targets
      if (d2 <= rg * rg) {
        u.wp = null;
        if (st.minRange && d2 < st.minRange * st.minRange) return 'ok'; // too close for the mortar: it cannot fire (cavalry and sorties are the answer)
        if (u.cd <= 0 && (!st.setup || u.dep >= st.setup)) this.fire(u, st, e);
        return 'ok';
      }
      let r;
      if (e.kind === 1) {
        if (d2 < 7000 * 7000 && this.paths.losClear(u.owner, u.x, u.y, e.px, e.py)) r = this.stepDirect(u, e.px, e.py) ? 'ok' : 'stuck';
        else {
          const idx = this.tileOf(e.px, e.py);
          r = this.moveToGoal(u, idx, this.tileSeeds(idx));
        }
      } else r = this.moveToGoal(u, KEY_ENT + e.id, this.entSeeds(e));
      return r === 'ok' ? 'ok' : 'lost';
    },

    doAttackOrder(u, o) {
      const e = this.get(o.id);
      const bad = !e || e.dead || this.team[e.owner] === this.team[u.owner];
      let stop = bad;
      if (!stop && o.auto) {
        const dx = u.x - o.hx, dy = u.y - o.hy;
        if (dx * dx + dy * dy > (RULES.leash * 1000) ** 2) stop = true;
      }
      if (!stop && this.engage(u, e) === 'lost') stop = true;
      if (stop) {
        if (o.auto) {
          const dx = u.x - o.hx, dy = u.y - o.hy;
          if (dx * dx + dy * dy > 3000 * 3000) {
            this.setOrder(u, { t: 'move', x: o.hx, y: o.hy, r: 600 });
            return;
          }
        }
        this.setOrder(u, { t: 'idle' });
      }
    },

    doAttackMove(u, o) {
      const st = this.pl(u.owner).stats[u.type];
      if (st.heal && this.healerFollow(u, st)) {
        if (o.fm) this.leaveForm(u);
        return;
      }
      if (u.type !== 'worker' && !st.noAtk) {
        let e = u.tgt ? this.get(u.tgt) : null;
        if (e && (e.dead || this.team[e.owner] === this.team[u.owner])) e = null;
        if (!e) u.tgt = 0;
        if (e && (this.t + u.ph) % 6 === 0 && (e.kind === 2 || this.pl(e.owner).stats[e.type].cls === 'worker') && st.only !== 'buildings') {
          const n = this.acquire(u, Math.min(st.sight * 1000, 6000), true);
          if (n) {
            e = n;
            u.tgt = n.id;
          }
        }
        if (!e && (this.t + u.ph) % 3 === 0) {
          e = this.acquire(u, st.sight * 1000, false, !!o.blocked);
          if (e) u.tgt = e.id;
        }
        if (e) {
          if (o.fm) this.leaveForm(u); // a fight breaks the formation
          const lim = (st.sight + 5) * 1000;
          if (e.kind === 1 && (e.px - u.x) ** 2 + (e.py - u.y) ** 2 > lim * lim) u.tgt = 0;
          else if (this.engage(u, e) === 'lost') u.tgt = 0;
          return;
        }
      }
      const r = o.fm ? this.formGo(u, o) : this.goPoint(u, o.x, o.y, o.r);
      if (r === 'arrived') this.setOrder(u, { t: 'idle' });
      else if (r === 'stuck') {
        if (u.type === 'worker' || o.blocked) this.setOrder(u, { t: 'idle' });
        else o.blocked = true;
      }
    },

    fire(shooter, st, e) {
      if (st.charge) { // sapper: plant the charge. The blast comes when the fuse has burnt down (tickFuse).
        shooter.fuse = st.charge.fuse;
        shooter.cd = st.charge.fuse;
        shooter.ftid = e.id;
        shooter.fx = e.kind === 1 ? e.px : (e.tx + e.size / 2) * 1000;
        shooter.fy = e.kind === 1 ? e.py : (e.ty + e.size / 2) * 1000;
        shooter.wp = null;
        return;
      }
      shooter.cd = st.cd;
      if (st.proj) {
        let tx, ty;
        if (e.kind === 1) { tx = e.px; ty = e.py; }
        else { tx = (e.tx + e.size / 2) * 1000; ty = (e.ty + e.size / 2) * 1000; }
        const sx = shooter.kind === 1 ? shooter.x : (shooter.tx + shooter.size / 2) * 1000;
        const sy = shooter.kind === 1 ? shooter.y : (shooter.ty + shooter.size / 2) * 1000;
        this.proj.push({
          x: sx, y: sy, tx, ty, tid: e.id, owner: shooter.owner, atk: st.atk, dmg: st.dmg, bonus: st.bonus,
          splash: st.splash || 0, speed: st.proj, src: shooter.kind === 1 ? shooter.type : null, sid: shooter.id, life: 120,
          lob: !!st.lob, sb: st.splashBuilding || 0,
        });
      } else this.applyDamage(shooter.owner, shooter.id, shooter.kind === 1 ? shooter.type : null, st.atk, st.dmg, st.bonus, e);
    },

    applyDamage(owner, sid, src, atk, dmgType, bonus, tgt) {
      if (tgt.dead) return; // a unit that is already dying still absorbs hits: all hits of one tick count alike
      const tp = this.pl(tgt.owner);
      let cls, arm;
      if (tgt.kind === 1) {
        const ts = tp.stats[tgt.type];
        cls = ts.cls;
        arm = ts.armour[dmgType];
      } else {
        cls = 'building';
        arm = tp.bstats[tgt.type].armour[dmgType];
      }
      const bon = bonus && bonus[cls] ? bonus[cls] : 100;
      const ar = ARM(arm);
      const dmg = Math.max(1, Math.floor((atk * bon * ar) / 100000));
      const real = Math.max(0, Math.min(dmg, tgt.hp));
      tgt.hp -= dmg;
      // mirror safety: several hits can land on one target in the same tick and the global projectile
      // order interleaves the seats, so "last hitter wins" would pick different shooters from the two
      // seats. Keep the hitter with the smallest mirror-safe key instead (order independent).
      if (tgt.hitT === this.t && tgt.hitBy) {
        const prev = this.get(tgt.hitBy), cur = this.get(sid);
        // key: mirror-safe position key first, then the per-owner creation count (mirrored pairs share ph),
        // so even two shooters at the exact same position resolve the same way from both seats.
        const key = (e) => (e && e.kind === 1) ? this.tieKey(tgt.owner, e.px, e.py)
          : e ? this.tieKey(tgt.owner, (e.tx + e.size / 2) * 1000, (e.ty + e.size / 2) * 1000) : Infinity;
        if (!cur || key(cur) < key(prev) || (key(cur) === key(prev) && (cur.ph || 0) < (prev.ph || 0))) tgt.hitBy = sid;
      } else { tgt.hitBy = sid; tgt.hitT = this.t; }
      if (src) {
        const us = this.unitStat(owner, src);
        us.dmg += real;
      }
      if (tgt.kind === 2 && (this.t - (tp.lastAttackEv || -999)) > 50) {
        tp.lastAttackEv = this.t;
        this.event(tp, { type: 'attacked', x: this.centreTile(tgt.owner, tgt.tx, tgt.size), y: this.centreTile(tgt.owner, tgt.ty, tgt.size), what: tgt.type });
      } else if (tgt.kind === 1 && (this.t - (tp.lastAttackEv || -999)) > 50) {
        tp.lastAttackEv = this.t;
        this.event(tp, { type: 'attacked', x: this.tileMilli(tgt.owner, tgt.x), y: this.tileMilli(tgt.owner, tgt.y), what: tgt.type });
      }
      if (tgt.hp <= 0) this.kill(tgt, owner, src);
    },

    unitStat(owner, type) {
      const m = this.pl(owner).unitStats;
      return m[type] || (m[type] = { dmg: 0, kills: 0, killValue: 0, lost: 0, lostValue: 0 });
    },

    // Deaths are applied at the end of the tick (cleanup) so that unit update order gives no advantage.
    kill(e, killerOwner, src) {
      if (e.dead || e.dying) return;
      e.dying = true;
      this.dead.push(e);
      if (e.kind === 3) return;
      if (e.kind === 2) e.kby = killerOwner; // who destroyed it (wonder announcement)
      const vp = this.pl(e.owner);
      const cost = e.kind === 1 ? vp.faction.units[e.type].cost : vp.faction.buildings[e.type].cost;
      const v = costValue(cost);
      vp.lostValue += v;
      if (e.kind === 1) {
        vp.losses++;
        const us = this.unitStat(e.owner, e.type);
        us.lost++;
        us.lostValue += v;
      }
      if (killerOwner && this.team[killerOwner] !== this.team[e.owner]) {
        const kp = this.pl(killerOwner);
        kp.killFeed.push({ t: this.t, killer: killerOwner, killerType: src, victim: e.owner, victimType: e.type, kind: e.kind === 1 ? 'unit' : 'building' });
        if (kp.killFeed.length > 40) kp.killFeed.shift();
        kp.killValue += v;
        kp.kills++;
        if (src) {
          const us = this.unitStat(killerOwner, src);
          us.kills++;
          us.killValue += v;
        }
      }
    },

    updateProjectiles() {
      const arr = this.proj;
      for (let i = arr.length - 1; i >= 0; i--) {
        const pr = arr[i];
        const t = this.get(pr.tid);
        if (t && !t.dead) {
          if (t.kind === 1 && !pr.lob) { pr.tx = t.x; pr.ty = t.y; } // a lobbed shell keeps its landing point
        }
        pr.life--;
        const dx = pr.tx - pr.x, dy = pr.ty - pr.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= pr.speed * pr.speed || pr.life <= 0) {
          if (pr.splash) {
            const myTeam = this.team[pr.owner];
            const hits = [];
            this.unitsNear(pr.tx, pr.ty, pr.splash, (e) => {
              if (this.team[e.owner] !== myTeam) hits.push(e);
            });
            for (const e of hits) this.applyDamage(pr.owner, pr.sid, pr.src, pr.atk, pr.dmg, pr.bonus, e);
            if (t && !t.dead && t.kind === 2) this.applyDamage(pr.owner, pr.sid, pr.src, pr.atk, pr.dmg, pr.bonus, t);
            if (pr.sb) this.splashBuildings(pr.owner, pr.sid, pr.src, pr.tx, pr.ty, pr.splash, Math.floor((pr.atk * pr.sb) / 100), pr.dmg, pr.bonus, t);
          } else if (t && !t.dead && pr.life > 0) this.applyDamage(pr.owner, pr.sid, pr.src, pr.atk, pr.dmg, pr.bonus, t);
          arr[i] = arr[arr.length - 1];
          arr.pop();
        } else {
          const len = Math.sqrt(d2);
          pr.x += rnd((dx * pr.speed) / len);
          pr.y += rnd((dy * pr.speed) / len);
        }
      }
    },

    // Area damage on the buildings around a point (mortar shell, sapper blast). `skip` = the building that took the full hit already.
    splashBuildings(owner, sid, src, x, y, r, atk, dmg, bonus, skip) {
      const myTeam = this.team[owner], rr = r * r;
      for (const b of this.buildings.values()) {
        if (b.dead || b === skip || this.team[b.owner] === myTeam) continue;
        if (this.distSq(x, y, b) <= rr) this.applyDamage(owner, sid, src, atk, dmg, bonus, b);
      }
    },

    // Sapper: the fuse burns down, then the charge blows. Dying before that defuses it (the unit is gone, nothing happens).
    tickFuse(u) {
      u.cd = --u.fuse;
      if (u.fuse > 0) return;
      const st = this.pl(u.owner).stats[u.type], c = st.charge;
      const t = this.buildings.get(u.ftid);
      const hit = t && !t.dead ? t : null;
      if (hit) this.applyDamage(u.owner, u.id, u.type, c.atk, st.dmg, st.bonus, hit);
      this.splashBuildings(u.owner, u.id, u.type, u.fx, u.fy, c.splash, Math.floor((c.atk * c.sb) / 100), st.dmg, st.bonus, hit);
      const myTeam = this.team[u.owner], victims = [];
      this.unitsNear(u.fx, u.fy, c.splash, (e) => { if (this.team[e.owner] !== myTeam && e !== u) victims.push(e); });
      for (const e of victims) this.applyDamage(u.owner, u.id, u.type, Math.floor((c.atk * c.su) / 100), st.dmg, null, e);
      this.kill(u, 0, null); // the sapper dies with its charge (no kill credit to anybody)
    },

    // Healers: every tick each healer picks the most wounded unit of its team in reach (siege and healers excluded), lowest hp share
    // first. All picks are made on the hp of the start of the pass and applied together, so the order of the healers does not matter.
    healPass() {
      let list = null;
      for (const u of this.units.values()) {
        if (u.dead || u.dying) continue;
        const st = this.pl(u.owner).stats[u.type];
        if (!st.heal) continue;
        (list ||= []).push([u, st]);
      }
      if (!list) return;
      const gives = [];
      for (const [h, st] of list) {
        let best = null, bs = Infinity;
        const team = this.team[h.owner];
        this.unitsNear(h.px, h.py, st.heal.range, (e) => {
          if (e === h || e.dying || e.hp <= 0 || e.hp >= e.maxhp || this.team[e.owner] !== team) return;
          const es = this.pl(e.owner).stats[e.type];
          if (es.cls === 'siege' || es.heal) return;
          const s = Math.floor((e.hp * 100000) / e.maxhp);
          if (s < bs || (s === bs && this.tieKey(h.owner, e.px, e.py) < this.tieKey(h.owner, best.px, best.py))) { bs = s; best = e; }
        });
        if (!best) { h.hacc = 0; continue; }
        h.hacc += Math.round(st.heal.hp * 100); // milli hit points per tick
        const n = Math.floor(h.hacc / 1000);
        if (n > 0) { h.hacc -= n * 1000; gives.push([best, n]); }
      }
      for (const [e, n] of gives) e.hp = Math.min(e.maxhp, e.hp + n);
    },

    // A healer on attack-move holds back while the units around it are fighting: it stays within reach of the nearest fighting
    // friend instead of marching on alone. Returns true when it handled this tick.
    healerFollow(u, st) {
      if ((this.t + u.ph) % 4 === 0) {
        const team = this.team[u.owner];
        let best = null, bd = Infinity;
        this.unitsNear(u.px, u.py, st.sight * 1000, (e) => {
          if (e === u || this.team[e.owner] !== team) return;
          const es = this.pl(e.owner).stats[e.type];
          if (es.noAtk || es.cls === 'worker' || es.cls === 'siege' || !(e.tgt || e.ord.t === 'attack')) return;
          const d = (e.px - u.px) ** 2 + (e.py - u.py) ** 2;
          if (d < bd || (d === bd && this.tieKey(u.owner, e.px, e.py) < this.tieKey(u.owner, best.px, best.py))) { bd = d; best = e; }
        });
        u.fol = best ? best.id : 0;
      }
      const f = u.fol ? this.units.get(u.fol) : null;
      if (!f || f.dead) { u.fol = 0; return false; }
      const near = st.heal.range * 0.6;
      if ((f.x - u.x) ** 2 + (f.y - u.y) ** 2 > near * near) this.stepDirect(u, f.x, f.y, 0);
      return true;
    },

    // Idle healer: walks to the nearest wounded unit of its team within sight and stays close; otherwise it holds the spot.
    healerIdle(u, st) {
      if ((this.t + u.ph) % 5 !== 0) return;
      const team = this.team[u.owner], r = st.sight * 1000;
      let best = null, bd = Infinity;
      this.unitsNear(u.px, u.py, r, (e) => {
        if (e === u || e.hp >= e.maxhp || this.team[e.owner] !== team) return;
        const es = this.pl(e.owner).stats[e.type];
        if (es.cls === 'siege' || es.heal) return;
        const d = (e.px - u.px) ** 2 + (e.py - u.py) ** 2;
        if (d < bd || (d === bd && this.tieKey(u.owner, e.px, e.py) < this.tieKey(u.owner, best.px, best.py))) { bd = d; best = e; }
      });
      if (best && bd > (st.heal.range * 0.6) ** 2) this.setOrder(u, { t: 'move', x: best.px, y: best.py, r: Math.round(st.heal.range * 0.5) });
    },

    // ---------------- buildings ----------------
    updateBuilding(b) {
      if (b.dead || !b.built) return;
      const p = this.pl(b.owner);
      const bs = p.bstats[b.type];
      if (b.cd > 0) b.cd--;
      if (bs.atk && b.cd === 0 && (this.t + b.ph) % 3 === 0) {
        let best = null, bd = Infinity;
        const cx = (b.tx + b.size / 2) * 1000, cy = (b.ty + b.size / 2) * 1000;
        const myTeam = this.team[b.owner];
        this.unitsNear(cx, cy, bs.range + b.size * 500, (e) => {
          if (this.team[e.owner] === myTeam || e.owner === 0 && e.type === 'caravan') return; // towers leave the traders alone
          const dx = e.px - cx, dy = e.py - cy;
          const d = dx * dx + dy * dy;
          if (d < bd || (d === bd && this.tieKey(b.owner, e.px, e.py) < this.tieKey(b.owner, best.px, best.py))) {
            bd = d;
            best = e;
          }
        });
        if (best) this.fire(b, bs, best);
      }
      if (b.research) {
        const r = b.research;
        if (--r.t <= 0) {
          b.research = null;
          if (r.kind === 'tech') {
            p.techs.add(r.tech);
            p.queuedTechs.delete(r.tech);
            this.computeStats(p);
            this.applyTechToEntities(p);
            this.event(p, { type: 'tech_done', tech: r.tech });
          } else {
            p.tier = r.tier;
            p.advancing = 0;
            this.event(p, { type: 'tier', tier: r.tier });
          }
        }
      }
      if (!b.queue.length) return;
      const q = b.queue[0];
      if (--q.t > 0) return;
      const pos = b.type === 'harbor' ? this.shipSpawn(b, (b.spawnK = (b.spawnK || 0) + 1)) : this.spawnPoint(b, (b.spawnK = (b.spawnK || 0) + 1));
      if (!pos) { q.t = 1; return; } // no free water at the harbor: try again next tick
      const u = this.addUnit(b.owner, q.type, pos[0], pos[1]);
      b.queue.shift();
      this.spawned(b, u);
    },

    spawned(b, u) {
      const p = this.pl(b.owner);
      this.event(p, { type: 'trained', unit: u.type, id: u.id });
      const r = b.rally;
      if (r) {
        if (u.type === 'worker' && r.res) this.assignGather(u, r.res, [r.x, r.y]);
        else this.setOrder(u, { t: 'move', x: r.x, y: r.y, r: 700 + 250 * (u.ph % 5) });
      } else if (u.type === 'worker' && this.opts.autoWorkers) this.autoGather(u);
    },

    // ---------------- construction ----------------
    doBuild(u, o) {
      const b = this.get(o.id);
      if (!b || b.dead || b.built) {
        this.afterBuild(u, o, b && !b.dead ? b : null);
        return;
      }
      if (this.distSq(u.x, u.y, b) <= REACH2) {
        u.wp = null;
        if (b.bt !== this.t) {
          b.bt = this.t;
          b.bn = 0;
        }
        const add = BUILD_ADD[Math.min(b.bn, 4)];
        b.bn++;
        const p = this.pl(b.owner);
        const total = p.faction.buildings[b.type].time * TICK_HZ * 1000;
        b.prog += add;
        const gain = Math.floor((b.maxhp * 0.9 * add) / total);
        b.hp = Math.min(b.maxhp, b.hp + Math.max(gain, 0));
        if (b.prog >= total) {
          b.built = true;
          b.hp = Math.min(b.maxhp, Math.max(b.hp, Math.floor(b.maxhp * 0.9)));
          this.recalcPop(p);
          this.onBuilt(b);
          this.event(p, { type: 'built', b: b.type, id: b.id, x: b.tx, y: b.ty });
        }
      } else if (this.moveToGoal(u, KEY_ENT + b.id, this.entSeeds(b)) === 'stuck') {
        u.stuck = this.t;
        this.setOrder(u, { t: 'idle' });
      }
    },

    afterBuild(u, o, b) {
      const done = b && b.built ? b : o.last ? this.get(o.last) : null;
      if (o.next && o.next.length) {
        while (o.next.length) {
          const nb = this.get(o.next.shift());
          if (nb && !nb.dead && !nb.built) {
            this.setOrder(u, { t: 'build', id: nb.id, next: o.next, last: done ? done.id : 0 });
            return;
          }
        }
      }
      const p = this.pl(u.owner);
      if (done && !done.dead && done.built) {
        const d = p.faction.buildings[done.type];
        if (d.node === 'farm') {
          this.assignNode(u, 'food', { k: 'e', id: done.id });
          return;
        }
        if (d.drop && d.drop.length) {
          const res = d.drop.includes(u.lastRes) ? u.lastRes : d.drop[0];
          if (this.assignGather(u, res, [(done.tx + done.size / 2) * 1000, (done.ty + done.size / 2) * 1000])) return;
        }
      }
      if (u.lastRes) {
        const hint = done ? [(done.tx + done.size / 2) * 1000, (done.ty + done.size / 2) * 1000] : null;
        if (this.assignGather(u, u.lastRes, hint)) return;
      }
      this.setOrder(u, { t: 'idle' });
    },

    // ---------------- gathering ----------------
    dropDist(p, res, x, y) {
      let best = 40000 * 40000;
      for (const b of this.buildings.values()) {
        if (b.owner !== p.id && this.team[b.owner] !== p.team) continue;
        if (!b.built || b.dead) continue;
        const d = p.faction.buildings[b.type].drop;
        if (!d || !d.includes(res)) continue;
        const d2 = this.distSq(x, y, b);
        if (d2 < best) best = d2;
      }
      return Math.sqrt(best) / 1000;
    },

    findNode(p, res, x, y, hint) {
      const cx = hint ? hint[0] : x, cy = hint ? hint[1] : y;
      let best = null, bs = Infinity;
      const W = this.W;
      if (res === 'wood') {
        const tx0 = this.tileMilli(p.id, cx), ty0 = this.tileMilli(p.id, cy);
        let found = -1;
        for (let r = 0; r <= 30; r++) {
          if (found >= 0 && r > found + 3) break;
          for (let dy = -r; dy <= r; dy++) {
            const yy = ty0 + dy;
            if (yy < 0 || yy >= this.H) continue;
            const edge = Math.abs(dy) === r;
            for (let dx = -r; dx <= r; dx += edge ? 1 : 2 * r || 1) {
              const xx = tx0 + dx;
              if (xx < 0 || xx >= W) continue;
              const i = yy * W + xx;
              if (this.terrain[i] !== 1 || this.wood[i] <= 0 || !p.expl[i] || !this.rectReachable(p.comp, xx, yy, 1)) continue;
              const P = this.paths;
              if (!((xx > 0 && P.canPass(p.id, i - 1)) || (xx < W - 1 && P.canPass(p.id, i + 1)) || (yy > 0 && P.canPass(p.id, i - W)) || (yy < this.H - 1 && P.canPass(p.id, i + W)))) continue;
              const d = Math.sqrt(dx * dx + dy * dy);
              const s = d + 0.8 * this.dropDist(p, res, xx * 1000 + 500, yy * 1000 + 500) + 3 * this.treeGat[i] + 0.001 * Math.sqrt((xx + 0.5 - W / 2) ** 2 + (yy + 0.5 - W / 2) ** 2);
              if (s < bs || (s === bs && this.tieKey(p.id, xx, yy) < this.tieKey(p.id, best.idx % W, (best.idx / W) | 0))) {
                bs = s;
                best = { k: 't', idx: i };
                if (found < 0) found = r;
              }
              if (found < 0) found = r;
            }
          }
        }
        return best;
      }
      const consider = (e, kind, slots) => {
        // explored = any footprint tile seen (the top-left tile alone is not mirror safe for even sizes)
        let seen = false;
        for (let j = 0; j < e.size && !seen; j++) for (let i = 0; i < e.size; i++) if (p.expl[(e.ty + j) * W + e.tx + i]) { seen = true; break; }
        if (!seen || !this.rectReachable(p.comp, e.tx, e.ty, e.size)) return;
        const ex = (e.tx + e.size / 2) * 1000, ey = (e.ty + e.size / 2) * 1000;
        const d = Math.sqrt((ex - cx) ** 2 + (ey - cy) ** 2) / 1000;
        let s = d + 0.8 * this.dropDist(p, res, ex, ey) + 4 * e.gat + 0.001 * Math.sqrt((e.tx + e.size / 2 - W / 2) ** 2 + (e.ty + e.size / 2 - W / 2) ** 2);
        if (e.gat >= slots) s += kind === 'farm' ? 200 : 40;
        if (s < bs || (s === bs && this.tieKey(p.id, ex, ey) < this.tieKey(p.id, best.cx, best.cy))) {
          bs = s;
          best = { k: 'e', id: e.id, cx: ex, cy: ey };
        }
      };
      for (const n of this.nodes.values()) {
        if (n.dead || GATHER.resOfKind[n.res] !== res) continue;
        consider(n, n.res, GATHER.slots[n.res]);
      }
      if (res === 'food') {
        for (const b of this.buildings.values()) {
          if (b.owner !== p.id || b.dead || !b.built || p.faction.buildings[b.type].node !== 'farm') continue;
          consider(b, 'farm', GATHER.slots.farm);
        }
      }
      return best;
    },

    nodeRect(ref) {
      if (ref.k === 'e') {
        const e = this.get(ref.id);
        if (!e || e.dead) return null;
        if (e.kind === 3) return { kind: e.res, ent: e, x0: e.tx * 1000, y0: e.ty * 1000, x1: (e.tx + e.size) * 1000, y1: (e.ty + e.size) * 1000 };
        if (!e.built) return null;
        return { kind: 'farm', ent: e, x0: e.tx * 1000, y0: e.ty * 1000, x1: (e.tx + e.size) * 1000, y1: (e.ty + e.size) * 1000 };
      }
      if (this.terrain[ref.idx] !== 1 || this.wood[ref.idx] <= 0) return null;
      const x0 = (ref.idx % this.W) * 1000, y0 = Math.floor(ref.idx / this.W) * 1000;
      return { kind: 'wood', ent: null, x0, y0, x1: x0 + 1000, y1: y0 + 1000 };
    },

    assignNode(u, res, ref) {
      const r = this.nodeRect(ref);
      if (!r) return false;
      const prev = u.ord;
      this.setOrder(u, { t: 'gather', res, node: ref, kind: r.kind, st: 'go', slot: ref, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 });
      void prev;
      if (ref.k === 'e') r.ent.gat++;
      else this.treeGat[ref.idx]++;
      u.lastRes = res;
      if (u.res !== res) {
        u.res = res;
        u.amt = 0;
      }
      u.gp = 0;
      return true;
    },

    assignGather(u, res, hint) {
      const p = this.pl(u.owner);
      const ref = this.findNode(p, res, u.x, u.y, hint);
      if (!ref) return false;
      return this.assignNode(u, res, ref);
    },

    // server-side helper: new workers join the resource with the biggest deficit
    autoGather(u) {
      const p = this.pl(u.owner);
      const cnt = { food: 0, wood: 0, stone: 0, gold: 0 };
      let total = 0;
      for (const w of this.units.values())
        if (w.owner === p.id && w.type === 'worker' && w.ord.t === 'gather') {
          cnt[w.ord.res]++;
          total++;
        }
      const hasCamp = (this.pl(u.owner).built.mining_camp || 0) > 0;
      const order = ['food', 'wood', 'gold', 'stone'].filter((r) => (r === 'gold' || r === 'stone' ? hasCamp : true));
      order.sort((a, b) => (RULES.workerPolicy[b] * (total + 1) / 100 - cnt[b]) - (RULES.workerPolicy[a] * (total + 1) / 100 - cnt[a]));
      for (const r of order) if (this.assignGather(u, r, null)) return true;
      return false;
    },

    nearestDrop(p, res, u) {
      let best = null, bd = Infinity;
      for (const b of this.buildings.values()) {
        if (b.owner !== p.id || !b.built || b.dead) continue;
        const d = p.faction.buildings[b.type].drop;
        if (!d || !d.includes(res)) continue;
        const d2 = this.distSq(u.x, u.y, b);
        if (d2 < bd || (d2 === bd && this.tieKey(u.owner, 2 * b.tx + b.size, 2 * b.ty + b.size) < this.tieKey(u.owner, 2 * best.tx + best.size, 2 * best.ty + best.size))) {
          bd = d2;
          best = b;
        }
      }
      return best;
    },

    regather(u, o) {
      const p = this.pl(u.owner);
      const hint = [(o.x0 + o.x1) / 2, (o.y0 + o.y1) / 2];
      const res = o.res;
      if (u.amt > 0 && u.res === res) {
        // deliver first, then pick a new node
        this.releaseNode(u);
        o.st = 'ret';
        o.node = null;
        o.drop = 0;
        return;
      }
      if (!this.assignGather(u, res, hint)) this.setOrder(u, { t: 'idle' });
    },

    doGather(u, o) {
      const p = this.pl(u.owner);
      if (o.st === 'go') {
        if (u.amt >= p.carry) {
          o.st = 'ret';
          return;
        }
        const alive = o.node.k === 'e' ? this.nodeRect(o.node) !== null : this.terrain[o.node.idx] === 1 && this.wood[o.node.idx] > 0;
        if (!alive) {
          this.regather(u, o);
          return;
        }
        const dx = Math.max(o.x0 - u.x, 0, u.x - o.x1), dy = Math.max(o.y0 - u.y, 0, u.y - o.y1);
        if (dx * dx + dy * dy <= REACH2) {
          o.st = 'work';
          u.wp = null;
          u.gp = 0;
        } else {
          let res;
          if (o.node.k === 'e') {
            const e = this.get(o.node.id);
            res = this.moveToGoal(u, KEY_ENT + e.id, this.entSeeds(e));
          } else res = this.moveToGoal(u, o.node.idx, this.tileSeeds(o.node.idx));
          if (res === 'stuck') {
            // unreachable node: try another one next to it, else give up
            const hint = [(o.x0 + o.x1) / 2, (o.y0 + o.y1) / 2];
            const ref = this.findNode(p, o.res, u.x, u.y, hint);
            if (ref && !(ref.k === o.node.k && (ref.id === o.node.id && ref.idx === o.node.idx)) && (o.retries = (o.retries || 0) + 1) < 4) this.assignNode(u, o.res, ref);
            else {
              u.stuck = this.t;
              this.setOrder(u, { t: 'idle' });
            }
          }
        }
        return;
      }
      if (o.st === 'work') {
        const alive = o.node.k === 'e' ? this.nodeRect(o.node) !== null : this.terrain[o.node.idx] === 1 && this.wood[o.node.idx] > 0;
        if (!alive) {
          if (u.amt > 0) o.st = 'ret';
          else this.regather(u, o);
          return;
        }
        const pct = p.gatherPct[o.kind] || 0;
        u.gp += Math.round((GATHER.rate[o.kind] * 100 * (100 + pct)) / 100 * (this.storms.length ? this.stormGather(u) : 1) * (this.wxGath ? this.worldGather(o.kind) : 1));
        while (u.gp >= 1000 && u.amt < p.carry) {
          u.gp -= 1000;
          u.amt++;
          if (o.node.k === 't') {
            const i = o.node.idx;
            this.wood[i]--;
            const c = this.tileCluster[i];
            if (c >= 0) this.clusters[c].amt--;
            if (this.wood[i] <= 0) {
              this.terrain[i] = 0;
              this.tileCluster[i] = -1;
              {
                const W = this.W;
                const x = i % W;
                // label of the first labelled neighbour; the neighbour order is mirrored for player 2
                const L = this.comp[i - 1] * (x > 0 ? 1 : 0), R = this.comp[i + 1] * (x < W - 1 ? 1 : 0);
                const U = i >= W ? this.comp[i - W] : 0, D = i + W < this.comp.length ? this.comp[i + W] : 0;
                this.comp[i] = this.sgn[u.owner] > 0 ? L || R || U || D : R || L || D || U;
              }
              this.blk[i] = this.occ[i] !== 0 ? 1 : 0;
              this.treeGat[i] = 0;
              o.slot = null;
              break;
            }
          } else {
            const e = this.get(o.node.id);
            if (e.kind === 3) {
              e.amt--;
              if (e.amt <= 0) {
                e.dead = true;
                this.dead.push(e);
                break;
              }
            }
          }
        }
        if (u.amt >= p.carry || !(o.node.k === 'e' ? this.nodeRect(o.node) : this.terrain[o.node.idx] === 1)) {
          o.st = 'ret';
          u.gp = 0;
          o.drop = 0;
        }
        return;
      }
      if (o.st === 'ret') {
        if (u.amt <= 0) {
          if (!o.node) {
            this.regather(u, o);
            return;
          }
          o.st = 'go';
          return;
        }
        let d = o.drop ? this.buildings.get(o.drop) : null;
        if (!d || d.dead) {
          d = this.nearestDrop(p, u.res, u);
          o.drop = d ? d.id : 0;
        }
        if (!d) {
          this.setOrder(u, { t: 'idle' });
          return;
        }
        if (this.distSq(u.x, u.y, d) <= REACH2) {
          p.res[u.res] += u.amt;
          p.gathered[u.res] += u.amt;
          u.amt = 0;
          u.wp = null;
          if (!o.node) {
            this.regather(u, o);
            return;
          }
          o.st = 'go';
        } else if (this.moveToGoal(u, KEY_ENT + d.id, this.entSeeds(d)) === 'stuck') {
          o.drop = 0;
          if ((o.retries = (o.retries || 0) + 1) > 5) this.setOrder(u, { t: 'idle' });
        }
      }
    },
  };

  function ARM(a) {
    return ARM_TABLE[a < 0 ? 0 : a > 80 ? 80 : a];
  }
  Object.assign(Game.prototype, methods);
}

// Armour percent table, built here to avoid a circular import with game.mjs.
const ARM_TABLE = (() => {
  const a = [100];
  let p = 100;
  for (let i = 1; i <= 80; i++) {
    p = (p * ARMOUR_STEP_PCT) / 100;
    a.push(Math.max(1, Math.floor(p)));
  }
  return a;
})();
