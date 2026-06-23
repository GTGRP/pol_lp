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

**What was done** live/auth (L1 EIP-712 ClobAuth + deriveOrCreateApiKey, EOA-signed so sig-type-3 safe); live/orderSigning (CTF Exchange EIP-712 order; 6-dec maker/taker; sig type 3 maker=funder, signer=EOA; GTC; std vs neg-risk addresses isolated); live/rateLimiter (token bucket); live/liveClient (sign+POST /order GTC, /order/cancel, /cancel-all; per-order USD cap; 429 backoff); live/reconciler (shadow paper vs live fill-rate + PnL delta); run/liveRunner (gated, single-market, reuses same quoter/risk/drift; cancel-all on resolve+shutdown); main routes live; config+env LIVE_MAX_ORDER_USD.
**Why** Live reuses identical strategy/risk code (no divergence); dangerous unknowns isolated + capped to validate with a $1 order first.
**Safety** opt-in TRADING_MODE=live, hard per-order cap, cancel-all on resolve/shutdown. Exchange addresses + /order payload flagged to verify against live API before real use.
**Findings** L1 auth is EOA-signed regardless of sig type; only order signing needs the funder binding for POLY_1271. Shadow paper engine in live mode gives a free continuous accuracy check.
**Next** Phase 4.

---

## 2026-06-23 19:21 IST — Phase 4: Scale + Control Panel (FINAL)

**What was done**
- Merged Phase 3 to `main`; branched `phase-4-scale-telegram`.
- `src/select/marketSelector.ts` — composite 0–10 scoring (spread .30 / reward-sanity .22 / depth .20 / volume .13 / centrality .15) + sports boost; `selectTopMarkets` keeps only >= act score (default 7) and top N; `metricsFromBook` derives spread/depth/midpoint from the live book.
- `src/strategy/strategies.ts` — strategy registry: **core-maker** (tight two-sided in-band) + **grid-lp** (wider hedged grid for <= 1-week markets); `selectStrategy` picks the highest expected-reward enabled+applicable strategy; each output carries strategy name + expected daily reward.
- `src/telegram/settingsStore.ts` — WEATHERPOL-style typed BOOL/NUM/STR settings grouped into tabs (STRATEGY/RISK/SIZING/SELECTION/ALERTS), JSON-persisted, validated/coerced; read live by the runner so changes apply without restart.
- `src/telegram/alerts.ts` — AlertSink + formatters; **every strategy alert names the strategy and its expected daily reward**.
- `src/telegram/bot.ts` — control panel over the Bot API (no deps): /status /pnl /settings [group] /set KEY VALUE /pause /resume /help.
- `src/monitor/monitor.ts` — periodic PnL push + drawdown alerting.
- `src/redeem/autoRedeem.ts` — CTF redeemPositions for resolved markets (gated; addresses flagged to verify).
- Rewrote `src/run/paperRunner.ts` to wire selection + strategy registry + settings + Telegram alerts + monitor. Config+env gain TELEGRAM_BOT_TOKEN/CHAT_ID, RPC_URL, ENABLE_AUTO_REDEEM.

**Why** This delivers the requested control surface: multiple named strategies, Telegram alerts that say which strategy acted and the expected return, runtime-adjustable settings (balance/sizing/risk/selection) mirroring the WEATHERPOL panel, and disciplined market selection so we only farm high-quality opportunities (maximize returns, avoid bad fills).

**Findings** Reading settings live each cycle is the cleanest way to get WEATHERPOL-style runtime control without IPC. Composite scoring naturally down-weights tail/illiquid markets (low centrality/depth), which is exactly where adverse selection bites.

**Status** All 4 phases complete and merged to `main`. Paper mode is fully runnable end-to-end against live Polymarket data; live mode is implemented behind explicit opt-in + caps.

**Verify-before-live checklist** (1) CTF + neg-risk exchange addresses & /order payload shape, (2) auto-redeem conditionId/indexSets on one position, (3) run paper for a sustained period and watch the reconciler before funding live.

**Next / backlog** Wire neg-risk detection per market into live order signing; add the cross-outcome stacked-arb strategy (needs both YES+NO books subscribed); calibrator feedback loop from the live reconciler into reward estimates.
