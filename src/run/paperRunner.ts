// Paper runner — broad funded-reward discovery + strategy registry + rich Telegram ops.
//
// Discovery is now based on the reference-repo pattern: scan Gamma broadly for live
// markets, scan CLOB simplified/sampling markets for funded rewards, join by token /
// condition, and only farm markets with actual funded reward rates when that CLOB
// reward source is available.
import type { AppConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { GammaClient } from "../core/gamma.js";
import { ClobRestClient, type ClobRewardSnapshot } from "../core/clob.js";
import { ParallelWsManager } from "../ws/parallelWsManager.js";
import { PaperEngine } from "../paper/paperEngine.js";
import { reconcileQuotes, buildInventoryExit, netExposureUsd, canQuote, DriftDetector, AdverseSelectionMonitor, buildStackedArb, type ArbBook } from "../strategy/index.js";
import { selectStrategy, type StrategyOutput } from "../strategy/strategies.js";
import { scoreSide, type QuoteOrder } from "../rewards/index.js";
import { SettingsStore } from "../telegram/settingsStore.js";
import { TelegramBot } from "../telegram/bot.js";
import { NoopAlertSink, formatStrategyAlert, formatPnlAlert, formatDetailedStatus, formatMarketSelectedAlert, formatOrderPlacedAlert, formatFillAlert, type AlertSink } from "../telegram/alerts.js";
import { Monitor } from "../monitor/monitor.js";
import { selectTopMarkets, compositeScore, metricsFromBook, type MarketMetrics, type ScoredMarket } from "../select/marketSelector.js";
import type { GammaMarket, OrderBookSnapshot, ManagedOrder } from "../core/types.js";

const log = createLogger("paper-runner");

const REQUOTE_INTERVAL_MS = 10_000;
const STATS_INTERVAL_MS = 15_000;
const REPRICE_TOLERANCE = 0.005;
const DEFAULT_DISCOVERY_GAMMA_LIMIT = 500;
const DEFAULT_REWARD_SCAN_PAGES = 30;

interface MarketCtx {
	market: GammaMarket;
	yesToken: string;
	noToken: string | null;
	scored: ScoredMarket;
	reward: ClobRewardSnapshot | null;
	lastBook: OrderBookSnapshot | null;
	lastAlertStrategy: string | null;
	lastAlertAt: number;
	lastArbAlertAt: number;
}

function envNum(key: string, fallback: number): number {
	const n = Number(process.env[key]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function hoursToResolution(m: GammaMarket): number | null {
	const end = m.endDateIso ?? (m as any).endDate ?? (m as any).end_date_iso;
	if (!end) return null;
	const ms = new Date(end).getTime() - Date.now();
	return Number.isFinite(ms) ? ms / 3_600_000 : null;
}

function isSports(m: GammaMarket): boolean {
	const hay = `${m.category ?? ""} ${((m as any).tags ?? []).join(" ")} ${m.question}`.toLowerCase();
	return /\b(nba|nfl|mlb|nhl|soccer|football|tennis|ufc|game|match|vs\.?|cup)\b/.test(hay);
}

function getRewardForMarket(rewards: { byToken: Map<string, ClobRewardSnapshot>; byCondition: Map<string, ClobRewardSnapshot> }, m: GammaMarket): ClobRewardSnapshot | null {
	for (const token of m.clobTokenIds) {
		const byToken = rewards.byToken.get(token);
		if (byToken) return byToken;
	}
	return rewards.byCondition.get(m.conditionId) ?? null;
}

function expectedExposureForOrder(o: ManagedOrder): number {
	return Math.abs(o.price * o.size);
}

export async function runPaper(cfg: AppConfig): Promise<void> {
	const gamma = new GammaClient(cfg);
	const clob = new ClobRestClient(cfg);
	const paper = new PaperEngine({ startingBalance: cfg.startingBalance });
	const drift = new DriftDetector();
	const adverse = new AdverseSelectionMonitor();
	const settings = new SettingsStore();
	const midpoints = new Map<string, number>();
	const latestBooks = new Map<string, OrderBookSnapshot>();
	const lastTradeByToken = new Map<string, number>();

	let ctxs: MarketCtx[] = [];
	let sink: AlertSink = new NoopAlertSink();
	let bot: TelegramBot | null = null;
	if (cfg.telegramBotToken && cfg.telegramChatId) {
		bot = new TelegramBot(cfg.telegramBotToken, cfg.telegramChatId, settings, {
			status: () => formatDetailedStatus({ mode: "paper", markets: ctxs.length, snapshot: paper.snapshot(midpoints), openOrders: paper.getOpenOrders() }),
			pnl: () => formatPnlAlert(paper.snapshot(midpoints)),
		});
		bot.start();
		sink = bot;
	}
	const monitor = new Monitor(sink, { minAlertIntervalMs: settings.getNum("ALERTS.MIN_INTERVAL_SEC") * 1000 });

	// ---- Discover funded reward markets.
	const gammaLimit = envNum("DISCOVERY_GAMMA_LIMIT", DEFAULT_DISCOVERY_GAMMA_LIMIT);
	const rewardPages = envNum("CLOB_REWARD_SCAN_PAGES", DEFAULT_REWARD_SCAN_PAGES);
	log.info(`discovering funded reward markets (Gamma limit=${gammaLimit}, CLOB reward pages=${rewardPages})...`);
	const [rewardState, activeMarkets] = await Promise.all([
		clob.getRewardMarketSnapshots(rewardPages),
		gamma.getActiveMarkets(gammaLimit),
	]);
	const hasClobRewardSource = rewardState.byToken.size > 0 || rewardState.byCondition.size > 0;
	log.info(`discovery join: activeGamma=${activeMarkets.length}, clobRewardTokens=${rewardState.byToken.size}, clobRewardConditions=${rewardState.byCondition.size}, source=${rewardState.source}`);

	let rewardMarkets = activeMarkets
		.filter((m) => m.clobTokenIds.length >= 1)
		.filter((m) => m.active && !m.closed && !m.archived && m.acceptingOrders !== false && m.enableOrderBook !== false)
		.map((m) => ({ market: m, reward: getRewardForMarket(rewardState, m) }))
		.filter((x) => (hasClobRewardSource ? x.reward !== null : (x.market.rewardsDailyRate ?? 0) > 0));

	// Enrich Gamma reward fields from CLOB rewards, because CLOB rewards.rates is the
	// authoritative funded-rate source.
	rewardMarkets = rewardMarkets.map((x) => {
		if (x.reward) {
			x.market.rewardsDailyRate = x.reward.rewardDailyRate;
			x.market.rewardsMinSize = x.reward.rewardMinSize;
			x.market.rewardsMaxSpread = x.reward.rewardMaxSpread;
		}
		return x;
	});
	log.info(`funded reward candidates after strict filter: ${rewardMarkets.length}`);

	const metrics: MarketMetrics[] = [];
	const byToken = new Map<string, { market: GammaMarket; reward: ClobRewardSnapshot | null; book: OrderBookSnapshot }>();
	for (const { market, reward } of rewardMarkets) {
		const token = market.clobTokenIds[0];
		try {
			const book = await clob.getOrderBook(token);
			latestBooks.set(token, book);
			byToken.set(token, { market, reward, book });
			metrics.push(
				metricsFromBook(
					{
						tokenId: token,
						question: market.question,
						rewardPerDay: reward?.rewardDailyRate ?? market.rewardsDailyRate ?? 0,
						rewardPool: reward?.rewardDailyRate ?? market.rewardsDailyRate ?? 0,
						volume24h: Number(market.volume24hr ?? 0),
						isSports: isSports(market),
					},
					book,
				),
			);
		} catch (e) {
			log.debug(`skip book unreadable ${token.slice(0, 8)}... ${(e as Error).message}`);
		}
	}

	const actScore = settings.getNum("SELECTION.ACT_SCORE");
	const maxMarkets = settings.getNum("SELECTION.MAX_MARKETS");
	let selected = selectTopMarkets(metrics, actScore, maxMarkets);
	if (selected.length === 0 && metrics.length > 0) {
		selected = metrics.map((m) => ({ ...m, ...compositeScore(m) })).sort((a, b) => b.score10 - a.score10).slice(0, maxMarkets);
		const best = selected[0]?.score10 ?? 0;
		log.warn(`no funded reward markets scored >= ${actScore}; fallback farming best funded rewards (${best.toFixed(1)}/10)`);
		await sink.send(`⚠️ no funded reward markets scored >= ${actScore}/10 — farming best funded rewards (${best.toFixed(1)}/10)`);
	}

	ctxs = selected.map((s) => {
		const item = byToken.get(s.tokenId)!;
		return {
			market: item.market,
			yesToken: s.tokenId,
			noToken: item.market.clobTokenIds[1] ?? null,
			scored: s,
			reward: item.reward,
			lastBook: item.book,
			lastAlertStrategy: null,
			lastAlertAt: 0,
			lastArbAlertAt: 0,
		};
	});

	if (ctxs.length === 0) {
		log.error("no readable funded reward markets found; nothing to farm");
		await sink.send("⚠️ no readable funded reward markets found right now");
		return;
	}
	for (const c of ctxs) log.info(`farming funded reward [${c.scored.score10.toFixed(1)}/10] reward=$${(c.reward?.rewardDailyRate ?? c.market.rewardsDailyRate ?? 0).toFixed(2)}/day ${c.market.question.slice(0, 70)}`);
	await sink.send(`🚀 farming ${ctxs.length} funded reward markets from ${rewardState.source}`);
	for (let i = 0; i < ctxs.length; i += 1) {
		const c = ctxs[i];
		await sink.send(formatMarketSelectedAlert({
			index: i + 1,
			total: ctxs.length,
			question: c.market.question,
			slug: c.market.slug,
			conditionId: c.market.conditionId,
			yesToken: c.yesToken,
			noToken: c.noToken,
			score10: c.scored.score10,
			rewardDaily: c.reward?.rewardDailyRate ?? c.market.rewardsDailyRate ?? 0,
			rewardMinSize: c.reward?.rewardMinSize ?? c.market.rewardsMinSize,
			rewardMaxSpread: c.reward?.rewardMaxSpread ?? c.market.rewardsMaxSpread,
			book: c.lastBook,
			volume24h: c.market.volume24hr,
			liquidity: c.market.liquidity,
		}));
	}

	// ---- Live feed.
	const tokenIds = [...new Set(ctxs.flatMap((c) => (c.noToken ? [c.yesToken, c.noToken] : [c.yesToken])))];
	const manager = new ParallelWsManager(cfg, tokenIds, {
		onQuote: (q) => {
			if (q.midpoint !== null) midpoints.set(q.tokenId, q.midpoint);
			if (q.lastTradePrice !== null && lastTradeByToken.get(q.tokenId) !== q.lastTradePrice) {
				lastTradeByToken.set(q.tokenId, q.lastTradePrice);
				const ctx = ctxs.find((c) => c.yesToken === q.tokenId || c.noToken === q.tokenId);
				if (ctx) {
					const before = paper.snapshot(midpoints).realizedPnl;
					const fills = paper.onTrade(q.tokenId, q.lastTradePrice);
					const after = paper.snapshot(midpoints);
					const delta = after.realizedPnl - before;
					if (delta !== 0) adverse.addFillPnl(q.tokenId, delta);
					for (const fill of fills) {
						void sink.send(formatFillAlert({ fill, question: ctx.market.question, book: latestBooks.get(q.tokenId) ?? ctx.lastBook, netPnl: after.netPnl, unrealizedPnl: after.unrealizedPnl, openOrders: after.openOrders }));
					}
				}
			}
		},
		onResolved: (ids) => {
			for (const id of ids) {
				paper.cancelAll(id);
				const ctx = ctxs.find((c) => c.yesToken === id || c.noToken === id);
				void sink.send(`🏁 *Market resolved*\n${ctx?.market.question.slice(0, 100) ?? id}\nCancelled paper orders for token ${id.slice(0, 8)}...`);
			}
		},
	});
	await manager.start();

	const requote = setInterval(() => {
		void requoteCycle(cfg, clob, paper, ctxs, midpoints, latestBooks, drift, adverse, settings, sink).catch((e) => log.warn(`requote error: ${(e as Error).message}`));
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
	latestBooks: Map<string, OrderBookSnapshot>,
	drift: DriftDetector,
	adverse: AdverseSelectionMonitor,
	settings: SettingsStore,
	sink: AlertSink,
): Promise<void> {
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
			await sink.send(`🛑 *Risk cancel*\n${ctx.market.question.slice(0, 100)}\nReason: ${drift.isDrifting(token) ? "fast drift" : "toxic fills"}\nCancelled YES${ctx.noToken ? " + NO" : ""} paper orders.`);
			continue;
		}

		const pos = paper.getPosition(token);
		if (pos) {
			const exit = buildInventoryExit(pos);
			if (exit && !paper.getOpenOrders(token).some((o) => o.strategy === "inventory-exit" && o.side === exit.side)) {
				const order = paper.placeOrder({ tokenId: token, side: exit.side, outcome: exit.outcome, price: exit.price, size: exit.size, strategy: "inventory-exit" });
				await sink.send(formatOrderPlacedAlert({ order, question: ctx.market.question, book: ctx.lastBook, expectedDailyReward: 0, exposureUsd: expectedExposureForOrder(order), balance: paper.getBalance(), openOrders: paper.getOpenOrders().length }));
			}
		}

		const totalExposure = netExposureUsd(paper.getPositions(), midpoints);
		const marketExposure = pos ? Math.abs(pos.shares) * mid : 0;
		const gate = canQuote({ marketExposureUsd: marketExposure, totalExposureUsd: totalExposure, balanceUsd: paper.getBalance(), params: { maxSingleMarketUsd: maxSingle, maxTotalExposureUsd: maxTotal } });
		if (!gate.ok) continue;

		let competitorScore = 0;
		let book: OrderBookSnapshot | null = null;
		try {
			book = await clob.getOrderBook(token);
			ctx.lastBook = book;
			latestBooks.set(token, book);
			const bids: QuoteOrder[] = book.bids.map((b) => ({ price: b.price, size: b.size }));
			const asks: QuoteOrder[] = book.asks.map((a) => ({ price: a.price, size: a.size }));
			competitorScore = scoreSide(bids, mid).qScore + scoreSide(asks, mid).qScore;
		} catch {
			/* tolerate book read failure */
		}

		const out: StrategyOutput | null = selectStrategy(
			{ midpoint: mid, yesTokenId: token, rewardPool: ctx.reward?.rewardDailyRate ?? ctx.market.rewardsDailyRate ?? 0, competitorScore, sharesPerSide, hoursToResolution: hoursToResolution(ctx.market), offsetFrac },
			settings,
		);
		if (!out) {
			for (const o of paper.getOpenOrders(token)) if (o.strategy !== "inventory-exit" && o.strategy !== "stacked-arb") paper.cancelOrder(o.id);
		} else {
			const current = paper.getOpenOrders(token).filter((o) => o.strategy === out.strategy);
			const { toCancel, toPlace } = reconcileQuotes({ desired: out.orders, current, repriceTolerance: REPRICE_TOLERANCE });
			for (const o of paper.getOpenOrders(token)) if (o.strategy !== out.strategy && o.strategy !== "inventory-exit" && o.strategy !== "stacked-arb") paper.cancelOrder(o.id);
			for (const id of toCancel) paper.cancelOrder(id);
			for (const d of toPlace) {
				const order = paper.placeOrder({ tokenId: token, side: d.side, outcome: d.outcome, price: d.price, size: d.size, strategy: out.strategy });
				if (settings.getBool("ALERTS.ENABLED")) await sink.send(formatOrderPlacedAlert({ order, question: ctx.market.question, book, expectedDailyReward: out.expectedDailyReward, exposureUsd: marketExposure + expectedExposureForOrder(order), balance: paper.getBalance(), openOrders: paper.getOpenOrders().length }));
			}

			if ((ctx.reward?.rewardDailyRate ?? ctx.market.rewardsDailyRate ?? 0) > 0) {
				const cycleReward = (out.expectedDailyReward * REQUOTE_INTERVAL_MS) / 86_400_000;
				paper.accrueReward(cycleReward);
				adverse.addReward(token, cycleReward);
			}

			const now = Date.now();
			const changed = ctx.lastAlertStrategy !== out.strategy;
			if (settings.getBool("ALERTS.ENABLED") && (changed || now - ctx.lastAlertAt >= minAlertMs) && toPlace.length > 0) {
				ctx.lastAlertStrategy = out.strategy;
				ctx.lastAlertAt = now;
				await sink.send(formatStrategyAlert({ strategy: out.strategy, question: ctx.market.question, action: changed ? "engaged" : "requoted", expectedDailyReward: out.expectedDailyReward, midpoint: mid, score10: ctx.scored.score10, book, exposureUsd: marketExposure, balance: paper.getBalance() }));
			}
		}

		if (settings.getBool("STRATEGY.ENABLE_STACKED_ARB") && ctx.noToken) {
			await manageStackedArb(clob, paper, ctx, latestBooks, settings, sink, minAlertMs);
		}
	}
}

async function manageStackedArb(
	clob: ClobRestClient,
	paper: PaperEngine,
	ctx: MarketCtx,
	latestBooks: Map<string, OrderBookSnapshot>,
	settings: SettingsStore,
	sink: AlertSink,
	minAlertMs: number,
): Promise<void> {
	const yesToken = ctx.yesToken;
	const noToken = ctx.noToken!;
	let yesBook: OrderBookSnapshot;
	let noBook: OrderBookSnapshot;
	try {
		yesBook = await clob.getOrderBook(yesToken);
		noBook = await clob.getOrderBook(noToken);
		latestBooks.set(yesToken, yesBook);
		latestBooks.set(noToken, noBook);
		ctx.lastBook = yesBook;
	} catch {
		return;
	}
	const yes: ArbBook = { bestBid: yesBook.bids[0]?.price ?? 0, bestAsk: yesBook.asks[0]?.price ?? 1 };
	const no: ArbBook = { bestBid: noBook.bids[0]?.price ?? 0, bestAsk: noBook.asks[0]?.price ?? 1 };

	const quote = buildStackedArb({ yes, no, params: { minEdge: settings.getNum("STRATEGY.ARB_MIN_EDGE"), sharesPerSide: settings.getNum("STRATEGY.ARB_SHARES_PER_SIDE") } });
	if (!quote) {
		for (const o of paper.getOpenOrders(yesToken)) if (o.strategy === "stacked-arb") paper.cancelOrder(o.id);
		for (const o of paper.getOpenOrders(noToken)) if (o.strategy === "stacked-arb") paper.cancelOrder(o.id);
		return;
	}

	const placed: ManagedOrder[] = [];
	const yesRecon = reconcileQuotes({ desired: [quote.yesOrder], current: paper.getOpenOrders(yesToken).filter((o) => o.strategy === "stacked-arb"), repriceTolerance: REPRICE_TOLERANCE });
	for (const id of yesRecon.toCancel) paper.cancelOrder(id);
	for (const d of yesRecon.toPlace) placed.push(paper.placeOrder({ tokenId: yesToken, side: d.side, outcome: d.outcome, price: d.price, size: d.size, strategy: "stacked-arb" }));

	const noRecon = reconcileQuotes({ desired: [quote.noOrder], current: paper.getOpenOrders(noToken).filter((o) => o.strategy === "stacked-arb"), repriceTolerance: REPRICE_TOLERANCE });
	for (const id of noRecon.toCancel) paper.cancelOrder(id);
	for (const d of noRecon.toPlace) placed.push(paper.placeOrder({ tokenId: noToken, side: d.side, outcome: d.outcome, price: d.price, size: d.size, strategy: "stacked-arb" }));

	for (const order of placed) {
		await sink.send(formatOrderPlacedAlert({ order, question: ctx.market.question, book: order.tokenId === yesToken ? yesBook : noBook, expectedDailyReward: ctx.reward?.rewardDailyRate ?? ctx.market.rewardsDailyRate ?? 0, exposureUsd: expectedExposureForOrder(order), balance: paper.getBalance(), openOrders: paper.getOpenOrders().length }));
	}

	const now = Date.now();
	if (settings.getBool("ALERTS.ENABLED") && now - ctx.lastArbAlertAt >= minAlertMs && placed.length > 0) {
		ctx.lastArbAlertAt = now;
		await sink.send(`🎯 *stacked-arb active*\n${ctx.market.question.slice(0, 95)}\nYES ${quote.yesOrder.price.toFixed(3)} + NO ${quote.noOrder.price.toFixed(3)} = ${(quote.yesOrder.price + quote.noOrder.price).toFixed(3)}\nLocked edge ${(quote.edge * 100).toFixed(1)}¢/matched share + maker reward.`);
	}
}
