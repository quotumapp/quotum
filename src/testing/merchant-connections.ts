import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { request as httpsRequest } from "node:https";
import type { SQL } from "bun";
import { createConnectionValidation } from "../composition/connection-validation";
import {
	createConnectionRepository,
	createRuntimeConnectionResolver,
} from "../composition/connections";
import { merchantSql } from "../composition/merchant-persistence";
import type { StripeOAuthPort } from "../platform/connections/oauth-port";
import type { ConnectionValidationPort } from "../platform/connections/ports";
import { MerchantError, secureEqual } from "../platform/security";
import { verifyProjectionSignature } from "../projections/http-types";
import type { RuntimeConnectionResolver } from "../projects/connections";

const receiverOrigin = "https://receiver.example.test";

/** Synthetic outgoing transports; neither provider credentials nor receiver bodies leave this process. */
export function merchantTestConnections(database: SQL, fallback: RuntimeConnectionResolver) {
	const persistence = merchantSql(database);
	const repository = createConnectionRepository(persistence);
	const captures: {
		projectKey: string;
		verification: boolean;
		bearerOk: boolean;
		signatureOk: boolean;
	}[] = [];
	const codes = new Map<string, "sandbox" | "production">();
	let callbackOrigin = "";
	let authorizeBase = "";
	let nextReceiverStatus = 200;
	const oauth: StripeOAuthPort = {
		authorize(environment, state) {
			const url = new URL(authorizeBase);
			url.searchParams.set("state", state);
			url.searchParams.set("environment", environment);
			return url.href;
		},
		async exchange(environment, code) {
			if (codes.get(code) !== environment) throw new Error("Synthetic OAuth code unavailable");
			codes.delete(code);
			return {
				accessToken: `synthetic-access-${randomUUID()}`,
				refreshToken: `synthetic-refresh-${randomUUID()}`,
				expiresAt: Date.now() + 3_600_000,
				accountId: `acct_synthetic_oauth_${environment}`,
				livemode: environment === "production",
			};
		},
		async refresh(environment) {
			return {
				accessToken: "synthetic-refreshed",
				refreshToken: "synthetic-refresh",
				expiresAt: Date.now() + 3_600_000,
				accountId: `acct_synthetic_oauth_${environment}`,
				livemode: environment === "production",
			};
		},
		webhookSecret: () => "whsec_synthetic_oauth",
	};
	const managed = createRuntimeConnectionResolver(repository, persistence, oauth);
	const connections: RuntimeConnectionResolver = {
		async resolve(project, kind, purpose) {
			return (await repository.describe(project.projectInstanceId, kind))
				? managed.resolve(project, kind, purpose)
				: fallback.resolve(project, kind, purpose);
		},
		async describe(project, kind) {
			return (await repository.describe(project.projectInstanceId, kind))
				? (managed.describe?.(project, kind) ?? null)
				: (fallback.describe?.(project, kind) ?? null);
		},
	};
	async function receive(url: URL, body: string, headers: Headers, secret: string) {
		if (url.origin !== receiverOrigin) throw new Error("Unexpected synthetic receiver destination");
		const parsed = JSON.parse(body) as { projectKey: string; challenge?: string };
		const verification = url.pathname.endsWith("/internal/billing/projections/verify");
		const bearerOk = secureEqual(headers.get("authorization") ?? "", `Bearer ${secret}`);
		const signatureOk = verifyProjectionSignature({
			secret,
			body,
			timestamp: headers.get("x-billing-timestamp") ?? "",
			signature: headers.get("x-billing-signature") ?? "",
		});
		if (captures.length >= 256) throw new Error("Synthetic receiver capture limit reached");
		captures.push({ projectKey: parsed.projectKey, verification, bearerOk, signatureOk });
		const status = nextReceiverStatus;
		nextReceiverStatus = 200;
		return Response.json(
			verification ? { success: true, challenge: parsed.challenge } : { success: true },
			{ status: bearerOk && signatureOk ? status : 401 },
		);
	}
	const productionValidation = createConnectionValidation();
	const validation: ConnectionValidationPort = {
		normalize: productionValidation.normalize,
		async validate(kind, environment, input, context) {
			if (kind !== "projection")
				return {
					identity: `synthetic_${kind}_${context.instanceKey}_${environment}`,
					eventVerified: true,
					checks: [{ code: "SYNTHETIC_PROVIDER", passed: true }],
				};
			const version = await repository.version(context.instanceId, context.versionId);
			const secrets = await repository.secrets(version);
			const transport = ((
				url: URL,
				options: { headers: Record<string, string> },
				onResponse: (response: IncomingMessage) => void,
			) => {
				const request = new EventEmitter() as EventEmitter & {
					end(body: string): void;
					destroy(): void;
				};
				request.destroy = () => undefined;
				request.end = (body) => {
					void receive(url, body, new Headers(options.headers), secrets.projectionSecret ?? "")
						.then(async (response) => {
							const incoming = new EventEmitter() as IncomingMessage;
							incoming.statusCode = response.status;
							incoming.destroy = () => incoming;
							onResponse(incoming);
							incoming.emit("data", Buffer.from(await response.text()));
							incoming.emit("end");
						})
						.catch(() => request.emit("error", new Error("Synthetic receiver failed")));
				};
				return request;
			}) as unknown as typeof httpsRequest;
			return createConnectionValidation({
				destinationDependencies: {
					lookup: async () => [{ address: "8.8.8.8", family: 4 }],
					request: transport,
				},
			}).validate(kind, environment, input, context);
		},
	};
	return {
		connections,
		validation,
		oauth,
		configure(origin: string, authorizeUrl: string) {
			callbackOrigin = origin;
			authorizeBase = authorizeUrl;
		},
		authorize(url: URL) {
			const environment = url.searchParams.get("environment");
			if (environment !== "sandbox" && environment !== "production")
				throw new MerchantError("INVALID_REQUEST", "Synthetic environment required.");
			const code = randomUUID();
			if (codes.size >= 256) throw new Error("Synthetic authorization limit reached");
			codes.set(code, environment);
			const callback = new URL("/auth/stripe/callback", callbackOrigin);
			callback.searchParams.set("state", url.searchParams.get("state") ?? "");
			callback.searchParams.set("code", code);
			return callback.href;
		},
		async fetch(input: string, init: RequestInit) {
			const url = new URL(input);
			if (url.origin !== receiverOrigin) {
				if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
					throw new Error("External receiver traffic forbidden in synthetic runtime");
				return globalThis.fetch(input, init);
			}
			const body = String(init.body);
			const { projectKey } = JSON.parse(body) as { projectKey: string };
			const [instance] = await database<
				{ id: string }[]
			>`SELECT id FROM projects WHERE key=${projectKey}`;
			const active = instance ? await repository.active(instance.id, "projection", true) : null;
			if (!active) throw new Error("Synthetic committed receiver unavailable");
			return receive(url, body, new Headers(init.headers), active.secrets.projectionSecret ?? "");
		},
		state(projectKey: string | null) {
			return captures.filter((capture) => !projectKey || capture.projectKey === projectKey);
		},
		respond(status: number) {
			nextReceiverStatus = status;
		},
		reset() {
			captures.length = 0;
			codes.clear();
			nextReceiverStatus = 200;
		},
	};
}
