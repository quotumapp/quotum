import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { trapInterrupts } from "../../scripts/lib/interrupts";

describe("trapInterrupts", () => {
	it("records the first signal and maps exit codes", () => {
		const proc = new EventEmitter();
		const trap = trapInterrupts(proc);
		expect(trap.signal()).toBeUndefined();
		expect(trap.exitCode()).toBeUndefined();
		proc.emit("SIGINT", "SIGINT");
		proc.emit("SIGTERM", "SIGTERM");
		expect(trap.signal()).toBe("SIGINT");
		expect(trap.exitCode()).toBe(130);
	});

	it("maps SIGTERM to 143", () => {
		const proc = new EventEmitter();
		const trap = trapInterrupts(proc);
		proc.emit("SIGTERM", "SIGTERM");
		expect(trap.exitCode()).toBe(143);
	});
});
