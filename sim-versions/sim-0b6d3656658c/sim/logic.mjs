// Per-tick behaviour: orders, movement, gathering, building, production, combat, projectiles.
import { GATHER, RULES, ARMOUR_STEP_PCT } from './data.mjs';
import { INF, TICK_HZ } from './util.mjs';

const REACH2 = 1500 * 1500; // distance from a node/building edge at which a worker can work
const BUILD_ADD = [1000, 600, 450, 350, 300];
const KEY_ENT = 1000000;
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
        const dx = e.x - x, dy = e.y - y;
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
      u.x += Math.round((dx * speed) / len);
      u.y += Math.round((dy * speed) / len);
      return false;
    },

    // Straight steering with axis sliding. Returns false if completely blocked.
    stepDirect(u, tx, ty, cap) {
      let sp = this.players[u.owner].stats[u.type].speed;
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
        nx = u.x + Math.round((dx * sp) / len);
        ny = u.y + Math.round((dy * sp) / len);
      }
      const P = this.paths, W = this.W;
      if (P.canPass(u.owner, Math.floor(ny / 1000) * W + Math.floor(nx / 1000))) {
        u.x = nx;
        u.y = ny;
        return true;
      }
      if (P.canPass(u.owner, Math.floor(u.y / 1000) * W + Math.floor(nx / 1000)) && nx !== u.x) {
        u.x = nx;
        return true;
      }
      if (P.canPass(u.owner, Math.floor(ny / 1000) * W + Math.floor(u.x / 1000)) && ny !== u.y) {
        u.y = ny;
        return true;
      }
      return false;
    },

    // Follow the cached flow field of goal `key`. Returns 'ok' or 'stuck'.
    moveToGoal(u, key, seedsFn, cap) {
      const P = this.paths, W = this.W;
      const ui = Math.floor(u.y / 1000) * W + Math.floor(u.x / 1000);
      const f = P.get(u.owner, key, ui, seedsFn);
      if (f.dist[ui] >= INF) {
        if (!P.canPass(u.owner, ui)) {
          this.unstick(u);
          return 'ok';
        }
        return 'stuck';
      }
      if (u.wp && !P.canPass(u.owner, Math.floor(u.wp[1] / 1000) * W + Math.floor(u.wp[0] / 1000))) {
        u.wp = null;
        P.invalidate(u.owner, key);
      }
      if (!u.wp) {
        u.wp = P.waypoint(u.owner, f, u.x, u.y);
        if (!u.wp) return 'stuck';
      }
      let sp = this.players[u.owner].stats[u.type].speed;
      if (cap && cap < sp) sp = cap;
      if (this.moveStep(u, u.wp[0], u.wp[1], sp)) u.wp = null;
      return 'ok';
    },

    // A unit standing on a blocked tile (building placed over it, ...) is moved to the nearest free tile.
    unstick(u) {
      const W = this.W, H = this.H;
      const tx = Math.floor(u.x / 1000), ty = Math.floor(u.y / 1000);
      for (let r = 1; r <= 8; r++)
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = tx + dx, y = ty + dy;
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            if (this.paths.canPass(u.owner, y * W + x)) {
              u.x = x * 1000 + 500;
              u.y = y * 1000 + 500;
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
      if (u.dead) return;
      if (u.cd > 0) u.cd--;
      const o = u.ord;
      switch (o.t) {
        case 'idle': this.idleLogic(u); break;
        case 'move': this.doMove(u, o); break;
        case 'amove': this.doAttackMove(u, o); break;
        case 'attack': this.doAttackOrder(u, o); break;
        case 'gather': this.doGather(u, o); break;
        case 'build': this.doBuild(u, o); break;
      }
    },

    doMove(u, o) {
      const r = this.goPoint(u, o.x, o.y, o.r);
      if (r !== 'ok') this.setOrder(u, { t: 'idle' });
    },

    // ---------------- combat ----------------
    acquire(u, r, unitsOnly = false, walls = false) {
      const st = this.players[u.owner].stats[u.type];
      const myTeam = this.team[u.owner];
      let best = null, bs = Infinity;
      if (st.only !== 'buildings') {
        this.unitsNear(u.x, u.y, r, (e) => {
          if (this.team[e.owner] === myTeam) return;
          const dx = e.x - u.x, dy = e.y - u.y;
          let s = dx * dx + dy * dy;
          const c = this.players[e.owner].stats[e.type].cls;
          if (c === 'worker') s += 9000000;
          if (s < bs) {
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
        const d2 = this.distSq(u.x, u.y, b);
        if (d2 <= r2 && d2 < bs) {
          bs = d2;
          best = b;
        }
      }
      return best;
    },

    idleLogic(u) {
      if (u.type === 'worker') {
        // server helper: idle workers finish unfinished buildings of their own side close by
        if ((this.t + u.id) % 10 !== 0 || this.t - (u.stuck ?? -9999) < 300) return;
        let best = null, bd = 9000 * 9000;
        for (const b of this.buildings.values()) {
          if (b.built || b.dead || this.team[b.owner] !== this.team[u.owner]) continue;
          const d2 = this.distSq(u.x, u.y, b);
          if (d2 < bd) {
            bd = d2;
            best = b;
          }
        }
        if (best) this.setOrder(u, { t: 'build', id: best.id, next: [], last: 0 });
        return;
      }
      if ((this.t + u.id) % 4 !== 0) return;
      const st = this.players[u.owner].stats[u.type];
      let tgt = null;
      if (u.hitBy && this.t - u.hitT < 30) {
        const a = this.get(u.hitBy);
        if (a && !a.dead && this.team[a.owner] !== this.team[u.owner] && a.kind === 1 && st.only !== 'buildings') {
          const dx = a.x - u.x, dy = a.y - u.y;
          if (dx * dx + dy * dy < 12000 * 12000) tgt = a;
        }
      }
      if (!tgt) tgt = this.acquire(u, Math.max(st.range + RULES.idleAcquireBonus * 1000, 5000));
      if (tgt) this.setOrder(u, { t: 'attack', id: tgt.id, auto: true, hx: u.x, hy: u.y });
    },

    // chase/attack. returns 'ok' or 'lost'
    engage(u, e) {
      const st = this.players[u.owner].stats[u.type];
      const d2 = this.distSq(u.x, u.y, e);
      const rg = e.kind === 1 ? st.range : st.range + 500; // buildings are big targets
      if (d2 <= rg * rg) {
        u.wp = null;
        if (u.cd <= 0) this.fire(u, st, e);
        return 'ok';
      }
      let r;
      if (e.kind === 1) {
        if (d2 < 7000 * 7000 && this.paths.losClear(u.owner, u.x, u.y, e.x, e.y)) r = this.stepDirect(u, e.x, e.y) ? 'ok' : 'stuck';
        else {
          const idx = this.tileOf(e.x, e.y);
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
      const st = this.players[u.owner].stats[u.type];
      if (u.type !== 'worker') {
        let e = u.tgt ? this.get(u.tgt) : null;
        if (e && (e.dead || this.team[e.owner] === this.team[u.owner])) e = null;
        if (!e) u.tgt = 0;
        if (e && (this.t + u.id) % 6 === 0 && (e.kind === 2 || this.players[e.owner].stats[e.type].cls === 'worker') && st.only !== 'buildings') {
          const n = this.acquire(u, Math.min(st.sight * 1000, 6000), true);
          if (n) {
            e = n;
            u.tgt = n.id;
          }
        }
        if (!e && (this.t + u.id) % 3 === 0) {
          e = this.acquire(u, st.sight * 1000, false, !!o.blocked);
          if (e) u.tgt = e.id;
        }
        if (e) {
          const lim = (st.sight + 5) * 1000;
          if (e.kind === 1 && (e.x - u.x) ** 2 + (e.y - u.y) ** 2 > lim * lim) u.tgt = 0;
          else if (this.engage(u, e) === 'lost') u.tgt = 0;
          return;
        }
      }
      const r = this.goPoint(u, o.x, o.y, o.r);
      if (r === 'arrived') this.setOrder(u, { t: 'idle' });
      else if (r === 'stuck') {
        if (u.type === 'worker' || o.blocked) this.setOrder(u, { t: 'idle' });
        else o.blocked = true;
      }
    },

    fire(shooter, st, e) {
      shooter.cd = st.cd;
      if (st.proj) {
        let tx, ty;
        if (e.kind === 1) { tx = e.x; ty = e.y; }
        else { tx = (e.tx + e.size / 2) * 1000; ty = (e.ty + e.size / 2) * 1000; }
        const sx = shooter.kind === 1 ? shooter.x : (shooter.tx + shooter.size / 2) * 1000;
        const sy = shooter.kind === 1 ? shooter.y : (shooter.ty + shooter.size / 2) * 1000;
        this.proj.push({
          x: sx, y: sy, tx, ty, tid: e.id, owner: shooter.owner, atk: st.atk, dmg: st.dmg, bonus: st.bonus,
          splash: st.splash || 0, speed: st.proj, src: shooter.kind === 1 ? shooter.type : null, sid: shooter.id, life: 120,
        });
      } else this.applyDamage(shooter.owner, shooter.id, shooter.kind === 1 ? shooter.type : null, st.atk, st.dmg, st.bonus, e);
    },

    applyDamage(owner, sid, src, atk, dmgType, bonus, tgt) {
      if (tgt.dead || tgt.dying) return;
      const tp = this.players[tgt.owner];
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
      const real = Math.min(dmg, tgt.hp);
      tgt.hp -= dmg;
      tgt.hitBy = sid;
      tgt.hitT = this.t;
      if (src) {
        const us = this.unitStat(owner, src);
        us.dmg += real;
      }
      if (tgt.kind === 2 && (this.t - (tp.lastAttackEv || -999)) > 50) {
        tp.lastAttackEv = this.t;
        this.event(tp, { type: 'attacked', x: tgt.tx, y: tgt.ty, what: tgt.type });
      } else if (tgt.kind === 1 && (this.t - (tp.lastAttackEv || -999)) > 50) {
        tp.lastAttackEv = this.t;
        this.event(tp, { type: 'attacked', x: Math.floor(tgt.x / 1000), y: Math.floor(tgt.y / 1000), what: tgt.type });
      }
      if (tgt.hp <= 0) this.kill(tgt, owner, src);
    },

    unitStat(owner, type) {
      const m = this.players[owner].unitStats;
      return m[type] || (m[type] = { dmg: 0, kills: 0, killValue: 0, lost: 0, lostValue: 0 });
    },

    // Deaths are applied at the end of the tick (cleanup) so that unit update order gives no advantage.
    kill(e, killerOwner, src) {
      if (e.dead || e.dying) return;
      e.dying = true;
      this.dead.push(e);
      if (e.kind === 3) return;
      const vp = this.players[e.owner];
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
        const kp = this.players[killerOwner];
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
          if (t.kind === 1) { pr.tx = t.x; pr.ty = t.y; }
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
          } else if (t && !t.dead && pr.life > 0) this.applyDamage(pr.owner, pr.sid, pr.src, pr.atk, pr.dmg, pr.bonus, t);
          arr[i] = arr[arr.length - 1];
          arr.pop();
        } else {
          const len = Math.sqrt(d2);
          pr.x += Math.round((dx * pr.speed) / len);
          pr.y += Math.round((dy * pr.speed) / len);
        }
      }
    },

    // ---------------- buildings ----------------
    updateBuilding(b) {
      if (b.dead || !b.built) return;
      const p = this.players[b.owner];
      const bs = p.bstats[b.type];
      if (b.cd > 0) b.cd--;
      if (bs.atk && b.cd === 0 && (this.t + b.id) % 3 === 0) {
        let best = null, bd = Infinity;
        const cx = (b.tx + b.size / 2) * 1000, cy = (b.ty + b.size / 2) * 1000;
        const myTeam = this.team[b.owner];
        this.unitsNear(cx, cy, bs.range + b.size * 500, (e) => {
          if (this.team[e.owner] === myTeam) return;
          const dx = e.x - cx, dy = e.y - cy;
          const d = dx * dx + dy * dy;
          if (d < bd) {
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
      const pos = this.spawnPoint(b, (b.spawnK = (b.spawnK || 0) + 1));
      const u = this.addUnit(b.owner, q.type, pos[0], pos[1]);
      b.queue.shift();
      this.spawned(b, u);
    },

    spawned(b, u) {
      const p = this.players[b.owner];
      this.event(p, { type: 'trained', unit: u.type, id: u.id });
      const r = b.rally;
      if (r) {
        if (u.type === 'worker' && r.res) this.assignGather(u, r.res, [r.x, r.y]);
        else this.setOrder(u, { t: 'move', x: r.x, y: r.y, r: 700 + 250 * (u.id % 5) });
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
        const p = this.players[b.owner];
        const total = p.faction.buildings[b.type].time * TICK_HZ * 1000;
        b.prog += add;
        const gain = Math.floor((b.maxhp * 0.9 * add) / total);
        b.hp = Math.min(b.maxhp, b.hp + Math.max(gain, 0));
        if (b.prog >= total) {
          b.built = true;
          b.hp = Math.min(b.maxhp, Math.max(b.hp, Math.floor(b.maxhp * 0.9)));
          this.recalcPop(p);
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
      const p = this.players[u.owner];
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
        const tx0 = Math.floor(cx / 1000), ty0 = Math.floor(cy / 1000);
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
              const s = d + 0.8 * this.dropDist(p, res, xx * 1000 + 500, yy * 1000 + 500) + 3 * this.treeGat[i] + 0.001 * Math.sqrt((xx - W / 2) ** 2 + (yy - W / 2) ** 2);
              if (s < bs) {
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
        if (!p.expl[e.ty * W + e.tx] || !this.rectReachable(p.comp, e.tx, e.ty, e.size)) return;
        const ex = (e.tx + e.size / 2) * 1000, ey = (e.ty + e.size / 2) * 1000;
        const d = Math.sqrt((ex - cx) ** 2 + (ey - cy) ** 2) / 1000;
        let s = d + 0.8 * this.dropDist(p, res, ex, ey) + 4 * e.gat + 0.001 * Math.sqrt((e.tx - W / 2) ** 2 + (e.ty - W / 2) ** 2);
        if (e.gat >= slots) s += kind === 'farm' ? 200 : 40;
        if (s < bs) {
          bs = s;
          best = { k: 'e', id: e.id };
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
      const p = this.players[u.owner];
      const ref = this.findNode(p, res, u.x, u.y, hint);
      if (!ref) return false;
      return this.assignNode(u, res, ref);
    },

    // server-side helper: new workers join the resource with the biggest deficit
    autoGather(u) {
      const p = this.players[u.owner];
      const cnt = { food: 0, wood: 0, stone: 0, gold: 0 };
      let total = 0;
      for (const w of this.units.values())
        if (w.owner === p.id && w.type === 'worker' && w.ord.t === 'gather') {
          cnt[w.ord.res]++;
          total++;
        }
      const hasCamp = (this.players[u.owner].built.mining_camp || 0) > 0;
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
        if (d2 < bd) {
          bd = d2;
          best = b;
        }
      }
      return best;
    },

    regather(u, o) {
      const p = this.players[u.owner];
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
      const p = this.players[u.owner];
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
        u.gp += Math.round((GATHER.rate[o.kind] * 100 * (100 + pct)) / 100);
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
                this.comp[i] = this.comp[i - 1] * (x > 0 ? 1 : 0) || this.comp[i + 1] * (x < W - 1 ? 1 : 0) || (i >= W ? this.comp[i - W] : 0) || (i + W < this.comp.length ? this.comp[i + W] : 0);
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
