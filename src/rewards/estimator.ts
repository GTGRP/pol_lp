// Reward estimator — converts a scoring into an expected USDC/day and APR.
//
// Polymarket splits a market's daily reward pool across all LPs in proportion to
// their share of the total market score. If our score is `myScore` and the rest
// of the market already totals `competitorScore`, our daily reward is:
//
//   reward = pool * myScore / (competitorScore + myScore)
//
// This captures the core competition dynamic: adding more of our own size has
// diminishing returns as we become a larger fraction of the pool, and a crowded
// market (high competitorScore) pays less per unit of our score.
import { scoreMarket, rewardScore, type ScoringParams, type QuoteOrder } from "./scorer.js";

export interface RewardEstimate {
	dailyReward: number; // expected USDC/day
	shareOfPool: number; // 0..1
	capitalAtRisk: number; // USDC notionally resting on the book
	dailyReturnPct: number; // dailyReward / capitalAtRisk
	annualizedPct: number; // naive APR = dailyReturnPct * 365
}

// Estimate reward given a precomputed score.
export function estimateDailyReward(args: {
	myScore: number;
	competitorScore: number;
	dailyRewardPool: number;
	capitalAtRisk: number;
}): RewardEstimate {
	const denom = args.competitorScore + args.myScore;
	const share = denom > 0 ? args.myScore / denom : 0;
	const dailyReward = args.dailyRewardPool * share;
	const dailyReturnPct = args.capitalAtRisk > 0 ? dailyReward / args.capitalAtRisk : 0;
	return {
		dailyReward,
		shareOfPool: share,
		capitalAtRisk: args.capitalAtRisk,
		dailyReturnPct,
		annualizedPct: dailyReturnPct * 365,
	};
}

// Estimate reward for a concrete quote configuration (our resting orders).
export function estimateForQuoteConfig(args: {
	bids: QuoteOrder[];
	asks: QuoteOrder[];
	midpoint: number;
	dailyRewardPool: number;
	competitorScore: number;
	params?: Partial<ScoringParams>;
}): RewardEstimate & { qualifies: boolean } {
	const score = scoreMarket({ bids: args.bids, asks: args.asks, midpoint: args.midpoint, params: args.params });
	const myScore = rewardScore(score);
	const capital =
		sumNotional(args.bids) + sumNotional(args.asks);
	const est = estimateDailyReward({
		myScore,
		competitorScore: args.competitorScore,
		dailyRewardPool: args.dailyRewardPool,
		capitalAtRisk: capital,
	});
	return { ...est, qualifies: score.qualifies };
}

function sumNotional(orders: QuoteOrder[]): number {
	let total = 0;
	for (const o of orders) total += o.price * o.size;
	return total;
}
