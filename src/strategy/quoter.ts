// Quoter — builds two-sided maker quotes inside the reward band.
//
// Given a market midpoint and reward config, it places a bid below and an ask
// above the midpoint at an offset chosen to balance reward score (tighter = more
// score) against adverse-fill risk (tighter = more likely to be picked off).
// The offset stays strictly inside `maxSpread` so both orders qualify.
import type { ManagedOrder, Side, Outcome } from "../core/types.js";

export interface QuoteParams {
	maxSpread: number; // reward band half-width (price units)
	minSize: number; // min qualifying size
	sharesPerSide: number; // target size per side
	// Fraction of maxSpread to sit at (0 = at mid/max risk, 1 = at edge/min score).
	offsetFrac: number;
	// Don't quote if midpoint is in the extreme tails (toxic / low value).
	minMidpoint: number;
	maxMidpoint: number;
	tick: number; // price tick size
}

export const DEFAULT_QUOTE_PARAMS: QuoteParams = {
	maxSpread: 0.03,
	minSize: 5,
	sharesPerSide: 75,
	offsetFrac: 0.5,
	minMidpoint: 0.1,
	maxMidpoint: 0.9,
	tick: 0.01,
};

export interface DesiredOrder {
	side: Side;
	outcome: Outcome;
	price: number;
	size: number;
}

function roundToTick(price: number, tick: number): number {
	return Math.round(price / tick) * tick;
}

// Build the desired two-sided quote for a market's YES token.
export function buildQuotes(args: { midpoint: number; yesTokenId: string; params?: Partial<QuoteParams> }): DesiredOrder[] {
	const p: QuoteParams = { ...DEFAULT_QUOTE_PARAMS, ...(args.params ?? {}) };
	const mid = args.midpoint;
	if (mid < p.minMidpoint || mid > p.maxMidpoint) return []; // skip toxic tails
	const offset = Math.max(p.tick, p.maxSpread * p.offsetFrac);
	const bid = roundToTick(mid - offset, p.tick);
	const ask = roundToTick(mid + offset, p.tick);
	if (bid <= 0 || ask >= 1 || bid >= ask) return [];
	return [
		{ side: "BUY", outcome: "YES", price: bid, size: p.sharesPerSide },
		{ side: "SELL", outcome: "YES", price: ask, size: p.sharesPerSide },
	];
}

export interface Reconciliation {
	toCancel: string[]; // order ids
	toPlace: DesiredOrder[];
}

// Compare desired quotes against current open orders; cancel/replace only when a
// matching side drifts beyond `repriceTolerance`, to avoid churn (and fees/gas).
export function reconcileQuotes(args: {
	desired: DesiredOrder[];
	current: ManagedOrder[];
	repriceTolerance: number;
}): Reconciliation {
	const toCancel: string[] = [];
	const toPlace: DesiredOrder[] = [];
	const usedOrderIds = new Set<string>();

	for (const d of args.desired) {
		const match = args.current.find(
			(o) =>
				!usedOrderIds.has(o.id) &&
				o.side === d.side &&
				Math.abs(o.price - d.price) <= args.repriceTolerance,
		);
		if (match) {
			usedOrderIds.add(match.id);
		} else {
			toPlace.push(d);
		}
	}
	// Cancel any current orders not matched by a desired quote.
	for (const o of args.current) {
		if (!usedOrderIds.has(o.id)) toCancel.push(o.id);
	}
	return { toCancel, toPlace };
}
