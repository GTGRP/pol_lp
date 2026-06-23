// Telegram control panel.
//
// Implements AlertSink (outbound alerts) plus a long-poll command loop that lets
// the user inspect status/PnL and adjust runtime settings live. No external deps
// — uses the Bot API over fetch.
//   /status            current status line
//   /pnl               latest PnL snapshot
//   /settings [group]  list settings (optionally one group)
//   /set KEY VALUE     change a setting at runtime
//   /pause /resume     master strategy toggle
//   /help              command list
import type { SettingsStore } from "./settingsStore.js";
import type { AlertSink } from "./alerts.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("telegram");

export interface BotHooks {
	status: () => string;
	pnl: () => string;
}

export class TelegramBot implements AlertSink {
	private readonly token: string;
	private readonly chatId: string;
	private readonly settings: SettingsStore;
	private readonly hooks: BotHooks;
	private offset = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly base: string;

	constructor(token: string, chatId: string, settings: SettingsStore, hooks: BotHooks) {
		this.token = token;
		this.chatId = chatId;
		this.settings = settings;
		this.hooks = hooks;
		this.base = `https://api.telegram.org/bot${token}`;
	}

	async send(text: string): Promise<void> {
		if (!this.settings.getBool("ALERTS.ENABLED")) return;
		try {
			await fetch(`${this.base}/sendMessage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: "Markdown" }),
			});
		} catch (e) {
			log.warn(`sendMessage failed: ${(e as Error).message}`);
		}
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.poll().catch((e) => log.warn(`poll: ${(e as Error).message}`)), 2000);
		log.info("telegram command loop started");
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	private async poll(): Promise<void> {
		const res = await fetch(`${this.base}/getUpdates?timeout=0&offset=${this.offset}`);
		if (!res.ok) return;
		const data = (await res.json()) as any;
		for (const upd of data.result ?? []) {
			this.offset = upd.update_id + 1;
			const text: string | undefined = upd.message?.text;
			if (text) await this.handle(text.trim());
		}
	}

	private async handle(text: string): Promise<void> {
		const [cmd, ...args] = text.split(/\s+/);
		switch (cmd.toLowerCase()) {
			case "/status":
				await this.send(this.hooks.status());
				break;
			case "/pnl":
				await this.send(this.hooks.pnl());
				break;
			case "/settings":
				await this.send(args[0] ? this.formatGroup(args[0].toUpperCase()) : this.settings.formatAll());
				break;
			case "/set":
				await this.handleSet(args);
				break;
			case "/pause":
				this.settings.set("STRATEGY.ENABLED", false);
				await this.send("⏸ strategy paused");
				break;
			case "/resume":
				this.settings.set("STRATEGY.ENABLED", true);
				await this.send("▶️ strategy resumed");
				break;
			case "/help":
				await this.send("/status /pnl /settings [group] /set KEY VALUE /pause /resume");
				break;
			default:
				break; // ignore non-commands
		}
	}

	private formatGroup(group: string): string {
		const rows = this.settings.byGroup(group);
		if (rows.length === 0) return `no settings in group ${group}`;
		return `*${group}*\n` + rows.map((r) => `  ${r.def.key} = ${r.value}  (${r.def.label})`).join("\n");
	}

	private async handleSet(args: string[]): Promise<void> {
		const [key, ...rest] = args;
		if (!key || rest.length === 0) {
			await this.send("usage: /set KEY VALUE");
			return;
		}
		try {
			const value = this.settings.set(key, rest.join(" "));
			await this.send(`✅ ${key} = ${value}`);
		} catch (e) {
			await this.send(`❌ ${(e as Error).message}`);
		}
	}
}
