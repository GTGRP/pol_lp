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
- Built core modules: `types.ts`, `config.ts` (defaults to paper mode; sig type 3 wiring), `logger.ts`, `clob.ts` (CLOB v2 REST + L2 HMAC auth; L1/signing deferred to Phase 3), `gamma.ts` (market discovery), `ws/clobMarketWs.ts` (single CLOB market-channel WS with pre-warm/stale-tick/drop-first-tick + market_resolved), `ws/parallelWsManager.ts` (N redundant connections, staggered starts, jitter-EMA pruning), `main.ts` (smoke test).

**Why** TypeScript-only for a clean compile; ms-accurate redundant book is the core defense against adverse selection.

**Findings** CLOB market channel events: book / price_change / best_bid_ask / last_trade_price / market_resolved; ping ~8s; market_resolved lets us stop instantly.

**Next** Phase 1 reward brain.

---

## 2026-06-23 18:22 IST — Phase 1: Reward Brain

**What was done**
- Merged Phase 0 to `main`; branched `phase-1-reward-brain`.
- Added `src/rewards/`: `scorer.ts` (Qn: quadratic spread decay, maxSpread/minSize cutoffs, two-sided binding score min(qBid,qAsk)), `estimator.ts` (USDC/day = pool*myScore/(competitorScore+myScore), APR), `calibrator.ts` (EMA factor reconciling estimates vs real order-scoring + earnings endpoints), `index.ts`.

**Why** Make tightness + two-sidedness first-class quantified signals; treat the formula as model+calibrator since constants drift.

**Findings** Reward share has diminishing returns to size; order-scoring endpoint gives a live qualifying check.

**Next** Phase 2 paper engine.

---

## 2026-06-23 18:41 IST — Phase 2: Paper Engine

**What was done**
- Merged Phase 1 to `main`; branched `phase-2-paper-engine`.
- `src/core/fees.ts` — configurable maker/taker bps + gas model (Polymarket fees currently 0; gasless orders).
- `src/paper/fillSimulator.ts` — **crossing-fill simulator**: a resting BUY fills only when a real trade prints at/below it; a SELL when a print is at/above it; maker fills at our price; better-priced orders fill first; respects known trade size.
- `src/paper/paperEngine.ts` — full paper account: USDC balance, positions w/ average cost, open orders, realized/unrealized PnL, fees, gas, accrued rewards, fill count; `snapshot()` mark-to-market.
- `src/strategy/quoter.ts` — two-sided quotes inside the reward band (offsetFrac of maxSpread), skips toxic tails (<0.1 / >0.9), `reconcileQuotes` only reprices beyond tolerance to avoid churn.
- `src/strategy/inventoryManager.ts` — maker take-profit exits for filled inventory; **dust management** (ignore < dustShares).
- `src/strategy/riskGuard.ts` — pre-quote exposure/balance gating; **DriftDetection** (abandon markets marching to 0/1); **taker stop-loss**; **AdverseSelectionMonitor** (halt markets whose fill losses outrun rewards).
- `src/run/paperRunner.ts` — ties live WS + strategy + paper engine into a loop: real trade prints drive fills; cycle re-quotes, gates risk, places inventory exits, accrues calibrated rewards. `src/main.ts` now runs this on `npm run paper`.

**Why** This is the “99% close to real” paper mode requirement: fills come from real CLOB trade prints (not random), PnL includes fees/gas/rewards, and the same risk + inventory logic that live trading will use is exercised in paper.

**Findings / limitations** When a trade print lacks size we fill the crossed order fully (slightly optimistic); queue position is approximated. These are flagged for Phase 3 reconciliation (compare paper vs live fills to tighten the model).

**Next (Phase 3)** Live executor: L1 EIP-712 + POLY_1271 (sig type 3) API-key derivation, order signing, GTC create/cancel/replace with rate-limit handling, and paper/live reconciliation hooks.
