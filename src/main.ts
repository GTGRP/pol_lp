// Entry point. Paper mode runs the full farming loop against live data; live mode
// is gated until Phase 3.
import { loadConfig, isPaper } from "./core/config.js";
import { setLogLevel, createLogger, type LogLevel } from "./core/logger.js";
import { runPaper } from "./run/paperRunner.js";

const log = createLogger("main");

async function main(): Promise<void> {
	const cfg = loadConfig();
	setLogLevel(cfg.logLevel as LogLevel);
	log.info(`pol_lp starting in ${cfg.mode.toUpperCase()} mode (signature type ${cfg.signatureType})`);

	if (isPaper(cfg)) {
		await runPaper(cfg);
		return;
	}

	log.warn("LIVE mode is not enabled until Phase 3. Run with TRADING_MODE=paper for now.");
}

main().catch((err) => {
	log.error(`fatal: ${(err as Error).message}`);
	process.exit(1);
});
