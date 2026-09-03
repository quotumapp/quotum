type ShutdownSignal = "SIGINT" | "SIGTERM";
type FatalProcessEvent = "unhandledRejection" | "uncaughtException";
type ProcessEvent = ShutdownSignal | FatalProcessEvent;

type ProcessLike = {
	on(signal: ProcessEvent, handler: (error?: unknown) => void | Promise<void>): unknown;
	exit(code?: number): never;
};

type RuntimeLike = {
	stop(): void | Promise<void>;
};

type CleanupHook = () => void | Promise<void>;

type ShutdownLogger = {
	error(message: string, error: unknown): void;
};

const defaultLogger: ShutdownLogger = {
	error: (message, error) => console.error(message, error),
};
const defaultShutdownTimeoutMs = 10_000;

export const registerProjectionRuntimeShutdown = ({
	process,
	runtime,
}: {
	process: ProcessLike;
	runtime: RuntimeLike;
}) => {
	registerBillingRuntimeShutdown({ process, runtimes: [runtime] });
};

export const registerBillingRuntimeShutdown = ({
	process,
	runtimes,
	cleanup = [],
	shutdownTimeoutMs = defaultShutdownTimeoutMs,
	logger = defaultLogger,
}: {
	process: ProcessLike;
	runtimes: RuntimeLike[];
	cleanup?: CleanupHook[];
	shutdownTimeoutMs?: number;
	logger?: ShutdownLogger;
}) => {
	const shutdown = async (exitCode: number) => {
		const result = await withShutdownDeadline(
			runShutdown({ runtimes, cleanup, logger, exitCode }),
			shutdownTimeoutMs,
		);
		if (result === "timed_out") {
			logger.error("Billing runtime shutdown timed out", new Error("shutdown timed out"));
			process.exit(1);
			return;
		}

		process.exit(result);
	};

	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, async () => {
			await shutdown(0);
		});
	}

	for (const event of ["unhandledRejection", "uncaughtException"] as const) {
		process.on(event, async (error) => {
			logger.error("Billing runtime fatal error", error);
			await shutdown(1);
		});
	}
};

async function runShutdown({
	runtimes,
	cleanup,
	logger,
	exitCode,
}: {
	runtimes: RuntimeLike[];
	cleanup: CleanupHook[];
	logger: ShutdownLogger;
	exitCode: number;
}): Promise<number> {
	const stops = runtimes.map((runtime) => {
		try {
			return Promise.resolve(runtime.stop());
		} catch (error) {
			return Promise.reject(error);
		}
	});
	const stopResults = await Promise.allSettled(stops);
	let failed = false;

	for (const result of stopResults) {
		if (result.status === "rejected") {
			failed = true;
			logger.error("Billing runtime stop failed", result.reason);
		}
	}

	for (const hook of cleanup) {
		try {
			await hook();
		} catch (error) {
			failed = true;
			logger.error("Billing shutdown cleanup failed", error);
		}
	}

	return failed ? 1 : exitCode;
}

async function withShutdownDeadline(
	shutdown: Promise<number>,
	shutdownTimeoutMs: number,
): Promise<number | "timed_out"> {
	if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
		return await shutdown;
	}

	let timeout: Timer | null = null;
	try {
		return await Promise.race([
			shutdown,
			new Promise<"timed_out">((resolve) => {
				timeout = setTimeout(() => resolve("timed_out"), shutdownTimeoutMs);
			}),
		]);
	} finally {
		if (timeout !== null) {
			clearTimeout(timeout);
		}
	}
}
