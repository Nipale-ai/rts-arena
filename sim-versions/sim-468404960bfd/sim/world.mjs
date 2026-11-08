// The living world: deterministic weather, neutral caravans, the `say` chat tool and the log of world events.
// Everything here follows from the match seed, the map and the command log, and is symmetric for the players:
//   weather   one sky for the whole map, a schedule drawn from the seed when the game is built (God mode can override it)
//   caravans  neutral traders (owner 0) on mirrored routes: the killing blow earns a bounty, an escort earns a trade fee
//   chat      `say` is a normal logged command; the text only reaches the other player's observation, never the sim
// Ships and the harbor live in sim/naval.mjs. Nothing in here uses wall clocks or Math.random.
import { RNG } from './rng.mjs';
import { DIRECTOR_ACTIONS } from './director.mjs';
import { hashStep, TICK_HZ } from './util.mjs';
import { RESOURCES } from './data.mjs';
import {
  WEATHER_KINDS, WEATHER, WEATHER_MIX, WEATHER_TIMING, CARAVAN, CHAT, MAP_TYPES,
} from './world-data.mjs';

const fail = (error, message) => ({ ok: false, error, message });
const WORLD_LOG_MAX = 4000;

// ---------------------------------------------------------------- weather schedule (pure, tested)
// mode: 'off' | 'auto' | a fixed kind. Returns [{ from, to, kind }] in ticks; the last period never ends.
export function buildWeather(seed, mapType, limitS, mode) {
  if (mode !== 'auto') return [{ from: 0, to: Infinity, kind: WEATHER_KINDS.includes(mode) ? mode : 'clear' }];
  const mix = WEATHER_MIX[MAP_TYPES.includes(mapType) ? mapType : 'meadow'];
  const rng = new RNG(((seed ^ 0x77ea7e55) >>> 0) + Math.imul(MAP_TYPES.indexOf(mapType) + 1, 40503));
  const secs = ([lo, hi]) => rng.range(lo, hi);
  const out = [];
  let t = secs(WEATHER_TIMING.firstClearS) * TICK_HZ;
  out.push({ from: 0, to: t, kind: 'clear' });
  let prev = 'clear';
  const end = (limitS + 400) * TICK_HZ;
  while (t < end) {
    const pool = Object.entries(mix).filter(([k]) => k !== prev);
    const tot = pool.reduce((a, [, w]) => a + w, 0);
    let r = rng.int(tot), kind = pool[0][0];
    for (const [k, w] of pool) { if (r < w) { kind = k; break; } r -= w; }
    const d = secs(kind === 'clear' ? WEATHER_TIMING.clearS : kind === 'storm' ? WEATHER_TIMING.stormS : WEATHER_TIMING.otherS) * TICK_HZ;
    out.push({ from: t, to: t + d, kind });
    t += d;
    prev = kind;
  }
  out[out.length - 1].to = Infinity;
  return out;
}

DIRECTOR_ACTIONS.push('weather', 'caravan'); // God mode: change the sky, send a new caravan

export function installWorld(Game) {
  // prototype defaults: a plain clear sky (the hot paths read these numbers without a weather check)
  Object.assign(Game.prototype, { wxKind: 'clear', wxMove: 100, wxSea: 100, wxSightPct: 100, wxFood: 100, wxAll: 100, wxSlow: false, wxGath: false });

  // a destroyed caravan pays its bounty to the side of the killing blow; a sunk transport takes its cargo down
  const baseKill = Game.prototype.kill;
  Game.prototype.kill = function (e, killerOwner, src) {
    const was = e.dying || e.dead;
    baseKill.call(this, e, killerOwner, src);
    if (was || !e.dying || e.kind !== 1) return;
    if (e.owner === 0 && e.type === 'caravan') this.caravanDestroyed(e, killerOwner);
    else if (e.cargo && e.cargo.length) this.cargoLost(e, killerOwner, src);
  };

  const methods = {
    // ---------------- set-up ----------------
    initWorld(mapObj) {
      this.worldLog = [];
      this.chatLog = [];
      this.chatSeq = 0;
      this.mapType = mapObj.mapType || this.rules.mapType || 'meadow';
      for (const p of this.players) if (p) p.lastSay = -100000;
      // weather
      const mode = this.rules.weather || 'off';
      this.wxOn = mode !== 'off';
      this.wx = { mode, sched: buildWeather(this.seed, this.mapType, this.rules.timeLimitS, this.wxOn ? mode : 'off'), i: 0, over: null };
      this.applyWeather(this.wx.sched[0].kind, false);
      // the wild owner also knows the caravan
      this.wild.faction.units.caravan = { cost: {}, cls: 'trader' };
      this.wild.stats.caravan = {
        cls: 'trader', atk: 0, hp: CARAVAN.hp, armour: { ...CARAVAN.armour }, range: 1000, speed: Math.round(CARAVAN.speed * 100), sight: CARAVAN.sight,
        cd: 10, proj: 0, splash: 0, dmg: 'melee', bonus: null, only: null, pop: 0, minRange: 0, setup: 0, lob: false, splashBuilding: 0, noAtk: true, noArmy: true, needs: null, heal: null, charge: null, naval: null,
      };
      // caravans
      this.caravans = [];
      if (this.rules.caravans) {
        for (const r of mapObj.caravans || []) {
          if (!r.route || r.route.length < 2) continue;
          const c = { id: this.caravans.length + 1, route: r.route.map(([x, y]) => [x | 0, y | 0]), next: 1, uid: 0, wait: CARAVAN.stopS * TICK_HZ, respawnAt: 0, lx: 0, ly: 0, lt: 0, trips: 0 };
          this.caravans.push(c);
          this.spawnCaravan(c);
        }
      }
      this.initNaval(mapObj);
    },

    wlog(e) {
      e.t = this.t;
      this.worldLog.push(e);
      if (this.worldLog.length > WORLD_LOG_MAX) this.worldLog.shift();
    },

    // ---------------- weather ----------------
    applyWeather(kind, log = true) {
      const E = WEATHER[kind], was = this.wxKind;
      this.wxKind = kind;
      this.wxMove = E.move; this.wxSea = E.sea; this.wxSightPct = E.sight; this.wxFood = E.food; this.wxAll = E.all;
      this.wxSlow = E.move !== 100 || E.sea !== 100;
      this.wxGath = E.food !== 100 || E.all !== 100;
      if (log && kind !== was) this.wlog({ type: 'weather', kind, from: was });
    },

    // land units and ships crawl or race with the weather (0 and the wild owner are affected alike)
    worldSpeed(u, sp) {
      const st = this.pl(u.owner).stats[u.type];
      const pct = st && st.cls === 'naval' ? this.wxSea : this.wxMove;
      return pct === 100 ? sp : Math.max(1, Math.floor((sp * pct) / 100));
    },
    // gathering multiplier for a node kind (food kinds get the extra food factor)
    worldGather(kind) {
      const food = kind === 'berries' || kind === 'herd' || kind === 'farm' || kind === 'fish';
      return (food ? this.wxFood * this.wxAll : this.wxAll * 100) / 10000;
    },
    // sight radius (tiles) of an entity with the weather: the same for everybody
    worldSight(r) {
      return this.wxSightPct === 100 ? r : Math.max(2, Math.floor((r * this.wxSightPct) / 100));
    },

    weatherInfo() {
      const w = this.wx;
      const cur = w.sched[w.i];
      const kind = w.over ? w.over.kind : cur.kind;
      const endsT = w.over ? w.over.until : cur.to;
      const next = w.over ? cur.kind : w.sched[w.i + 1] ? w.sched[w.i + 1].kind : null;
      return { kind, effect: WEATHER[kind].text, ends_in_s: Number.isFinite(endsT) ? Math.max(0, Math.ceil((endsT - this.t) / TICK_HZ)) : null, next };
    },

    // ---------------- caravans ----------------
    spawnCaravan(c) {
      const [x, y] = c.route[0];
      const u = this.addUnit(0, 'caravan', x * 1000 + 500, y * 1000 + 500);
      c.uid = u.id;
      c.next = 1;
      c.wait = CARAVAN.stopS * TICK_HZ;
      c.lx = u.x; c.ly = u.y; c.lt = this.t;
      c.respawnAt = 0;
      return u;
    },

    // killing blow of a caravan (called from the kill hook): the bounty goes to the side that landed it
    caravanDestroyed(u, killerOwner) {
      const x = Math.round(u.x / 100) / 10, y = Math.round(u.y / 100) / 10;
      const c = this.caravans.find((k) => k.uid === u.id);
      if (killerOwner > 0) {
        const p = this.players[killerOwner];
        p.res.gold += CARAVAN.bounty;
        p.killValue += CARAVAN.bounty;
        this.wlog({ type: 'caravan_raid', p: killerOwner, gold: CARAVAN.bounty, x, y, caravan: c ? c.id : 0 });
      } else this.wlog({ type: 'caravan_lost', x, y, caravan: c ? c.id : 0 });
    },

    updateCaravans() {
      for (const c of this.caravans) {
        let u = c.uid ? this.units.get(c.uid) : null;
        if (u && (u.dying || u.dead)) u = null;
        if (!u) {
          if (c.uid) { c.uid = 0; c.respawnAt = this.t + CARAVAN.respawnS * TICK_HZ; }
          else if (c.respawnAt && this.t >= c.respawnAt) { this.spawnCaravan(c); this.wlog({ type: 'caravan_new', caravan: c.id }); }
          continue;
        }
        if (c.wait > 0) { c.wait--; c.lx = u.x; c.ly = u.y; c.lt = this.t; continue; }
        const [tx, ty] = c.route[c.next];
        const r = this.goPoint(u, tx * 1000 + 500, ty * 1000 + 500, 900);
        if (r === 'arrived') {
          this.caravanArrived(c, u);
          c.next = (c.next + 1) % c.route.length;
          c.wait = CARAVAN.stopS * TICK_HZ;
          c.trips++;
          c.lx = u.x; c.ly = u.y; c.lt = this.t;
          continue;
        }
        // no progress for a long time: replace it
        if (this.t - c.lt >= CARAVAN.stuckS * TICK_HZ) {
          if ((u.x - c.lx) ** 2 + (u.y - c.ly) ** 2 < 1500 * 1500) {
            u.dying = true; this.dead.push(u); c.uid = 0; c.respawnAt = this.t + CARAVAN.respawnS * TICK_HZ;
            this.wlog({ type: 'caravan_lost', x: Math.round(u.x / 100) / 10, y: Math.round(u.y / 100) / 10, caravan: c.id, stuck: true });
            continue;
          }
          c.lx = u.x; c.ly = u.y; c.lt = this.t;
        }
      }
    },

    // the caravan reached a post: players with soldiers close by share the trade fee
    caravanArrived(c, u) {
      const R = CARAVAN.escortR * 1000, near = new Map(); // team -> [players]
      this.unitsNear(u.x, u.y, R, (e) => {
        if (e.owner === 0 || e.dying) return;
        const st = this.pl(e.owner).stats[e.type];
        if (!st || st.cls === 'worker' || st.cls === 'naval' || st.noAtk) return;
        const team = this.team[e.owner];
        if (!near.has(team)) near.set(team, new Set());
        near.get(team).add(e.owner);
      });
      if (!near.size) return;
      const share = Math.floor(CARAVAN.trade / near.size);
      const paid = [];
      for (const [, owners] of [...near.entries()].sort((a, b) => a[0] - b[0])) {
        for (const o of [...owners].sort((a, b) => a - b)) {
          const p = this.players[o];
          const each = Math.floor(share / owners.size);
          p.res.gold += each;
          p.gathered.gold += each;
          paid.push([o, each]);
        }
      }
      this.wlog({ type: 'caravan_trade', paid, x: Math.round(u.x / 100) / 10, y: Math.round(u.y / 100) / 10, caravan: c.id });
    },

    // ---------------- per tick ----------------
    worldStep() {
      const w = this.wx;
      if (w.over && this.t >= w.over.until) w.over = null;
      while (w.i < w.sched.length - 1 && this.t >= w.sched[w.i].to) w.i++;
      const kind = w.over ? w.over.kind : w.sched[w.i].kind;
      if (kind !== this.wxKind) this.applyWeather(kind);
      if (this.caravans.length) this.updateCaravans();
      if (this.navUsed) this.navalStep();
    },

    // ---------------- chat ----------------
    cmd_say(p, a) {
      let text = String(a.text ?? a.message ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) return fail('bad_args', 'say needs a non-empty "text"');
      const wait = p.lastSay + CHAT.gapTicks - this.t;
      if (wait > 0) return fail('rate_limited', `you can speak once every ${CHAT.gapTicks / TICK_HZ} s; wait ${Math.ceil(wait / TICK_HZ)} s`);
      let note;
      if (text.length > CHAT.maxChars) { text = text.slice(0, CHAT.maxChars - 1).trimEnd() + '…'; note = `cut to ${CHAT.maxChars} characters`; }
      p.lastSay = this.t;
      const m = { seq: ++this.chatSeq, t: this.t, p: p.id, text };
      this.chatLog.push(m);
      if (this.chatLog.length > CHAT.keep) this.chatLog.shift();
      this.wlog({ type: 'chat', p: p.id, text, seq: m.seq });
      return { ok: true, text, ...(note ? { note } : {}) };
    },

    // what a player reads in its observation: lines of the other players since `since` (a tick), newest last
    chatFor(pid, since) {
      if (!(since >= 0) || !this.chatLog.length) return [];
      const p = this.players[pid];
      return this.chatLog.filter((m) => m.t > since && m.p !== pid).slice(-CHAT.inbox)
        .map((m) => ({ from: this.team[m.p] === p.team ? 'ally' : 'enemy', player: m.p, t: Math.floor(m.t / TICK_HZ), text: m.text }));
    },

    // ---------------- God mode ----------------
    dir_weather(a) {
      const kind = String(a.kind ?? a.type ?? '');
      if (!WEATHER_KINDS.includes(kind)) return fail('bad_args', `kind must be one of ${WEATHER_KINDS.join(', ')}`);
      const secs = Math.max(10, Math.min(600, Math.round(Number(a.secs)) || 90));
      this.wx.over = { kind, until: this.t + secs * TICK_HZ };
      this.applyWeather(kind);
      return { ok: true, text: kind === 'clear' ? `the sky clears for ${secs}s` : `${kind} for ${secs}s: ${WEATHER[kind].text}` };
    },
    dir_caravan(a) {
      if (!this.caravans.length) return fail('no_caravans', 'this match has no caravans');
      const dead = this.caravans.filter((c) => !c.uid);
      for (const c of dead) { this.spawnCaravan(c); }
      if (!dead.length) return fail('already_here', 'all caravans are on the road');
      return { ok: true, text: `${dead.length} new caravan${dead.length > 1 ? 's' : ''} set out` };
    },

    // ---------------- hash and views ----------------
    hashWorld(h) {
      const w = this.wx;
      if (this.wxOn || w.over) {
        h = hashStep(h, w.i); h = hashStep(h, WEATHER_KINDS.indexOf(this.wxKind));
        if (w.over) h = hashStep(h, w.over.until);
      }
      for (const c of this.caravans) { h = hashStep(h, c.next); h = hashStep(h, c.wait); h = hashStep(h, c.respawnAt); h = hashStep(h, c.uid); }
      return this.hashNaval(h);
    },

    // small facts for the spectator snapshot
    worldView() {
      const info = this.weatherInfo();
      return {
        wx: [WEATHER_KINDS.indexOf(info.kind), info.ends_in_s, info.next ? WEATHER_KINDS.indexOf(info.next) : -1],
        chat: this.chatLog.slice(-4).map((m) => [m.seq, m.t, m.p, m.text]),
      };
    },
  };
  Object.assign(Game.prototype, methods);
}

export { RESOURCES };
