// L1 authentication + API-key derivation for the CLOB.
//
// L1 auth is an EIP-712 signature from the signing EOA over the ClobAuthDomain.
// It is used once to derive (or create) the L2 API credentials used for all
// authenticated REST calls. Works for signature type 3 (POLY_1271) because L1
// auth is always signed by the controlling EOA — the funder/deposit wallet only
// matters for order signing (orderSigning.ts).
import { Wallet } from "ethers";
import type { AppConfig } from "../core/config.js";
import type { L2Credentials } from "../core/clob.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("auth");

const AUTH_MESSAGE = "This message attests that I control the given wallet";

function authDomain(chainId: number) {
	return { name: "ClobAuthDomain", version: "1", chainId };
}

const AUTH_TYPES = {
	ClobAuth: [
		{ name: "address", type: "address" },
		{ name: "timestamp", type: "string" },
		{ name: "nonce", type: "uint256" },
		{ name: "message", type: "string" },
	],
};

export async function buildL1Headers(wallet: Wallet, chainId: number, nonce = 0): Promise<Record<string, string>> {
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const signature = await wallet.signTypedData(authDomain(chainId), AUTH_TYPES, {
		address: wallet.address,
		timestamp,
		nonce,
		message: AUTH_MESSAGE,
	});
	return {
		POLY_ADDRESS: wallet.address,
		POLY_SIGNATURE: signature,
		POLY_TIMESTAMP: timestamp,
		POLY_NONCE: String(nonce),
	};
}

function parseCreds(j: any): L2Credentials | null {
	const apiKey = j?.apiKey ?? j?.api_key;
	const apiSecret = j?.secret ?? j?.api_secret;
	const passphrase = j?.passphrase ?? j?.api_passphrase;
	if (apiKey && apiSecret && passphrase) return { apiKey, apiSecret, passphrase };
	return null;
}

// Derive existing L2 credentials, or create new ones if none exist yet.
export async function deriveOrCreateApiKey(cfg: AppConfig): Promise<L2Credentials> {
	if (!cfg.privateKey) throw new Error("PRIVATE_KEY required to derive API credentials");
	const wallet = new Wallet(cfg.privateKey);

	// 1) Try to derive an existing key.
	try {
		const headers = await buildL1Headers(wallet, cfg.chainId);
		const res = await fetch(`${cfg.clobHttpUrl}/auth/derive-api-key`, { method: "GET", headers });
		if (res.ok) {
			const creds = parseCreds(await res.json());
			if (creds) {
				log.info("derived existing L2 API credentials");
				return creds;
			}
		}
	} catch (err) {
		log.warn(`derive-api-key failed: ${(err as Error).message}`);
	}

	// 2) Create a new key.
	const headers = await buildL1Headers(wallet, cfg.chainId);
	const res = await fetch(`${cfg.clobHttpUrl}/auth/api-key`, { method: "POST", headers });
	if (!res.ok) throw new Error(`create api-key failed: ${res.status} ${res.statusText}`);
	const creds = parseCreds(await res.json());
	if (!creds) throw new Error("create api-key returned an unexpected payload");
	log.info("created new L2 API credentials");
	return creds;
}
