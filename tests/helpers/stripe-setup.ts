import { readFileSync } from "node:fs";
import Stripe from "stripe";
import { STRIPE_API_VERSION } from "../../src/providers/stripe/client";

const catalog = JSON.parse(
	readFileSync(new URL("../../examples/quickstart/catalog.json", import.meta.url), "utf8"),
);

export function setupManifest(production = false) {
	return {
		version: 1,
		instance: production ? "alpha" : "alpha-sandbox",
		accountId: "acct_setup",
		environment: production ? "production" : "sandbox",
		publicOrigin: "https://billing.example.com",
		settings: {
			checkoutSuccessUrl: "https://shop.example/success?session_id={CHECKOUT_SESSION_ID}",
			checkoutCancelUrl: "https://shop.example/cancel",
			portalReturnUrl: "https://shop.example/billing",
		},
		bindings: [
			{
				source: "create",
				productKey: "credits_10",
				name: "10 credits",
				kind: "topup",
				entitlementKey: "ai_credits",
				credits: 10,
				currency: "usd",
				unitAmountMinor: 1000,
			},
		],
		webhook: { source: "create" },
		expectedRevision: null,
		catalog,
	};
}

type ObjectData = Record<string, unknown> & { id: string };

/** Real Stripe SDK, with only its HTTP transport replaced. Rejects unexpected financial writes. */
export class SetupStripeTransport {
	readonly objects = new Map<string, ObjectData>();
	readonly receipts = new Map<string, ObjectData>();
	readonly calls: Array<{ method: string; path: string; idempotencyKey: string | null }> = [];
	readonly deliveries: Array<{ url: string; event: ObjectData }> = [];
	accountId = "acct_setup";
	deniedPath: string | null = null;
	failAfterCreate: string | null = null;
	constructor(readonly production = false) {}
	credentials() {
		return {
			setupKey: `rk_${this.production ? "live" : "test"}_setup`,
			runtimeKey: `rk_${this.production ? "live" : "test"}_runtime`,
		};
	}
	readonly fetch = Object.assign(
		async (input: URL | RequestInfo, init?: RequestInit) => {
			const path = new URL(String(input)).pathname;
			const method = init?.method ?? "GET";
			const idempotencyKey = new Headers(init?.headers).get("Idempotency-Key");
			this.calls.push({ method, path, idempotencyKey });
			if (path === this.deniedPath)
				return Response.json(
					{
						error: {
							type: "invalid_request_error",
							message: "Missing product_write permission rk_test_never_print",
						},
					},
					{ status: 403 },
				);
			if (idempotencyKey && this.receipts.has(idempotencyKey))
				return Response.json(this.receipts.get(idempotencyKey));
			const pieces = path.split("/");
			const resource = pieces[2] ?? "";
			const id = pieces[3];
			if (method === "GET") {
				if (resource === "account") return Response.json({ id: this.accountId, object: "account" });
				if (id && this.objects.has(id)) return Response.json(this.objects.get(id));
				if (id && path !== "/v1/checkout/sessions")
					return Response.json({ error: { message: "Missing" } }, { status: 404 });
				return Response.json({
					object: "list",
					data: [...this.objects.values()].filter(
						(item) => item.object === resource.replace(/s$/, ""),
					),
					has_more: false,
					url: path,
				});
			}
			const params = new URLSearchParams(String(init?.body ?? ""));
			if (!["products", "prices", "webhook_endpoints"].includes(resource)) {
				if (
					String(init?.body).includes("quotum_permission_probe") ||
					path.includes("quotum_permission_probe") ||
					resource === "promotion_codes"
				)
					return Response.json(
						{ error: { type: "invalid_request_error", message: "Invalid permission probe" } },
						{ status: 400 },
					);
				throw new Error(`Unexpected Stripe mutation: ${method} ${path}`);
			}
			const metadata = Object.fromEntries(
				[...params]
					.filter(([key]) => /^metadata\[/.test(key))
					.map(([key, value]) => [key.slice(9, -1), value]),
			);
			let object: ObjectData;
			if (id) {
				const current = this.objects.get(id);
				if (!current) throw new Error("Missing fake Stripe object");
				object = {
					...current,
					...(Object.keys(metadata).length
						? { metadata: { ...(current.metadata as object), ...metadata } }
						: {}),
				};
			} else {
				const prefix = resource === "products" ? "prod" : resource === "prices" ? "price" : "we";
				object = {
					id: `${prefix}_${this.objects.size + 1}`,
					object: resource === "webhook_endpoints" ? "webhook_endpoint" : resource.slice(0, -1),
					livemode: this.production,
					active: params.get("active") !== "false",
					metadata,
				};
			}
			if (resource === "prices")
				Object.assign(object, {
					product: params.get("product"),
					currency: params.get("currency"),
					unit_amount: Number(params.get("unit_amount")),
					tax_behavior: params.get("tax_behavior"),
					billing_scheme: "per_unit",
					type: params.has("recurring[interval]") ? "recurring" : "one_time",
					recurring: params.has("recurring[interval]")
						? {
								interval: params.get("recurring[interval]"),
								interval_count: Number(params.get("recurring[interval_count]")),
								usage_type: "licensed",
							}
						: null,
				});
			if (resource === "webhook_endpoints")
				Object.assign(object, {
					url: params.get("url"),
					enabled_events: [...params]
						.filter(([key]) => key.startsWith("enabled_events["))
						.map(([, value]) => value),
					status: params.get("disabled") === "true" ? "disabled" : "enabled",
					api_version: params.get("api_version") ?? object.api_version,
					...(!id ? { secret: "whsec_setup" } : {}),
				});
			this.objects.set(object.id, structuredClone(object));
			if (resource === "products" && id) {
				const event: ObjectData = {
					id: `evt_${this.objects.size + 1}`,
					object: "event",
					type: "product.updated",
					api_version: STRIPE_API_VERSION,
					created: Math.floor(Date.now() / 1000),
					livemode: this.production,
					data: { object: structuredClone(object) },
				};
				this.objects.set(event.id, event);
				for (const endpoint of this.objects.values())
					if (
						endpoint.object === "webhook_endpoint" &&
						endpoint.status === "enabled" &&
						(endpoint.enabled_events as string[]).includes("product.updated")
					)
						this.deliveries.push({ url: String(endpoint.url), event });
			}
			if (idempotencyKey) this.receipts.set(idempotencyKey, structuredClone(object));
			if (this.failAfterCreate === resource && !id) {
				this.failAfterCreate = null;
				return Response.json(
					{ error: { type: "api_error", message: "Lost response rk_test_never_print" } },
					{ status: 500 },
				);
			}
			return Response.json(object);
		},
		{ preconnect: fetch.preconnect },
	);
	readonly httpClient = Stripe.createFetchHttpClient(this.fetch);
	readonly client = (key: string) =>
		new Stripe(key, {
			apiVersion: STRIPE_API_VERSION,
			httpClient: this.httpClient,
			maxNetworkRetries: 0,
		});
	count(resource: string) {
		return [...this.objects.values()].filter((item) => item.object === resource).length;
	}
}
