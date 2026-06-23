// Auto-redeem resolved positions (V2).
//
// After a market resolves, winning outcome tokens must be redeemed for collateral.
// Two redeem paths (different ABIs):
//   - STANDARD markets: ConditionalTokens.redeemPositions(collateral, parentCollectionId, conditionId, indexSets)
//   - NEG-RISK markets: NegRiskAdapter.redeemPositions(conditionId, amounts)
//
// V2 NOTES (docs-verified 2026-06-23):
//   - Collateral is now pUSD (Polymarket USD), NOT bridged USDC.e. See core/contracts.ts.
//   - On Polymarket, positions live in a Safe/proxy or deposit wallet (sig types 1/2/3),
//     so a DIRECT EOA redeemPositions REVERTS ("need operator approval"). The correct,
//     recommended path is GASLESS via the Polymarket relayer (builder code): the relayer
//     broadcasts from the owning wallet and Polymarket sponsors gas.
//
// This module is gasless-first (cfg.gaslessRedeem), with a direct on-chain fallback
// that only works when the signer EOA itself holds the tokens (sig type 0).
// VERIFY on ONE resolved position before relying on it in production.
import { Wallet, Contract, JsonRpcProvider, getAddress } from "ethers";
import type { AppConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { POLYMARKET_V2 } from "../core/contracts.js";
import { GaslessRelayer } from "./gaslessRelayer.js";

const log = createLogger("redeem");

export const CONDITIONAL_TOKENS = POLYMARKET_V2.conditionalTokens;
export const NEG_RISK_ADAPTER = POLYMARKET_V2.negRiskAdapter;
export const PUSD_COLLATERAL = POLYMARKET_V2.pUsd;
const PARENT_COLLECTION_ID = "0x0000000000000000000000000000000000000000000000000000000000000000";

const CTF_ABI = [
	"function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
];
const NEG_RISK_ADAPTER_ABI = [
	"function redeemPositions(bytes32 _conditionId, uint256[] _amounts)",
];

export interface RedeemArgs {
	conditionId: string;
	rpcUrl: string;
	// Set true for neg-risk (multi-outcome) markets — routes via the NegRiskAdapter.
	negRisk?: boolean;
	// STANDARD markets: index sets to redeem (binary markets use [1, 2]).
	indexSets?: number[];
	// NEG-RISK markets: amount of each outcome token held (ERC1155 wei). Defaults [0,0].
	amounts?: Array<string | number>;
	// Collateral token (defaults to pUSD). Override only if you know what you're doing.
	collateral?: string;
}

export async function redeemResolved(cfg: AppConfig, args: RedeemArgs): Promise<string> {
	// ---- Preferred: GASLESS via Polymarket relayer + builder code.
	if (cfg.gaslessRedeem) {
		if (!cfg.funderAddress) throw new Error("FUNDER_ADDRESS required for gasless redeem");
		if (!cfg.builderApiKey) throw new Error("POLY_BUILDER_API_KEY required for gasless redeem");
		const relayer = new GaslessRelayer({
			relayerUrl: cfg.relayerUrl,
			builderApiKey: cfg.builderApiKey,
			builderApiSecret: cfg.builderApiSecret,
			builderApiPassphrase: cfg.builderApiPassphrase,
		});
		const { to, data } = relayer.encodeRedeem({
			negRisk: Boolean(args.negRisk),
			collateral: args.collateral ?? PUSD_COLLATERAL,
			conditionId: args.conditionId,
			indexSets: args.indexSets,
			amounts: args.amounts,
		});
		log.info(`gasless redeem -> ${args.negRisk ? "NEG-RISK" : "STANDARD"} condition ${args.conditionId}`);
		const { transactionID } = await relayer.submit({ from: cfg.funderAddress, to, data });
		const hash = await relayer.waitForHash(transactionID);
		log.info(`gasless redeem ${hash ? "mined " + hash : "submitted " + transactionID}`);
		return hash ?? transactionID;
	}

	// ---- Fallback: direct on-chain (pays POL gas; only works if signer EOA holds tokens).
	if (!cfg.privateKey) throw new Error("PRIVATE_KEY required to redeem");
	const provider = new JsonRpcProvider(args.rpcUrl);
	const wallet = new Wallet(cfg.privateKey, provider);

	if (args.negRisk) {
		const adapter = new Contract(getAddress(NEG_RISK_ADAPTER.toLowerCase()), NEG_RISK_ADAPTER_ABI, wallet);
		const amounts = (args.amounts ?? [0, 0]).map((a) => BigInt(a));
		log.info(`direct NEG-RISK redeem condition ${args.conditionId} amounts=[${amounts.join(",")}]`);
		const tx = await adapter.redeemPositions(args.conditionId, amounts);
		const receipt = await tx.wait();
		log.info(`neg-risk redeem tx mined: ${receipt?.hash ?? tx.hash}`);
		return receipt?.hash ?? tx.hash;
	}

	const ctf = new Contract(getAddress(CONDITIONAL_TOKENS.toLowerCase()), CTF_ABI, wallet);
	const collateral = getAddress((args.collateral ?? PUSD_COLLATERAL).toLowerCase());
	const indexSets = args.indexSets ?? [1, 2];
	log.info(`direct STANDARD redeem condition ${args.conditionId} indexSets=[${indexSets.join(",")}] collateral=${collateral}`);
	const tx = await ctf.redeemPositions(collateral, PARENT_COLLECTION_ID, args.conditionId, indexSets);
	const receipt = await tx.wait();
	log.info(`redeem tx mined: ${receipt?.hash ?? tx.hash}`);
	return receipt?.hash ?? tx.hash;
}
