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

**What was done** Initialized `GTGRP/pol_lp`. TypeScript scaffold (package.json, tsconfig, .env.example). Core: types, config (paper default, sig type 3), logger, clob (CLOB v2 REST + L2 HMAC), gamma (discovery), ws/clobMarketWs (pre-warm/stale-tick/drop-first + market_resolved), ws/parallelWsManager (N redundant conns, staggered, jitter-EMA pruning), main smoke test.
**Why** TS-only clean compile; ms-accurate redundant book defends against adverse selection.
**Findings** CLOB events book/price_change/best_bid_ask/last_trade_price/market_resolved; ping ~8s.
**Next** Phase 1.

---

## 2026-06-23 18:22 IST — Phase 1: Reward Brain

**What was done** `src/rewards/`: scorer (Qn quadratic decay, maxSpread/minSize cutoffs, two-sided min(qBid,qAsk)), estimator (USDC/day = pool*myScore/(competitorScore+myScore), APR), calibrator (EMA vs real order-scoring + earnings), index.
**Why** Quantify tightness + two-sidedness; model+calibrator since constants drift.
**Next** Phase 2.

---

## 2026-06-23 18:41 IST — Phase 2: Paper Engine

**What was done** fees model; paper/fillSimulator (crossing fills from real prints; maker fills at our price); paper/paperEngine (balance, positions w/ avg cost, realized/unrealized PnL, fees, gas, rewards, snapshot); strategy/quoter (two-sided in-band, skip toxic tails, low-churn reprice); strategy/inventoryManager (maker take-profit exits + dust); strategy/riskGuard (exposure gating, DriftDetection, taker stop-loss, AdverseSelectionMonitor); run/paperRunner + main => runnable `npm run paper`.
**Why** “99% close to real” paper: fills from real CLOB prints, full fee/gas/reward PnL, same risk+inventory logic as live.
**Limitations** unknown-size prints fill fully; queue approximated — to tighten via Phase 3 reconciliation.
**Next** Phase 3.

---

## 2026-06-23 19:02 IST — Phase 3: Live Executor

**What was done**
- Merged Phase 2 to `main`; branched `phase-3-live-executor`.
- `src/live/auth.ts` — L1 EIP-712 ClobAuth signing + `deriveOrCreateApiKey` (derive existing L2 creds, else create). Works for sig type 3 since L1 is always EOA-signed.
- `src/live/orderSigning.ts` — CTF Exchange EIP-712 Order builder + signer: 6-decimal maker/taker amounts, BUY/SELL, **sig type 3 maps maker=funder/deposit wallet, signer=EOA**, GTC (expiration 0), standard vs neg-risk exchange addresses isolated for verification.
- `src/live/rateLimiter.ts` — token-bucket limiter.
- `src/live/liveClient.ts` — init/derive creds, sign+POST `/order` (GTC), `/order/cancel`, `/cancel-all`; **per-order notional cap** (`LIVE_MAX_ORDER_USD`, default $10); 429 backoff.
- `src/live/reconciler.ts` — shadow PaperEngine vs live: fill-rate error + PnL delta, feeding model convergence.
- `src/run/liveRunner.ts` — gated live loop reusing the SAME quoter/risk/drift logic; single-market start; cancels all on resolve + shutdown. `main.ts` routes live mode here; added `LIVE_MAX_ORDER_USD` to config + `.env.example`.

**Why** Live must reuse the identical strategy/risk code exercised in paper (no divergence), and every dangerous unknown (exchange addresses, payload shape) is isolated + capped so it can be validated with a $1 order before scaling.

**Safety** Live is opt-in (`TRADING_MODE=live`), hard per-order USD cap, cancel-all on resolution and shutdown, starts on one market. Exchange addresses + `/order` payload shape flagged for verification against the live API before real use.

**Findings** L1 auth is EOA-signed regardless of signature type; only order signing needs the funder binding for POLY_1271. Keeping a shadow paper engine in live mode gives a free, continuous accuracy check of the paper model.

**Next (Phase 4)** Scale + harden: multi-market scoring/selection engine (act on 7+/10), Telegram control panel (port WEATHERPOL settings_store + telegram_ui: runtime-adjustable settings + per-strategy alerts naming strategy & expected reward), monitoring, auto-redeem.
