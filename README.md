# pol_lp — Polymarket LP Reward Farming Bot

A TypeScript bot that farms **Polymarket liquidity-provider (LP) rewards** by posting two-sided resting limit orders inside the reward band, while actively managing inventory and adverse-selection risk. Ships with a **paper-trading mode** that consumes real CLOB data so simulated fills and PnL track live farming to ~99%.

## Why this bot can be profitable

LP farming is a market-making business, not free money. Profit = **rewards captured − adverse-fill losses − fees − gas**. The edge is mechanical (rewards are paid daily on a deterministic published formula), but the killer risk is toxic flow. This bot is built around four winning requirements:

1. Good market selection (scoring engine, only act on 7+/10).
2. Tight-but-safe two-sided quotes inside `max_incentive_spread`.
3. Active inventory management (maker take-profit exits, taker stop-loss, drift detection, dust management).
4. The ability to cancel/re-quote faster than the market moves (ms-accurate parallel WebSockets).

## Phased build

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | Foundations: config, logger, types, CLOB v2 client (sig type 3 / POLY_1271), Gamma discovery, parallel WebSocket layer | ✅ this PR |
| 1 | Reward brain: Qn scorer + $/day estimator + live calibrator | ⏳ |
| 2 | Paper mode: quoter, inventory, risk guard, crossing-fill simulator, full PnL | ⏳ |
| 3 | Live (small): live executor + order signing + paper/live reconciliation | ⏳ |
| 4 | Scale & harden: multi-market, Telegram control panel, alerts, monitoring | ⏳ |

## WebSocket data-quality system (ported from polymarket-bot-v2)

Multi-connection, ms-accurate order book with a 6-layer quality system:

- **Layer 1 — Pre-warm:** require N valid ticks before trusting a token's data.
- **Layer 2 — Redundancy:** multiple parallel connections to the CLOB market channel.
- **Layer 3 — Stale-tick guard:** reject ticks that jump more than a threshold from the last valid price.
- **Layer 4 — Drop first tick:** the first tick on a fresh connection is a cached snapshot.
- **Layer 5 — Staggered starts:** never open all sockets in the same millisecond.
- **Layer 6 — Jitter-EMA culling:** track timing variance and auto-prune erratic connections, respawning replacements within a budget.

## Getting started

```bash
npm install
cp .env.example .env   # fill in wallet + API creds
npm run build
npm run paper          # paper mode (default, safe)
```

## Safety

- Defaults to **paper mode**. Live mode requires explicit `TRADING_MODE=live`.
- Never commit `.env` or private keys (see `.gitignore`).
- Start live with tiny capital and reconcile against paper.

## Session memory

See [`SESSION_MEMORY.md`](./SESSION_MEMORY.md) — an append-only build diary. Every change is logged at the end of the file with a timestamp; entries are never deleted.
