// Polymarket V2 contract addresses — Polygon mainnet (chainId 137).
//
// SINGLE SOURCE OF TRUTH for on-chain addresses. Verified against Polymarket's
// official contracts page (https://docs.polymarket.com/resources/contracts) on
// 2026-06-23.
//
// CONTEXT: Polymarket cut over to CLOB V2 in late April 2026 (new Exchange
// contracts, EIP-1271 support, builder codes) and migrated collateral from bridged
// USDC.e to its own pUSD (Polymarket USD) token. V1-signed orders are REJECTED on
// production. The V1 addresses below are kept ONLY so we can detect/avoid accidental
// reuse — never sign or settle against them.
export const POLYMARKET_V2 = {
	chainId: 137,
	// Core trading (V2)
	ctfExchange: "0xE111180000d2663C0091e4f400237545B87B996B",
	negRiskCtfExchange: "0xe2222d279d744050d28e00520010520000310F59",
	negRiskAdapter: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
	conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
	// Collateral (V2 = pUSD, replaced USDC.e)
	pUsd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
	ctfCollateralAdapter: "0xAdA100Db00Ca00073811820692005400218FcE1f",
} as const;

// DEPRECATED V1 — DO NOT USE (CLOB V2 cutover April 2026).
export const POLYMARKET_V1_DEPRECATED = {
	ctfExchange: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
	negRiskCtfExchange: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
	usdcE: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
} as const;
