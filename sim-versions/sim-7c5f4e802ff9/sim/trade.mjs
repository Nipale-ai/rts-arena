// Market: swap resources at prices that move with use, and send tribute to allies (content 2).
// Every player has its own price index per resource (per mille, 1000 = base price). Nothing is global, nothing is random:
// the same command log gives the same prices. See MARKET in data.mjs for the numbers.
//
//   trade   {sell, buy, amount}      swap `amount` of one resource for another at the current prices (needs a finished market)
//   tribute {to, resource, amount}   give resources to an ally (needs a finished market, a part is lost as fee)
//
// Selling lowers the price index of the sold resource, buying raises the index of the bought one (impactPct % per 100 units).
// Every recoverEvery ticks the indices drift back toward 1000.
import { MARKET, RESOURCES } from './data.mjs';
import { hashStep } from './util.mjs';

const fail = (error, message) => ({ ok: false, error, message });
const BASE_PX = 1000;

export function newMarketState() {
  return { px: { food: BASE_PX, wood: BASE_PX, stone: BASE_PX, gold: BASE_PX }, trades: 0, tributes: 0 };
}

// How many units of `buy` do `amount` units of `sell` fetch right now (integer maths, no state change)
export function quote(p, sell, buy, amount) {
  const m = p.mkt.px;
  const value = amount * MARKET.base[sell] * m[sell];
  const net = Math.floor((value * (100 - p.tradeFee)) / 100);
  return Math.floor(net / (MARKET.base[buy] * m[buy]));
}

// Compact view for observations: price indices and what 100 units of each resource fetch in every other resource
export function marketView(p) {
  const sell100 = {};
  for (const s of RESOURCES) {
    sell100[s] = {};
    for (const b of RESOURCES) if (b !== s) sell100[s][b] = quote(p, s, b, 100);
  }
  return { price_index: { ...p.mkt.px }, fee_pct: p.tradeFee, sell100 };
}

export function installTrade(Game) {
  const methods = {
    ownMarket(p) {
      for (const b of this.buildings.values()) if (b.owner === p.id && !b.dead && b.built && !b.dying && p.faction.buildings[b.type].trade) return b;
      return null;
    },

    cmd_trade(p, a) {
      const sell = a.sell ?? a.give ?? a.from, buy = a.buy ?? a.get ?? a.for;
      if (!RESOURCES.includes(sell) || !RESOURCES.includes(buy)) return fail('bad_args', `sell and buy must be one of ${RESOURCES.join(', ')}`);
      if (sell === buy) return fail('bad_args', 'sell and buy must be different resources');
      if (!this.ownMarket(p)) return fail('no_market', 'you need a finished market (tier 2) to trade');
      let n = a.amount === 'all' ? Math.min(p.res[sell], MARKET.maxTrade) : Number(a.amount);
      if (!Number.isInteger(n) || n < MARKET.minTrade) return fail('bad_args', `amount must be a whole number from ${MARKET.minTrade} to ${MARKET.maxTrade}`);
      n = Math.min(n, MARKET.maxTrade);
      if (p.res[sell] < n) return fail('insufficient_resources', `you have ${Math.floor(p.res[sell])} ${sell}, not ${n}`);
      const got = quote(p, sell, buy, n);
      if (got < 1) return fail('too_small', `${n} ${sell} is too little to fetch any ${buy}`);
      const m = p.mkt;
      p.res[sell] -= n;
      p.res[buy] += got;
      m.px[sell] = Math.max(MARKET.pMin, m.px[sell] - Math.floor((m.px[sell] * n * MARKET.impactPct) / 10000));
      m.px[buy] = Math.min(MARKET.pMax, m.px[buy] + Math.floor((m.px[buy] * got * MARKET.impactPct) / 10000));
      m.trades++;
      return { ok: true, sold: n, sold_resource: sell, got, got_resource: buy, price_index: { ...m.px } };
    },

    cmd_tribute(p, a) {
      const res = a.resource ?? a.res;
      if (!RESOURCES.includes(res)) return fail('bad_args', `resource must be one of ${RESOURCES.join(', ')}`);
      const to = this.players[Math.round(Number(a.to))];
      if (!to) return fail('bad_target', 'to must be the number of an allied player');
      if (to.id === p.id) return fail('bad_target', 'you cannot send tribute to yourself');
      if (to.team !== p.team) return fail('not_allied', `player ${to.id} is not your ally`);
      if (!to.alive) return fail('bad_target', `player ${to.id} is out of the match`);
      if (!this.ownMarket(p)) return fail('no_market', 'you need a finished market (tier 2) to send tribute');
      let n = a.amount === 'all' ? Math.min(Math.floor(p.res[res]), MARKET.maxTrade) : Number(a.amount);
      if (!Number.isInteger(n) || n < MARKET.minTrade) return fail('bad_args', `amount must be a whole number from ${MARKET.minTrade} to ${MARKET.maxTrade}`);
      n = Math.min(n, MARKET.maxTrade);
      if (p.res[res] < n) return fail('insufficient_resources', `you have ${Math.floor(p.res[res])} ${res}, not ${n}`);
      const got = Math.floor((n * (100 - MARKET.tributeFeePct)) / 100);
      p.res[res] -= n;
      to.res[res] += got;
      p.mkt.tributes++;
      this.event(to, { type: 'tribute', from: p.id, res, amount: got });
      return { ok: true, sent: n, received: got, resource: res, to: to.id };
    },

    // prices drift back toward the base price
    marketRecover() {
      for (const p of this.players) {
        if (!p) continue;
        const px = p.mkt.px;
        for (const r of RESOURCES) {
          const gap = BASE_PX - px[r];
          if (!gap) continue;
          const step = Math.max(1, Math.floor((Math.abs(gap) * MARKET.recoverPct) / 100));
          px[r] += gap > 0 ? Math.min(step, gap) : -Math.min(step, -gap);
        }
      }
    },

    hashMarket(h) {
      for (const p of this.players) {
        if (!p || !(p.mkt.trades || p.mkt.tributes)) continue;
        for (const r of RESOURCES) h = hashStep(h, p.mkt.px[r]);
      }
      return h;
    },
  };
  Object.assign(Game.prototype, methods);
}
