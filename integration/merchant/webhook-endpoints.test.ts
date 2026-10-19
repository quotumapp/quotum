import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { StepUpChallengeView } from "../../src/platform/contracts";
import { mutationTarget } from "../../src/platform/step-up";
import { MerchantBrowser, merchantFixture, onboard } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

const scope = { organizationSlug: "acme", projectKey: "example" };
const headers = (environment: "sandbox" | "production") => ({
	"x-quotum-organization": scope.organizationSlug,
	"x-quotum-project": scope.projectKey,
	"x-quotum-environment": environment,
});
const endpoints = "/api/billing/admin/webhook-endpoints";
const body = { url: "https://hooks.example.com/quotum", eventTypes: ["invoice.paid"] };

async function storedReplays(): Promise<string> {
	return JSON.stringify(await f.sql`SELECT result FROM platform_idempotency`);
}

describe("webhook endpoints in the merchant console", () => {
	it("lets a Developer manage sandbox endpoints and never stores a disclosed secret", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		await f.sql`UPDATE platform_memberships SET role='Developer'`;
		const sandbox = headers("sandbox");

		const created = await browser.request(endpoints, body, {
			key: "webhook-create",
			headers: sandbox,
		});
		expect(created.status).toBe(201);
		const first = (await created.json()).data;
		expect(first).toMatchObject({ duplicate: false, secretDisclosed: true });
		expect(first.secret).toMatch(/^whsec_/);
		const [principal] = await f.sql<{ id: string }[]>`SELECT id FROM platform_principals`;
		expect(first.endpoint).toMatchObject({
			url: body.url,
			eventTypes: ["invoice.paid"],
			createdBy: `merchant:${principal?.id}`,
		});

		// A repeat answers from the console's stored copy, which never held the secret.
		const repeated = await browser.request(endpoints, body, {
			key: "webhook-create",
			headers: sandbox,
		});
		expect(repeated.status).toBe(200);
		expect((await repeated.json()).data).toEqual({
			...first,
			duplicate: true,
			secret: null,
			secretDisclosed: false,
		});
		expect(await storedReplays()).not.toContain(first.secret);
		expect(await storedReplays()).toContain(first.endpoint.id);

		const path = `${endpoints}/${first.endpoint.id}`;
		const rotated = await browser.request(
			`${path}/rotate-secret`,
			{ overlapHours: 1 },
			{ key: "webhook-rotate", headers: sandbox },
		);
		const rotation = (await rotated.json()).data;
		expect(rotation).toMatchObject({ secretDisclosed: true, endpoint: { secretGeneration: 2 } });
		const rotatedAgain = await browser.request(
			`${path}/rotate-secret`,
			{ overlapHours: 1 },
			{ key: "webhook-rotate", headers: sandbox },
		);
		expect((await rotatedAgain.json()).data).toMatchObject({
			secret: null,
			secretDisclosed: false,
		});
		expect(await storedReplays()).not.toContain(rotation.secret);

		const disabled = await browser.request(
			path,
			{ enabled: false },
			{ method: "PATCH", headers: sandbox },
		);
		expect((await disabled.json()).data).toMatchObject({
			enabled: false,
			disabledReason: "operator",
		});
		const refusedTest = await browser.request(`${path}/test`, {}, { headers: sandbox });
		expect([refusedTest.status, (await refusedTest.json()).error.code]).toEqual([
			409,
			"WEBHOOK_ENDPOINT_DISABLED",
		]);
		await browser.request(path, { enabled: true }, { method: "PATCH", headers: sandbox });
		const tested = await browser.request(`${path}/test`, {}, { headers: sandbox });
		expect(tested.status).toBe(202);
		const { deliveryId } = (await tested.json()).data;
		const deliveries = await browser.request(
			`/api/billing/admin/webhook-deliveries?endpointId=${first.endpoint.id}`,
			undefined,
			{ headers: sandbox },
		);
		expect((await deliveries.json()).data).toMatchObject([
			{ id: deliveryId, eventType: "webhook.test", status: "pending" },
		]);
		const types = await browser.request("/api/billing/admin/webhook-event-types", undefined, {
			headers: sandbox,
		});
		expect((await types.json()).data.subscribable).toContain("invoice.paid");

		// Production stays with Owners and Admins.
		const production = await browser.request(endpoints, body, { headers: headers("production") });
		expect(production.status).toBe(403);

		const deleted = await browser.request(path, {}, { method: "DELETE", headers: sandbox });
		expect((await deleted.json()).data).toEqual({ id: first.endpoint.id, deleted: true });
		const audited = await f.sql<{ count: number }[]>`
			SELECT count(*)::int AS count FROM platform_audit_events
			WHERE action='billing.action_accepted' AND metadata->>'action'='webhooks.manage'
		`;
		expect(audited[0]?.count).toBe(7);
	});

	it("lets a Viewer read endpoints and deliveries but change nothing", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		const sandbox = headers("sandbox");
		const created = await browser.request(endpoints, body, { headers: sandbox });
		const { endpoint } = (await created.json()).data;
		await f.sql`UPDATE platform_memberships SET role='Viewer'`;

		const listed = await browser.request(endpoints, undefined, { headers: sandbox });
		expect((await listed.json()).data).toMatchObject([{ id: endpoint.id, url: body.url }]);
		expect(
			JSON.stringify(
				await (
					await browser.request(`${endpoints}/${endpoint.id}`, undefined, { headers: sandbox })
				).json(),
			),
		).not.toContain("whsec_");
		for (const [path, method, input] of [
			[endpoints, "POST", body],
			[`${endpoints}/${endpoint.id}`, "PATCH", { enabled: false }],
			[`${endpoints}/${endpoint.id}`, "DELETE", {}],
			[`${endpoints}/${endpoint.id}/rotate-secret`, "POST", {}],
			[`${endpoints}/${endpoint.id}/test`, "POST", {}],
		] as const) {
			const refused = await browser.request(path, input, { method, headers: sandbox });
			expect(refused.status, `${method} ${path}`).toBe(403);
		}
	});

	it("needs an Owner's step-up for each production write, bound to that request", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		await f.sql`UPDATE projects SET lifecycle_status='active' WHERE environment='production'`;
		const production = headers("production");
		const challengeScope = {
			kind: "merchant" as const,
			...scope,
			environment: "production" as const,
		};
		const stepUp = async (method: "POST" | "PATCH", path: string, input: unknown, key: string) => {
			const challenge = await browser.json<StepUpChallengeView>("/api/platform/step-up", {
				scope: challengeScope,
				action: "webhooks.manage",
				target: mutationTarget(method, path, input),
				returnTo: "/orgs/acme/projects/example/production/webhooks",
				request: { method, path, body: input, idempotencyKey: key },
			});
			await f.sql`DELETE FROM platform_rate_limits`;
			return browser.completeStepUp(challenge.id);
		};

		const unconfirmed = await browser.request(endpoints, body, { headers: production });
		expect([unconfirmed.status, (await unconfirmed.json()).error.code]).toEqual([
			403,
			"STEP_UP_REQUIRED",
		]);
		const createGrant = await stepUp("POST", endpoints, body, "production-create");
		const created = await browser.request(endpoints, body, {
			key: "production-create",
			headers: { ...production, "x-quotum-step-up-grant": createGrant },
		});
		expect(created.status).toBe(201);
		const { endpoint, secret } = (await created.json()).data;
		expect(secret).toMatch(/^whsec_/);

		// The grant was spent on the create; a change needs its own.
		const path = `${endpoints}/${endpoint.id}`;
		const change = { description: "Production receiver" };
		const reused = await browser.request(path, change, {
			method: "PATCH",
			headers: { ...production, "x-quotum-step-up-grant": createGrant },
		});
		expect(reused.status).toBe(409);
		const patchGrant = await stepUp("PATCH", path, change, "production-describe");
		const described = await browser.request(path, change, {
			method: "PATCH",
			key: "production-describe",
			headers: { ...production, "x-quotum-step-up-grant": patchGrant },
		});
		expect((await described.json()).data).toMatchObject({ description: "Production receiver" });
		expect(await storedReplays()).not.toContain(secret);

		// The connection action cannot be confirmed for a billing request, so none of its grants reach one.
		const connectionChallenge = await browser.request("/api/platform/step-up", {
			scope: challengeScope,
			action: "connections.manage",
			target: mutationTarget("POST", `${path}/test`, {}),
			returnTo: "/",
		});
		expect(connectionChallenge.status).toBe(400);
	});
});
