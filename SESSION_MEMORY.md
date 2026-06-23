# pol_lp — Session Memory (Build Diary)

> **APPEND-ONLY DIARY — READ FIRST.**
> This file is a continuous diary of the build. Rules for every contributor (human or AI):
> 1. **Never delete or rewrite** existing entries. History stays intact.
> 2. **Always append** the newest entry at the **very bottom** of the file.
> 3. Every entry must include a **date + time (IST / Asia-Kolkata)** header.
> 4. Record **what was done, what changed, what improved, why we did it, findings, and next steps** — A to Z, with data.
> 5. Keep it honest: log failures, blockers, and dead-ends too.

---

## 2026-06-23 18:07 IST — Phase 0: Foundations

**What was done**
- Initialized the `GTGRP/pol_lp` repository (`.gitignore`, `README.md`).
- Created branch `phase-0-foundations` and opened a PR for Phase 0.
- Scaffolded the TypeScript project: `package.json`, `tsconfig.json`, `.env.example`.
- Built core modules:
  - `src/core/types.ts` — shared domain types (order book, best quote, reward config, Gamma market, sides/outcomes).
  - `src/core/config.ts` — env-driven config; defaults to **paper mode**; signature type 3 (POLY_1271) wiring; all tunables documented.
  - `src/core/logger.ts` — leveled, timestamped logger.
  - `src/core/clob.ts` — CLOB v2 REST client wrapper: public market/book/rewards reads + **L2 HMAC auth** header builder; L1 (EIP-712) key derivation + order signing left as a clearly-marked Phase 3 interface.
  - `src/core/gamma.ts` — Gamma market-discovery client (active, reward-bearing markets).
  - `src/ws/clobMarketWs.ts` — single CLOB market-channel WebSocket client with data-quality Layers 1/3/4 (pre-warm, stale-tick guard, drop-first-tick) and instant `market_resolved` detection.
  - `src/ws/parallelWsManager.ts` — **parallel WebSocket manager**: N redundant connections (Layer 2), staggered starts (Layer 5), per-connection health + jitter-EMA scoring, and auto-pruning of erratic connections with a respawn budget (Layer 6). Merges data by freshest tick per token.
  - `src/main.ts` — Phase 0 entry point / smoke test: loads config, discovers a few reward markets, boots the parallel WS, prints live best bid/ask + connection health.

**Why we did it this way**
- **TypeScript-only** for Phase 0–2 to guarantee a clean compile with no cross-language integration errors (per the requirement that everything compiles and runs clean). Rust stays an optional Phase-4 latency fast-path, not a hard dependency.
- Implemented auth/REST/WS directly on `ethers` + native `fetch` + `ws` (all stable) instead of pinning to a fast-moving SDK surface, so the codebase compiles deterministically. The CLOB client is wrapped behind an interface, so we can swap in the official SDK later without touching strategy code.
- Ported the v2 bot's parallel-WS + 6-layer data-quality design because ms-accurate, redundant order-book data is exactly what protects an LP maker from adverse selection and lets us cancel before toxic fills.

**Findings**
- v2 bot's parallel WS used Binance book-ticker feeds; for an LP bot the relevant feed is the **Polymarket CLOB market channel** (`book`, `price_change`, `best_bid_ask`, `last_trade_price`, `market_resolved`). The manager was generalized accordingly.
- CLOB market channel requires a PING roughly every 10s; we ping at 8s.
- `market_resolved` is critical: it lets us stop quoting/selling instantly instead of getting run over at resolution.

**Next steps (Phase 1)**
- Implement `rewards/scorer.ts` (replicate Qn: quadratic spread penalty, size cutoff, two-sided bonus), `rewards/estimator.ts` ($/day given a quote config + competition), and `rewards/calibrator.ts` (poll order-scoring + per-user reward % to tune the estimator against reality).
