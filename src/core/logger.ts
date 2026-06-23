// Minimal leveled, timestamped logger. No external deps.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

let currentLevel: LogLevel =
	(process.env.LOG_LEVEL as LogLevel) in LEVEL_ORDER
		? (process.env.LOG_LEVEL as LogLevel)
		: "info";

export function setLogLevel(level: LogLevel): void {
	if (level in LEVEL_ORDER) currentLevel = level;
}

function ts(): string {
	return new Date().toISOString();
}

function emit(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
	if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
	const line = `${ts()} [${level.toUpperCase()}] (${scope}) ${msg}`;
	const args: unknown[] = extra === undefined ? [line] : [line, extra];
	if (level === "error") console.error(...args);
	else if (level === "warn") console.warn(...args);
	else console.log(...args);
}

export interface Logger {
	debug(msg: string, extra?: unknown): void;
	info(msg: string, extra?: unknown): void;
	warn(msg: string, extra?: unknown): void;
	error(msg: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
	return {
		debug: (m, e) => emit("debug", scope, m, e),
		info: (m, e) => emit("info", scope, m, e),
		warn: (m, e) => emit("warn", scope, m, e),
		error: (m, e) => emit("error", scope, m, e),
	};
}
