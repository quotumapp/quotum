import { describe, expect, it } from "bun:test";
import {
	createWebhookSecretSealer,
	lazyWebhookSecretSealer,
} from "../../src/composition/webhook-secrets";
import { ConnectionCipher } from "../../src/platform/connections/cipher";

const key = (fill: number) => Buffer.alloc(32, fill);
const cipher = new ConnectionCipher("k1", new Map([["k1", key(1)]]));
const scope = { projectId: "project-a", endpointId: "endpoint-a", generation: 1 };

describe("webhook secret sealer", () => {
	it("seals with the active key and opens only in the same scope", () => {
		const sealer = createWebhookSecretSealer(cipher);
		const envelope = sealer.seal("whsec_secret", scope);

		expect(sealer.activeKeyId).toBe("k1");
		expect(envelope.keyId).toBe("k1");
		expect(JSON.stringify(envelope)).not.toContain("whsec_secret");
		expect(sealer.open(envelope, scope)).toBe("whsec_secret");
		for (const other of [
			{ ...scope, projectId: "project-b" },
			{ ...scope, endpointId: "endpoint-b" },
			{ ...scope, generation: 2 },
		]) {
			expect(() => sealer.open(envelope, other)).toThrow("Webhook endpoint secret is unavailable");
		}
	});

	it("never opens a connection secret's envelope as a webhook secret", () => {
		const connectionEnvelope = cipher.encrypt("whsec_secret", {
			instanceId: scope.projectId,
			connectionId: scope.endpointId,
			versionId: "1",
			purpose: "signing",
		});

		expect(() => createWebhookSecretSealer(cipher).open(connectionEnvelope, scope)).toThrow(
			"Webhook endpoint secret is unavailable",
		);
	});

	it("loads the keys once, on first use", () => {
		let loads = 0;
		const sealer = lazyWebhookSecretSealer(() => {
			loads += 1;
			return cipher;
		});

		expect(loads).toBe(0);
		expect(sealer().activeKeyId).toBe("k1");
		expect(sealer().activeKeyId).toBe("k1");
		expect(loads).toBe(1);
	});
});
