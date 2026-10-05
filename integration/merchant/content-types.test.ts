import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createRemoteMcpApp } from "../../src/composition/remote-mcp";
import { CSRF_COOKIE } from "../../src/platform/security";
import {
	MerchantBrowser,
	merchantFixture,
	merchantTestScope,
	onboard,
	serviceToken,
	testConfig,
} from "./fixture";

const origin = "https://api.example.test";
const f = merchantFixture({ mcp: { origin, writesEnabled: true } });
const remote = createRemoteMcpApp({ auth: f.auth, store: f.store, port: f.billingPort });
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

describe("merchant and OAuth media types", () => {
	it("reads JSON bodies for the exact media type only, ignoring case and parameters", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		const post = async (contentType: string) =>
			(
				await f.app.handle(
					new Request(new URL("/api/platform/mcp/connections/list", testConfig.origin), {
						method: "POST",
						headers: {
							"content-type": contentType,
							"x-quotum-service-token": serviceToken,
							origin: testConfig.origin,
							"x-quotum-client-ip": "192.0.2.10",
							cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
							"x-csrf-token": browser.cookies.get(CSRF_COOKIE) ?? "",
							"idempotency-key": crypto.randomUUID(),
						},
						body: JSON.stringify({ scope: merchantTestScope }),
					}),
				)
			).status;
		for (const accepted of [
			"application/json",
			"Application/JSON",
			"application/json; charset=utf-8",
			"APPLICATION/JSON;charset=UTF-8",
		]) {
			expect({ accepted, status: await post(accepted) }).toEqual({ accepted, status: 200 });
		}
		for (const refused of [
			"application/jsonx",
			"application/json-seq",
			"application/jsonl",
			"text/plain",
			"application/vnd.api+json",
		]) {
			expect({ refused, status: await post(refused) }).toEqual({ refused, status: 415 });
		}
	});

	it("reads OAuth forms for the exact form media type only", async () => {
		const post = async (contentType: string) =>
			(
				await remote.handle(
					new Request(`${origin}/oauth/revoke`, {
						method: "POST",
						headers: { "content-type": contentType },
						body: "token=unknown-token&client_id=quotum-claude-code",
					}),
				)
			).status;
		for (const accepted of [
			"application/x-www-form-urlencoded",
			"Application/X-WWW-Form-Urlencoded; charset=UTF-8",
		]) {
			expect({ accepted, notRefused: (await post(accepted)) !== 415 }).toEqual({
				accepted,
				notRefused: true,
			});
		}
		for (const refused of [
			"application/x-www-form-urlencodedx",
			"application/json",
			"multipart/form-data",
		]) {
			expect({ refused, status: await post(refused) }).toEqual({ refused, status: 415 });
		}
	});
});
