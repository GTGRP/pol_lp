// Crossing-fill simulator.
//
// Paper fills are driven by REAL trade prints from the live CLOB WebSocket. A
// resting order fills only when the market actually trades through its price:
//   - a BUY (bid) at price b fills when a trade prints at P <= b (a seller hit us),
//   - a SELL (ask) at price a fills when a trade prints at P >= a (a buyer lifted us).
// Maker orders fill at THEIR resting price (price improvement goes to us). When
// the trade size is known we cap fills to it (and fill better-priced orders
// first); when unknown we optionally fill the crossed order fully. Optional queue
// modeling is handled by the engine via per-order queue-ahead tracking.
import type { ManagedOrder, Side, Outcome } from "../core/types.js";

export interface SimFill {
	orderId: string;
	tokenId: string;
	side: Side;
	outcome: Outcome;
	price: number; // maker price (our resting price)
	size: number;
}

const EPS = 1e-9;

export function simulateTradeCrossing(
	orders: ManagedOrder[],
	tradePrice: number,
	availableSize: number,
): SimFill[] {
	const fills: SimFill[] = [];
	let remaining = availableSize;

	// A downtick (trade at/below a bid) hits bids; an uptick (trade at/above an ask)
	// lifts asks. In a normal book only one set qualifies for a given print.
	const buys = orders
		.filter((o) => o.side === "BUY" && o.status !== "cancelled" && o.status !== "filled" && tradePrice <= o.price + EPS)
		.sort((a, b) => b.price - a.price); // best (highest) bid first
	const sells = orders
		.filter((o) => o.side === "SELL" && o.status !== "cancelled" && o.status !== "filled" && tradePrice >= o.price - EPS)
		.sort((a, b) => a.price - b.price); // best (lowest) ask first

	for (const o of [...buys, ...sells]) {
		if (remaining <= EPS) break;
		const fillSize = Math.min(o.size, remaining);
		if (fillSize <= EPS) continue;
		fills.push({
			orderId: o.id,
			tokenId: o.tokenId,
			side: o.side,
			outcome: o.outcome,
			price: o.price,
			size: fillSize,
		});
		remaining -= fillSize;
	}
	return fills;
}
