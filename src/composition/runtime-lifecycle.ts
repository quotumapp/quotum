/** Bun's server as passed to `fetch`; the runtime only uses it to resolve client addresses. */
export interface QuotumRequestServer {
	requestIP(request: Request): { address: string } | null;
}

/**
 * The portable surface exposed to distributions; it does not expose persistence or workers.
 * Forward Bun's `server` argument (and the original Request object) so client-IP rate limits work.
 */
export interface QuotumApp {
	fetch(request: Request, server?: QuotumRequestServer | null): Response | Promise<Response>;
}

export interface QuotumScheduledJob {
	name: string;
	runOnce(): Promise<unknown>;
	pollIntervalMs: number;
}

export interface QuotumRuntimeScheduler {
	schedule(job: QuotumScheduledJob): { stop(): Promise<void> };
}

export interface QuotumRuntime {
	app: QuotumApp;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export function createRuntimeLifecycle(options: {
	acquire(): () => void;
	initialize(): Promise<void>;
	compose(): { app: QuotumApp; jobs: QuotumScheduledJob[] };
	scheduler: QuotumRuntimeScheduler;
	cleanup: Array<() => Promise<unknown>>;
}): QuotumRuntime {
	let startPromise: Promise<void> | undefined;
	let stopPromise: Promise<void> | undefined;
	let disposePromise: Promise<void> | undefined;
	let release: (() => void) | undefined;
	let app: QuotumApp | undefined;
	let accepting = false;
	let stopped = false;
	const handles: Array<{ stop(): Promise<void> }> = [];
	const requests = new Set<Promise<Response>>();

	const dispose = () => {
		disposePromise ??= (async () => {
			accepting = false;
			const failures: unknown[] = [];
			const results = await Promise.allSettled([
				...handles.map((handle) => Promise.resolve().then(() => handle.stop())),
				...requests,
			]);
			for (const result of results) {
				if (result.status === "rejected") failures.push(result.reason);
			}
			if (release) {
				try {
					for (const cleanup of options.cleanup) {
						try {
							await cleanup();
						} catch (error) {
							failures.push(error);
						}
					}
				} finally {
					release();
					release = undefined;
				}
			}
			if (failures.length) throw new AggregateError(failures, "Quotum runtime cleanup failed");
		})();
		return disposePromise;
	};

	return {
		app: {
			async fetch(request, server) {
				if (!accepting || !app) return Response.json({ status: "unavailable" }, { status: 503 });
				const target = app;
				const response = Promise.resolve().then(() => target.fetch(request, server));
				requests.add(response);
				try {
					return await response;
				} finally {
					requests.delete(response);
				}
			},
		},
		start() {
			if (stopped) return Promise.reject(new Error("A stopped Quotum runtime cannot be restarted"));
			startPromise ??= Promise.resolve().then(async () => {
				try {
					release = options.acquire();
					await options.initialize();
					if (stopped) throw new Error("Quotum runtime stopped during startup");
					const composed = options.compose();
					app = composed.app;
					for (const job of composed.jobs) handles.push(options.scheduler.schedule(job));
					accepting = true;
				} catch (error) {
					stopped = true;
					try {
						await dispose();
					} catch (cleanupError) {
						throw new AggregateError([error, cleanupError], "Quotum runtime startup failed");
					}
					throw error;
				}
			});
			return startPromise;
		},
		stop() {
			stopped = true;
			accepting = false;
			stopPromise ??= (async () => {
				try {
					await startPromise;
				} catch {
					/* Startup already reports its failure. */
				}
				await dispose();
			})();
			return stopPromise;
		},
	};
}
