// Shared domain types for pol_lp.

export type Mode = "paper" | "live";
export type Side = "BUY" | "SELL";
export type Outcome = "YES" | "NO";

export interface OrderBookLevel {
	price: number;
	size: number;
}

export interface OrderBookSnapshot {
	tokenId: string;
	bids: OrderBookLevel[]; // sorted best (highest) first
	asks: OrderBookLevel[]; // sorted best (lowest) first
	timestamp: number; // ms epoch when observed locally
}

export interface BestQuote {
	tokenId: string;
	bestBid: number | null;
	bestAsk: number | null;
	lastTradePrice: number | null;
	midpoint: number | null;
	timestamp: number;
}

// Per-market reward configuration as published by Polymarket.
export interface RewardConfig {
	conditionId: string;
	marketSlug?: string;
	// Max distance from midpoint (in price units, e.g. 0.03 = 3c) an order can be and still earn.
	maxIncentiveSpread: number | null;
	// Minimum qualifying order size (shares).
	minIncentiveSize: number | null;
	// Daily reward pool for the market in pUSD/USDC terms.
	dailyRewardPool: number | null;
}

// A market as returned by the Gamma discovery API (normalized).
export interface GammaMarket {
	conditionId: string;
	questionId?: string;
	slug: string;
	question: string;
	category?: string;
	endDateIso?: string;
	active: boolean;
	closed: boolean;
	archived?: boolean;
	acceptingOrders?: boolean;
	enableOrderBook?: boolean;
	negRisk?: boolean;
	volume24hr: number | null;
	liquidity: number | null;
	// CLOB token ids: typically [yesTokenId, noTokenId].
	clobTokenIds: string[];
	outcomes: string[];
	rewardsDailyRate: number | null;
	rewardsMaxSpread: number | null;
	rewardsMinSize: number | null;
}

// A resting order we own (paper or live).
export interface ManagedOrder {
	id: string; // local id (and exchange id once placed)
	tokenId: string;
	side: Side;
	outcome: Outcome;
	price: number;
	size: number; // remaining size in shares
	originalSize: number;
	createdAt: number;
	strategy: string;
	status: "open" | "filled" | "partial" | "cancelled";
}

export interface Position {
	tokenId: string;
	outcome: Outcome;
	shares: number;
	avgPrice: number;
}
