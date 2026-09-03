import type { ProjectionSyncRunResult } from "./projection-sync";

export type TimeoutHandle = ReturnType<typeof setTimeout> | number | object;

export interface PollingRuntimeWorker<T = unknown> {
	runOnce(): Promise<T>;
}

export interface PollingRuntimeTimers {
	setTimeout(callback: () => void, ms: number): TimeoutHandle;
	clearTimeout(handle: TimeoutHandle): void;
}

export interface PollingRuntimeLogger {
	error(message: string, error: unknown, context?: Record<string, unknown>): void;
}

export interface PollingRuntimeOptions {
	name: string;
	worker: PollingRuntimeWorker;
	pollIntervalMs: number;
	timers?: PollingRuntimeTimers;
	logger?: PollingRuntimeLogger;
}

export interface ProjectionSyncRuntimeWorker
	extends PollingRuntimeWorker<ProjectionSyncRunResult> {}

export type ProjectionSyncRuntimeTimers = PollingRuntimeTimers;
export type ProjectionSyncRuntimeLogger = PollingRuntimeLogger;

export interface ProjectionSyncRuntimeOptions {
	worker: ProjectionSyncRuntimeWorker;
	pollIntervalMs: number;
	timers?: PollingRuntimeTimers;
	logger?: PollingRuntimeLogger;
}

export interface ProjectionSyncRuntime {
	stop(): Promise<void>;
}

const defaultTimers: PollingRuntimeTimers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const defaultLogger: PollingRuntimeLogger = {
	error: (message, error, context) => console.error(message, error, context),
};

export function startPollingRuntime({
	name,
	worker,
	pollIntervalMs,
	timers = defaultTimers,
	logger = defaultLogger,
}: PollingRuntimeOptions): ProjectionSyncRuntime {
	let stopped = false;
	let timeoutHandle: TimeoutHandle | null = null;
	let activePoll: Promise<void> | null = null;

	const scheduleNext = () => {
		if (stopped) {
			return;
		}

		timeoutHandle = timers.setTimeout(() => {
			timeoutHandle = null;

			if (stopped) {
				return;
			}

			const currentPoll = poll();
			activePoll = currentPoll;
			void currentPoll.finally(() => {
				if (activePoll === currentPoll) {
					activePoll = null;
				}
			});
		}, pollIntervalMs);
	};

	const poll = async () => {
		try {
			await worker.runOnce();
		} catch (error) {
			logger.error(`${name} worker poll failed`, error, { worker: name });
		} finally {
			scheduleNext();
		}
	};

	scheduleNext();

	return {
		async stop() {
			stopped = true;

			if (timeoutHandle !== null) {
				timers.clearTimeout(timeoutHandle);
				timeoutHandle = null;
			}

			if (activePoll !== null) {
				await activePoll;
			}
		},
	};
}

export function startProjectionSyncRuntime(
	options: ProjectionSyncRuntimeOptions,
): ProjectionSyncRuntime {
	return startPollingRuntime({ name: "projection_sync", ...options });
}
