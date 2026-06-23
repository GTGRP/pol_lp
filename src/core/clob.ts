// CLOB v2 REST client wrapper.
//
// Phase 0 scope: public reads (order book, midpoint, reward-bearing markets) plus
// the L2 HMAC auth header builder used by authenticated reads (order scoring,
// user reward earnings). L1 (EIP-712) API-key derivation and order signing are
// scaffolded behind a clearly-marked interface and completed in Phase 3.
import crypto from "node:crypto";
import { Wallet } from "ethers";
import type { AppConfig } from "./config.js";
import type { OrderBookLevel, OrderBookSnapshot } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("clob");
const FETCH_TIMEOUT_MS = 10_000;

export interface L2Credentials {
	apiKey: string;
	apiSecret: string;
	passphrase: string;
}

function base64UrlToBuffer(s: string): Buffer {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	return Buffer.from(b64, "base64");
}

function bufferToBase64Url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

// Build Polymarket L2 (API-key) auth headers: HMAC-SHA256 over
// `${timestamp}${method}${requestPath}${body}` with the base64url-decoded secret.
export function buildL2Headers(
	creds: L2Credentials,
	address: string,
	method: string,
	requestPath: string,
	body?: unknown,
): Record<string, string> {
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const bodyStr = body === undefined ? "" : JSON.stringify(body);
	const message = `${timestamp}${method}${requestPath}${bodyStr}`;
	const secret = creds.apiSecret
		? base64UrlToBuffer(creds.apiSecret)
		: Buffer.alloc(0);
	const sig = bufferToBase64Url(
		crypto.createHmac("sha256", secret).update(message).digest(),
	);
	return {
		POLY_ADDRESS: address,
		POLY_SIGNATURE: sig,
		POLY_TIMESTAMP: timestamp,
		POLY_API_KEY: creds.apiKey,
		POLY_PASSPHRASE: creds.passphrase,
	};
}

function normalizeLevels(
	raw: unknown,
	sort: "desc" | "asc",
): OrderBookLevel[] {
	if (!Array.isArray(raw)) return [];
	const levels: OrderBookLevel[] = [];
	for (const item of raw) {
		const price = Number((item as any)?.price);
		const size = Number((item as any)?.size);
		if (Number.isFinite(price) && Number.isFinite(size)) {
			levels.push({ price, size });
		}
	}
	levels.sort((a, b) => (sort === "desc" ? b.price - a.price : a.price - b.price));
	return levels;
}

export class ClobRestClient {
	private readonly cfg: AppConfig;
	private readonly creds: L2Credentials;
	private readonly address: string;

	constructor(cfg: AppConfig) {
		this.cfg = cfg;
		this.creds = {
			apiKey: cfg.clobApiKey,
			apiSecret: cfg.clobApiSecret,
			passphrase: cfg.clobApiPassphrase,
		};
		// Address used in L2 headers: signing EOA if a key is present, else funder.
		let addr = cfg.funderAddress;
		if (cfg.privateKey) {
			try {
				addr = new Wallet(cfg.privateKey).address;
			} catch {
				log.warn("PRIVATE_KEY present but invalid; falling back to FUNDER_ADDRESS for L2 address");
			}
		}
		this.address = addr;
	}

	private url(path: string, query?: Record<string, string | number | boolean | undefined>): string {
		const u = new URL(path, this.cfg.clobHttpUrl);
		if (query) {
			for (const [k, v] of Object.entries(query)) {
				if (v !== undefined) u.searchParams.set(k, String(v));
			}
		}
		return u.toString();
	}

	async getJson<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
		const url = this.url(path, query);
		log.debug(`GET ${url}`);
		let res: Response;
		try {
			res = await fetchWithTimeout(url, { method: "GET" });
		} catch (e) {
			throw new Error(`CLOB GET ${path} timed out/failed: ${(e as Error).message}`);
		}
		if (!res.ok) {
			throw new Error(`CLOB GET ${path} failed: ${res.status} ${res.statusText}`);
		}
		return (await res.json()) as T;
	}

	// Authenticated GET using L2 headers. requestPath must be the path used in the HMAC.
	async getAuthedJson<T>(requestPath: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
		if (!this.creds.apiKey) {
			throw new Error("L2 credentials not configured (CLOB_API_KEY/SECRET/PASSPHRASE)");
		}
		const headers = buildL2Headers(this.creds, this.address, "GET", requestPath);
		const res = await fetchWithTimeout(this.url(requestPath, query), { method: "GET", headers });
		if (!res.ok) {
			throw new Error(`CLOB authed GET ${requestPath} failed: ${res.status} ${res.statusText}`);
		}
		return (await res.json()) as T;
	}

	// Public: full order book for a token.
	async getOrderBook(tokenId: string): Promise<OrderBookSnapshot> {
		const raw = await this.getJson<{ bids?: unknown; asks?: unknown }>("/book", { token_id: tokenId });
		const book = {
			tokenId,
			bids: normalizeLevels(raw.bids, "desc"),
			asks: normalizeLevels(raw.asks, "asc"),
			timestamp: Date.now(),
		};
		log.debug(`book ${tokenId.slice(0, 8)}... bids=${book.bids.length} asks=${book.asks.length}`);
		return book;
	}

	// Public: midpoint price for a token (returns null if unavailable).
	async getMidpoint(tokenId: string): Promise<number | null> {
		try {
			const raw = await this.getJson<{ mid?: string | number }>("/midpoint", { token_id: tokenId });
			const mid = Number(raw.mid);
			return Number.isFinite(mid) ? mid : null;
		} catch {
			return null;
		}
	}

	// Public: reward-bearing (sampling) markets. Cursor-paginated by the CLOB API.
	async getSamplingMarkets(nextCursor = ""): Promise<{ data: unknown[]; next_cursor: string }> {
		return this.getJson("/sampling-markets", { next_cursor: nextCursor });
	}

	// Authenticated (L2): live scoring status of one of our resting orders. Phase 1 uses this.
	async getOrderScoring(orderId: string): Promise<unknown> {
		return this.getAuthedJson("/order-scoring", { order_id: orderId });
	}

	// Authenticated (L2): per-market earnings + reward configuration for the user. Phase 1 uses this.
	async getUserRewardsEarnings(date?: string): Promise<unknown> {
		return this.getAuthedJson("/rewards/user/markets", { date });
	}

	getAddress(): string {
		return this.address;
	}

	// ---- Phase 3 scaffolding (not yet implemented) ----
	// Derive/create L2 API credentials from an L1 EIP-712 signature, honoring
	// signature type 3 (POLY_1271) where the funder is the deposit wallet.
	async deriveApiKeyL1(): Promise<L2Credentials> {
		throw new Error("deriveApiKeyL1 not implemented yet (Phase 3): L1 EIP-712 + POLY_1271 funder binding");
	}
}
