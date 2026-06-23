// Live reward calibrator.
//
// Our scorer/estimator are models. Reality (queue position, exact constants,
// rounding, competitor behaviour) differs. The calibrator periodically compares
// what we ESTIMATED we'd earn against what Polymarket ACTUALLY reports via the
// authenticated order-scoring + user-earnings endpoints, and maintains an EMA
// calibration factor that future estimates are multiplied by. Over time this
// pulls the model to ~99% of real farming behaviour.
import type { ClobRestClient } from "../core/clob.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("calibrator");

const EMA_ALPHA = 0.25;
const MIN_FACTOR = 0.2;
const MAX_FACTOR = 5;

export class RewardCalibrator {
	private readonly clob: ClobRestClient;
	private factor = 1; // multiply model estimates by this
	private samples = 0;

	constructor(clob: ClobRestClient) {
		this.clob = clob;
	}

	getFactor(): number {
		return this.factor;
	}

	// Apply the current calibration factor to a raw model estimate.
	calibrate(rawDailyReward: number): number {
		return rawDailyReward * this.factor;
	}

	// Feed an observed (estimated, actual) pair to update the factor.
	recordObservation(estimated: number, actual: number): void {
		if (estimated <= 0 || actual < 0) return;
		const ratio = clamp(actual / estimated, MIN_FACTOR, MAX_FACTOR);
		this.factor =
			this.samples === 0 ? ratio : EMA_ALPHA * ratio + (1 - EMA_ALPHA) * this.factor;
		this.samples += 1;
		log.info(`calibration updated: est=${estimated.toFixed(4)} actual=${actual.toFixed(4)} ratio=${ratio.toFixed(3)} -> factor=${this.factor.toFixed(3)} (n=${this.samples})`);
	}

	// Pull the day's actual earnings from Polymarket and reconcile against an
	// estimate map keyed by conditionId. Best-effort; tolerates endpoint drift.
	async reconcileDailyEarnings(estimatesByCondition: Map<string, number>, date?: string): Promise<void> {
		let raw: unknown;
		try {
			raw = await this.clob.getUserRewardsEarnings(date);
		} catch (err) {
			log.warn(`could not fetch user earnings: ${(err as Error).message}`);
			return;
		}
		const rows = Array.isArray(raw) ? raw : (raw as any)?.data;
		if (!Array.isArray(rows)) return;
		for (const row of rows) {
			const conditionId = String(row?.condition_id ?? row?.conditionId ?? "");
			const actual = Number(row?.earnings ?? row?.reward ?? row?.amount);
			if (!conditionId || !Number.isFinite(actual)) continue;
			const estimated = estimatesByCondition.get(conditionId);
			if (estimated !== undefined) this.recordObservation(estimated, actual);
		}
	}

	// Check whether a specific resting order is currently scoring (qualifying).
	async isOrderScoring(orderId: string): Promise<boolean> {
		try {
			const raw = await this.clob.getOrderScoring(orderId);
			const scoring = (raw as any)?.scoring ?? (raw as any)?.is_scoring;
			return Boolean(scoring);
		} catch (err) {
			log.warn(`order-scoring check failed for ${orderId}: ${(err as Error).message}`);
			return false;
		}
	}
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}
