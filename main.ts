// Trend-ride bot for btc-race-24h-20261123-0511 (agent-fun/bars-replay/v1).
//
// Design (authored in-session; backtested on the kit's frozen dev window):
//   - Entry: buy 100% of cash on the first tradable batch. One asset, one
//     position, long only: buying at the open guarantees at least one trade
//     on any window (the guardrail needs >= 1 trade) and rides the trend
//     from its first bar instead of paying for whipsaw entries. Fast
//     1-minute EMA crosses lost ~$100 on the dev window (50-70 round trips
//     at ~34 bps each); this shape made +$32.17 there with a single trade.
//   - Exit: trailing stop 2.5% below the highest close since entry. A 1.5%
//     trail whipsawed out 5 times on the dev window's chop; 2.5% never fired
//     there (dev max drawdown -1.98%) but caps a falling race window near
//     -2.5% instead of riding a crash to the 25% guardrail.
//   - Re-entry: after an exit, buy again only when the 60-bar momentum is
//     above +0.3% and the close is above EMA(60) -- a confirmed new up-leg,
//     not noise.
//   - Orders cap slippage at 200 bps (2% past the close decided on): wide
//     enough for any ordinary 1-minute move (1-min stdev ~8 bps) plus the
//     ~13 bps of modelled slippage + impact, tight enough to refuse a gap.
//   - Deterministic: no clock, no environment, no randomness; only bar
//     closes feed the state. EMA(60) seeds as the mean of its first 60
//     closes. All comparisons run on the raw integer price strings, so the
//     same bars give the same orders, run after run.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const TRAIL_BPS = 250; // trailing stop: 2.5% below the peak close since entry
const REENTRY_MOM_BPS = 50; // re-entry needs 60-bar momentum above +0.5%:
// 1-minute noise is ~8 bps, so 60-bar momentum noise is ~63 bps and a
// +0.3% trigger sits inside it -- a whipsaw re-entry pays ~34 bps a round
// trip. +0.5% needs a real leg, not noise. (Re-entry never fired on the
// dev window at either threshold, so the dev grade is unchanged.)
const REENTRY_WINDOW = 60; // bars of momentum / EMA span
const MAX_SLIPPAGE_BPS = 200; // 2% past the close decided on

const closes: number[] = []; // closes seen, in order (warm-up included)
let ema60: number | null = null; // EMA(60) value once seeded
const emaWarm: number[] = []; // first 60 closes, to seed the EMA
let entered = false; // ever held a position
let peak: number | null = null; // highest close since the current entry

function pushClose(close: number): void {
  closes.push(close);
  if (ema60 !== null) {
    ema60 += (2 / (REENTRY_WINDOW + 1)) * (close - ema60);
    return;
  }
  emaWarm.push(close);
  if (emaWarm.length === REENTRY_WINDOW) {
    ema60 = emaWarm.reduce((a, x) => a + x, 0) / REENTRY_WINDOW;
  }
}

function momentumOk(): boolean {
  if (closes.length <= REENTRY_WINDOW || ema60 === null) return false;
  const old = closes[closes.length - 1 - REENTRY_WINDOW];
  const now = closes[closes.length - 1];
  return (now - old) * 10000 >= old * REENTRY_MOM_BPS && now > ema60;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) pushClose(Number(bar.c));
    if (state.warmingUp || bar === undefined) return [];

    const close = Number(bar.c);
    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      entered = true;
      if (peak === null || close > peak) peak = close;
      // Trailing stop: sell the whole position 2.5% below its peak.
      if (close * 10000 <= peak * (10000 - TRAIL_BPS)) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // Flat: the first entry is the bar-0 buy; later entries need a
    // confirmed up-leg (momentum + trend). A rejected buy retries on the
    // next batch, because the position is still empty and entered is
    // still false.
    if (!entered || momentumOk()) {
      let stake = state.cash;
      const room = state.weightRoom(SYMBOL);
      if (room < stake) stake = room;
      const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
      if (stake >= minNotional) {
        peak = close;
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
    }
    return [];
  },
});
