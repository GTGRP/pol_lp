// Gamma market-discovery client. Finds active, reward-bearing markets to farm.
import type { AppConfig } from "./config.js";
import type { GammaMarket } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("gamma");

function parseMaybeJsonArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => String(x));
	if (typeof v === "string" && v.trim().startsWith("[")) {
		try {
			const arr = JSON.parse(v);
			return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
		} catch {
			return [];
		}
	}
	return [];
}

function numOrNull(v: unknown): number | null {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function normalize(raw: Record<string, any>): GammaMarket {
	return {
		conditionId: String(raw.conditionId ?? raw.condition_id ?? ""),
		questionId: raw.questionID ?? raw.questionId,
		slug: String(raw.slug ?? ""),
		question: String(raw.question ?? raw.title ?? ""),
		category: raw.category ? String(raw.category) : undefined,
		endDateIso: raw.endDate ?? raw.end_date_iso ?? raw.endDateIso,
		active: Boolean(raw.active),
		closed: Boolean(raw.closed),
		volume24hr: numOrNull(raw.volume24hr ?? raw.volume24Hr ?? raw.volume_24hr),
		liquidity: numOrNull(raw.liquidity ?? raw.liquidityNum),
		clobTokenIds: parseMaybeJsonArray(raw.clobTokenIds ?? raw.clob_token_ids),
		outcomes: parseMaybeJsonArray(raw.outcomes),
		rewardsDailyRate: numOrNull(raw.rewardsDailyRate ?? raw.rewards_daily_rate),
		rewardsMaxSpread: numOrNull(raw.rewardsMaxSpread ?? raw.rewards_max_spread),
		rewardsMinSize: numOrNull(raw.rewardsMinSize ?? raw.rewards_min_size),
	};
}

export class GammaClient {
	private readonly cfg: AppConfig;

	constructor(cfg: AppConfig) {
		this.cfg = cfg;
	}

	private url(path: string, query?: Record<string, string | number | boolean | undefined>): string {
		const u = new URL(path, this.cfg.gammaUrl);
		if (query) {
			for (const [k, v] of Object.entries(query)) {
				if (v !== undefined) u.searchParams.set(k, String(v));
			}
		}
		return u.toString();
	}

	// Fetch active, open markets ordered by 24h volume (proxy for liquidity/activity).
	async getActiveMarkets(limit = 50): Promise<GammaMarket[]> {
		const raw = await this.getJson<Record<string, any>[]>("/markets", {
			active: true,
			closed: false,
			limit,
			order: "volume24hr",
			ascending: false,
		});
		if (!Array.isArray(raw)) return [];
		return raw.map(normalize).filter((m) => m.clobTokenIds.length >= 1);
	}

	// Active markets that advertise a reward rate. These are the LP-farming candidates.
	async getRewardMarkets(limit = 50): Promise<GammaMarket[]> {
		const markets = await this.getActiveMarkets(limit);
		return markets.filter((m) => (m.rewardsDailyRate ?? 0) > 0);
	}

	private async getJson<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
		const res = await fetch(this.url(path, query), { method: "GET" });
		if (!res.ok) {
			throw new Error(`Gamma GET ${path} failed: ${res.status} ${res.statusText}`);
		}
		return (await res.json()) as T;
	}
}
