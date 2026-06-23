// Paper runner (Phase 4/5) — selection engine + strategy registry + control panel.
//
// Flow: discover reward markets -> score & select top N (>= act score) -> open
// parallel WS over chosen YES (and NO, for arb) tokens -> each cycle pick the best
// enabled strategy per market, gate risk, reconcile quotes, manage inventory, run
// the optional cross-outcome stacked-arb maker, accrue calibrated rewards, and fire
// per-strategy Telegram alerts. Settings are read live so the Telegram panel changes
// behaviour without a restart.
import type { AppConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { GammaClient } from "../core/gamma.js";
import { ClobRestClient } from "../core/clob.js";
import { ParallelWsManager } from "../ws/parallelWsManager.js";
import { PaperEngine } from "../paper/paperEngine.js";
import { reconcileQuotes, buildInventoryExit, netExposureUsd, canQuote, DriftDetector, AdverseSelectionMonitor, buildStackedArb, type ArbBook } from "../strategy/index.js";
import { selectStrategy, type StrategyOutput } from "../strategy/strategies.js";
import { scoreSide, type QuoteOrder } from "../rewards/index.js";
import { SettingsStore } from "../telegram/settingsStore.js";
import { TelegramBot } from "../telegram/bot.js";
import { NoopAlertSink, formatStrategyAlert, formatPnlAlert, type AlertSink } from "../telegram/alerts.js";
import { Monitor } from "../monitor/monitor.js";
import { selectTopMarkets, metricsFromBook, type MarketMetrics, type ScoredMarket } from "../select/marketSelector.js";
import type { GammaMarket } from "../core/types.js";

const log = createLogger("paper-runner");

const REQUOTE_INTERVAL_MS = 10_000;
const STATS_INTERVAL_MS = 15_000;
const REPRICE_TOLERANCE = 0.005;

interface MarketCtx {
	market: GammaMarket;
	yesToken: string;
	noToken: string | null;
	scored: ScoredMarket;
	lastAlertStrategy: string | null;
	lastAlertAt: number;
	lastArbAlertAt: number;
}

function hoursToResolution(m: GammaMarket): number | null {
	const end = (m as any).endDate ?? (m as any).end_date_iso;
	if (!end) return null;
	const ms = new Date(end).getTime() - Date.now();
	return Number.isFinite(ms) ? ms / 3_600_000 : null;
}

function isSports(m: GammaMarket): boolean {
	const hay = `${(m as any).category ?? ""} ${((m as any).tags ?? []).join(" ")} ${m.question}`.toLowerCase();
	return /\b(nba|nfl|mlb|nhl|soccer|football|tennis|ufc|game|match|vs\.?|cup)\b/.test(hay);
}

export async function runPaper(cfg: AppConfig): Promise<void> {
	const gamma = new GammaClient(cfg);
	const clob = new ClobRestClient(cfg);
	const paper = new PaperEngine({ startingBalance: cfg.startingBalance });
	const drift = new DriftDetector();
	const adverse = new AdverseSelectionMonitor();
	const settings = new SettingsStore();
	const midpoints = new Map<string, number>();
	const lastTradeByToken = new Map<string, number>();

	// Alert sink: Telegram if configured, else no-op.
	let sink: AlertSink = new NoopAlertSink();
	let bot: TelegramBot | null = null;
	if (cfg.telegramBotToken && cfg.telegramChatId) {
		bot = new TelegramBot(cfg.telegramBotToken, cfg.telegramChatId, settings, {
			status: () => `mode=paper | markets=${ctxs.length} | open=${paper.getOpenOrders().length} | bal=$${paper.getBalance().toFixed(2)}`,
			pnl: () => formatPnlAlert(paper.snapshot(midpoints)),
		});
		bot.start();
		sink = bot;
	}
	const monitor = new Monitor(sink, { minAlertIntervalMs: settings.getNum("ALERTS.MIN_INTERVAL_SEC") * 1000 });

	// ---- Discover + score + select markets.
	log.info("discovering reward-bearing markets...");
	let markets = await gamma.getRewardMarkets(50);
	if (markets.length === 0) markets = await gamma.getActiveMarkets(20);
	const candidates = markets.filter((m) => m.clobTokenIds.length >= 1).slice(0, 15);

	const metrics: MarketMetrics[] = [];
	const byToken = new Map<string, GammaMarket>();
	for (const m of candidates) {
		const token = m.clobTokenIds[0];
		byToken.set(token, m);
		try {
			const book = await clob.getOrderBook(token);
			metrics.push(
				metricsFromBook(
					{
						tokenId: token,
						question: m.question,
						rewardPerDay: m.rewardsDailyRate ?? 0,
						rewardPool: m.rewardsDailyRate ?? 0,
						volume24h: Number((m as any).volume24hr ?? (m as any).volume ?? 0),
						isSports: isSports(m),
					},
					book,
				),
			);
		} catch {
			/* skip markets we can't read */
		}
	}

	const actScore = settings.getNum("SELECTION.ACT_SCORE");
	const maxMarkets = settings.getNum("SELECTION.MAX_MARKETS");
	const selected = selectTopMarkets(metrics, actScore, maxMarkets);
	const ctxs: MarketCtx[] = selected.map((s) => {
		const m = byToken.get(s.tokenId)!;
		return {
			market: m,
			yesToken: s.tokenId,
			noToken: m.clobTokenIds[1] ?? null,
			scored: s,
			lastAlertStrategy: null,
			lastAlertAt: 0,
			lastArbAlertAt: 0,
		};
	});

	if (ctxs.length === 0) {
		log.error(`no markets scored >= ${actScore}; nothing to farm`);
		await sink.send(`⚠️ no markets scored >= ${actScore}/10 right now`);
		return;
	}
	for (const c of ctxs) log.info(`farming [${c.scored.score10.toFixed(1)}/10] ${c.market.question.slice(0, 56)}`);
	await sink.send(`🚀 farming ${ctxs.length} markets:\n` + ctxs.map((c) => `• ${c.scored.score10.toFixed(1)}/10 ${c.market.question.slice(0, 50)}`).join("\n"));

	// ---- Live feed (subscribe BOTH outcome tokens so the stacked-arb sees both books).
	const tokenIds = [...new Set(ctxs.flatMap((c) => (c.noToken ? [c.yesToken, c.noToken] : [c.yesToken])))];
	const manager = new ParallelWsManager(cfg, tokenIds, {
		onQuote: (q) => {
			if (q.midpoint !== null) midpoints.set(q.tokenId, q.midpoint);
			if (q.lastTradePrice !== null && lastTradeByToken.get(q.tokenId) !== q.lastTradePrice) {
				lastTradeByToken.set(q.tokenId, q.lastTradePrice);
				const ctx = ctxs.find((c) => c.yesToken === q.tokenId || c.noToken === q.tokenId);
				if (ctx) {
					const before = paper.snapshot(midpoints).realizedPnl;
					paper.onTrade(q.tokenId, q.lastTradePrice);
					const delta = paper.snapshot(midpoints).realizedPnl - before;
					if (delta !== 0) adverse.addFillPnl(q.tokenId, delta);
				}
			}
		},
		onResolved: (ids) => {
			for (const id of ids) {
				paper.cancelAll(id);
				void sink.send(`🏁 market resolved — cancelled paper orders for ${id.slice(0, 8)}...`);
			}
		},
	});
	await manager.start();

	const requote = setInterval(() => {
		void requoteCycle(cfg, clob, paper, ctxs, midpoints, drift, adverse, settings, sink).catch((e) => log.warn(`requote error: ${(e as Error).message}`));
	}, REQUOTE_INTERVAL_MS);

	const stats = setInterval(() => {
		const s = paper.snapshot(midpoints);
		log.info(`PnL net=$${s.netPnl.toFixed(3)} realized=$${s.realizedPnl.toFixed(3)} rewards=$${s.rewardsAccrued.toFixed(3)} fees=$${s.feesPaid.toFixed(3)} bal=$${s.balance.toFixed(2)} open=${s.openOrders} fills=${paper.getFillCount()}`);
		void monitor.onSnapshot(s, true);
	}, STATS_INTERVAL_MS);

	const shutdown = () => {
		clearInterval(requote);
		clearInterval(stats);
		manager.stop();
		bot?.stop();
		const s = paper.snapshot(midpoints);
		log.info(`final net PnL: $${s.netPnl.toFixed(3)} on $${cfg.startingBalance} (${((s.netPnl / cfg.startingBalance) * 100).toFixed(2)}%)`);
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

async function requoteCycle(
	cfg: AppConfig,
	clob: ClobRestClient,
	paper: PaperEngine,
	ctxs: MarketCtx[],
	midpoints: Map<string, number>,
	drift: DriftDetector,
	adverse: AdverseSelectionMonitor,
	settings: SettingsStore,
	sink: AlertSink,
): Promise<void> {
	const totalExposure = netExposureUsd(paper.getPositions(), midpoints);
	const sharesPerSide = settings.getNum("SIZING.SHARES_PER_SIDE");
	const offsetFrac = settings.getNum("STRATEGY.OFFSET_FRAC");
	const maxSingle = settings.getNum("RISK.MAX_SINGLE_MARKET_USD");
	const maxTotal = settings.getNum("RISK.MAX_TOTAL_EXPOSURE_USD");
	const minAlertMs = settings.getNum("ALERTS.MIN_INTERVAL_SEC") * 1000;

	for (const ctx of ctxs) {
		const token = ctx.yesToken;
		const mid = midpoints.get(token);
		if (mid === undefined) continue;
		drift.record(token, mid);

		if (drift.isDrifting(token) || adverse.isToxic(token)) {
			paper.cancelAll(token);
			if (ctx.noToken) paper.cancelAll(ctx.noToken);
			continue;
		}

		// Inventory exit (maker take-profit) for any holding.
		const pos = paper.getPosition(token);
		if (pos) {
			const exit = buildInventoryExit(pos);
			if (exit && !paper.getOpenOrders(token).some((o) => o.strategy === "inventory-exit" && o.side === exit.side)) {
				paper.placeOrder({ tokenId: token, side: exit.side, outcome: exit.outcome, price: exit.price, size: exit.size, strategy: "inventory-exit" });
			}
		}

		// Risk gate.
		const marketExposure = pos ? Math.abs(pos.shares) * mid : 0;
		const gate = canQuote({ marketExposureUsd: marketExposure, totalExposureUsd: totalExposure, balanceUsd: paper.getBalance(), params: { maxSingleMarketUsd: maxSingle, maxTotalExposureUsd: maxTotal } });
		if (!gate.ok) continue;

		// Estimate competition from the live book.
		let competitorScore = 0;
		try {
			const book = await clob.getOrderBook(token);
			const bids: QuoteOrder[] = book.bids.map((b) => ({ price: b.price, size: b.size }));
			const asks: QuoteOrder[] = book.asks.map((a) => ({ price: a.price, size: a.size }));
			competitorScore = scoreSide(bids, mid).qScore + scoreSide(asks, mid).qScore;
		} catch {
			/* tolerate book read failure */
		}

		// Pick the best enabled strategy for this market.
		const out: StrategyOutput | null = selectStrategy(
			{ midpoint: mid, yesTokenId: token, rewardPool: ctx.market.rewardsDailyRate ?? 0, competitorScore, sharesPerSide, hoursToResolution: hoursToResolution(ctx.market), offsetFrac },
			settings,
		);
		if (!out) {
			// Keep inventory-exit and stacked-arb orders; clear plain quotes only.
			for (const o of paper.getOpenOrders(token)) if (o.strategy !== "inventory-exit" && o.strategy !== "stacked-arb") paper.cancelOrder(o.id);
		} else {
			// Reconcile against current strategy quotes.
			const current = paper.getOpenOrders(token).filter((o) => o.strategy === out.strategy);
			const { toCancel, toPlace } = reconcileQuotes({ desired: out.orders, current, repriceTolerance: REPRICE_TOLERANCE });
			// Cancel quotes from a different (switched) strategy too — but never inventory-exit or stacked-arb.
			for (const o of paper.getOpenOrders(token)) if (o.strategy !== out.strategy && o.strategy !== "inventory-exit" && o.strategy !== "stacked-arb") paper.cancelOrder(o.id);
			for (const id of toCancel) paper.cancelOrder(id);
			for (const d of toPlace) paper.placeOrder({ tokenId: token, side: d.side, outcome: d.outcome, price: d.price, size: d.size, strategy: out.strategy });

			// Accrue calibrated reward for this cycle.
			if ((ctx.market.rewardsDailyRate ?? 0) > 0) {
				const cycleReward = (out.expectedDailyReward * REQUOTE_INTERVAL_MS) / 86_400_000;
				paper.accrueReward(cycleReward);
				adverse.addReward(token, cycleReward);
			}

			// Per-strategy alert (throttled, named, with expected reward).
			const now = Date.now();
			const changed = ctx.lastAlertStrategy !== out.strategy;
			if (settings.getBool("ALERTS.ENABLED") && (changed || now - ctx.lastAlertAt >= minAlertMs) && toPlace.length > 0) {
				ctx.lastAlertStrategy = out.strategy;
				ctx.lastAlertAt = now;
				void sink.send(
					formatStrategyAlert({
						strategy: out.strategy,
						question: ctx.market.question,
						action: changed ? "engaged" : "requoted",
						expectedDailyReward: out.expectedDailyReward,
						midpoint: mid,
						score10: ctx.scored.score10,
					}),
				);
			}
		}

		// Cross-outcome stacked-arb (optional, resting maker on BOTH legs).
		if (settings.getBool("STRATEGY.ENABLE_STACKED_ARB") && ctx.noToken) {
			await manageStackedArb(clob, paper, ctx, settings, sink, minAlertMs);
		}
	}
}

// Maintain a resting YES+NO maker pair whose prices sum to < 1 (locked arb edge
// stacked on top of the maker reward). Cancels stale arb orders when no edge exists.
async function manageStackedArb(
	clob: ClobRestClient,
	paper: PaperEngine,
	ctx: MarketCtx,
	settings: SettingsStore,
	sink: AlertSink,
	minAlertMs: number,
): Promise<void> {
	const yesToken = ctx.yesToken;
	const noToken = ctx.noToken!;
	let yesBook;
	let noBook;
	try {
		yesBook = await clob.getOrderBook(yesToken);
		noBook = await clob.getOrderBook(noToken);
	} catch {
		return;
	}
	const yes: ArbBook = { bestBid: yesBook.bids[0]?.price ?? 0, bestAsk: yesBook.asks[0]?.price ?? 1 };
	const no: ArbBook = { bestBid: noBook.bids[0]?.price ?? 0, bestAsk: noBook.asks[0]?.price ?? 1 };

	const quote = buildStackedArb({
		yes,
		no,
		params: { minEdge: settings.getNum("STRATEGY.ARB_MIN_EDGE"), sharesPerSide: settings.getNum("STRATEGY.ARB_SHARES_PER_SIDE") },
	});

	if (!quote) {
		for (const o of paper.getOpenOrders(yesToken)) if (o.strategy === "stacked-arb") paper.cancelOrder(o.id);
		for (const o of paper.getOpenOrders(noToken)) if (o.strategy === "stacked-arb") paper.cancelOrder(o.id);
		return;
	}

	const yesCurrent = paper.getOpenOrders(yesToken).filter((o) => o.strategy === "stacked-arb");
	const yesRecon = reconcileQuotes({ desired: [quote.yesOrder], current: yesCurrent, repriceTolerance: REPRICE_TOLERANCE });
	for (const id of yesRecon.toCancel) paper.cancelOrder(id);
	for (const d of yesRecon.toPlace) paper.placeOrder({ tokenId: yesToken, side: d.side, outcome: d.outcome, price: d.price, size: d.size, strategy: "stacked-arb" });

	const noCurrent = paper.getOpenOrders(noToken).filter((o) => o.strategy === "stacked-arb");
	const noRecon = reconcileQuotes({ desired: [quote.noOrder], current: noCurrent, repriceTolerance: REPRICE_TOLERANCE });
	for (const id of noRecon.toCancel) paper.cancelOrder(id);
	for (const d of noRecon.toPlace) paper.placeOrder({ tokenId: noToken, side: d.side, outcome: d.outcome, price: d.price, size: d.size, strategy: "stacked-arb" });

	const now = Date.now();
	if (settings.getBool("ALERTS.ENABLED") && now - ctx.lastArbAlertAt >= minAlertMs && yesRecon.toPlace.length + noRecon.toPlace.length > 0) {
		ctx.lastArbAlertAt = now;
		void sink.send(
			`🎯 stacked-arb — ${ctx.market.question.slice(0, 50)}\nYES ${quote.yesOrder.price.toFixed(2)} + NO ${quote.noOrder.price.toFixed(2)} -> locked ${(quote.edge * 100).toFixed(1)}¢/share (+ maker reward)`,
		);
	}
}
