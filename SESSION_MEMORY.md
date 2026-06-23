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

---

## 2026-06-23 19:48 IST — Phase 5 (dev branch): V2 contracts + gasless redeem + stacked-arb

Working on a single `dev` branch from here on (no more per-phase branches).

**What was done**
- `src/core/contracts.ts` (NEW) — single source of truth for Polymarket **V2** Polygon addresses, docs-verified: CTF Exchange V2 `0xE111180000d2663C0091e4f400237545B87B996B`, Neg Risk CTF Exchange V2 `0xe2222d279d744050d28e00520010520000310F59`, NegRiskAdapter `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`, ConditionalTokens `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`, pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`, CtfCollateralAdapter `0xAdA100Db00Ca00073811820692005400218FcE1f`. Deprecated **V1** addresses kept ONLY to avoid accidental reuse.
- `src/live/orderSigning.ts` — now imports the V2 exchange addresses; lowercases before getAddress so a checksum-casing mismatch can't throw.
- `src/redeem/gaslessRelayer.ts` (NEW) — Polymarket Relayer API client (Builder Program). Encodes redeem calldata (standard CTF vs neg-risk), submits with builder API-key HMAC auth, polls for the broadcast tx hash. Relayer broadcasts from the position-owning proxy/deposit wallet and Polymarket sponsors gas.
- `src/redeem/autoRedeem.ts` — rewritten for V2: collateral defaults to **pUSD** (not USDC.e); **gasless-first** (cfg.gaslessRedeem) with a direct on-chain fallback; standard + neg-risk redeem paths.
- `src/run/liveRunner.ts` — on market resolve, when ENABLE_AUTO_REDEEM is set, calls redeemResolved with the market conditionId (gasless if configured).
- `src/strategy/stackedArb.ts` (NEW) + wiring in `paperRunner.ts` — cross-outcome arbitrage: rest maker BUY on YES and NO at prices summing to < 1 by >= ARB_MIN_EDGE. Every matched pair locks the arb edge AND earns the maker reward on the same fills (stacked edge). paperRunner now subscribes BOTH outcome tokens, runs the arb after the core strategy, excludes stacked-arb from the strategy-switch cancel sweep, and cancels both legs on drift.
- `src/telegram/settingsStore.ts` — new live settings STRATEGY.ENABLE_STACKED_ARB / ARB_MIN_EDGE / ARB_SHARES_PER_SIDE.
- `src/core/config.ts` + `.env.example` — GASLESS_REDEEM, RELAYER_URL, POLY_BUILDER_API_KEY/SECRET/PASSPHRASE; pUSD/V2 notes.
- `Procfile` (NEW) — `worker: node dist/main.js` for Railway (build runs via the package `build` script; start runs the compiled worker).

**Why** User explicitly required everything be **V2-compatible — do NOT use the old (V1) contracts**, and wanted gasless redeem via the builder-code relayer while still being able to take/exit liquidity fast. The CLOB V2 cutover (late April 2026) changed every exchange contract and moved collateral from bridged USDC.e to pUSD; V1-signed orders are rejected. Direct EOA redeem reverts because positions sit in a proxy/deposit wallet, so gasless relayer redeem is the correct path.

**Findings / V2 facts**
- CLOB V2 cutover ~April 22–28 2026: new Exchange contracts, EIP-1271 support, builder codes, pUSD collateral, no backward compatibility (V1 SDKs/orders rejected; open orders wiped at cutover; full V1 shutdown June 30 2026).
- Gasless redeem = Relayer Client + Builder Program: app builds tx -> user signs -> POST to relayer -> relayer submits on-chain and pays gas, executing from the user's wallet. Works for proxy/Safe AND deposit wallets. Unverified builder tier ~100 relay tx/day.
- Signature types: 0 EOA, 1 POLY_PROXY, 2 GNOSIS_SAFE, 3 POLY_1271 (deposit wallet, ERC-1271) — this bot uses type 3.

**Open / verify-before-production**
- Relayer base URL + `/submit` and `/transaction` payload field names + builder HMAC auth scheme are modeled on the docs and MUST be confirmed against the live relayer API (and `@polymarket/builder-relayer-client`) before relying on auto-redeem. These are isolated in `gaslessRelayer.ts` and don't affect paper trading.
- Confirm the V2 EIP-712 order domain (name/version) + `/order` payload with a single $1 live order before scaling.
- pUSD collateral address used for redeem `collateralToken` arg — verify whether redemption routes through pUSD directly or via the CtfCollateralAdapter.

**Deploy** Railway: build = `npm run build`, start = `node dist/main.js` (Procfile worker). Runs as a background worker (no web port). Full env var list delivered to the user in chat.

**Next** Confirm relayer payload against live API; optional calibrator feedback from live reconciler; consider per-market neg-risk detection feeding both order signing and redeem.
