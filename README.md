# Pump Sprint Momentum

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ZQ051031/pump-fun-paper-sprint-20261124/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ZQ051031/pump-fun-paper-sprint-20261124/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the make.fun **Pump.fun Paper Sprint** competition
(`u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`). It trades pump.fun
bonding curves on a 6-hour replay; the highest net PnL wins. No real funds,
no network, no secrets — everything the bot runs is in this repository.

## Strategy

Early momentum with tight exits. The bot watches every new coin and buys only
the ones showing real buying pressure, then exits on a fixed plan:

- **Buy** — a coin is "hot" when it is young (created within the last ~24
  minutes), its price has risen at least 25% over its creation price, it has
  at least 5 trades, and its real SOL reserve is at least 2 SOL (so the
  1%-of-reserve size cap lets us buy a meaningful amount). We buy 0.05 SOL per
  coin, at most two buys per batch, one buy per coin, at most five open
  positions.
- **Sell** — take profit at +30% over cost, stop loss at −15% under cost, a
  breakeven stop (moved up to the entry price) once a position is up 15%, and
  a time exit after ~16 minutes held. All exits are measured against the
  position's cost basis, in exact integer lamport math.
- **Spread** — the replay ranks entries below every entry that meets its bar
  unless they round-trip at least 0.01 SOL on at least 20 distinct coins, so
  the bot buys each coin at most once and spreads across many coins.

## Determinism

The replay executes every entry twice and the two action logs must match byte
for byte, so the bot never reads the clock, the environment, or `Math.random`.
Every decision comes from the harness state and the constants in `main.ts`,
and coins are always considered in creation order.

## Layout

- `main.ts` — the strategy. Run by the grader as `node /bot/main.ts`
  (Node 22 strips the types; no build, no install).
- `vendor/makefun-bot.ts` — the `agent-fun/replay/v2` protocol shim from the
  competition kit (byte-identical to `sdk/ts/makefun-bot.ts`). It owns the
  stdin/stdout wire: it reads the harness's `hello` / `batch` / `done` lines
  and writes one reply per batch.

## Local test

The bot speaks the replay protocol on stdin/stdout, so any harness that feeds
it `hello`, `batch`, and `done` JSON lines can run it. Feed it the kit's dev
dataset through the replay harness and check that it trades, exits, and
reproduces the same action log twice.

## License

MIT — see `LICENSE`.
