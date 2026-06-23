// Paper↔live reconciliation.
//
// While live, we keep a shadow PaperEngine that receives the same intended
// orders and the same trade prints. Comparing the two surfaces model error
// (queue position, partial fills, latency) and feeds the reward calibrator, so
// the paper model keeps converging toward live reality.
import type { PaperEngine } from "../paper/paperEngine.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("reconcile");

export interface ReconResult {
	paperFills: number;
	liveFills: number;
	fillRateError: number; // (live - paper) / max(1, paper)
	paperNetPnl: number;
	liveNetPnl: number;
	pnlDeltaUsd: number;
}

export class Reconciler {
	private liveFills = 0;
	private liveNetPnl = 0;

	recordLiveFill(pnlDelta: number): void {
		this.liveFills += 1;
		this.liveNetPnl += pnlDelta;
	}

	compare(paper: PaperEngine, midpoints: Map<string, number>): ReconResult {
		const s = paper.snapshot(midpoints);
		const paperFills = paper.getFillCount();
		const fillRateError = (this.liveFills - paperFills) / Math.max(1, paperFills);
		const result: ReconResult = {
			paperFills,
			liveFills: this.liveFills,
			fillRateError,
			paperNetPnl: s.netPnl,
			liveNetPnl: this.liveNetPnl,
			pnlDeltaUsd: this.liveNetPnl - s.netPnl,
		};
		log.info(`reconcile: paperFills=${paperFills} liveFills=${this.liveFills} fillRateErr=${(fillRateError * 100).toFixed(1)}% pnlΔ=$${result.pnlDeltaUsd.toFixed(3)}`);
		return result;
	}
}
