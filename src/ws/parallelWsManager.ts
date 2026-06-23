// Parallel WebSocket manager — ms-accurate, redundant CLOB order book.
//
// Ported and generalized from polymarket-bot-v2/data/parallel_ws.py.
// Runs N redundant CLOB market-channel connections (Layer 2), starts them
// staggered (Layer 5), tracks per-connection health + jitter EMA, and auto-prunes
// the most erratic connection on a budget while respawning a replacement (Layer 6).
// The freshest tick per token wins, giving the lowest-latency view of the book.
import type { AppConfig } from "../core/config.js";
import type { BestQuote } from "../core/types.js";
import { createLogger } from "../core/logger.js";
import { ClobMarketWs } from "./clobMarketWs.js";

const log = createLogger("parallel-ws");

const STAGGER_INTERVAL_MS = 333; // Layer 5
const JITTER_EMA_ALPHA = 0.3; // Layer 6
const NEW_CONNECTION_GRACE_SEC = 8; // Layer 6
const MAX_RESPAWNS_PER_MINUTE = 20; // Layer 6
const MAX_RESPAWNS_PER_CYCLE = 2; // Layer 6

interface ConnState {
	ws: ClobMarketWs;
	createdAt: number;
	lastTickTime: number;
	lastInterval: number;
	jitterEma: number;
	tickCount: number;
}

export interface ParallelWsCallbacks {
	onQuote?: (quote: BestQuote) => void;
	onResolved?: (tokenIds: string[], winningOutcome: string) => void;
}

export class ParallelWsManager {
	private readonly cfg: AppConfig;
	private readonly tokenIds: string[];
	private readonly callbacks: ParallelWsCallbacks;
	private readonly conns = new Map<string, ConnState>();
	private readonly latest = new Map<string, BestQuote>();
	private running = false;
	private pruneTimer: NodeJS.Timeout | null = null;
	private connCounter = 0;
	private respawnsThisMinute = 0;
	private respawnMinuteStart = 0;

	constructor(cfg: AppConfig, tokenIds: string[], callbacks: ParallelWsCallbacks = {}) {
		this.cfg = cfg;
		this.tokenIds = tokenIds.filter(Boolean);
		this.callbacks = callbacks;
	}

	async start(): Promise<void> {
		this.running = true;
		this.respawnMinuteStart = Date.now();
		const n = Math.max(1, this.cfg.wsParallelConnections);
		for (let i = 0; i < n; i += 1) {
			if (i > 0) await sleep(STAGGER_INTERVAL_MS); // Layer 5
			this.spawn();
		}
		this.pruneTimer = setInterval(() => this.prune(), this.cfg.wsPruneIntervalSec * 1000);
		log.info(`parallel WS started: ${n} connections × ${this.tokenIds.length} tokens`);
	}

	stop(): void {
		this.running = false;
		if (this.pruneTimer) clearInterval(this.pruneTimer);
		this.pruneTimer = null;
		for (const state of this.conns.values()) state.ws.stop();
		this.conns.clear();
	}

	// Freshest known quote for a token across all connections.
	getQuote(tokenId: string): BestQuote | null {
		return this.latest.get(tokenId) ?? null;
	}

	getAllQuotes(): BestQuote[] {
		return Array.from(this.latest.values());
	}

	private spawn(): void {
		this.connCounter += 1;
		const name = `clob_${this.connCounter}`;
		const ws = new ClobMarketWs({
			name,
			wsUrl: this.cfg.clobWsUrl,
			tokenIds: this.tokenIds,
			maxPriceJump: this.cfg.wsMaxPriceJump,
			minWarmupTicks: this.cfg.wsMinWarmupTicks,
			debugRejectedTicks: this.cfg.debugRejectedTicks,
			callbacks: {
				onMessage: (connName) => this.onMessage(connName),
				onQuote: (_connName, quote) => this.onQuote(quote),
				onResolved: (_connName, ids, outcome) => this.callbacks.onResolved?.(ids, outcome),
			},
		});
		this.conns.set(name, {
			ws,
			createdAt: Date.now(),
			lastTickTime: 0,
			lastInterval: 0,
			jitterEma: 0,
			tickCount: 0,
		});
		ws.start();
		log.debug(`spawned [${name}]`);
	}

	private onMessage(connName: string): void {
		const state = this.conns.get(connName);
		if (!state) return;
		const now = Date.now();
		state.tickCount += 1;
		if (state.lastTickTime > 0) {
			const interval = now - state.lastTickTime;
			// jitter = deviation from the running average interval
			const expected = state.lastInterval > 0 ? state.lastInterval : interval;
			const jitter = Math.abs(interval - expected);
			state.jitterEma = JITTER_EMA_ALPHA * jitter + (1 - JITTER_EMA_ALPHA) * state.jitterEma;
			state.lastInterval = interval;
		}
		state.lastTickTime = now;
	}

	private onQuote(quote: BestQuote): void {
		const existing = this.latest.get(quote.tokenId);
		if (existing && existing.timestamp > quote.timestamp) return; // older than what we have
		this.latest.set(quote.tokenId, quote);
		this.callbacks.onQuote?.(quote);
	}

	private healthScore(state: ConnState): number {
		if (!state.ws.isConnected) return 0;
		let score = 100;
		const ageSec = (Date.now() - state.createdAt) / 1000;
		const msgsPerSec = ageSec > 0 ? state.tickCount / ageSec : 0;
		score += Math.min(msgsPerSec * 3, 20); // reward throughput
		score -= state.ws.errors * 10; // penalize errors
		score -= Math.min(state.jitterEma * 0.05, 30); // penalize jitter (ms)
		return Math.max(0, Math.min(100, score));
	}

	private prune(): void {
		if (!this.running || this.conns.size < 2) return;
		const now = Date.now();
		if (now - this.respawnMinuteStart > 60_000) {
			this.respawnsThisMinute = 0;
			this.respawnMinuteStart = now;
		}
		if (this.respawnsThisMinute >= MAX_RESPAWNS_PER_MINUTE) return;

		const eligible = Array.from(this.conns.entries()).filter(
			([, s]) => (now - s.createdAt) / 1000 > NEW_CONNECTION_GRACE_SEC,
		);
		if (eligible.length < 2) return;
		const scored = eligible.map(([name, s]) => ({ name, s, score: this.healthScore(s) }));
		const avg = scored.reduce((acc, x) => acc + x.score, 0) / scored.length;
		scored.sort((a, b) => a.score - b.score);

		let killed = 0;
		for (const { name, s, score } of scored) {
			if (killed >= MAX_RESPAWNS_PER_CYCLE) break;
			if (this.respawnsThisMinute >= MAX_RESPAWNS_PER_MINUTE) break;
			if (score < avg * 0.6) {
				log.info(`culling [${name}] (health=${score.toFixed(0)}, jitter=${s.jitterEma.toFixed(1)}ms, avg=${avg.toFixed(0)})`);
				s.ws.stop();
				this.conns.delete(name);
				this.respawnsThisMinute += 1;
				killed += 1;
				this.spawn(); // replacement
			}
		}
	}

	getStats(): Record<string, unknown> {
		const connections: Record<string, unknown> = {};
		for (const [name, s] of this.conns.entries()) {
			connections[name] = {
				connected: s.ws.isConnected,
				health: Math.round(this.healthScore(s)),
				msgs: s.ws.messagesReceived,
				rejected: s.ws.rejectedTicks,
				jitterMs: Math.round(s.jitterEma),
				ageSec: Math.round((Date.now() - s.createdAt) / 1000),
			};
		}
		return {
			connections,
			trackedTokens: this.latest.size,
			respawnsThisMinute: this.respawnsThisMinute,
		};
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
