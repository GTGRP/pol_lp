// Market scoring + selection engine.
//
// Scores each candidate market 0–10 from a weighted blend and selects the top N
// markets above an “act” threshold. Weights (sum = 1.0):
//   spread 0.30 | reward-sanity 0.22 | depth 0.20 | volume 0.13 | centrality 0.15
// A sports multiplier nudges in-game / sports markets up (they churn rewards).
import type { OrderBookSnapshot } from "../core/types.js";

export const SELECTION_WEIGHTS = {
	spread: 0.3,
	reward: 0.22,
	depth: 0.2,
	volume: 0.13,
	centrality: 0.15,
};

// Saturation points used to normalize raw metrics into 0..1.
const SAT = {
	spread: 0.03, // reward band width
	rewardPerDay: 150, // USDC/day
	depthUsd: 5_000,
	volume24h: 100_000,
};

const SPORTS_BOOST = 1.15;

export interface MarketMetrics {
	tokenId: string;
	question: string;
	spread: number; // best ask - best bid
	rewardPerDay: number;
	depthUsd: number; // top-of-book notional both sides
	volume24h: number;
	midpoint: number;
	isSports: boolean;
	rewardPool: number;
}

export interface ScoredMarket extends MarketMetrics {
	score10: number;
	breakdown: Record<string, number>;
}

function clamp01(x: number): number {
	return Math.max(0, Math.min(1, x));
}

export function compositeScore(m: MarketMetrics): { score10: number; breakdown: Record<string, number> } {
	const spreadComp = clamp01(m.spread / SAT.spread); // more room in band = better
	const rewardComp = clamp01(m.rewardPerDay / SAT.rewardPerDay);
	const depthComp = clamp01(m.depthUsd / SAT.depthUsd);
	const volumeComp = clamp01(m.volume24h / SAT.volume24h);
	const centralityComp = clamp01(1 - 2 * Math.abs(m.midpoint - 0.5)); // near 0.5 = safer
	let score01 =
		SELECTION_WEIGHTS.spread * spreadComp +
		SELECTION_WEIGHTS.reward * rewardComp +
		SELECTION_WEIGHTS.depth * depthComp +
		SELECTION_WEIGHTS.volume * volumeComp +
		SELECTION_WEIGHTS.centrality * centralityComp;
	if (m.isSports) score01 = Math.min(1, score01 * SPORTS_BOOST);
	return {
		score10: Math.round(score01 * 1000) / 100,
		breakdown: { spreadComp, rewardComp, depthComp, volumeComp, centralityComp },
	};
}

// Derive book-based metrics (spread, depth, midpoint) from a snapshot.
export function metricsFromBook(
	base: { tokenId: string; question: string; rewardPerDay: number; rewardPool: number; volume24h: number; isSports: boolean },
	book: OrderBookSnapshot,
): MarketMetrics {
	const bestBid = book.bids[0]?.price ?? 0;
	const bestAsk = book.asks[0]?.price ?? 1;
	const spread = Math.max(0, bestAsk - bestBid);
	const midpoint = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0.5;
	const bidDepth = (book.bids[0]?.price ?? 0) * (book.bids[0]?.size ?? 0);
	const askDepth = (book.asks[0]?.price ?? 0) * (book.asks[0]?.size ?? 0);
	return {
		tokenId: base.tokenId,
		question: base.question,
		spread,
		rewardPerDay: base.rewardPerDay,
		depthUsd: bidDepth + askDepth,
		volume24h: base.volume24h,
		midpoint,
		isSports: base.isSports,
		rewardPool: base.rewardPool,
	};
}

export function selectTopMarkets(metrics: MarketMetrics[], actScore: number, maxMarkets: number): ScoredMarket[] {
	return metrics
		.map((m) => ({ ...m, ...compositeScore(m) }))
		.filter((m) => m.score10 >= actScore)
		.sort((a, b) => b.score10 - a.score10)
		.slice(0, maxMarkets);
}
