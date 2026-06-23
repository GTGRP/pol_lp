// Auto-redeem resolved positions on the Conditional Tokens Framework.
//
// After a market resolves, winning outcome tokens must be redeemed for USDC via
// CTF.redeemPositions. This is on-chain and isolated/gated.
// !! VERIFY BEFORE LIVE USE !! contract addresses + that you pass the correct
// conditionId + indexSets for the market. Test on one resolved position first.
import { Wallet, Contract, JsonRpcProvider } from "ethers";
import type { AppConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("redeem");

// Polygon mainnet (verify before live use).
export const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
export const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PARENT_COLLECTION_ID = "0x0000000000000000000000000000000000000000000000000000000000000000";

const CTF_ABI = [
	"function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
];

export interface RedeemArgs {
	conditionId: string;
	// Binary markets: [1, 2] redeems both YES/NO index sets.
	indexSets?: number[];
	rpcUrl: string;
}

export async function redeemResolved(cfg: AppConfig, args: RedeemArgs): Promise<string> {
	if (!cfg.privateKey) throw new Error("PRIVATE_KEY required to redeem");
	const provider = new JsonRpcProvider(args.rpcUrl);
	const wallet = new Wallet(cfg.privateKey, provider);
	const ctf = new Contract(CONDITIONAL_TOKENS, CTF_ABI, wallet);
	const indexSets = args.indexSets ?? [1, 2];
	log.info(`redeeming condition ${args.conditionId} indexSets=[${indexSets.join(",")}]`);
	const tx = await ctf.redeemPositions(USDC, PARENT_COLLECTION_ID, args.conditionId, indexSets);
	const receipt = await tx.wait();
	log.info(`redeem tx mined: ${receipt?.hash ?? tx.hash}`);
	return receipt?.hash ?? tx.hash;
}
