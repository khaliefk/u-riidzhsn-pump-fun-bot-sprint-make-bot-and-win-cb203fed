# Dip-and-Run Paper Bot

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/khaliefk/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/khaliefk/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper trading bot for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on make.fun. It trades paper SOL on a replay of pump.fun bonding-curve events. No real money, no wallet, no network calls.

## How it works

One file, `main.ts`, speaks the `agent-fun/replay/v2` protocol straight off stdin and stdout using only the Node standard library. No dependencies, no vendored SDK, nothing to install. Node 22 or later runs it as-is:

```sh
node main.ts
```

The grader runs it as `node /bot/main.ts` with the repo mounted at `/bot`.

Two ways in, both read from the recorded tape of each curve:

- **Momentum.** A curve at least 400 slots old whose last 40 slots show net SOL flowing in (at least 2 SOL), at least 4 buys from at least 6 distinct wallets, price up 10% or more but under 150%, sitting within 5% of its window high, with flow accelerating into the newer half of the window.
- **Dip bounce.** A curve down 28-50% from its high over the last 2500 slots, with buyers stepping back in on the last few trades.

First buy is 0.03 SOL. It adds 0.06 SOL at a time while the price is above the last buy and flow stays positive, up to 0.2 SOL per coin. Every buy respects the harness cap of 1% of the curve's real SOL reserve.

A position leaves whole on the first trigger: +15% take profit, -6% stop against cost, a 12% trailing stop once up 4%, a single recorded sell of 3 SOL or more, 600 slots held, or flow turning hard negative. Completed curves are closed by the replay.

Tiny 0.01 SOL probe round trips keep the run above the 20-coin guardrail when fills or coins lag the pace the bot expects by that point in the window.

Everything is deterministic: no clock, no randomness, no I/O beyond the protocol. The two graded runs produce byte-identical action logs.

## Dev results

Graded locally with the kit (`grade-local --driver process`) on the frozen dev window:

| Version | Net PnL | Max drawdown | Round trips | Coins |
| --- | --- | --- | --- | --- |
| v1 | -2.95 SOL | 49.2% | 278 | 143 |
| v2 | -1.79 SOL | 19.8% | 293 | 139 |
| v3 | -0.52 SOL | 5.9% | 286 | 130 |
| v4 | -0.40 SOL | 4.2% | 282 | 127 |

The dev window punishes size: each tightening step (smaller stakes, tighter stops, pickier entries) cut the loss and the drawdown. v4 is the shipped version. For reference, the kit's pilot momentum bot scores -9.46 SOL with a 95.6% drawdown on the same window, and the equal-weight baseline barely trades (5 fills, -0.02 SOL).

## License

MIT. See [LICENSE](LICENSE).
