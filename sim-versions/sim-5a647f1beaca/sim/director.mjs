// God mode: the spectator ("director") intervenes in a running match with simple clicks.
//
// Every intervention is a command of player 0 with a tick in the command log:
//   { t, p: 0, cmd: { cmd: 'director', action: 'give' | 'spawn' | 'remove' | 'heal' | 'reveal' | 'wolves' | 'treasure' | 'storm', ... } }
// Game.command(0, cmd) routes here, so live matches, replays (sim/replay.mjs, server/replay-verify.mjs, spectate replays, the
// broadcast tools) all apply it exactly like an agent command: same seed + same log = same match.
// The first successful intervention sets game.godMode = true. result() carries it; such a match never counts for rankings.
// Randomness only comes from game.dirRng (seeded from the match seed) and only when a command leaves a choice open.
// LLM agents never send these: the TOOLS list has no 'director', agent commands always carry their own player id (>= 1).
import { RESOURCES } from './data.mjs';
import { hashStep, TICK_HZ } from './util.mjs';

export const GOD_COLORS = ['blue', 'orange', 'green', 'purple']; // same order as the spectator's player colours
export const DIRECTOR_ACTIONS = ['give', 'spawn', 'remove', 'heal', 'reveal', 'wolves', 'treasure', 'storm'];

export const WOLF = {
  hp: 46, atk: 6, cd: 1.2, speed: 3.1, sight: 9, armour: { melee: 0, pierce: 1, siege: 0 },
};
export const STORM = { speedPct: 60, gatherPct: 50, defaultR: 9, defaultSecs: 40, maxSecs: 180, maxR: 24 };
export const TREASURE = { gold: 300, ttl: 6000, reach: 1300 };
const WOLF_TTL = 1800; // wolves leave after 3 minutes

const fail = (error, message) => ({ ok: false, error, message });
const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const isNum = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
const colorOf = (pid) => GOD_COLORS[(pid - 1) % 4] || `P${pid}`;

// The wild "player" (owner 0). Only holds the stats the unit code reads; it is not part of game.players.
export function makeWild() {
  return {
    id: 0, team: 0, name: 'wolves', alive: false,
    faction: { units: { wolf: { cost: {}, cls: 'beast' } }, buildings: {} },
    stats: {
      wolf: {
        cls: 'beast', atk: WOLF.atk * 10, hp: WOLF.hp, armour: { ...WOLF.armour }, range: 1000, speed: Math.round(WOLF.speed * 100), sight: WOLF.sight,
        cd: Math.max(1, Math.round(WOLF.cd * 10)), proj: 0, splash: 0, dmg: 'melee', bonus: null, only: null, pop: 0,
      },
    },
    bstats: {}, techs: new Set(), gatherPct: {}, carry: 0, res: { food: 0, wood: 0, stone: 0, gold: 0 },
    pop: 0, cap: 0, unitStats: {}, killFeed: [], events: [], results: [], built: {}, trained: {}, gathered: { food: 0, wood: 0, stone: 0, gold: 0 },
    killValue: 0, lostValue: 0, kills: 0, losses: 0, income: [], standing: [], intents: [], ghosts: [],
  };
}

export function installDirector(Game) {
  const methods = {
    // Player record of any owner, including 0 (wild).
    pl(owner) {
      return owner === 0 ? this.wild : this.players[owner];
    },

    godNote(text, kind = 'god', p = 0) {
      this.godFeed.push({ seq: this.godFeed.length + 1, t: this.t, text, kind, p });
      if (this.godFeed.length > 200) this.godFeed.shift();
    },

    // ---------- entry point ----------
    directorCommand(cmd) {
      let res;
      const a = cmd && typeof cmd === 'object' ? (cmd.args && typeof cmd.args === 'object' ? { ...cmd.args } : { ...cmd }) : null;
      if (this.over) res = fail('game_over', 'the match is over');
      else if (!a || (cmd.cmd ?? cmd.name) !== 'director') res = fail('bad_args', 'a director command is {cmd:"director", action, ...}');
      else if (!DIRECTOR_ACTIONS.includes(a.action)) res = fail('unknown_action', `unknown director action "${a.action}"`);
      else {
        try { res = this['dir_' + a.action](a); } catch (err) { res = fail('bad_args', `invalid arguments: ${err.message}`); }
      }
      this.commandLog.push({ t: this.t, p: 0, cmd });
      if (res.ok) {
        this.godMode = true;
        this.godNote(res.text, 'god', res.player || 0);
      }
      return res;
    },

    _dirPlayer(a) {
      const pid = int(a.player, 0, 4, 0);
      const p = this.players[pid];
      return p ? p : null;
    },

    // nearest free walkable tile around (tx, ty); null if none within r
    freeTileNear(tx, ty, r = 6, owner = 1, skip = null) {
      const W = this.W, H = this.H;
      tx = Math.max(0, Math.min(W - 1, Math.floor(tx)));
      ty = Math.max(0, Math.min(H - 1, Math.floor(ty)));
      for (let k = 0; k <= r; k++) {
        let best = null, bd = Infinity;
        for (let dy = -k; dy <= k; dy++)
          for (let dx = -k; dx <= k; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== k) continue;
            const x = tx + dx, y = ty + dy;
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            if (!this.paths.canPass(owner || 1, y * W + x) || (skip && skip.has(y * W + x))) continue;
            const d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = [x, y]; }
          }
        if (best) return best;
      }
      return null;
    },

    // ---------- actions ----------
    dir_give(a) {
      const p = this._dirPlayer(a);
      if (!p) return fail('bad_player', 'player must be 1..' + this.numPlayers);
      if (!RESOURCES.includes(a.res)) return fail('bad_args', `res must be one of ${RESOURCES.join(', ')}`);
      const n = int(a.amount, 1, 10000, 100);
      p.res[a.res] += n;
      return { ok: true, player: p.id, res: a.res, amount: n, text: `+${n} ${a.res} to ${colorOf(p.id)}` };
    },

    dir_spawn(a) {
      const p = this._dirPlayer(a);
      if (!p) return fail('bad_player', 'player must be 1..' + this.numPlayers);
      const type = String(a.unit ?? a.type ?? '');
      if (!p.faction.units[type]) return fail('bad_args', `unknown unit "${type}"`);
      const n = int(a.count, 1, 10, 1);
      let tx, ty;
      if (isNum(a.x) && isNum(a.y)) { tx = Number(a.x); ty = Number(a.y); }
      else {
        const tc = [...this.buildings.values()].find((b) => b.owner === p.id && b.type === 'town_center') || [...this.buildings.values()].find((b) => b.owner === p.id);
        if (!tc) return fail('no_spot', 'no building to spawn next to');
        [tx, ty] = [tc.tx + tc.size / 2, tc.ty + tc.size / 2];
      }
      const made = [];
      const used = new Set();
      for (let i = 0; i < n; i++) {
        const spot = this.freeTileNear(tx, ty, 8, p.id, used); // several units spread over neighbouring free tiles
        if (!spot) break;
        used.add(spot[1] * this.W + spot[0]);
        const u = this.addUnit(p.id, type, spot[0] * 1000 + 500, spot[1] * 1000 + 500);
        if (type === 'worker' && this.opts.autoWorkers) this.autoGather(u);
        made.push(u.id);
      }
      if (!made.length) return fail('no_spot', 'no free tile there');
      this.recalcPop(p);
      const name = type.replace(/_/g, ' ');
      return { ok: true, player: p.id, unit: type, ids: made, text: `${made.length > 1 ? made.length + ' ' : 'a '}${name}${made.length > 1 ? 's' : ''} for ${colorOf(p.id)}` };
    },

    dir_remove(a) {
      const u = this.units.get(+a.id);
      if (!u || u.dead || u.dying) return fail('not_found', `no unit ${a.id}`);
      u.dying = true; // removed without credit for anybody: no kill, no loss value
      this.dead.push(u);
      const name = String(u.type).replace(/_/g, ' ');
      return { ok: true, id: u.id, player: u.owner, text: u.owner ? `removed a ${name} of ${colorOf(u.owner)}` : `removed a ${name}` };
    },

    dir_heal(a) {
      if (isNum(a.id) && !isNum(a.player)) {
        const e = this.units.get(+a.id) || this.buildings.get(+a.id);
        if (!e || e.dead || e.dying) return fail('not_found', `no unit or building ${a.id}`);
        e.hp = e.maxhp;
        return { ok: true, id: e.id, player: e.owner, text: `healed a ${String(e.type).replace(/_/g, ' ')}${e.owner ? ' of ' + colorOf(e.owner) : ''}` };
      }
      const p = this._dirPlayer(a);
      if (!p) return fail('bad_player', 'give an id or a player');
      let n = 0;
      for (const u of this.units.values()) if (u.owner === p.id && !u.dead && !u.dying) { u.hp = u.maxhp; n++; }
      return { ok: true, player: p.id, count: n, text: `healed all ${n} units of ${colorOf(p.id)}` };
    },

    // Forces the map knowledge of a player's team open: its agent really sees everything from now on (until on:false).
    // The spectator-only reveal is not a sim action: it is the fog toggle of the page (/api/fog), nothing in the log.
    dir_reveal(a) {
      const p = this._dirPlayer(a);
      if (!p) return fail('bad_player', 'player must be 1..' + this.numPlayers);
      const on = !(a.on === false || a.on === 0 || a.on === 'off');
      if (on) this.revealed.add(p.team);
      else this.revealed.delete(p.team);
      this.updateVision();
      return { ok: true, player: p.id, on, text: on ? `map revealed for ${colorOf(p.id)} (their agent sees everything)` : `reveal off for ${colorOf(p.id)}` };
    },

    // A small hostile pack from the map edge. With a click the pack comes in at the edge nearest to it, else a random edge.
    // On 2 player maps the mirrored pack arrives at the opposite edge as well, so neither seat is favoured.
    dir_wolves(a) {
      const n = int(a.count, 1, 8, 3);
      const W = this.W;
      let x, y;
      if (isNum(a.x) && isNum(a.y)) {
        x = Math.max(0, Math.min(W - 1, Math.floor(a.x))); y = Math.max(0, Math.min(W - 1, Math.floor(a.y)));
        const dl = x, dr = W - 1 - x, dt = y, db = W - 1 - y, m = Math.min(dl, dr, dt, db);
        if (m === dl) x = 1; else if (m === dr) x = W - 2; else if (m === dt) y = 1; else y = W - 2;
      } else {
        const side = this.dirRng.int(4), pos = this.dirRng.range(Math.floor(W * 0.2), Math.floor(W * 0.8));
        if (side === 0) { x = 1; y = pos; } else if (side === 1) { x = W - 2; y = pos; } else if (side === 2) { x = pos; y = 1; } else { x = pos; y = W - 2; }
      }
      const spots = [[x, y]];
      if (this.numPlayers === 2 && a.mirror !== false) spots.push([W - 1 - x, W - 1 - y]);
      const made = [];
      for (const [sx, sy] of spots) {
        const t0 = this.freeTileNear(sx, sy, 12, 1);
        if (!t0) continue;
        for (let i = 0; i < n; i++) {
          const c = this.freeTileNear(t0[0] + (i % 3) - 1, t0[1] + ((i / 3) | 0), 4, 1) || t0;
          const u = this.addUnit(0, 'wolf', c[0] * 1000 + 500, c[1] * 1000 + 500);
          u.ttl = this.t + WOLF_TTL;
          made.push(u.id);
        }
      }
      if (!made.length) return fail('no_spot', 'no free spot at the map edge');
      const dir = x <= 1 ? 'west' : x >= W - 2 ? 'east' : y <= 1 ? 'north' : 'south';
      return { ok: true, ids: made, text: `wolves! ${made.length} of them come in from the ${dir}${spots.length > 1 ? ' and the opposite edge' : ''}` };
    },

    // A chest worth resources. The first worker (of any player) that gets within reach collects it.
    // Without a click it lies in the middle of the map, which is the fair spot on the mirrored maps.
    dir_treasure(a) {
      const res = a.res === 'mixed' ? 'mixed' : RESOURCES.includes(a.res) ? a.res : 'gold';
      const amount = int(a.amount, 1, 5000, TREASURE.gold);
      const tx = isNum(a.x) ? Number(a.x) : (this.W - 1) / 2, ty = isNum(a.y) ? Number(a.y) : (this.H - 1) / 2;
      const c = this.freeTileNear(tx, ty, 10, 1);
      if (!c) return fail('no_spot', 'no free tile there');
      const reward = res === 'mixed' ? { food: amount, wood: amount, stone: amount, gold: amount } : { [res]: amount };
      const chest = { id: this.nextId++, x: c[0] * 1000 + 500, y: c[1] * 1000 + 500, reward, until: this.t + TREASURE.ttl };
      this.chests.push(chest);
      const what = res === 'mixed' ? `${amount} of each resource` : `${amount} ${res}`;
      return { ok: true, id: chest.id, tile: c, text: `treasure chest (${what}) appears; the first worker to reach it keeps it` };
    },

    // Slows movement and gathering of everybody inside the circle for a while.
    dir_storm(a) {
      const r = int(a.r, 2, STORM.maxR, STORM.defaultR), secs = int(a.secs, 5, STORM.maxSecs, STORM.defaultSecs);
      const x = isNum(a.x) ? Number(a.x) : (this.W - 1) / 2, y = isNum(a.y) ? Number(a.y) : (this.H - 1) / 2;
      const s = { x: Math.round((x + 0.5) * 1000), y: Math.round((y + 0.5) * 1000), r: r * 1000, from: this.t, until: this.t + secs * TICK_HZ };
      this.storms.push(s);
      return { ok: true, text: `storm over (${Math.floor(x)},${Math.floor(y)}) for ${secs}s: slower movement and gathering` };
    },

    // ---------- effects ----------
    inStorm(u) {
      for (const s of this.storms) {
        const dx = u.x - s.x, dy = u.y - s.y;
        if (dx * dx + dy * dy <= s.r * s.r) return true;
      }
      return false;
    },
    stormSpeed(u, sp) {
      return this.inStorm(u) ? Math.max(1, Math.floor((sp * STORM.speedPct) / 100)) : sp;
    },
    stormGather(u) {
      return this.inStorm(u) ? STORM.gatherPct / 100 : 1;
    },

    // wolves: chase the nearest unit of any player, bite, leave after a while
    updateWolf(u) {
      if (u.dead || u.dying) return;
      if (u.cd > 0) u.cd--;
      if (this.t >= u.ttl) { u.dying = true; this.dead.push(u); return; }
      let e = u.tgt ? this.units.get(u.tgt) : null;
      if (e && (e.dead || e.dying)) e = null;
      if (!e || (this.t + u.ph) % 5 === 0) {
        let best = null, bd = Infinity;
        for (const v of this.units.values()) {
          if (v.owner === 0 || v.dead || v.dying) continue;
          const dx = v.px - u.x, dy = v.py - u.y, d = dx * dx + dy * dy;
          if (d < bd || (d === bd && v.id < best.id)) { bd = d; best = v; }
        }
        e = best;
        u.tgt = e ? e.id : 0;
      }
      if (!e) return;
      if (this.engage(u, e) === 'lost') u.tgt = 0;
    },

    directorStep() {
      for (const u of this.units.values()) if (u.owner === 0) this.updateWolf(u);
      if (this.chests.length && this.t % 2 === 0) {
        for (let i = this.chests.length - 1; i >= 0; i--) {
          const c = this.chests[i];
          if (this.t >= c.until) { this.chests.splice(i, 1); this.godNote('the treasure chest crumbles, nobody reached it', 'result'); continue; }
          let best = null, bd = TREASURE.reach * TREASURE.reach;
          for (const u of this.units.values()) {
            if (u.type !== 'worker' || u.dead || u.dying) continue;
            const dx = u.x - c.x, dy = u.y - c.y, d = dx * dx + dy * dy;
            if (d < bd || (d === bd && best && u.id < best.id)) { bd = d; best = u; }
          }
          if (!best) continue;
          const p = this.players[best.owner];
          for (const [r, v] of Object.entries(c.reward)) p.res[r] += v;
          this.chests.splice(i, 1);
          const parts = Object.entries(c.reward).map(([r, v]) => `${v} ${r}`).join(', ');
          this.godNote(`${colorOf(best.owner)} found the treasure: +${parts}`, 'result', best.owner);
        }
      }
      if (this.storms.length) this.storms = this.storms.filter((s) => this.t < s.until);
    },

    hashDirector(h) {
      h = hashStep(h, this.dirRng.s);
      for (const c of this.chests) { h = hashStep(h, c.id); h = hashStep(h, c.x); h = hashStep(h, c.y); }
      for (const s of this.storms) { h = hashStep(h, s.x); h = hashStep(h, s.y); h = hashStep(h, s.until); }
      for (const t of this.revealed) h = hashStep(h, 1000 + t);
      return h;
    },

    // what the spectator page needs to draw the interventions (small; only sent once God mode was used)
    godView() {
      return {
        on: this.godMode,
        feed: this.godFeed.slice(-8),
        storms: this.storms.map((s) => [Math.round(s.x / 10) / 100, Math.round(s.y / 10) / 100, s.r / 1000, s.until - this.t, s.until - s.from]),
        chests: this.chests.map((c) => [c.id, Math.round(c.x / 10) / 100, Math.round(c.y / 10) / 100]),
        revealed: [...this.revealed],
      };
    },
  };
  Object.assign(Game.prototype, methods);
}
