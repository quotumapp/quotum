import { describe, expect, it } from "bun:test";
import { createProjectionSignatureHeaders } from "../../src/projections/http-types";
import { createLocalProjectionReceiver } from "./projection-receiver";

describe("local projection receiver", () => {
	it("records verified projection requests and serves queued responses", async () => {
		const receiver = createLocalProjectionReceiver({ secret: "projection-secret" });
		receiver.queueResponses({ status: 503, body: { success: false } });

		try {
			const body = JSON.stringify({ jobId: "job-1", idempotencyKey: "idem-1" });
			const response = await fetch(`${receiver.url}/internal/billing/projections`, {
				method: "POST",
				headers: {
					authorization: "Bearer projection-secret",
					"content-type": "application/json",
					...createProjectionSignatureHeaders({
						secret: "projection-secret",
						body,
					}),
				},
				body,
			});

			await receiver.waitForRequests(1, 1000);

			expect(response.status).toBe(503);
			expect(receiver.requests).toEqual([
				expect.objectContaining({
					rawBody: body,
					body: { jobId: "job-1", idempotencyKey: "idem-1" },
					bearerOk: true,
					signatureOk: true,
				}),
			]);
		} finally {
			receiver.stop();
		}
	});

	it("can hold and release the next response", async () => {
		const receiver = createLocalProjectionReceiver({ secret: "projection-secret" });
		const hold = receiver.holdNextResponse();

		try {
			const responsePromise = fetch(`${receiver.url}/internal/billing/projections`, {
				method: "POST",
				headers: { authorization: "Bearer projection-secret" },
				body: "{}",
			});

			await hold.requestStarted;
			hold.release(202);
			const response = await responsePromise;

			expect(response.status).toBe(202);
			expect(receiver.requests).toHaveLength(1);
			expect(receiver.requests[0].signatureOk).toBe(false);
		} finally {
			receiver.stop();
		}
	});
});
