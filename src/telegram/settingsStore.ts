// Runtime settings store (WEATHERPOL-style).
//
// Typed BOOL/NUM/STR keys grouped into tabs, with defaults, JSON persistence, and
// validation/coercion on set. Telegram commands edit these live, so the running
// bot reacts to changes without a restart.
import { existsSync, readFileSync, writeFileSync } from "fs";
import { createLogger } from "../core/logger.js";

const log = createLogger("settings");

export type SettingType = "BOOL" | "NUM" | "STR";
export type SettingValue = boolean | number | string;

export interface SettingDef {
	key: string;
	type: SettingType;
	default: SettingValue;
	group: string;
	label: string;
}

export const SETTING_DEFS: SettingDef[] = [
	// STRATEGY
	{ key: "STRATEGY.ENABLED", type: "BOOL", default: true, group: "STRATEGY", label: "Master strategy on/off" },
	{ key: "STRATEGY.ENABLE_CORE_MAKER", type: "BOOL", default: true, group: "STRATEGY", label: "Enable core-maker" },
	{ key: "STRATEGY.ENABLE_GRID_LP", type: "BOOL", default: true, group: "STRATEGY", label: "Enable grid-lp" },
	{ key: "STRATEGY.ENABLE_STACKED_ARB", type: "BOOL", default: false, group: "STRATEGY", label: "Enable stacked YES+NO<1 arb" },
	{ key: "STRATEGY.ARB_MIN_EDGE", type: "NUM", default: 0.02, group: "STRATEGY", label: "Min locked edge (1-pYes-pNo)" },
	{ key: "STRATEGY.ARB_SHARES_PER_SIDE", type: "NUM", default: 50, group: "STRATEGY", label: "Arb shares per leg" },
	{ key: "STRATEGY.OFFSET_FRAC", type: "NUM", default: 0.5, group: "STRATEGY", label: "Quote offset as fraction of band" },
	// RISK
	{ key: "RISK.MAX_SINGLE_MARKET_USD", type: "NUM", default: 40, group: "RISK", label: "Max exposure per market" },
	{ key: "RISK.MAX_TOTAL_EXPOSURE_USD", type: "NUM", default: 90, group: "RISK", label: "Max total exposure" },
	{ key: "RISK.STOP_LOSS_USD", type: "NUM", default: 4, group: "RISK", label: "Per-position taker stop-loss" },
	// SIZING
	{ key: "SIZING.SHARES_PER_SIDE", type: "NUM", default: 75, group: "SIZING", label: "Shares quoted per side" },
	// SELECTION
	{ key: "SELECTION.MAX_MARKETS", type: "NUM", default: 3, group: "SELECTION", label: "Max concurrent markets" },
	{ key: "SELECTION.ACT_SCORE", type: "NUM", default: 7, group: "SELECTION", label: "Min score (0-10) to farm" },
	// ALERTS
	{ key: "ALERTS.ENABLED", type: "BOOL", default: true, group: "ALERTS", label: "Send Telegram alerts" },
	{ key: "ALERTS.MIN_INTERVAL_SEC", type: "NUM", default: 60, group: "ALERTS", label: "Min seconds between same alert" },
];

function coerce(def: SettingDef, raw: string | SettingValue): SettingValue {
	if (def.type === "BOOL") {
		if (typeof raw === "boolean") return raw;
		return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
	}
	if (def.type === "NUM") {
		const n = Number(raw);
		if (!Number.isFinite(n)) throw new Error(`expected a number for ${def.key}`);
		return n;
	}
	return String(raw);
}

export class SettingsStore {
	private readonly defs = new Map<string, SettingDef>();
	private values = new Map<string, SettingValue>();
	private readonly path: string;

	constructor(path = ".settings.json") {
		this.path = path;
		for (const d of SETTING_DEFS) {
			this.defs.set(d.key, d);
			this.values.set(d.key, d.default);
		}
		this.load();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const saved = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, SettingValue>;
			for (const [k, v] of Object.entries(saved)) {
				const def = this.defs.get(k);
				if (def) this.values.set(k, coerce(def, v));
			}
			log.info(`loaded settings from ${this.path}`);
		} catch (e) {
			log.warn(`failed to load settings: ${(e as Error).message}`);
		}
	}

	private persist(): void {
		try {
			const obj: Record<string, SettingValue> = {};
			for (const [k, v] of this.values) obj[k] = v;
			writeFileSync(this.path, JSON.stringify(obj, null, 2));
		} catch (e) {
			log.warn(`failed to persist settings: ${(e as Error).message}`);
		}
	}

	has(key: string): boolean {
		return this.defs.has(key);
	}

	get(key: string): SettingValue {
		if (!this.defs.has(key)) throw new Error(`unknown setting ${key}`);
		return this.values.get(key) as SettingValue;
	}

	getBool(key: string): boolean {
		return Boolean(this.get(key));
	}

	getNum(key: string): number {
		return Number(this.get(key));
	}

	getStr(key: string): string {
		return String(this.get(key));
	}

	set(key: string, raw: string | SettingValue): SettingValue {
		const def = this.defs.get(key);
		if (!def) throw new Error(`unknown setting ${key}`);
		const value = coerce(def, raw);
		this.values.set(key, value);
		this.persist();
		log.info(`setting ${key} = ${value}`);
		return value;
	}

	groups(): string[] {
		return Array.from(new Set(SETTING_DEFS.map((d) => d.group)));
	}

	byGroup(group: string): Array<{ def: SettingDef; value: SettingValue }> {
		return SETTING_DEFS.filter((d) => d.group === group).map((def) => ({ def, value: this.values.get(def.key) as SettingValue }));
	}

	formatAll(): string {
		const lines: string[] = [];
		for (const g of this.groups()) {
			lines.push(`*${g}*`);
			for (const { def, value } of this.byGroup(g)) lines.push(`  ${def.key} = ${value}`);
		}
		return lines.join("\n");
	}
}
