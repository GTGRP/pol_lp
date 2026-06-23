// Paper runner — ties the live feed + strategy + paper engine into a loop.
//
// Flow per cycle: refresh midpoints from the parallel WS, detect drift/toxicity,
// estimate competition from the live book, build two-sided quotes inside the
// reward band, gate them through the risk guard, reconcile against open paper
// orders, place maker inventory exits, and accrue calibrated rewards. Real trade
// prints drive paper fills as they happen.
import type { AppConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { GammaClient } from "../core/gamma.js";
import { ClobRestClient } from "../core/clob.js";
import { ParallelWsManager } from "../ws/parallelWsManager.js";
import { PaperEngine } from "../paper/paperEngine.js";
import {
	buildQuotes,
	reconcileQuotes,
	buildInventoryExit,
	netExposureUsd,
	canQuote,
	DriftDetector,
	AdverseSelectionMonitor,
} from "../strategy/index.js";
import { scoreSide, scoreMarket, rewardScore, estimateDailyReward, type QuoteOrder } from "../rewards/index.js";
import type { GammaMarket } from "../core/types.js";

const log = createLogger("paper-runner");

const REQUOTE_INTERVAL_MS = 10_000;
const STATS_INTERVAL_MS = 15_000;
const REPRICE_TOLERANCE = 0.005;

interface MarketCtx {
	market: GammaMarket;
	yesToken: string;
	lastTrade: number | null;
}

export async function runPaper(cfg: AppConfig): Promise<void> {
	const gamma = new GammaClient(cfg);
	const clob = new ClobRestClient(cfg);
	const paper = new PaperEngine({ startingBalance: cfg.startingBalance });
	const drift = new DriftDetector();
	const adverse = new AdverseSelectionMonitor();

	log.info("discovering reward-bearing markets...");
	let markets = await gamma.getRewardMarkets(50);
	if (markets.length === 0) markets = await gamma.getActiveMarkets(10);
	const chosen = markets.slice(0, 3);
	const ctxs: MarketCtx[] = chosen
		.filter((m) => m.clobTokenIds.length >= 1)
		.map((m) => ({ market: m, yesToken: m.clobTokenIds[0], lastTrade: null }));
	if (ctxs.length === 0) {
		log.error("no tradable markets found; aborting paper run");
		return;
	}
	for (const c of ctxs) log.info(`farming: ${c.market.question.slice(0, 60)} | pool/day=${c.market.rewardsDailyRate ?? "?"}`);

	const tokenIds = ctxs.map((c) => c.yesToken);
	const midpoints = new Map<string, number>();

	const manager = new ParallelWsManager(cfg, tokenIds, {
		onQuote: (q) => {
			if (q.midpoint !== null) midpoints.set(q.tokenId, q.midpoint);
			// Real trade print drives fills.
			if (q.lastTradePrice !== null) {
				const ctx = ctxs.find((c) => c.yesToken === q.tokenId);
				if (ctx && ctx.lastTrade !== q.lastTradePrice) {
					ctx.lastTrade = q.lastTradePrice;
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
				log.warn(`market resolved -> cancelled all paper orders for ${id.slice(0, 8)}...`);
			}
		},
	});
	await manager.start();

	const requote = setInterval(() => {
		void requoteCycle(cfg, clob, paper, ctxs, midpoints, drift, adverse).catch((e) => log.warn(`requote error: ${(e as Error).message}`));
	}, REQUOTE_INTERVAL_MS);

	const stats = setInterval(() => {
		const s = paper.snapshot(midpoints);
		log.info(
			`PnL net=$${s.netPnl.toFixed(3)} | realized=$${s.realizedPnl.toFixed(3)} unreal=$${s.unrealizedPnl.toFixed(3)} rewards=$${s.rewardsAccrued.toFixed(3)} fees=$${s.feesPaid.toFixed(3)} | bal=$${s.balance.toFixed(2)} open=${s.openOrders} fills=${paper.getFillCount()}`,
		);
	}, STATS_INTERVAL_MS);

	const shutdown = () => {
		clearInterval(requote);
		clearInterval(stats);
		manager.stop();
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
): Promise<void> {
	const allPositions = paper.getPositions();
	const totalExposure = netExposureUsd(allPositions, midpoints);

	for (const ctx of ctxs) {
		const token = ctx.yesToken;
		const mid = midpoints.get(token);
		if (mid === undefined) continue;
		drift.record(token, mid);

		// Abandon drifting or toxic markets.
		if (drift.isDrifting(token) || adverse.isToxic(token)) {
			paper.cancelAll(token);
			continue;
		}

		// Handle existing inventory first (maker take-profit / stop handled here as maker exit).
		const pos = paper.getPosition(token);
		if (pos) {
			const exit = buildInventoryExit(pos);
			if (exit) {
				const hasExit = paper.getOpenOrders(token).some((o) => o.strategy === "inventory-exit" && o.side === exit.side);
				if (!hasExit) {
					paper.placeOrder({ tokenId: token, side: exit.side, outcome: exit.outcome, price: exit.price, size: exit.size, strategy: "inventory-exit" });
				}
			}
		}

		// Risk gate.
		const marketExposure = pos ? Math.abs(pos.shares) * mid : 0;
		const gate = canQuote({ marketExposureUsd: marketExposure, totalExposureUsd: totalExposure, balanceUsd: paper.getBalance() });
		if (!gate.ok) {
			continue;
		}

		// Estimate competition from the live book.
		let competitorScore = 0;
		try {
			const book = await clob.getOrderBook(token);
			const bidOrders: QuoteOrder[] = book.bids.map((b) => ({ price: b.price, size: b.size }));
			const askOrders: QuoteOrder[] = book.asks.map((a) => ({ price: a.price, size: a.size }));
			competitorScore = scoreSide(bidOrders, mid, { maxSpread: cfg.wsMaxPriceJump } as any).qScore + scoreSide(askOrders, mid, { maxSpread: cfg.wsMaxPriceJump } as any).qScore;
		} catch {
			/* tolerate book read failure */
		}

		// Build and reconcile quotes.
		const desired = buildQuotes({ midpoint: mid, yesTokenId: token, params: { sharesPerSide: cfg.defaultSharesPerSide } });
		if (desired.length === 0) {
			paper.cancelAll(token);
			continue;
		}
		const current = paper.getOpenOrders(token).filter((o) => o.strategy === "quote");
		const { toCancel, toPlace } = reconcileQuotes({ desired, current, repriceTolerance: REPRICE_TOLERANCE });
		for (const id of toCancel) paper.cancelOrder(id);
		for (const d of toPlace) paper.placeOrder({ tokenId: token, side: d.side, outcome: d.outcome, price: d.price, size: d.size, strategy: "quote" });

		// Accrue rewards for this cycle (model estimate, pro-rated to the interval).
		const score = scoreMarket({
			bids: desired.filter((d) => d.side === "BUY").map((d) => ({ price: d.price, size: d.size })),
			asks: desired.filter((d) => d.side === "SELL").map((d) => ({ price: d.price, size: d.size })),
			midpoint: mid,
		});
		const pool = ctx.market.rewardsDailyRate ?? 0;
		if (pool > 0) {
			const capital = desired.reduce((acc, d) => acc + d.price * d.size, 0);
			const est = estimateDailyReward({ myScore: rewardScore(score), competitorScore, dailyRewardPool: pool, capitalAtRisk: capital });
			const cycleReward = (est.dailyReward * REQUOTE_INTERVAL_MS) / 86_400_000;
			paper.accrueReward(cycleReward);
			adverse.addReward(token, cycleReward);
		}
	}
}
