export interface BillingLogger {
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, error: unknown, context?: Record<string, unknown>): void;
}

export interface BillingLoggerWriter {
	info(line: string): void;
	warn(line: string): void;
	error(line: string): void;
}

export interface ConsoleBillingLoggerOptions {
	now?: () => Date;
	write?: BillingLoggerWriter;
}

export function createConsoleBillingLogger({
	now = () => new Date(),
	write = {
		info: (line) => console.log(line),
		warn: (line) => console.warn(line),
		error: (line) => console.error(line),
	},
}: ConsoleBillingLoggerOptions = {}): BillingLogger {
	return {
		info(message, context) {
			writeSafely(write.info, serializeLogEvent(createLogEvent("info", message, now, context)));
		},
		warn(message, context) {
			writeSafely(write.warn, serializeLogEvent(createLogEvent("warn", message, now, context)));
		},
		error(message, error, context) {
			writeSafely(
				write.error,
				serializeLogEvent({
					...createLogEvent("error", message, now, context),
					error: normalizeLoggerError(error),
				}),
			);
		},
	};
}

export function safelyLogInfo(
	logger: BillingLogger,
	message: string,
	context?: Record<string, unknown>,
): void {
	try {
		logger.info(message, context);
	} catch {
		// Observability must not alter billing behavior.
	}
}

export function safelyLogWarn(
	logger: BillingLogger,
	message: string,
	context?: Record<string, unknown>,
): void {
	try {
		logger.warn(message, context);
	} catch {
		// Observability must not alter billing behavior.
	}
}

export function safelyLogError(
	logger: BillingLogger,
	message: string,
	error: unknown,
	context?: Record<string, unknown>,
): void {
	try {
		logger.error(message, error, context);
	} catch {
		// Observability must not alter billing behavior.
	}
}

export function createNoopBillingLogger(): BillingLogger {
	return {
		info() {},
		warn() {},
		error() {},
	};
}

function createLogEvent(
	level: "info" | "warn" | "error",
	message: string,
	now: () => Date,
	context?: Record<string, unknown>,
): Record<string, unknown> {
	const timestamp = safeTimestamp(now);
	return context === undefined
		? { level, message, timestamp }
		: { level, message, timestamp, context };
}

function normalizeLoggerError(error: unknown): { name: string; message: string; stack?: string } {
	if (error instanceof Error) {
		return typeof error.stack === "string" && error.stack.length > 0
			? { name: error.name || "Error", message: error.message, stack: error.stack }
			: { name: error.name || "Error", message: error.message };
	}

	return { name: "Error", message: stringifyUnknown(error) };
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (value === null || value === undefined) {
		return String(value);
	}

	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function safeTimestamp(now: () => Date): string {
	try {
		const timestamp = now();
		return Number.isNaN(timestamp.getTime()) ? "Invalid Date" : timestamp.toISOString();
	} catch {
		return "Invalid Date";
	}
}

function serializeLogEvent(event: Record<string, unknown>): string {
	try {
		return JSON.stringify(event, createSafeJsonReplacer());
	} catch {
		return JSON.stringify({
			level: event.level,
			message: event.message,
			timestamp: event.timestamp,
			context: "[Unserializable]",
		});
	}
}

function createSafeJsonReplacer(): (key: string, value: unknown) => unknown {
	const seen = new WeakSet<object>();

	return (_key, value) => {
		if (typeof value === "bigint") {
			return value.toString();
		}

		if (typeof value !== "object" || value === null) {
			return value;
		}

		if (seen.has(value)) {
			return "[Circular]";
		}

		seen.add(value);
		return value;
	};
}

function writeSafely(write: (line: string) => void, line: string): void {
	try {
		write(line);
	} catch {
		// Observability must not alter billing behavior.
	}
}
