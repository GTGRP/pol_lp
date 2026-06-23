// Reward brain public surface.
export {
	scoreOrder,
	scoreSide,
	scoreMarket,
	rewardScore,
	DEFAULT_SCORING,
	type ScoringParams,
	type QuoteOrder,
	type SideScore,
	type MarketScore,
} from "./scorer.js";
export {
	estimateDailyReward,
	estimateForQuoteConfig,
	type RewardEstimate,
} from "./estimator.js";
export { RewardCalibrator } from "./calibrator.js";
