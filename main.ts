// Pump Sprint Momentum — a paper-trading bot for the pump.fun replay.
//
// The harness says hello once, then sends one batch per slot; this bot answers
// each batch with its orders. The strategy is early momentum with a trailing
// exit:
//
//   Buy: a coin is "hot" when it is young (created within the last ~24 minutes),
//   its price has risen at least 25% over its creation price (but no more than
//   2x — never chase a coin that already ran), it has at least 5 trades, and
//   its real SOL reserve is at least 2 SOL (so the 1%-of-reserve size cap lets
//   us buy a meaningful amount). We buy 0.05 SOL per coin, at most two buys per
//   batch, one buy per coin, at most five open positions.
//
//   Sell: a trailing stop. Each position's stop is the higher of a hard floor
//   (-15% under cost) and 80% of the highest mark value the position has
//   reached, so losers are cut at -15% while winners keep running until they
//   pull back 20% from their peak — on pump.fun the rare coins that go several
//   times over are where the money is, and a fixed take-profit would throw
//   that tail away. A time exit sells whatever is left after ~16 minutes held.
//
//   Guardrail: the replay ranks entries below every entry that meets its bar
//   unless they round-trip at least 0.01 SOL on at least 20 distinct coins, so
//   the bot buys each coin at most once and spreads across many coins. If the
//   window is half over and fewer than 20 coins have been traded, the buy
//   trigger loosens (momentum >= 10%, reserve >= 1 SOL, trades >= 3) so the
//   bar is still met.
//
// Determinism: the replay executes every entry twice and the two action logs
// must match byte for byte, so the bot never reads the clock, the environment,
// or Math.random. Every decision comes from the harness state and the constants
// below, and coins are always considered in creation order.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BuyInput,
  type SellInput,
} from "./vendor/makefun-bot.ts";

// --- tuning (lamports, slots, or whole percent) ---

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL per coin
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 50n; // 0.02 SOL: never buy smaller
const ENTRY_CAP_MIN_LAMPORTS = (LAMPORTS_PER_SOL * 3n) / 100n; // 0.03 SOL: the size cap must clear this before we buy, so a small reserve dip between decision and fill does not get the buy rejected
const MAX_SLIPPAGE_BPS = 10_000; // wide open: latency must never refuse a fill
const MAX_BUYS_PER_BATCH = 2;
const YOUNG_SLOTS = 3600; // a coin is "young" for ~24 minutes
const MAX_HOLD_SLOTS = 2400; // time exit after ~16 minutes
const HARD_STOP_PCT = 85; // hard floor: sell at -15% under cost
const TRAIL_PCT = 80; // trailing stop: sell at 80% of the position's peak value
const MOMENTUM_PCT = 125; // buy when the price is +25% over creation
const MAX_MOMENTUM_PCT = 200; // never chase a coin already up 2x from creation
const MIN_TRADES = 5;
const MIN_RESERVE_LAMPORTS = 2n * LAMPORTS_PER_SOL; // real SOL reserve >= 2 SOL
const GUARDRAIL_MINTS = 20;
const LOOSE_AFTER_SLOTS = 27000; // loosen the buy trigger past ~half the window
const LOOSE_MOMENTUM_PCT = 110; // loose tier: buy at +10% over creation
const LOOSE_MIN_TRADES = 3;
const LOOSE_MIN_RESERVE_LAMPORTS = LAMPORTS_PER_SOL; // loose tier: reserve >= 1 SOL

// --- helpers ---

/**
 * True when (numA / denA) >= (numB / denB) * pct / 100, in exact integer math.
 * Used for the momentum check: is the current price at least pct% of the price
 * at creation?
 */
function atLeast(numA: bigint, denA: bigint, numB: bigint, denB: bigint, pct: number): boolean {
  if (denA === 0n || denB === 0n) return false;
  return numA * denB * 100n >= numB * denA * BigInt(pct);
}

/** Mark value of `tokens` at the curve's current reserves, in lamports. */
function markValueLamports(tokens: bigint, virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken === 0n) return 0n;
  return (tokens * virtualQuote) / virtualToken;
}

// --- per-coin records ---

interface Candidate {
  firstQuote: bigint; // virtual SOL reserves at creation
  firstToken: bigint; // virtual token reserves at creation
  createdSlot: number;
  trades: number;
}

const candidates = new Map<string, Candidate>();
const bought = new Set<string>(); // mints with a filled buy (never buy twice)
const entrySlot = new Map<string, number>(); // mint -> slot of the buy fill
const peakValue = new Map<string, bigint>(); // mint -> highest mark value since entry

let startSlot = -1; // slot of the first batch, for the loosening tier

await runBot({
  onHello(state) {
    console.error(
      `pump-sprint-momentum: hello, capital=${state.hello.capital.lamports} lamports, ` +
        `max positions=${state.hello.caps.max_open_positions}, seed=${state.hello.seed}`,
    );
  },

  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    if (startSlot < 0) startSlot = state.slot;

    // 1. Fold in the fills that resolved since the previous batch.
    for (const fill of batch.fills) {
      if (fill.side === "buy" && fill.status === "filled") {
        bought.add(fill.mint);
        entrySlot.set(fill.mint, fill.slot);
        candidates.delete(fill.mint);
      }
    }
    // Drop bookkeeping for positions that are gone (sold, completed, flattened).
    for (const mint of [...entrySlot.keys()]) {
      if (!state.positions.has(mint)) {
        const hasPendingSell = [...state.pending.values()].some(
          (p) => p.order.side === "sell" && p.order.mint === mint,
        );
        if (!hasPendingSell) {
          entrySlot.delete(mint);
          peakValue.delete(mint);
        }
      }
    }

    // 2. Track new and trading coins from this batch's events.
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        if (!candidates.has(e.mint) && !bought.has(e.mint)) {
          candidates.set(e.mint, {
            firstQuote: BigInt(e.virtual_quote_reserves),
            firstToken: BigInt(e.virtual_token_reserves),
            createdSlot: e.slot,
            trades: 0,
          });
        }
      } else if (e.event === "TradeEvent") {
        const c = candidates.get(e.mint);
        if (c !== undefined) c.trades += 1;
      } else {
        // CompleteEvent: the curve is done; never trade it again.
        candidates.delete(e.mint);
      }
    }
    // Prune coins that are too old or complete.
    for (const [mint, c] of candidates) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || state.slot - c.createdSlot > YOUNG_SLOTS) {
        candidates.delete(mint);
      }
    }

    const orders: (BuyInput | SellInput)[] = [];
    const pendingSells = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === "sell") pendingSells.add(p.order.mint);
    }

    // 3. Exits first: free slots before deciding new buys. A coin with a sell
    // already in flight is skipped, so a position is never sold twice.
    for (const [mint, pos] of state.positions) {
      if (pendingSells.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const cost = pos.cost_lamports;
      const value = markValueLamports(
        pos.token_amount,
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
      );
      const peak = peakValue.get(mint) ?? cost;
      peakValue.set(mint, peak > value ? peak : value);
      const hardStop = (cost * BigInt(HARD_STOP_PCT)) / 100n;
      const trailStop = (peakValue.get(mint)! * BigInt(TRAIL_PCT)) / 100n;
      const stop = hardStop > trailStop ? hardStop : trailStop;
      if (!entrySlot.has(mint)) entrySlot.set(mint, state.slot);
      const held = state.slot - (entrySlot.get(mint) ?? state.slot);
      const sell = { side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS } as const;
      if (value <= stop) {
        orders.push(sell); // hard stop or trailing stop
      } else if (held > MAX_HOLD_SLOTS) {
        orders.push(sell); // time exit
      }
    }

    // 4. Entries: hot young coins, in creation order. Past half the window,
    // with fewer than twenty coins traded, the trigger loosens so the
    // guardrail is still met.
    const loose = state.slot - startSlot > LOOSE_AFTER_SLOTS && bought.size < GUARDRAIL_MINTS;
    const momentumPct = loose ? LOOSE_MOMENTUM_PCT : MOMENTUM_PCT;
    const minTrades = loose ? LOOSE_MIN_TRADES : MIN_TRADES;
    const minReserve = loose ? LOOSE_MIN_RESERVE_LAMPORTS : MIN_RESERVE_LAMPORTS;
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    let buys = 0;
    const pendingBuys = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === "buy") pendingBuys.add(p.order.mint);
    }
    for (const [mint, c] of candidates) {
      if (buys >= MAX_BUYS_PER_BATCH || slots <= 0) break;
      if (bought.has(mint) || pendingBuys.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < minReserve) continue;
      if (c.trades < minTrades) continue;
      if (
        !atLeast(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          c.firstQuote,
          c.firstToken,
          momentumPct,
        )
      ) {
        continue;
      }
      if (
        atLeast(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          c.firstQuote,
          c.firstToken,
          MAX_MOMENTUM_PCT,
        )
      ) {
        continue; // already up 2x from creation: chasing, skip it
      }
      const cap = state.maxBuyLamports(mint);
      if (cap < ENTRY_CAP_MIN_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS || free < amount + tx) continue;
      orders.push({ side: "buy", mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      free -= amount + tx;
      slots -= 1;
      buys += 1;
    }

    return orders;
  },

  onDone(state, done) {
    console.error(
      `pump-sprint-momentum: done (${done.reason}), cash=${state.cash} lamports, ` +
        `positions=${state.positions.size}, distinct mints traded=${bought.size}`,
    );
  },
});
