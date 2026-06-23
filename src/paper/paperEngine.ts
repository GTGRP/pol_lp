// Paper trading engine.
//
// Mirrors a real Polymarket account using live data: holds pUSD/USDC-like balance,
// positions (with average cost), and open maker orders; applies crossing fills from
// real trade prints; tracks realized/unrealized PnL, fees, gas, and accrued LP rewards.
import type { ManagedOrder, Position, Side, Outcome } from "../core/types.js";
import { DEFAULT_FEES, tradeFee, type FeeModel } from "../core/fees.js";
import { simulateTradeCrossing } from "./fillSimulator.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("paper");
const EPS = 1e-9;

export interface PaperConfig {
	startingBalance: number;
	fees?: FeeModel;
	fillUnknownSizeFully?: boolean;
}

export interface PnlSnapshot {
	balance: number;
	realizedPnl: number;
	unrealizedPnl: number;
	feesPaid: number;
	gasPaid: number;
	rewardsAccrued: number;
	netPnl: number;
	openOrders: number;
	positions: Position[];
}

export interface PaperFillReport {
	orderId: string;
	tokenId: string;
	side: Side;
	outcome: Outcome;
	price: number;
	size: number;
	notional: number;
	fee: number;
	strategy: string;
	remainingSize: number;
	balanceAfter: number;
	positionAfter: Position | null;
	status: "filled" | "partial";
}

export interface PlaceArgs {
	tokenId: string;
	side: Side;
	outcome: Outcome;
	price: number;
	size: number;
	strategy: string;
}

export class PaperEngine {
	private balance: number;
	private readonly fees: FeeModel;
	private readonly fillUnknownSizeFully: boolean;
	private readonly orders = new Map<string, ManagedOrder>();
	private readonly positions = new Map<string, Position>();
	private realizedPnl = 0;
	private feesPaid = 0;
	private gasPaid = 0;
	private rewardsAccrued = 0;
	private orderSeq = 0;
	private fillCount = 0;

	constructor(cfg: PaperConfig) {
		this.balance = cfg.startingBalance;
		this.fees = cfg.fees ?? DEFAULT_FEES;
		this.fillUnknownSizeFully = cfg.fillUnknownSizeFully ?? true;
	}

	getBalance(): number {
		return this.balance;
	}

	getOpenOrders(tokenId?: string): ManagedOrder[] {
		const all = Array.from(this.orders.values());
		return tokenId ? all.filter((o) => o.tokenId === tokenId) : all;
	}

	getPosition(tokenId: string): Position | null {
		return this.positions.get(tokenId) ?? null;
	}

	getPositions(): Position[] {
		return Array.from(this.positions.values()).filter((p) => Math.abs(p.shares) > EPS);
	}

	placeOrder(args: PlaceArgs): ManagedOrder {
		this.orderSeq += 1;
		const id = `paper-${this.orderSeq}`;
		const order: ManagedOrder = {
			id,
			tokenId: args.tokenId,
			side: args.side,
			outcome: args.outcome,
			price: args.price,
			size: args.size,
			originalSize: args.size,
			createdAt: Date.now(),
			strategy: args.strategy,
			status: "open",
		};
		this.orders.set(id, order);
		return order;
	}

	cancelOrder(id: string): void {
		const o = this.orders.get(id);
		if (o) {
			o.status = "cancelled";
			this.orders.delete(id);
		}
	}

	cancelAll(tokenId?: string): void {
		for (const o of this.getOpenOrders(tokenId)) this.cancelOrder(o.id);
	}

	// Drive fills from a real trade print on the live feed and return detailed fill
	// reports so Telegram can say exactly what filled, on which market, and what the
	// new position/balance looks like.
	onTrade(tokenId: string, tradePrice: number, tradeSize?: number): PaperFillReport[] {
		const reports: PaperFillReport[] = [];
		const resting = this.getOpenOrders(tokenId);
		if (resting.length === 0) return reports;
		const size = tradeSize !== undefined && tradeSize > 0
			? tradeSize
			: this.fillUnknownSizeFully
				? Number.POSITIVE_INFINITY
				: 0;
		if (size <= 0) return reports;
		const fills = simulateTradeCrossing(resting, tradePrice, size);
		for (const f of fills) {
			const o = this.orders.get(f.orderId);
			if (!o) continue;
			const notional = f.price * f.size;
			const fee = tradeFee(notional, true, this.fees);
			this.feesPaid += fee;
			if (f.side === "BUY") {
				this.balance -= notional + fee;
				this.addShares(f.tokenId, f.outcome, f.size, f.price);
			} else {
				this.balance += notional - fee;
				this.reduceShares(f.tokenId, f.outcome, f.size, f.price);
			}
			o.size -= f.size;
			this.fillCount += 1;
			const status: "filled" | "partial" = o.size <= EPS ? "filled" : "partial";
			if (status === "filled") {
				o.status = "filled";
				this.orders.delete(o.id);
			} else {
				o.status = "partial";
			}
			reports.push({
				orderId: f.orderId,
				tokenId: f.tokenId,
				side: f.side,
				outcome: f.outcome,
				price: f.price,
				size: f.size,
				notional,
				fee,
				strategy: o.strategy,
				remainingSize: Math.max(0, o.size),
				balanceAfter: this.balance,
				positionAfter: this.getPosition(f.tokenId),
				status,
			});
			log.debug(`fill ${f.side} ${f.size.toFixed(1)} @ ${f.price.toFixed(3)} (${o.strategy}) bal=${this.balance.toFixed(2)}`);
		}
		return reports;
	}

	private addShares(tokenId: string, outcome: Outcome, size: number, price: number): void {
		const p = this.positions.get(tokenId);
		if (!p || Math.abs(p.shares) <= EPS) {
			this.positions.set(tokenId, { tokenId, outcome, shares: size, avgPrice: price });
			return;
		}
		const totalCost = p.avgPrice * p.shares + price * size;
		p.shares += size;
		p.avgPrice = p.shares > EPS ? totalCost / p.shares : price;
	}

	private reduceShares(tokenId: string, outcome: Outcome, size: number, price: number): void {
		const p = this.positions.get(tokenId);
		if (!p || p.shares <= EPS) {
			this.positions.set(tokenId, { tokenId, outcome, shares: -size, avgPrice: price });
			return;
		}
		const matched = Math.min(size, p.shares);
		this.realizedPnl += (price - p.avgPrice) * matched;
		p.shares -= size;
		if (p.shares < -EPS) p.avgPrice = price;
	}

	accrueReward(amountUsd: number): void {
		if (amountUsd > 0) this.rewardsAccrued += amountUsd;
	}

	chargeGas(times = 1): void {
		this.gasPaid += this.fees.gasPerSettlementUsd * times;
	}

	snapshot(midpoints: Map<string, number>): PnlSnapshot {
		let unrealized = 0;
		for (const p of this.getPositions()) {
			const mid = midpoints.get(p.tokenId);
			if (mid !== undefined) unrealized += (mid - p.avgPrice) * p.shares;
		}
		const netPnl = this.realizedPnl + unrealized + this.rewardsAccrued - this.feesPaid - this.gasPaid;
		return {
			balance: this.balance,
			realizedPnl: this.realizedPnl,
			unrealizedPnl: unrealized,
			feesPaid: this.feesPaid,
			gasPaid: this.gasPaid,
			rewardsAccrued: this.rewardsAccrued,
			netPnl,
			openOrders: this.orders.size,
			positions: this.getPositions(),
		};
	}

	getFillCount(): number {
		return this.fillCount;
	}
}
