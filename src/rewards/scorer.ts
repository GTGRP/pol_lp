// Reward scorer — replicates Polymarket's liquidity-rewards scoring ("Qn").
//
// Polymarket pays LP rewards in proportion to a per-order scoring function that:
//   1. decays quadratically as an order sits further from the midpoint,
//   2. only counts orders within `maxSpread` of the midpoint,
//   3. only counts orders at or above `minSize` shares,
//   4. strongly favours TWO-SIDED quoting — the binding score is the SMALLER of
//      your bid-side and ask-side scores, so a lopsided book earns little.
//
// The exact constants Polymarket uses drift over time, so every parameter is
// configurable and the live calibrator (calibrator.ts) tunes them against the
// real order-scoring + earnings endpoints.

export interface ScoringParams {
	// Max distance from midpoint (price units, e.g. 0.03 = 3c) for an order to score.
	maxSpread: number;
	// Minimum qualifying order size in shares.
	minSize: number;
	// Spread-decay exponent b (Polymarket uses a quadratic, b = 2).
	exponent: number;
	// Optional multiplier for boosted (e.g. sports / in-game) markets.
	inGameMultiplier: number;
}

export const DEFAULT_SCORING: ScoringParams = {
	maxSpread: 0.03,
	minSize: 5,
	exponent: 2,
	inGameMultiplier: 1,
};

export interface QuoteOrder {
	price: number;
	size: number;
}

export interface SideScore {
	qScore: number; // summed scoring across qualifying orders on this side
	qualifyingSize: number; // total shares that qualified
	orders: number; // number of qualifying orders
}

export interface MarketScore {
	qBid: number;
	qAsk: number;
	qOneSided: number; // qBid + qAsk (informational)
	qTwoSided: number; // min(qBid, qAsk) — the reward-binding score
	qualifies: boolean; // true only if both sides have qualifying orders
}

// Score a single order given its distance (spread) from the midpoint.
export function scoreOrder(spread: number, size: number, params: ScoringParams): number {
	if (size < params.minSize) return 0;
	if (spread < 0 || spread > params.maxSpread) return 0;
	const decay = (params.maxSpread - spread) / params.maxSpread; // 1 at mid, 0 at edge
	const weight = Math.pow(decay, params.exponent);
	return weight * size * params.inGameMultiplier;
}

// Score one side of the book against a midpoint.
export function scoreSide(orders: QuoteOrder[], midpoint: number, params: ScoringParams): SideScore {
	let qScore = 0;
	let qualifyingSize = 0;
	let count = 0;
	for (const o of orders) {
		const spread = Math.abs(o.price - midpoint);
		const s = scoreOrder(spread, o.size, params);
		if (s > 0) {
			qScore += s;
			qualifyingSize += o.size;
			count += 1;
		}
	}
	return { qScore, qualifyingSize, orders: count };
}

// Score a full set of our resting orders for one market.
export function scoreMarket(args: {
	bids: QuoteOrder[];
	asks: QuoteOrder[];
	midpoint: number;
	params?: Partial<ScoringParams>;
}): MarketScore {
	const params: ScoringParams = { ...DEFAULT_SCORING, ...(args.params ?? {}) };
	const bid = scoreSide(args.bids, args.midpoint, params);
	const ask = scoreSide(args.asks, args.midpoint, params);
	const qualifies = bid.qScore > 0 && ask.qScore > 0;
	return {
		qBid: bid.qScore,
		qAsk: ask.qScore,
		qOneSided: bid.qScore + ask.qScore,
		qTwoSided: qualifies ? Math.min(bid.qScore, ask.qScore) : 0,
		qualifies,
	};
}

// Convenience: the reward-relevant score for a market (two-sided binding score).
export function rewardScore(score: MarketScore): number {
	return score.qTwoSided;
}
