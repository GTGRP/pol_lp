// Alert sink + rich Telegram formatters.
//
// These messages are intentionally operational: market identity, orderbook review,
// spend/exposure, orders, fills, positions, PnL, and drawdown context are visible
// without opening logs.
import type { ManagedOrder, OrderBookSnapshot, Position } from "../core/types.js";
import type { PnlSnapshot, PaperFillReport } from "../paper/paperEngine.js";

export interface AlertSink {
	send(text: string): Promise<void>;
}

export class NoopAlertSink implements AlertSink {
	async send(): Promise<void> {
		/* no-op when Telegram is not configured */
	}
}

function money(n: number): string {
	return `$${n.toFixed(3)}`;
}

function shortToken(t: string): string {
	return t.length > 14 ? `${t.slice(0, 8)}...${t.slice(-4)}` : t;
}

function bookLine(book?: OrderBookSnapshot | null): string {
	if (!book) return "book n/a";
	const bid = book.bids[0];
	const ask = book.asks[0];
	const bestBid = bid?.price ?? 0;
	const bestAsk = ask?.price ?? 1;
	const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0.5;
	const spread = Math.max(0, bestAsk - bestBid);
	const depth = (bid?.price ?? 0) * (bid?.size ?? 0) + (ask?.price ?? 0) * (ask?.size ?? 0);
	return `book bid ${bestBid.toFixed(3)} x ${(bid?.size ?? 0).toFixed(1)} | ask ${bestAsk.toFixed(3)} x ${(ask?.size ?? 0).toFixed(1)} | mid ${mid.toFixed(3)} | spread ${(spread * 100).toFixed(1)}¢ | top depth ${money(depth)}`;
}

function posLine(p?: Position | null): string {
	if (!p) return "position none";
	return `position ${p.outcome} ${p.shares.toFixed(2)} @ avg ${p.avgPrice.toFixed(3)} (${shortToken(p.tokenId)})`;
}

export function formatMarketSelectedAlert(args: {
	index: number;
	total: number;
	question: string;
	slug?: string;
	conditionId?: string;
	yesToken: string;
	noToken?: string | null;
	score10: number;
	rewardDaily: number;
	rewardMinSize?: number | null;
	rewardMaxSpread?: number | null;
	book?: OrderBookSnapshot | null;
	volume24h?: number | null;
	liquidity?: number | null;
}): string {
	return [
		`✅ *Selected reward market* ${args.index}/${args.total}`,
		`📊 ${args.question.slice(0, 100)}`,
		`🏷 slug: ${args.slug || "n/a"}`,
		`🧾 condition: ${args.conditionId ? shortToken(args.conditionId) : "n/a"}`,
		`🪙 YES ${shortToken(args.yesToken)}${args.noToken ? ` | NO ${shortToken(args.noToken)}` : ""}`,
		`⭐ score ${args.score10.toFixed(1)}/10 | reward ${money(args.rewardDaily)}/day | min ${(args.rewardMinSize ?? 0).toFixed(1)} sh | max spread ${((args.rewardMaxSpread ?? 0) * 100).toFixed(1)}¢`,
		`📚 ${bookLine(args.book)}`,
		`📈 vol24 ${money(Number(args.volume24h ?? 0))} | liquidity ${money(Number(args.liquidity ?? 0))}`,
	].join("\n");
}

export function formatStrategyAlert(args: {
	strategy: string;
	question: string;
	action: string;
	expectedDailyReward: number;
	midpoint: number;
	score10?: number;
	book?: OrderBookSnapshot | null;
	exposureUsd?: number;
	balance?: number;
}): string {
	return [
		`🤖 *${args.strategy}* — ${args.action}`,
		`📊 ${args.question.slice(0, 90)}`,
		`🎯 mid ${args.midpoint.toFixed(3)}${args.score10 !== undefined ? ` | score ${args.score10.toFixed(1)}/10` : ""}`,
		`💰 expected reward ${money(args.expectedDailyReward)}/day`,
		`📚 ${bookLine(args.book)}`,
		`🧮 exposure ${money(args.exposureUsd ?? 0)} | balance ${money(args.balance ?? 0)}`,
	].join("\n");
}

export function formatOrderPlacedAlert(args: {
	order: ManagedOrder;
	question: string;
	book?: OrderBookSnapshot | null;
	expectedDailyReward?: number;
	exposureUsd: number;
	balance: number;
	openOrders: number;
}): string {
	const notional = args.order.price * args.order.size;
	return [
		`🟦 *Paper order placed* (${args.order.strategy})`,
		`📊 ${args.question.slice(0, 95)}`,
		`➡️ ${args.order.side} ${args.order.outcome} | ${args.order.size.toFixed(2)} sh @ ${args.order.price.toFixed(3)} | notional ${money(notional)}`,
		`🪙 token ${shortToken(args.order.tokenId)} | id ${args.order.id}`,
		`📚 ${bookLine(args.book)}`,
		`💰 expected reward ${money(args.expectedDailyReward ?? 0)}/day | exposure ${money(args.exposureUsd)} | balance ${money(args.balance)} | open ${args.openOrders}`,
	].join("\n");
}

export function formatFillAlert(args: {
	fill: PaperFillReport;
	question: string;
	book?: OrderBookSnapshot | null;
	netPnl: number;
	unrealizedPnl: number;
	openOrders: number;
}): string {
	return [
		`✅ *PAPER FILL* (${args.fill.strategy})`,
		`📊 ${args.question.slice(0, 95)}`,
		`➡️ ${args.fill.side} ${args.fill.outcome} filled ${args.fill.size.toFixed(2)} sh @ ${args.fill.price.toFixed(3)} | notional ${money(args.fill.notional)} | fee ${money(args.fill.fee)}`,
		`🪙 token ${shortToken(args.fill.tokenId)} | order ${args.fill.orderId} | ${args.fill.status} | remaining ${args.fill.remainingSize.toFixed(2)}`,
		`📦 ${posLine(args.fill.positionAfter)}`,
		`📚 ${bookLine(args.book)}`,
		`💵 balance ${money(args.fill.balanceAfter)} | net PnL ${money(args.netPnl)} | unreal ${money(args.unrealizedPnl)} | open ${args.openOrders}`,
	].join("\n");
}

export function formatPnlAlert(s: PnlSnapshot): string {
	const positions = s.positions.slice(0, 8).map((p) => `• ${p.outcome} ${p.shares.toFixed(2)} @ ${p.avgPrice.toFixed(3)} (${shortToken(p.tokenId)})`);
	return [
		`📈 *PnL / status update*`,
		`net ${money(s.netPnl)} | realized ${money(s.realizedPnl)} | unreal ${money(s.unrealizedPnl)}`,
		`rewards ${money(s.rewardsAccrued)} | fees ${money(s.feesPaid)} | gas ${money(s.gasPaid)}`,
		`balance ${money(s.balance)} | open orders ${s.openOrders} | positions ${s.positions.length}`,
		positions.length ? `📦 Positions:\n${positions.join("\n")}` : `📦 Positions: none`,
	].join("\n");
}

export function formatDetailedStatus(args: {
	mode: string;
	markets: number;
	snapshot: PnlSnapshot;
	openOrders: ManagedOrder[];
}): string {
	const orders = args.openOrders.slice(0, 8).map((o) => `• ${o.strategy} ${o.side} ${o.outcome} ${o.size.toFixed(1)} @ ${o.price.toFixed(3)} (${shortToken(o.tokenId)})`);
	return [
		`🧭 *Bot status*`,
		`mode=${args.mode} | tracked markets=${args.markets}`,
		formatPnlAlert(args.snapshot),
		orders.length ? `📋 Open orders:\n${orders.join("\n")}` : `📋 Open orders: none`,
	].join("\n");
}

export function formatDrawdownAlert(args: { drawdown: number; peakNet: number; snapshot: PnlSnapshot }): string {
	return [
		`⚠️ *Drawdown alert*`,
		`drawdown ${money(args.drawdown)} from peak ${money(args.peakNet)} | net now ${money(args.snapshot.netPnl)}`,
		`realized ${money(args.snapshot.realizedPnl)} | unreal ${money(args.snapshot.unrealizedPnl)} | rewards ${money(args.snapshot.rewardsAccrued)} | fees ${money(args.snapshot.feesPaid)}`,
		`balance ${money(args.snapshot.balance)} | open ${args.snapshot.openOrders} | positions ${args.snapshot.positions.length}`,
	].join("\n");
}
