// Risk guard — keeps the bot out of bad fills and handles fills that turn toxic.
//
// Three jobs:
//   1. Pre-quote gating: never exceed per-market / total exposure or run the
//      balance too low.
//   2. Drift detection: if a market's midpoint is marching toward 0 or 1, the
//      outcome is resolving — abandon it before we get repeatedly picked off.
//   3. Fill handling: taker stop-loss when a position is underwater past a limit,
//      plus an adverse-selection monitor that halts a market whose fill losses
//      are outrunning its rewards.
import type { Position } from "../core/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("risk");

export interface RiskParams {
	maxSingleMarketUsd: number;
	maxTotalExposureUsd: number;
	minBalanceUsd: number;
	stopLossUsd: number; // per-position taker stop-loss
	driftWindow: number; // samples kept for drift detection
	driftThreshold: number; // total move toward a tail to trigger abandon
	adverseWindowMs: number; // window for adverse-selection accounting
}

export const DEFAULT_RISK_PARAMS: RiskParams = {
	maxSingleMarketUsd: 40,
	maxTotalExposureUsd: 90,
	minBalanceUsd: 5,
	stopLossUsd: 4,
	driftWindow: 12,
	driftThreshold: 0.08,
	adverseWindowMs: 30 * 60 * 1000,
};

export interface QuoteGateInput {
	marketExposureUsd: number;
	totalExposureUsd: number;
	balanceUsd: number;
	params?: Partial<RiskParams>;
}

export function canQuote(input: QuoteGateInput): { ok: boolean; reason?: string } {
	const p: RiskParams = { ...DEFAULT_RISK_PARAMS, ...(input.params ?? {}) };
	if (input.balanceUsd < p.minBalanceUsd) return { ok: false, reason: "balance below floor" };
	if (input.marketExposureUsd >= p.maxSingleMarketUsd) return { ok: false, reason: "per-market exposure cap" };
	if (input.totalExposureUsd >= p.maxTotalExposureUsd) return { ok: false, reason: "total exposure cap" };
	return { ok: true };
}

// Taker stop-loss: exit immediately if a position is underwater past the limit.
export function shouldStopLoss(position: Position, midpoint: number, params: Partial<RiskParams> = {}): boolean {
	const p: RiskParams = { ...DEFAULT_RISK_PARAMS, ...params };
	const pnl = (midpoint - position.avgPrice) * position.shares; // shares<0 handled by sign
	return pnl <= -p.stopLossUsd;
}

// Tracks midpoint history per token and flags markets drifting to a tail.
export class DriftDetector {
	private readonly history = new Map<string, number[]>();
	private readonly params: RiskParams;

	constructor(params: Partial<RiskParams> = {}) {
		this.params = { ...DEFAULT_RISK_PARAMS, ...params };
	}

	record(tokenId: string, midpoint: number): void {
		const arr = this.history.get(tokenId) ?? [];
		arr.push(midpoint);
		while (arr.length > this.params.driftWindow) arr.shift();
		this.history.set(tokenId, arr);
	}

	// True if the midpoint has moved monotonically toward 0 or 1 beyond threshold.
	isDrifting(tokenId: string): boolean {
		const arr = this.history.get(tokenId);
		if (!arr || arr.length < this.params.driftWindow) return false;
		const first = arr[0];
		const last = arr[arr.length - 1];
		const move = last - first;
		if (Math.abs(move) < this.params.driftThreshold) return false;
		// Heading toward a tail (0 or 1)?
		const towardTail = (move < 0 && last < 0.5) || (move > 0 && last > 0.5);
		if (towardTail) log.warn(`drift on ${tokenId.slice(0, 8)}...: ${first.toFixed(3)} -> ${last.toFixed(3)}`);
		return towardTail;
	}
}

// Per-market adverse-selection accounting: compare realized fill losses vs rewards.
export class AdverseSelectionMonitor {
	private readonly rewards = new Map<string, number>();
	private readonly fillLosses = new Map<string, number>();

	addReward(tokenId: string, usd: number): void {
		this.rewards.set(tokenId, (this.rewards.get(tokenId) ?? 0) + usd);
	}

	addFillPnl(tokenId: string, usd: number): void {
		if (usd < 0) this.fillLosses.set(tokenId, (this.fillLosses.get(tokenId) ?? 0) + usd);
	}

	// True if this market is net-negative (losses outrunning rewards).
	isToxic(tokenId: string): boolean {
		const r = this.rewards.get(tokenId) ?? 0;
		const l = this.fillLosses.get(tokenId) ?? 0; // <= 0
		return r + l < 0;
	}
}
