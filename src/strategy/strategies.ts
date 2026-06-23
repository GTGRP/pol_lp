// Strategy registry.
//
// Each strategy turns market state into a named two-sided quote plus an expected
// daily reward, so Telegram alerts can say WHICH strategy acted and the return it
// expects. Strategies are toggled at runtime via the settings store.
//   - core-maker: tight two-sided quote inside the reward band (default).
//   - grid-lp:    slightly wider, hedged grid for short-dated (<= 1 week) markets.
import type { DesiredOrder } from "./quoter.js";
import { buildQuotes } from "./quoter.js";
import { scoreMarket, rewardScore, estimateDailyReward } from "../rewards/index.js";
import type { SettingsStore } from "../telegram/settingsStore.js";

export interface StrategyInput {
	midpoint: number;
	yesTokenId: string;
	rewardPool: number;
	competitorScore: number;
	sharesPerSide: number;
	hoursToResolution: number | null;
	offsetFrac: number;
}

export interface StrategyOutput {
	strategy: string;
	orders: DesiredOrder[];
	expectedDailyReward: number;
	rationale: string;
}

function expectedReward(orders: DesiredOrder[], midpoint: number, pool: number, competitorScore: number): number {
	if (pool <= 0 || orders.length === 0) return 0;
	const score = scoreMarket({
		bids: orders.filter((o) => o.side === "BUY").map((o) => ({ price: o.price, size: o.size })),
		asks: orders.filter((o) => o.side === "SELL").map((o) => ({ price: o.price, size: o.size })),
		midpoint,
	});
	const capital = orders.reduce((acc, o) => acc + o.price * o.size, 0);
	return estimateDailyReward({ myScore: rewardScore(score), competitorScore, dailyRewardPool: pool, capitalAtRisk: capital }).dailyReward;
}

export interface Strategy {
	name: string;
	isEnabled(s: SettingsStore): boolean;
	applies(input: StrategyInput): boolean;
	build(input: StrategyInput): StrategyOutput | null;
}

const coreMaker: Strategy = {
	name: "core-maker",
	isEnabled: (s) => s.getBool("STRATEGY.ENABLE_CORE_MAKER"),
	applies: () => true,
	build: (input) => {
		const orders = buildQuotes({
			midpoint: input.midpoint,
			yesTokenId: input.yesTokenId,
			params: { sharesPerSide: input.sharesPerSide, offsetFrac: input.offsetFrac },
		});
		if (orders.length === 0) return null;
		return {
			strategy: "core-maker",
			orders,
			expectedDailyReward: expectedReward(orders, input.midpoint, input.rewardPool, input.competitorScore),
			rationale: "tight two-sided quote inside reward band",
		};
	},
};

const gridLp: Strategy = {
	name: "grid-lp",
	isEnabled: (s) => s.getBool("STRATEGY.ENABLE_GRID_LP"),
	// Prefer for short-dated markets (daily reward churn, milder competition).
	applies: (input) => input.hoursToResolution !== null && input.hoursToResolution <= 24 * 7,
	build: (input) => {
		// Slightly wider, hedged: sit a touch further from mid to reduce pick-off.
		const orders = buildQuotes({
			midpoint: input.midpoint,
			yesTokenId: input.yesTokenId,
			params: { sharesPerSide: input.sharesPerSide, offsetFrac: Math.min(0.9, input.offsetFrac + 0.2) },
		});
		if (orders.length === 0) return null;
		return {
			strategy: "grid-lp",
			orders,
			expectedDailyReward: expectedReward(orders, input.midpoint, input.rewardPool, input.competitorScore),
			rationale: "hedged grid for short-dated market",
		};
	},
};

export const STRATEGIES: Strategy[] = [gridLp, coreMaker];

// Pick the highest expected-reward enabled+applicable strategy for a market.
export function selectStrategy(input: StrategyInput, settings: SettingsStore): StrategyOutput | null {
	if (!settings.getBool("STRATEGY.ENABLED")) return null;
	let best: StrategyOutput | null = null;
	for (const strat of STRATEGIES) {
		if (!strat.isEnabled(settings) || !strat.applies(input)) continue;
		const out = strat.build(input);
		if (out && (!best || out.expectedDailyReward > best.expectedDailyReward)) best = out;
	}
	return best;
}
