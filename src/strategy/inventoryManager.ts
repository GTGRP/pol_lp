// Inventory manager — turns unwanted inventory into maker exits and ignores dust.
//
// When a quote gets filled we hold directional inventory we didn't want. The
// cheapest way out is a MAKER take-profit order a little in our favour (earns the
// spread, possibly more rewards). Tiny fractional leftovers ("dust") are ignored
// to avoid churn. Hard risk exits (taker stop-loss) live in riskGuard.
import type { Position } from "../core/types.js";
import type { DesiredOrder } from "./quoter.js";

export interface InventoryParams {
	dustShares: number; // ignore positions smaller than this
	takeProfitMargin: number; // price improvement for maker exit (e.g. 0.01 = 1c)
	tick: number;
}

export const DEFAULT_INVENTORY_PARAMS: InventoryParams = {
	dustShares: 5,
	takeProfitMargin: 0.01,
	tick: 0.01,
};

function roundToTick(price: number, tick: number): number {
	return Math.round(price / tick) * tick;
}

// Returns a maker exit order for a position, or null if it's dust / not worth it.
export function buildInventoryExit(position: Position, params: Partial<InventoryParams> = {}): DesiredOrder | null {
	const p: InventoryParams = { ...DEFAULT_INVENTORY_PARAMS, ...params };
	const shares = position.shares;
	if (Math.abs(shares) < p.dustShares) return null; // Layer: dust management
	if (shares > 0) {
		// Long inventory -> sell above cost.
		const price = roundToTick(position.avgPrice + p.takeProfitMargin, p.tick);
		if (price >= 1) return null;
		return { side: "SELL", outcome: position.outcome, price, size: shares };
	}
	// Short inventory -> buy back below cost.
	const price = roundToTick(position.avgPrice - p.takeProfitMargin, p.tick);
	if (price <= 0) return null;
	return { side: "BUY", outcome: position.outcome, price, size: Math.abs(shares) };
}

export function netExposureUsd(positions: Position[], midpoints: Map<string, number>): number {
	let total = 0;
	for (const pos of positions) {
		const mid = midpoints.get(pos.tokenId) ?? pos.avgPrice;
		total += Math.abs(pos.shares) * mid;
	}
	return total;
}
