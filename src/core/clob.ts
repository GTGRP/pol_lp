// CLOB v2 REST client wrapper.
//
// Public reads: order books, midpoints, and CLOB reward/sampling market metadata.
// The reward-market discovery path mirrors the useful pattern from reference repos:
// scan Gamma broadly for active markets, then use CLOB simplified/sampling endpoints
// as the authoritative source for funded liquidity reward rates.
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

export interface ClobRewardSnapshot {
	conditionId: string;
	tokenId?: string;
	rewardDailyRate: number;
	rewardHourlyRate: number;
	rewardMinSize: number;
	rewardMaxSpread: number;
	rewardEpoch?: number;
	inGameMultiplier?: number;
	acceptingOrders?: boolean;
	eventStartDate?: string;
	eventEndDate?: string;
	source: string;
}

export interface ClobRewardState {
	byToken: Map<string, ClobRewardSnapshot>;
	byCondition: Map<string, ClobRewardSnapshot>;
	pages: number;
	source: string;
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

function num(v: unknown): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

function optBool(v: unknown): boolean | undefined {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") {
		if (v.toLowerCase() === "true") return true;
		if (v.toLowerCase() === "false") return false;
	}
	return undefined;
}

function normalizeRewardSpread(v: unknown): number {
	const n = num(v);
	if (!n) return 0;
	return n > 1 ? n / 100 : n;
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

function normalizeLevels(raw: unknown, sort: "desc" | "asc"): OrderBookLevel[] {
	if (!Array.isArray(raw)) return [];
	const levels: OrderBookLevel[] = [];
	for (const item of raw) {
		const price = Number((item as any)?.price);
		const size = Number((item as any)?.size ?? (item as any)?.shares);
		if (Number.isFinite(price) && Number.isFinite(size)) levels.push({ price, size });
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
		if (!res.ok) throw new Error(`CLOB GET ${path} failed: ${res.status} ${res.statusText}`);
		return (await res.json()) as T;
	}

	async getAuthedJson<T>(requestPath: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
		if (!this.creds.apiKey) throw new Error("L2 credentials not configured (CLOB_API_KEY/SECRET/PASSPHRASE)");
		const headers = buildL2Headers(this.creds, this.address, "GET", requestPath);
		const res = await fetchWithTimeout(this.url(requestPath, query), { method: "GET", headers });
		if (!res.ok) throw new Error(`CLOB authed GET ${requestPath} failed: ${res.status} ${res.statusText}`);
		return (await res.json()) as T;
	}

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

	async getMidpoint(tokenId: string): Promise<number | null> {
		try {
			const raw = await this.getJson<{ mid?: string | number }>("/midpoint", { token_id: tokenId });
			const mid = Number(raw.mid);
			return Number.isFinite(mid) ? mid : null;
		} catch {
			return null;
		}
	}

	async getSamplingMarkets(nextCursor = ""): Promise<{ data: unknown[]; next_cursor: string }> {
		return this.getJson("/sampling-markets", { next_cursor: nextCursor });
	}

	// Authoritative funded reward-market scan. We try the simplified/sampling endpoints
	// used by market-maker reference repos, paginate broadly, and only keep entries
	// with rewards.rates[].rewards_daily_rate > 0.
	async getRewardMarketSnapshots(maxPages = 30): Promise<ClobRewardState> {
		const endpoints = ["/sampling-simplified-markets", "/simplified-markets", "/sampling-markets"];
		for (const endpoint of endpoints) {
			const byToken = new Map<string, ClobRewardSnapshot>();
			const byCondition = new Map<string, ClobRewardSnapshot>();
			let nextCursor = "";
			let pages = 0;
			try {
				while (pages < maxPages) {
					const payload = await this.getJson<any>(endpoint, nextCursor ? { next_cursor: nextCursor } : undefined);
					const data = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
					for (const entry of data) {
						const conditionId = String(entry?.condition_id ?? entry?.conditionId ?? "").trim();
						if (!conditionId) continue;
						const rewards = entry?.rewards ?? {};
						const rates = Array.isArray(rewards?.rates) ? rewards.rates : [];
						const rewardMinSize = num(rewards?.min_size ?? rewards?.minSize);
						const rewardMaxSpread = normalizeRewardSpread(rewards?.max_spread ?? rewards?.maxSpread);
						const acceptingOrders = optBool(entry?.accepting_orders ?? entry?.acceptingOrders);
						let best: ClobRewardSnapshot | null = null;
						for (const r of rates) {
							const tokenId = String(r?.asset_address ?? r?.assetAddress ?? r?.token_id ?? r?.tokenId ?? "").trim();
							const rewardDailyRate = num(r?.rewards_daily_rate ?? r?.rewardsDailyRate);
							if (rewardDailyRate <= 0) continue;
							const snap: ClobRewardSnapshot = {
								conditionId,
								tokenId: tokenId || undefined,
								rewardDailyRate,
								rewardHourlyRate: rewardDailyRate / 24,
								rewardMinSize,
								rewardMaxSpread,
								rewardEpoch: num(rewards?.reward_epoch) || undefined,
								inGameMultiplier: num(rewards?.in_game_multiplier) || undefined,
								acceptingOrders,
								eventStartDate: rewards?.event_start_date,
								eventEndDate: rewards?.event_end_date,
								source: endpoint,
							};
							if (tokenId) byToken.set(tokenId, snap);
							if (!best || snap.rewardDailyRate > best.rewardDailyRate) best = snap;
						}
						if (best) byCondition.set(conditionId, { ...best, tokenId: undefined });
					}
					nextCursor = String(payload?.next_cursor ?? payload?.nextCursor ?? "");
					pages += 1;
					if (!nextCursor || nextCursor === "LTE=") break;
				}
				log.info(`CLOB reward scan ${endpoint}: pages=${pages}, rewardTokens=${byToken.size}, rewardConditions=${byCondition.size}`);
				if (byToken.size > 0 || byCondition.size > 0) return { byToken, byCondition, pages, source: endpoint };
			} catch (e) {
				log.warn(`CLOB reward scan ${endpoint} failed: ${(e as Error).message}`);
			}
		}
		return { byToken: new Map(), byCondition: new Map(), pages: 0, source: "none" };
	}

	async getOrderScoring(orderId: string): Promise<unknown> {
		return this.getAuthedJson("/order-scoring", { order_id: orderId });
	}

	async getUserRewardsEarnings(date?: string): Promise<unknown> {
		return this.getAuthedJson("/rewards/user/markets", { date });
	}

	getAddress(): string {
		return this.address;
	}

	async deriveApiKeyL1(): Promise<L2Credentials> {
		throw new Error("deriveApiKeyL1 not implemented yet (Phase 3): L1 EIP-712 + POLY_1271 funder binding");
	}
}
