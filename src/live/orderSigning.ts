// CLOB order construction + EIP-712 signing.
//
// Builds a Polymarket CTF Exchange (V2) order, computes maker/taker amounts (pUSD
// and shares are 6-decimal fixed point), and signs it with the EOA. For signature
// type 3 (POLY_1271) the `maker` is the funder/deposit wallet while the `signer`
// is the controlling EOA.
//
// Exchange addresses come from core/contracts.ts (V2, docs-verified). Still confirm
// the exact /order POST payload shape + EIP-712 domain (name/version) against the
// live CLOB V2 API with a $1 test order before scaling — the V2 order struct may
// differ from V1; that surface is isolated in liveClient.ts.
import { Wallet, getAddress } from "ethers";
import { POLYMARKET_V2 } from "../core/contracts.js";

export type OrderSide = "BUY" | "SELL";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SCALE = 1_000_000; // 1e6 fixed point for collateral (pUSD) and shares

// V2 Polygon exchange addresses (see core/contracts.ts).
export const CTF_EXCHANGE = POLYMARKET_V2.ctfExchange;
export const NEG_RISK_CTF_EXCHANGE = POLYMARKET_V2.negRiskCtfExchange;

function exchangeDomain(chainId: number, verifyingContract: string) {
	// Lowercase first so getAddress re-derives the checksum (avoids a throw on any
	// checksum-casing mismatch in the source address string).
	return { name: "Polymarket CTF Exchange", version: "1", chainId, verifyingContract: getAddress(verifyingContract.toLowerCase()) };
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
