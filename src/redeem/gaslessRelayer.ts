// Gasless redeem via Polymarket's Relayer API (Builder Program).
//
// Polymarket's relayer sponsors gas: we build the redeem calldata, submit it with
// builder API-key auth, and the relayer broadcasts it on-chain from the user's
// proxy/deposit wallet (the wallet that actually HOLDS the positions). This is the
// correct path for signature types 1/2/3 — a direct EOA redeem reverts because the
// EOA holds no tokens. Requires Builder Program membership + builder API creds
// (polymarket.com/settings?tab=builder).
//
// !! VERIFY BEFORE PRODUCTION !! The relayer base URL, the /submit + /transaction
// paths/payload field names, and the builder HMAC auth scheme are modeled on
// docs.polymarket.com/api-reference/relayer. Confirm them against the live API (and
// the @polymarket/builder-relayer-client reference) before relying on auto-redeem.
import { createHmac } from "node:crypto";
import { Interface } from "ethers";
import { POLYMARKET_V2 } from "../core/contracts.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("relayer");

const CTF_IFACE = new Interface([
	"function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
]);
const NEG_RISK_IFACE = new Interface([
	"function redeemPositions(bytes32 _conditionId, uint256[] _amounts)",
]);
const PARENT_COLLECTION_ID = "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface RelayerConfig {
	relayerUrl: string;
	builderApiKey: string;
	builderApiSecret: string;
	builderApiPassphrase: string;
}

export interface RelayerTxRequest {
	from: string; // wallet that owns the positions (proxy/Safe/deposit = funder)
	to: string; // target contract (CTF or NegRiskAdapter)
	data: string; // encoded calldata
	value?: string; // "0"
}

export interface RelayerSubmitResponse {
	transactionID: string;
	state: string; // STATE_NEW initially
}

export class GaslessRelayer {
	constructor(private readonly cfg: RelayerConfig) {}

	// Builder API-key auth headers (HMAC over timestamp+method+path+body).
	private headers(method: string, path: string, body: string): Record<string, string> {
		const ts = Math.floor(Date.now() / 1000).toString();
		const message = ts + method + path + body;
		const signature = createHmac("sha256", this.cfg.builderApiSecret || "").update(message).digest("base64");
		return {
			"Content-Type": "application/json",
			POLY_BUILDER_API_KEY: this.cfg.builderApiKey,
			POLY_BUILDER_TIMESTAMP: ts,
			POLY_BUILDER_PASSPHRASE: this.cfg.builderApiPassphrase,
			POLY_BUILDER_SIGNATURE: signature,
		};
	}

	// Encode redeem calldata for the correct contract (standard CTF vs neg-risk).
	encodeRedeem(args: {
		negRisk: boolean;
		collateral: string;
		conditionId: string;
		indexSets?: number[];
		amounts?: Array<string | number>;
	}): { to: string; data: string } {
		if (args.negRisk) {
			const amounts = (args.amounts ?? [0, 0]).map((a) => BigInt(a));
			const data = NEG_RISK_IFACE.encodeFunctionData("redeemPositions", [args.conditionId, amounts]);
			return { to: POLYMARKET_V2.negRiskAdapter, data };
		}
		const data = CTF_IFACE.encodeFunctionData("redeemPositions", [
			args.collateral,
			PARENT_COLLECTION_ID,
			args.conditionId,
			args.indexSets ?? [1, 2],
		]);
		return { to: POLYMARKET_V2.conditionalTokens, data };
	}

	async submit(req: RelayerTxRequest): Promise<RelayerSubmitResponse> {
		const path = "/submit";
		const body = JSON.stringify({ from: req.from, to: req.to, data: req.data, value: req.value ?? "0", type: "WALLET" });
		const res = await fetch(this.cfg.relayerUrl + path, { method: "POST", headers: this.headers("POST", path, body), body });
		if (!res.ok) throw new Error(`relayer submit ${res.status}: ${await res.text()}`);
		return (await res.json()) as RelayerSubmitResponse;
	}

	// Poll GET /transaction until the broadcast tx hash is available.
	async waitForHash(transactionID: string, timeoutMs = 60_000): Promise<string | null> {
		const path = "/transaction";
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const url = `${this.cfg.relayerUrl}${path}?id=${encodeURIComponent(transactionID)}`;
			try {
				const res = await fetch(url, { headers: this.headers("GET", path, "") });
				if (res.ok) {
					const j = (await res.json()) as { transactionHash?: string; state?: string };
					if (j.transactionHash) return j.transactionHash;
				}
			} catch (e) {
				log.warn(`relayer poll error: ${(e as Error).message}`);
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
		return null;
	}
}
