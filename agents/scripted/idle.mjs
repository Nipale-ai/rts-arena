// Idle: level 0 of the solo ladder. A small capped economy and nothing else.
// It never trains a soldier, never attacks, never gives a move order and never advances beyond tier 1. Its only defence is what the
// game does by itself (town center arrows, units that answer a hit). Workers: exactly WORKER_CAP. Houses on demand, lumber and mining
// camp, mill and farms come from the economy code of the style bots (ScriptedBot.eco). No chat (the other side would read it).
import { ScriptedBot } from './common.mjs';
import { stringToIds } from '../../sim/util.mjs';

export const WORKER_CAP = 16;

export const profile = {
  name: 'idle',
  mill: true,
  workers: () => WORKER_CAP,
  ratio: () => ({ food: 45, wood: 40, gold: 10, stone: 5 }),
};

export class IdleBot extends ScriptedBot {
  think(o) {
    this.cmds = [];
    this.bud = { ...o.res };
    this.ingest(o);
    this.reserve = {};
    // The style bots scale the worker target by a seat-fair role of +-8 % (common.mjs JITTER_WORKERS). The cap of level 0 is exact,
    // so the role stays out of the economy code; the seats then play it alike.
    const role = this.s.role;
    this.s.role = 0;
    this.eco(this.withoutStuck(o));
    this.s.role = role;
    const last = this.cmds.filter((c) => c.cmd !== 'gather').pop();
    let what = 'working the fields';
    if (last) what = last.cmd === 'build' ? `building ${last.building_type}` : last.cmd === 'train' ? `training ${last.count > 1 ? last.count + ' ' : ''}${last.unit_type}` : last.cmd;
    this.intent = `${this.name}: ${what}`.slice(0, 120);
    return this.cmds;
  }

  // A worker that cannot move (workers.stuck_ids: walled in) refuses every gather order. The economy code counts it as idle and would
  // ask again every turn; level 0 does not count it.
  withoutStuck(o) {
    const wk = o.workers;
    if (!wk.idle || !wk.stuck_ids) return o;
    const stuck = stringToIds(wk.stuck_ids), idle = stringToIds(wk.idle_ids || '');
    if (!stuck || !idle) return o; // a list cut off with ",..." (more than 40 idle workers: not at the cap of 16)
    const gone = new Set(stuck);
    return { ...o, workers: { ...wk, idle: idle.filter((id) => !gone.has(id)).length } };
  }
}

export function createBot() {
  return new IdleBot(profile);
}
