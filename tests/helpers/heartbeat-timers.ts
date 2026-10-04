import type { LeaseHeartbeatTimers } from "../../src/workers/lease-heartbeat";

export function heartbeatTimers() {
	const callbacks = new Set<() => void>();
	const timers: LeaseHeartbeatTimers = {
		setInterval(callback) {
			callbacks.add(callback);
			return callback;
		},
		clearInterval(handle) {
			callbacks.delete(handle as () => void);
		},
	};
	return {
		timers,
		get active() {
			return callbacks.size;
		},
		tick() {
			for (const callback of callbacks) callback();
		},
	};
}
