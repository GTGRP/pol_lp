// Single CLOB market-channel WebSocket client.
//
// Ported from polymarket-bot-v2/data/clob_ws.py and adapted to TypeScript.
// Implements data-quality layers 1 (pre-warm), 3 (stale-tick guard) and 4
// (drop-first-tick), plus instant market_resolved detection. Layers 2/5/6
// (redundancy, staggered starts, jitter-EMA culling) live in parallelWsManager.
import WebSocket from "ws";
import type { BestQuote } from "../core/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("clob-ws");

const PING_INTERVAL_MS = 8_000; // server requires a ping within ~10s
const TICKS_TO_DROP_ON_CONNECT = 1; // Layer 4

export interface ClobMarketWsCallbacks {
	// Called for every accepted (valid) quote update.
	onQuote?: (connName: string, quote: BestQuote) => void;
	// Called when a market resolves (token ids + winning outcome).
	onResolved?: (connName: string, tokenIds: string[], winningOutcome: string) => void;
	// Called for every accepted message (used by the manager for timing/jitter).
	onMessage?: (connName: string) => void;
}

export interface ClobMarketWsOptions {
	name: string;
	wsUrl: string;
	tokenIds: string[];
	maxPriceJump: number; // Layer 3 threshold
	minWarmupTicks: number; // Layer 1 threshold
	debugRejectedTicks: boolean;
	callbacks: ClobMarketWsCallbacks;
}

export class ClobMarketWs {
	readonly name: string;
	private readonly opts: ClobMarketWsOptions;
	private ws: WebSocket | null = null;
	private running = false;
	private connected = false;
	private pingTimer: NodeJS.Timeout | null = null;
	private backoffMs = 2_000;

	private readonly subscribed: Set<string>;
	private connectionTickCount = 0; // Layer 4
	private readonly bestBid = new Map<string, number>();
	private readonly bestAsk = new Map<string, number>();
	private readonly lastTrade = new Map<string, number>();
	private readonly lastValidBid = new Map<string, number>();
	private readonly lastValidAsk = new Map<string, number>();
	private readonly validTickCount = new Map<string, number>();
	private readonly resolved = new Set<string>();

	// metrics
	messagesReceived = 0;
	rejectedTicks = 0;
	droppedFirstTicks = 0;
	lastMsgTime = 0;
	connectTime = 0;
	errors = 0;

	constructor(opts: ClobMarketWsOptions) {
		this.name = opts.name;
		this.opts = opts;
		this.subscribed = new Set(opts.tokenIds.filter(Boolean));
	}

	get isConnected(): boolean {
		return this.connected;
	}

	getBestPrices(tokenId: string): { bid: number | null; ask: number | null } {
		return {
			bid: this.bestBid.get(tokenId) ?? null,
			ask: this.bestAsk.get(tokenId) ?? null,
		};
	}

	isMarketResolved(tokenId: string): boolean {
		return this.resolved.has(tokenId);
	}

	isWarmedUp(tokenId: string): boolean {
		return (this.validTickCount.get(tokenId) ?? 0) >= this.opts.minWarmupTicks;
	}

	start(): void {
		this.running = true;
		this.connect();
	}

	stop(): void {
		this.running = false;
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = null;
		try {
			this.ws?.close();
		} catch {
			/* ignore */
		}
		this.ws = null;
	}

	private connect(): void {
		if (!this.running) return;
		const ws = new WebSocket(this.opts.wsUrl);
		this.ws = ws;

		ws.on("open", () => {
			this.connected = true;
			this.connectTime = Date.now();
			this.connectionTickCount = 0; // Layer 4 reset on (re)connect
			this.backoffMs = 2_000;
			const sub = JSON.stringify({
				assets_ids: Array.from(this.subscribed),
				type: "market",
				custom_feature_enabled: true, // enables best_bid_ask + market_resolved
			});
			ws.send(sub);
			log.debug(`[${this.name}] connected + subscribed (${this.subscribed.size} tokens)`);
			this.pingTimer = setInterval(() => {
				try {
					ws.send("PING");
				} catch {
					/* ignore */
				}
			}, PING_INTERVAL_MS);
		});

		ws.on("message", (data: WebSocket.RawData) => {
			this.lastMsgTime = Date.now();
			this.messagesReceived += 1;
			const raw = data.toString();
			if (raw === "PONG") return;
			let msg: unknown;
			try {
				msg = JSON.parse(raw);
			} catch {
				return;
			}
			if (Array.isArray(msg)) {
				for (const item of msg) if (item && typeof item === "object") this.processMessage(item as Record<string, any>);
			} else if (msg && typeof msg === "object") {
				this.processMessage(msg as Record<string, any>);
			}
		});

		ws.on("error", (err: Error) => {
			this.errors += 1;
			log.warn(`[${this.name}] error: ${err.message}`);
		});

		ws.on("close", () => {
			this.connected = false;
			if (this.pingTimer) clearInterval(this.pingTimer);
			this.pingTimer = null;
			if (this.running) {
				setTimeout(() => this.connect(), this.backoffMs);
				this.backoffMs = Math.min(30_000, this.backoffMs + 2_000);
			}
		});
	}

	private processMessage(msg: Record<string, any>): void {
		const eventType = String(msg.event_type ?? "");
		if (["best_bid_ask", "book", "price_change", "last_trade_price"].includes(eventType)) {
			this.connectionTickCount += 1;
			if (this.connectionTickCount <= TICKS_TO_DROP_ON_CONNECT) {
				this.droppedFirstTicks += 1; // Layer 4
				return;
			}
		}
		this.opts.callbacks.onMessage?.(this.name);
		switch (eventType) {
			case "best_bid_ask":
				this.handleBestBidAsk(msg);
				break;
			case "last_trade_price":
				this.handleLastTrade(msg);
				break;
			case "market_resolved":
				this.handleResolution(msg);
				break;
			case "book":
				this.handleBook(msg);
				break;
			case "price_change":
				this.handlePriceChange(msg);
				break;
			default:
				break;
		}
	}

	// Layer 3: reject ticks that jump more than the threshold from last valid price.
	private validJump(tokenId: string, bid: number | null, ask: number | null): boolean {
		const lb = this.lastValidBid.get(tokenId);
		const la = this.lastValidAsk.get(tokenId);
		if (lb === undefined && la === undefined) return true;
		if (bid !== null && lb !== undefined && Math.abs(bid - lb) > this.opts.maxPriceJump) {
			this.rejectedTicks += 1;
			if (this.opts.debugRejectedTicks) log.debug(`[${this.name}] reject bid jump ${lb}->${bid}`);
			return false;
		}
		if (ask !== null && la !== undefined && Math.abs(ask - la) > this.opts.maxPriceJump) {
			this.rejectedTicks += 1;
			if (this.opts.debugRejectedTicks) log.debug(`[${this.name}] reject ask jump ${la}->${ask}`);
			return false;
		}
		return true;
	}

	private commit(tokenId: string, bid: number | null, ask: number | null): void {
		if (bid !== null) {
			this.bestBid.set(tokenId, bid);
			this.lastValidBid.set(tokenId, bid);
		}
		if (ask !== null) {
			this.bestAsk.set(tokenId, ask);
			this.lastValidAsk.set(tokenId, ask);
		}
		this.validTickCount.set(tokenId, (this.validTickCount.get(tokenId) ?? 0) + 1);
		const b = this.bestBid.get(tokenId) ?? null;
		const a = this.bestAsk.get(tokenId) ?? null;
		const mid = b !== null && a !== null ? (b + a) / 2 : null;
		const quote: BestQuote = {
			tokenId,
			bestBid: b,
			bestAsk: a,
			lastTradePrice: this.lastTrade.get(tokenId) ?? null,
			midpoint: mid,
			timestamp: Date.now(),
		};
		this.opts.callbacks.onQuote?.(this.name, quote);
	}

	private handleBestBidAsk(msg: Record<string, any>): void {
		const tokenId = String(msg.asset_id ?? "");
		if (!tokenId) return;
		const bid = msg.best_bid != null ? Number(msg.best_bid) : null;
		const ask = msg.best_ask != null ? Number(msg.best_ask) : null;
		if (!this.validJump(tokenId, bid, ask)) return;
		this.commit(tokenId, Number.isFinite(bid as number) ? bid : null, Number.isFinite(ask as number) ? ask : null);
	}

	private handleLastTrade(msg: Record<string, any>): void {
		const tokenId = String(msg.asset_id ?? "");
		const price = Number(msg.price);
		if (!tokenId || !Number.isFinite(price)) return;
		const prev = this.lastTrade.get(tokenId);
		if (prev !== undefined && Math.abs(price - prev) > this.opts.maxPriceJump) {
			this.rejectedTicks += 1;
			return;
		}
		this.lastTrade.set(tokenId, price);
	}

	private handleResolution(msg: Record<string, any>): void {
		const ids: string[] = Array.isArray(msg.assets_ids) ? msg.assets_ids.map((x: unknown) => String(x)) : [];
		const winning = String(msg.winning_outcome ?? "");
		for (const id of ids) this.resolved.add(id);
		log.info(`[${this.name}] MARKET RESOLVED -> ${winning} (${ids.length} tokens)`);
		this.opts.callbacks.onResolved?.(this.name, ids, winning);
	}

	private handleBook(msg: Record<string, any>): void {
		const tokenId = String(msg.asset_id ?? "");
		if (!tokenId) return;
		const bids = Array.isArray(msg.bids) ? msg.bids : [];
		const asks = Array.isArray(msg.asks) ? msg.asks : [];
		const bid = bids.length ? Number(bids[0]?.price) : null;
		const ask = asks.length ? Number(asks[0]?.price) : null;
		if (!this.validJump(tokenId, Number.isFinite(bid as number) ? bid : null, Number.isFinite(ask as number) ? ask : null)) return;
		this.commit(tokenId, Number.isFinite(bid as number) ? bid : null, Number.isFinite(ask as number) ? ask : null);
	}

	private handlePriceChange(msg: Record<string, any>): void {
		const changes = Array.isArray(msg.price_changes) ? msg.price_changes : [];
		for (const change of changes) {
			const tokenId = String(change?.asset_id ?? "");
			if (!tokenId) continue;
			const bid = change?.best_bid != null ? Number(change.best_bid) : null;
			const ask = change?.best_ask != null ? Number(change.best_ask) : null;
			if (!this.validJump(tokenId, bid, ask)) continue;
			this.commit(tokenId, Number.isFinite(bid as number) ? bid : null, Number.isFinite(ask as number) ? ask : null);
		}
	}
}
