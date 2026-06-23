// CLOB order construction + EIP-712 signing.
//
// Builds a Polymarket CTF Exchange order, computes maker/taker amounts (USDC and
// shares are 6-decimal fixed point), and signs it with the EOA. For signature
// type 3 (POLY_1271) the `maker` is the funder/deposit wallet while the `signer`
// is the controlling EOA.
//
// !! VERIFY BEFORE LIVE TRADING !!
//   - Exchange verifyingContract addresses (standard vs neg-risk markets).
//   - Exact /order POST payload shape expected by the current CLOB API.
// These are isolated here and in liveClient.ts so they can be confirmed against a
// $1 test order before scaling.
import { Wallet, getAddress } from "ethers";

export type OrderSide = "BUY" | "SELL";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SCALE = 1_000_000; // 1e6 fixed point for USDC and shares

// Polygon mainnet exchange addresses (verify before live use).
export const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
export const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

function exchangeDomain(chainId: number, verifyingContract: string) {
	return { name: "Polymarket CTF Exchange", version: "1", chainId, verifyingContract: getAddress(verifyingContract) };
}

const ORDER_TYPES = {
	Order: [
		{ name: "salt", type: "uint256" },
		{ name: "maker", type: "address" },
		{ name: "signer", type: "address" },
		{ name: "taker", type: "address" },
		{ name: "tokenId", type: "uint256" },
		{ name: "makerAmount", type: "uint256" },
		{ name: "takerAmount", type: "uint256" },
		{ name: "expiration", type: "uint256" },
		{ name: "nonce", type: "uint256" },
		{ name: "feeRateBps", type: "uint256" },
		{ name: "side", type: "uint8" },
		{ name: "signatureType", type: "uint8" },
	],
};

export interface BuildOrderArgs {
	tokenId: string;
	side: OrderSide;
	price: number; // 0..1
	size: number; // shares
	signatureType: number; // 0,1,2,3
	signerEoa: string;
	funder: string; // maker (deposit wallet for sig type 3)
	chainId: number;
	negRisk?: boolean;
	feeRateBps?: number;
}

export interface SignedOrder {
	salt: string;
	maker: string;
	signer: string;
	taker: string;
	tokenId: string;
	makerAmount: string;
	takerAmount: string;
	expiration: string;
	nonce: string;
	feeRateBps: string;
	side: number; // 0 BUY, 1 SELL
	signatureType: number;
	signature: string;
}

function computeAmounts(side: OrderSide, price: number, size: number): { makerAmount: bigint; takerAmount: bigint } {
	const sharesScaled = BigInt(Math.round(size * SCALE));
	const usdcScaled = BigInt(Math.round(price * size * SCALE));
	if (side === "BUY") return { makerAmount: usdcScaled, takerAmount: sharesScaled };
	return { makerAmount: sharesScaled, takerAmount: usdcScaled };
}

function randomSalt(): bigint {
	// 64-bit random salt is plenty for uniqueness.
	const hi = BigInt(Math.floor(Math.random() * 0xffffffff));
	const lo = BigInt(Math.floor(Math.random() * 0xffffffff));
	return (hi << 32n) | lo;
}

export async function buildAndSignOrder(wallet: Wallet, args: BuildOrderArgs): Promise<SignedOrder> {
	const { makerAmount, takerAmount } = computeAmounts(args.side, args.price, args.size);
	const salt = randomSalt();
	const sideInt = args.side === "BUY" ? 0 : 1;
	const verifying = args.negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;

	const orderStruct = {
		salt,
		maker: getAddress(args.funder),
		signer: getAddress(args.signerEoa),
		taker: ZERO_ADDRESS,
		tokenId: BigInt(args.tokenId),
		makerAmount,
		takerAmount,
		expiration: 0n, // GTC
		nonce: 0n,
		feeRateBps: BigInt(args.feeRateBps ?? 0),
		side: sideInt,
		signatureType: args.signatureType,
	};

	const signature = await wallet.signTypedData(exchangeDomain(args.chainId, verifying), ORDER_TYPES, orderStruct);

	return {
		salt: salt.toString(),
		maker: orderStruct.maker,
		signer: orderStruct.signer,
		taker: orderStruct.taker,
		tokenId: args.tokenId,
		makerAmount: makerAmount.toString(),
		takerAmount: takerAmount.toString(),
		expiration: "0",
		nonce: "0",
		feeRateBps: String(args.feeRateBps ?? 0),
		side: sideInt,
		signatureType: args.signatureType,
		signature,
	};
}
