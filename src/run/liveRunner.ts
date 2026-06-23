// Live runner (gated, small-size). Reuses the exact strategy + risk logic from
// paper mode, routes real orders through LiveClient, and runs a shadow
// PaperEngine for reconciliation. Intentionally conservative: requires explicit
// live mode and per-order notional caps, and starts on a single market.
import type { AppConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { GammaClient } from "../core/gamma.js";
import { ClobRestClient } from "../core/clob.js";
import { ParallelWsManager } from "../ws/parallelWsManager.js";
import { PaperEngine } from "../paper/paperEngine.js";
import { LiveClient } from "../live/liveClient.js";
import { Reconciler } from "../live/reconciler.js";
import { redeemResolved } from "../redeem/autoRedeem.js";
import { buildQuotes, reconcileQuotes, canQuote, DriftDetector } from "../strategy/index.js";

const log = createLogger("live-runner");

const REQUOTE_INTERVAL_MS = 12_000;
const REPRICE_TOLERANCE = 0.005;

export async function runLive(cfg: AppConfig): Promise<void> {
	log.warn("LIVE MODE — real orders will be placed with real funds. Caps: $" + cfg.liveMaxOrderUsd + "/order.");
	const gamma = new GammaClient(cfg);
	const clob = new ClobRestClient(cfg);
	const live = new LiveClient(cfg);
	await live.init();

	const shadow = new PaperEngine({ startingBalance: cfg.startingBalance });
	const recon = new Reconciler();
	const drift = new DriftDetector();

	let markets = await gamma.getRewardMarkets(50);
	if (markets.length === 0) markets = await gamma.getActiveMarkets(10);
	const market = markets.find((m) => m.clobTokenIds.length >= 1);
	if (!market) {
		log.error("no tradable market found; aborting live run");
		return;
	}
	const token = market.clobTokenIds[0];
	log.info(`live farming single market: ${market.question.slice(0, 60)}`);

	const midpoints = new Map<string, number>();
	const liveOrderIds = new Map<string, { side: "BUY" | "SELL"; price: number }>();

	const manager = new ParallelWsManager(cfg, [token], {
		onQuote: (q) => {
			if (q.midpoint !== null) midpoints.set(q.tokenId, q.midpoint);
			if (q.lastTradePrice !== null) shadow.onTrade(q.tokenId, q.lastTradePrice);
		},
		onResolved: async () => {
			try {
				await live.cancelAll();
			} catch (e) {
				log.warn(`cancelAll on resolve failed: ${(e as Error).message}`);
			}
			// Auto-redeem the resolved market's winning tokens (gasless if configured).
			if (cfg.enableAutoRedeem) {
				const conditionId = (market as any).conditionId ?? (market as any).condition_id;
				if (conditionId) {
					try {
						const hash = await redeemResolved(cfg, {
							conditionId,
							rpcUrl: cfg.rpcUrl,
							negRisk: Boolean((market as any).negRisk ?? (market as any).neg_risk),
						});
						log.info(`auto-redeem submitted: ${hash}`);
					} catch (e) {
						log.warn(`auto-redeem failed: ${(e as Error).message}`);
					}
				} else {
					log.warn("auto-redeem skipped: market has no conditionId");
				}
			}
		},
	});
	await manager.start();

	const loop = setInterval(() => {
		void cycle().catch((e) => log.warn(`live cycle error: ${(e as Error).message}`));
	}, REQUOTE_INTERVAL_MS);

	async function cycle(): Promise<void> {
		const mid = midpoints.get(token);
		if (mid === undefined) return;
		drift.record(token, mid);
		if (drift.isDrifting(token)) {
			await live.cancelAll();
			liveOrderIds.clear();
			return;
		}
		const pos = shadow.getPosition(token);
		const exposure = pos ? Math.abs(pos.shares) * mid : 0;
		const gate = canQuote({ marketExposureUsd: exposure, totalExposureUsd: exposure, balanceUsd: cfg.startingBalance });
		if (!gate.ok) return;

		const desired = buildQuotes({ midpoint: mid, yesTokenId: token, params: { sharesPerSide: cfg.defaultSharesPerSide } });
		if (desired.length === 0) return;

		// Reconcile against shadow's open orders to mirror intent, then mirror live.
		const current = shadow.getOpenOrders(token).filter((o) => o.strategy === "quote");
		const { toCancel, toPlace } = reconcileQuotes({ desired, current, repriceTolerance: REPRICE_TOLERANCE });
		for (const id of toCancel) shadow.cancelOrder(id);
		for (const d of toPlace) {
			shadow.placeOrder({ tokenId: token, side: d.side, outcome: d.outcome, price: d.price, size: d.size, strategy: "quote" });
			try {
				const { id } = await live.placeOrder({ tokenId: token, side: d.side, price: d.price, size: d.size });
				if (id) liveOrderIds.set(id, { side: d.side, price: d.price });
			} catch (e) {
				log.warn(`live placeOrder failed: ${(e as Error).message}`);
			}
		}
		recon.compare(shadow, midpoints);
	}

	const shutdown = async () => {
		clearInterval(loop);
		manager.stop();
		try {
			await live.cancelAll();
		} catch {
			/* ignore */
		}
		log.info("live runner stopped; all orders cancelled");
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
