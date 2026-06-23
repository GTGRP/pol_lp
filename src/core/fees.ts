// Fee + gas model. Polymarket maker/taker trading fees are currently 0 bps, and
// order placement/cancellation is gasless (relayed). We still model everything as
// configurable so paper accounting stays correct if Polymarket turns fees on.

export interface FeeModel {
	makerFeeBps: number;
	takerFeeBps: number;
	// USDC cost attributed to an on-chain settlement action (redeem, etc.).
	gasPerSettlementUsd: number;
}

export const DEFAULT_FEES: FeeModel = {
	makerFeeBps: 0,
	takerFeeBps: 0,
	gasPerSettlementUsd: 0.01,
};

// Trading fee on a filled notional (USDC).
export function tradeFee(notional: number, isMaker: boolean, fees: FeeModel): number {
	const bps = isMaker ? fees.makerFeeBps : fees.takerFeeBps;
	return (notional * bps) / 10_000;
}
