// Stacked-edge cross-outcome arbitrage strategy.
//
// On a binary Polymarket market the YES and NO outcome tokens always settle to
// exactly $1 combined. If we can BUY YES at pYes and BUY NO at pNo as RESTING
// MAKER bids with pYes + pNo < 1, every matched pair locks in (1 - pYes - pNo)
// of arbitrage profit per share AND earns the maker rebate / LP reward on the
// very same fills. We never cross the spread — we sit as (improved) best bids on
// both sides and let takers come to us, so the edges STACK: arb spread + maker
// reward captured on one fill.
//
// Risk: queue / one-legged risk. One leg may fill while the other does not,
// leaving directional inventory. We size conservatively and hand any unpaired
// inventory to the existing inventory manager + risk guard, exactly like the
// core-maker strategy does.
import type { DesiredOrder } from "./quoter.js";

export interface ArbBook {
	bestBid: number;
	bestAsk: number;
}

export interface StackedArbParams {
	minEdge: number; // required (1 - pYes - pNo) after buffer, to act
	tick: number;
	sharesPerSide: number;
	maxLegPrice: number; // never bid a leg above this (avoid toxic tails)
}

export const DEFAULT_STACKED_ARB_PARAMS: StackedArbParams = {
	minEdge: 0.02,
	tick: 0.01,
	sharesPerSide: 50,
	maxLegPrice: 0.97,
};

export interface StackedArbQuote {
	yesOrder: DesiredOrder;
	noOrder: DesiredOrder;
	edge: number; // locked profit per matched share
}

function floorToTick(price: number, tick: number): number {
	return Math.floor(price / tick + 1e-9) * tick;
}

// Build resting maker bids on both YES and NO that sum to < 1 by at least
// `minEdge`. Returns null when no profitable, maker-safe pair exists.
export function buildStackedArb(args: {
	yes: ArbBook;
	no: ArbBook;
	params?: Partial<StackedArbParams>;
}): StackedArbQuote | null {
	const p: StackedArbParams = { ...DEFAULT_STACKED_ARB_PARAMS, ...(args.params ?? {}) };

	// Improve the current best bid by one tick, but stay strictly maker (below the
	// opposing best ask so we are never an immediate taker).
	const yesBid = floorToTick(Math.min(args.yes.bestBid + p.tick, args.yes.bestAsk - p.tick), p.tick);
	const noBid = floorToTick(Math.min(args.no.bestBid + p.tick, args.no.bestAsk - p.tick), p.tick);

	if (!(yesBid > 0) || !(noBid > 0)) return null;
	if (yesBid > p.maxLegPrice || noBid > p.maxLegPrice) return null;

	const edge = 1 - (yesBid + noBid);
	if (edge < p.minEdge) return null;

	return {
		yesOrder: { side: "BUY", outcome: "YES", price: yesBid, size: p.sharesPerSide },
		noOrder: { side: "BUY", outcome: "NO", price: noBid, size: p.sharesPerSide },
		edge,
	};
}
