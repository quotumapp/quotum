import { describe, expect, it } from "bun:test";
import { driveUserArrivals } from "../../scripts/lib/load-arrivals";

function fakeClock(onSleep?: (elapsed: number) => void, jump = 0) {
	let elapsed = 0;
	return {
		now: () => elapsed,
		async sleep(ms: number) {
			elapsed += ms + jump;
			onSleep?.(elapsed);
			// Let completed requests leave the in-flight set before the next scheduler tick.
			for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
		},
	};
}

describe("driveUserArrivals", () => {
	it("sends one evenly staggered arrival per account per second", async () => {
		const clock = fakeClock();
		const arrivals: Array<{ account: number; at: number }> = [];
		const result = await driveUserArrivals(
			{ users: 4, durationMs: 2000, maxInFlight: 10, maxLagMs: 100 },
			async (account) => {
				arrivals.push({ account, at: clock.now() });
				return true;
			},
			clock,
		);
		expect(result.scheduled).toBe(8);
		expect(result.sent).toBe(8);
		expect(result.droppedCapacity + result.droppedLate).toBe(0);
		for (let account = 0; account < 4; account += 1) {
			const times = arrivals.filter((item) => item.account === account).map((item) => item.at);
			expect(times).toHaveLength(2);
			expect((times[1] ?? 0) - (times[0] ?? 0)).toBe(1000);
		}
	});

	it("counts arrivals lost to saturation without slowing the offered rate", async () => {
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const result = await driveUserArrivals(
			{ users: 10, durationMs: 1000, maxInFlight: 1, maxLagMs: 100 },
			async () => {
				await blocked;
				return true;
			},
			fakeClock((elapsed) => {
				if (elapsed >= 1000) release?.();
			}),
		);
		expect(result.scheduled).toBe(10);
		expect(result.sent).toBe(1);
		expect(result.droppedCapacity).toBe(9);
		expect(result.peakInFlight).toBe(1);
	});

	it("reports generator stalls instead of catching up with a burst", async () => {
		const result = await driveUserArrivals(
			{ users: 100, durationMs: 1000, maxInFlight: 100, maxLagMs: 20 },
			async () => true,
			fakeClock(undefined, 200),
		);
		expect(result.droppedLate).toBeGreaterThan(0);
		expect(result.sent + result.droppedLate + result.droppedCapacity).toBe(100);
		expect(result.samples.every((sample) => sample.lagMs <= 20)).toBe(true);
	});

	it("does not drop timely final arrivals when a timer crosses the window boundary", async () => {
		const result = await driveUserArrivals(
			{ users: 1000, durationMs: 10, maxInFlight: 100, maxLagMs: 100 },
			async () => true,
			fakeClock(undefined, 10),
		);
		expect(result.sent).toBe(10);
		expect(result.droppedLate).toBe(0);
		expect(result.samples.some((sample) => sample.finishedAtMs > 10)).toBe(true);
	});

	it("retains transport failures as completed attempts", async () => {
		const result = await driveUserArrivals(
			{ users: 2, durationMs: 1000, maxInFlight: 10, maxLagMs: 100 },
			async () => {
				throw new Error("connection lost");
			},
			fakeClock(),
		);
		expect(result.sent).toBe(2);
		expect(result.samples.map((sample) => sample.outcome)).toEqual([null, null]);
	});

	it("reports responses drained after the offered-load window separately", async () => {
		const result = await driveUserArrivals(
			{ users: 1, durationMs: 10, maxInFlight: 1, maxLagMs: 100 },
			async () => {
				await Bun.sleep(30);
				return true;
			},
		);
		expect(result.sent).toBe(1);
		expect(result.inFlightAtEnd).toBe(1);
		expect(result.samples[0]?.finishedAtMs).toBeGreaterThan(10);
		expect(result.elapsedMs).toBeGreaterThan(10);
	});
});
