// Standing orders: rules a player sets once and the sim keeps executing every half second
// (auto_train, attack_wave, auto_build_houses). Same for every player. Deterministic: the orders live in
// player state (p.standing), are evaluated at fixed ticks in the same rotating player order as all updates,
// and are part of the state hash. Setting/cancelling an order is a normal command (logged in the replay);
// the evaluation itself is not logged because it follows from the state.
import { POP_MAX, RULES } from './data.mjs';

export const STANDING_MAX = 8;
export const STANDING_EVERY = 5; // ticks between evaluations
const WAVE_GAP = 100; // ticks (10 s) between two launches of one wave order
const HOUSE_RETRY = 50;

const isXY = (v) => Array.isArray(v) && v.length === 2 && Number.isFinite(+v[0]) && Number.isFinite(+v[1]);
const fail = (error, message) => ({ ok: false, error, message });

export function installStanding(Game) {
  const methods = {
    addStanding(p, o) {
      // same kind + same key replaces the old order
      const i = p.standing.findIndex((s) => s.kind === o.kind && s.key === o.key);
      if (i >= 0) { o.id = p.standing[i].id; p.standing[i] = o; return o; }
      if (p.standing.length >= STANDING_MAX) return null;
      o.id = ++p.standingSeq;
      p.standing.push(o);
      return o;
    },

    cmd_auto_train(p, a) {
      const unit = a.unit_type;
      const ud = p.faction.units[unit];
      if (!ud) return fail('unknown_unit', `unknown unit type "${unit}"`);
      let bid = null, btype = ud.from;
      if (a.building_id !== undefined && a.building_id !== null) {
        const b = this.buildings.get(+a.building_id);
        if (!b || b.dead || b.owner !== p.id) return fail('not_found', `no building ${a.building_id} of yours`);
        if (b.type !== ud.from) return fail('cannot_train_here', `${b.type} cannot train ${unit} (${unit} is trained at ${ud.from})`);
        bid = b.id;
      } else if (a.type !== undefined && a.type !== null && a.type !== ud.from) return fail('cannot_train_here', `${unit} is trained at ${ud.from}`);
      let keep = a.keep_queue === undefined || a.keep_queue === null ? null : +a.keep_queue;
      let until = a.until_count === undefined || a.until_count === null ? null : +a.until_count;
      if (keep === null && until === null) keep = 2;
      if (keep !== null && (!Number.isInteger(keep) || keep < 1 || keep > RULES.maxQueue)) return fail('bad_args', `keep_queue must be 1..${RULES.maxQueue}`);
      if (until !== null && (!Number.isInteger(until) || until < 1 || until > POP_MAX)) return fail('bad_args', `until_count must be 1..${POP_MAX}`);
      const o = this.addStanding(p, { kind: 'train', key: `${bid ?? btype}:${unit}`, bid, btype, unit, keep, until, fired: 0 });
      if (!o) return fail('too_many_standing', `at most ${STANDING_MAX} standing orders; cancel one first`);
      return { ok: true, standing_id: o.id, kind: 'auto_train' };
    },

    cmd_attack_wave(p, a) {
      const min = a.min_army === undefined ? 10 : +a.min_army;
      if (!Number.isInteger(min) || min < 1 || min > POP_MAX) return fail('bad_args', `min_army must be 1..${POP_MAX}`);
      let target = a.target === undefined || a.target === null ? 'enemy_base' : a.target;
      if (typeof target === 'string' && /^\s*\[/.test(target)) { try { target = JSON.parse(target); } catch { /* keep */ } }
      if (target !== 'enemy_base') {
        if (!isXY(target)) return fail('bad_args', 'target must be [x, y] or "enemy_base"');
        target = this.clampXY(target);
      }
      const sel = a.group === undefined || a.group === null ? 'army' : String(a.group);
      if (sel !== 'army' && !sel.startsWith('type:') && !p.groups.has(sel)) return fail('bad_args', `group must be "army", "type:<unit_type>" or a group name`);
      const o = this.addStanding(p, { kind: 'wave', key: 'wave', min, target, sel, next: 0, fired: 0 });
      if (!o) return fail('too_many_standing', `at most ${STANDING_MAX} standing orders; cancel one first`);
      return { ok: true, standing_id: o.id, kind: 'attack_wave' };
    },

    cmd_auto_build_houses(p, a) {
      const on = a.on === undefined ? true : !(a.on === false || a.on === 'false' || a.on === 'off' || a.on === 0);
      if (!on) {
        p.standing = p.standing.filter((s) => s.kind !== 'houses');
        return { ok: true, kind: 'auto_build_houses', on: false };
      }
      const margin = a.margin === undefined ? 5 : +a.margin;
      if (!Number.isInteger(margin) || margin < 1 || margin > 30) return fail('bad_args', 'margin must be 1..30');
      const o = this.addStanding(p, { kind: 'houses', key: 'houses', margin, next: 0, fired: 0 });
      if (!o) return fail('too_many_standing', `at most ${STANDING_MAX} standing orders; cancel one first`);
      return { ok: true, standing_id: o.id, kind: 'auto_build_houses', on: true };
    },

    cmd_cancel_standing(p, a) {
      const id = a.id;
      if (id === 'all' || id === undefined || id === null) { const n = p.standing.length; p.standing = []; return { ok: true, cancelled: n }; }
      const before = p.standing.length;
      p.standing = p.standing.filter((s) => s.id !== +id);
      if (p.standing.length === before) return fail('not_found', `no standing order ${id}`);
      return { ok: true, cancelled: 1 };
    },

    // ---- evaluation (called by step for every living player) ----
    runStanding(p) {
      if (!p.alive || !p.standing.length) return;
      for (const o of p.standing) {
        if (o.kind === 'train') this.standingTrain(p, o);
        else if (o.kind === 'wave') this.standingWave(p, o);
        else if (o.kind === 'houses') this.standingHouses(p, o);
      }
    },

    standingTrain(p, o) {
      const ud = p.faction.units[o.unit];
      if (ud.tier > p.tier) return;
      const bs = [];
      for (const b of this.buildings.values()) {
        if (b.owner !== p.id || b.dead || !b.built) continue;
        if (o.bid ? b.id === o.bid : b.type === o.btype) bs.push(b);
      }
      if (!bs.length) return;
      let have = 0;
      if (o.until !== null) {
        for (const u of this.units.values()) if (u.owner === p.id && !u.dead && u.type === o.unit) have++;
        for (const b of this.buildings.values()) if (b.owner === p.id) for (const q of b.queue) if (q.kind === 'unit' && q.type === o.unit) have++;
        if (have >= o.until) return;
      }
      for (const b of bs) {
        let inQ = 0;
        for (const q of b.queue) if (q.kind === 'unit' && q.type === o.unit) inQ++;
        let want = o.keep === null ? 1 : o.keep - b.queue.length;
        if (o.until !== null) want = Math.min(want, o.until - have);
        if (want <= 0) continue;
        const r = this.cmd_train(p, { building_id: b.id, unit_type: o.unit, count: Math.min(want, RULES.trainMaxCount) });
        if (r.ok) { o.fired += r.queued; have += r.queued; }
        else if (r.error === 'insufficient_resources' || r.error === 'pop_cap') return; // nothing more can be paid this round
        void inQ;
      }
    },

    // Walkable tile just outside a building footprint, on the side that faces the player's own start (the building
    // tile itself is blocked; arriving units then attack what is within reach). Mirror safe: only signs and sizes.
    standingStage(p, tx, ty, size) {
      const home = this.starts[p.id - 1];
      const gx = tx === home.tx ? 0 : tx > home.tx ? -2 : size + 1, gy = ty === home.ty ? 0 : ty > home.ty ? -2 : size + 1;
      return this.clampXY([tx + gx, ty + gy]);
    },

    standingEnemyTarget(p) {
      const home = this.starts[p.id - 1];
      const hx = home.tx + 2, hy = home.ty + 2;
      let best = null, bk = Infinity;
      const prio = (t) => (t === 'town_center' ? 0 : p.faction.buildings[t]?.production ? 1 : 2);
      for (const k of p.known.values()) {
        if (this.team[k.owner] === p.team) continue;
        const s = p.faction.buildings[k.type]?.size ?? 2;
        const cx = k.tx + s / 2, cy = k.ty + s / 2;
        const key = prio(k.type) * 1e9 + (cx - hx) ** 2 + (cy - hy) ** 2;
        if (key < bk || (key === bk && this.tieKey(p.id, k.tx, k.ty) < this.tieKey(p.id, best.tx, best.ty))) { bk = key; best = k; best.s = s; }
      }
      if (best) return this.standingStage(p, best.tx, best.ty, best.s);
      for (const q of this.players) {
        if (!q || q.team === p.team || !q.alive) continue;
        const st = this.starts[q.id - 1];
        const key = (st.tx + 2 - hx) ** 2 + (st.ty + 2 - hy) ** 2;
        if (key < bk) { bk = key; best = { tx: st.tx, ty: st.ty, s: 4 }; }
      }
      return best ? this.standingStage(p, best.tx, best.ty, 4) : null;
    },

    standingWave(p, o) {
      if (this.t < o.next) return;
      const sel = this.resolveUnits(p, o.sel);
      if (sel.error) return;
      const ready = sel.list.filter((u) => u.type !== 'worker' && u.ord.t === 'idle');
      if (ready.length < o.min) return;
      const tg = o.target === 'enemy_base' ? this.standingEnemyTarget(p) : o.target;
      if (!tg) return;
      const r = this.cmd_attack_move(p, { units: ready.map((u) => u.id), target: tg });
      if (r.ok) { o.fired++; o.next = this.t + WAVE_GAP; o.last = ready.length; }
    },

    standingHouses(p, o) {
      if (this.t < o.next || p.cap >= POP_MAX) return;
      let pending = 0;
      for (const b of this.buildings.values()) if (b.owner === p.id && !b.dead && b.type === 'house' && !b.built) pending++;
      const hd = p.faction.buildings.house;
      const room = p.cap + pending * (hd.pop || 0) - p.pop;
      if (room > o.margin || pending >= 2) return;
      if (p.res.wood < hd.cost.wood) return;
      let tc = null;
      for (const b of this.buildings.values()) if (b.owner === p.id && !b.dead && b.type === 'town_center') { tc = b; break; }
      if (!tc) return;
      const r = this.cmd_build(p, { building_type: 'house', near: tc.id, worker_ids: 'auto' });
      if (r.ok) { o.fired++; o.next = this.t + 10; } else o.next = this.t + HOUSE_RETRY;
    },
  };
  Object.assign(Game.prototype, methods);
}

// Short labels for the HUD chips.
export function standingChips(p) {
  return p.standing.map((o) => {
    if (o.kind === 'train') return `train ${o.unit.replace(/_/g, ' ')}${o.keep !== null ? ` q${o.keep}` : ''}${o.until !== null ? ` to ${o.until}` : ''}`;
    if (o.kind === 'wave') return `wave ${o.min}+${o.fired ? ` (${o.fired}x)` : ''}`;
    return 'auto houses';
  });
}

// Compact description for the observation.
export function standingObs(p) {
  return p.standing.map((o) => {
    if (o.kind === 'train') return { id: o.id, order: 'auto_train', unit_type: o.unit, ...(o.bid ? { building_id: o.bid } : { at: o.btype }), ...(o.keep !== null ? { keep_queue: o.keep } : {}), ...(o.until !== null ? { until_count: o.until } : {}), queued_total: o.fired };
    if (o.kind === 'wave') return { id: o.id, order: 'attack_wave', min_army: o.min, target: o.target, group: o.sel, waves_sent: o.fired };
    return { id: o.id, order: 'auto_build_houses', margin: o.margin, houses_started: o.fired };
  });
}
