// Lightweight monitor: periodic PnL push + drawdown alerting.
import type { AlertSink } from "../telegram/alerts.js";
import { formatPnlAlert, formatDrawdownAlert } from "../telegram/alerts.js";
import type { PnlSnapshot } from "../paper/paperEngine.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("monitor");

export class Monitor {
	private readonly sink: AlertSink;
	private readonly drawdownAlertUsd: number;
	private peakNet = 0;
	private lastAlertAt = 0;
	private readonly minAlertIntervalMs: number;

	constructor(sink: AlertSink, opts: { drawdownAlertUsd?: number; minAlertIntervalMs?: number } = {}) {
		this.sink = sink;
		this.drawdownAlertUsd = opts.drawdownAlertUsd ?? 5;
		this.minAlertIntervalMs = opts.minAlertIntervalMs ?? 5 * 60 * 1000;
	}

	async onSnapshot(s: PnlSnapshot, push: boolean): Promise<void> {
		this.peakNet = Math.max(this.peakNet, s.netPnl);
		const drawdown = this.peakNet - s.netPnl;
		if (drawdown >= this.drawdownAlertUsd) {
			log.warn(`drawdown $${drawdown.toFixed(2)} from peak $${this.peakNet.toFixed(2)}`);
			await this.sink.send(formatDrawdownAlert({ drawdown, peakNet: this.peakNet, snapshot: s }));
		}
		const now = Date.now();
		if (push && now - this.lastAlertAt >= this.minAlertIntervalMs) {
			this.lastAlertAt = now;
			await this.sink.send(formatPnlAlert(s));
		}
	}
}
