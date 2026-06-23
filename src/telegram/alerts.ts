// Alert sink + formatters. Every strategy alert names the strategy and its
// expected daily reward, per the control-panel spec.
import type { PnlSnapshot } from "../paper/paperEngine.js";

export interface AlertSink {
	send(text: string): Promise<void>;
}

export class NoopAlertSink implements AlertSink {
	async send(): Promise<void> {
		/* no-op when Telegram is not configured */
	}
}

export function formatStrategyAlert(args: {
	strategy: string;
	question: string;
	action: string;
	expectedDailyReward: number;
	midpoint: number;
	score10?: number;
}): string {
	const apr = args.expectedDailyReward;
	return [
		`🤖 *${args.strategy}* — ${args.action}`,
		`📊 ${args.question.slice(0, 70)}`,
		`🎯 mid ${args.midpoint.toFixed(3)}${args.score10 !== undefined ? ` | score ${args.score10.toFixed(1)}/10` : ""}`,
		`💰 expected reward ~$${apr.toFixed(3)}/day`,
	].join("\n");
}

export function formatPnlAlert(s: PnlSnapshot): string {
	return [
		`📈 *PnL update*`,
		`net $${s.netPnl.toFixed(3)} | realized $${s.realizedPnl.toFixed(3)} | unreal $${s.unrealizedPnl.toFixed(3)}`,
		`rewards $${s.rewardsAccrued.toFixed(3)} | fees $${s.feesPaid.toFixed(3)}`,
		`balance $${s.balance.toFixed(2)} | open ${s.openOrders} | positions ${s.positions.length}`,
	].join("\n");
}
