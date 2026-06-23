// Env-driven configuration. Defaults to safe paper mode.
import "dotenv/config";
import type { Mode } from "./types.js";

function str(key: string, fallback = ""): string {
	const v = process.env[key];
	return v === undefined || v === "" ? fallback : v;
}

function num(key: string, fallback: number): number {
	const v = process.env[key];
	if (v === undefined || v === "") return fallback;
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
	const v = process.env[key];
	if (v === undefined || v === "") return fallback;
	return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export interface AppConfig {
	mode: Mode;
	// auth
	privateKey: string;
	signatureType: number;
	funderAddress: string;
	clobApiKey: string;
	clobApiSecret: string;
	clobApiPassphrase: string;
	// endpoints
	clobHttpUrl: string;
	clobWsUrl: string;
	gammaUrl: string;
	chainId: number;
	rpcUrl: string;
	// capital
	startingBalance: number;
	maxSingleMarketUsd: number;
	defaultSharesPerSide: number;
	liveMaxOrderUsd: number;
	// ws tuning
	wsParallelConnections: number;
	wsPruneIntervalSec: number;
	wsMaxPriceJump: number;
	wsMinWarmupTicks: number;
	// telegram
	telegramBotToken: string;
	telegramChatId: string;
	// ops
	enableAutoRedeem: boolean;
	// gasless redeem (Polymarket relayer + builder program)
	gaslessRedeem: boolean;
	relayerUrl: string;
	builderApiKey: string;
	builderApiSecret: string;
	builderApiPassphrase: string;
	// logging
	logLevel: string;
	debugRejectedTicks: boolean;
}

export function loadConfig(): AppConfig {
	const mode: Mode = str("TRADING_MODE", "paper") === "live" ? "live" : "paper";
	return {
		mode,
		privateKey: str("PRIVATE_KEY"),
		signatureType: num("SIGNATURE_TYPE", 3),
		funderAddress: str("FUNDER_ADDRESS"),
		clobApiKey: str("CLOB_API_KEY"),
		clobApiSecret: str("CLOB_API_SECRET"),
		clobApiPassphrase: str("CLOB_API_PASSPHRASE"),
		clobHttpUrl: str("CLOB_HTTP_URL", "https://clob.polymarket.com"),
		clobWsUrl: str(
			"CLOB_WS_URL",
			"wss://ws-subscriptions-clob.polymarket.com/ws/market",
		),
		gammaUrl: str("GAMMA_URL", "https://gamma-api.polymarket.com"),
		chainId: num("CHAIN_ID", 137),
		rpcUrl: str("RPC_URL", "https://polygon-rpc.com"),
		startingBalance: num("STARTING_BALANCE", 100),
		maxSingleMarketUsd: num("MAX_SINGLE_MARKET_USD", 40),
		defaultSharesPerSide: num("DEFAULT_SHARES_PER_SIDE", 75),
		liveMaxOrderUsd: num("LIVE_MAX_ORDER_USD", 10),
		wsParallelConnections: num("WS_PARALLEL_CONNECTIONS", 3),
		wsPruneIntervalSec: num("WS_PRUNE_INTERVAL_SEC", 30),
		wsMaxPriceJump: num("WS_MAX_PRICE_JUMP", 0.15),
		wsMinWarmupTicks: num("WS_MIN_WARMUP_TICKS", 3),
		telegramBotToken: str("TELEGRAM_BOT_TOKEN"),
		telegramChatId: str("TELEGRAM_CHAT_ID"),
		enableAutoRedeem: bool("ENABLE_AUTO_REDEEM", false),
		gaslessRedeem: bool("GASLESS_REDEEM", false),
		relayerUrl: str("RELAYER_URL", "https://relayer-v2.polymarket.com"),
		builderApiKey: str("POLY_BUILDER_API_KEY"),
		builderApiSecret: str("POLY_BUILDER_API_SECRET"),
		builderApiPassphrase: str("POLY_BUILDER_API_PASSPHRASE"),
		logLevel: str("LOG_LEVEL", "info"),
		debugRejectedTicks: bool("DEBUG_REJECTED_TICKS", false),
	};
}

export function isPaper(cfg: AppConfig): boolean {
	return cfg.mode === "paper";
}
