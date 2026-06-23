// Phase 0 entry point / smoke test.
//
// Loads config, discovers a few reward-bearing markets via Gamma, verifies REST
// by reading an order book, then boots the parallel WebSocket manager and prints
// live best bid/ask plus per-connection health every few seconds.
import { loadConfig, isPaper } from "./core/config.js";
import { setLogLevel, createLogger, type LogLevel } from "./core/logger.js";
import { GammaClient } from "./core/gamma.js";
import { ClobRestClient } from "./core/clob.js";
import { ParallelWsManager } from "./ws/parallelWsManager.js";

const log = createLogger("main");

async function main(): Promise<void> {
	const cfg = loadConfig();
	setLogLevel(cfg.logLevel as LogLevel);
	log.info(`pol_lp starting in ${cfg.mode.toUpperCase()} mode (signature type ${cfg.signatureType})`);
	if (!isPaper(cfg)) {
		log.warn("LIVE mode selected, but live execution is not implemented until Phase 3. Running data layer only.");
	}

	const gamma = new GammaClient(cfg);
	const clob = new ClobRestClient(cfg);

	log.info("discovering reward-bearing markets...");
	let markets = await gamma.getRewardMarkets(50);
	if (markets.length === 0) {
		log.warn("no markets advertised a reward rate; falling back to top active markets");
		markets = await gamma.getActiveMarkets(10);
	}
	const sample = markets.slice(0, 3);
	log.info(`selected ${sample.length} markets for the smoke test`);
	for (const m of sample) {
		log.info(`  - ${m.question.slice(0, 60)} | rewards/day=${m.rewardsDailyRate ?? "?"} | vol24h=${m.volume24hr ?? "?"}`);
	}

	const tokenIds = sample.flatMap((m) => m.clobTokenIds).filter(Boolean);
	if (tokenIds.length === 0) {
		log.error("no CLOB token ids found; aborting smoke test");
		return;
	}

	// Verify REST works by reading one order book.
	try {
		const book = await clob.getOrderBook(tokenIds[0]);
		log.info(`REST order book ok for ${tokenIds[0].slice(0, 10)}...: ${book.bids.length} bids / ${book.asks.length} asks`);
	} catch (err) {
		log.warn(`REST order book read failed: ${(err as Error).message}`);
	}

	const manager = new ParallelWsManager(cfg, tokenIds, {
		onResolved: (ids, outcome) => log.warn(`market resolved -> ${outcome} (${ids.length} tokens) — would stop quoting`),
	});
	await manager.start();

	const interval = setInterval(() => {
		const quotes = manager.getAllQuotes().slice(0, 6);
		for (const q of quotes) {
			log.info(`  ${q.tokenId.slice(0, 10)}... bid=${q.bestBid ?? "-"} ask=${q.bestAsk ?? "-"} mid=${q.midpoint?.toFixed(3) ?? "-"}`);
		}
		log.info(`ws stats: ${JSON.stringify(manager.getStats())}`);
	}, 5_000);

	const shutdown = () => {
		log.info("shutting down...");
		clearInterval(interval);
		manager.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	log.error(`fatal: ${(err as Error).message}`);
	process.exit(1);
});
