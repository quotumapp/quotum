/**
 * Reference projection receiver.
 *
 * Use it to see what the billing service delivers to a product backend and to check your own
 * signature verification against it.
 *
 * - Mounts the `/internal/billing/projections` endpoint shape a product backend exposes.
 * - Verifies `X-Billing-Signature` and `X-Billing-Timestamp` exactly the way the projection
 *   worker computes them, including the replay window.
 * - Prints every accepted and rejected delivery to stdout; pass `--log=<file>` to also persist
 *   deliveries as JSON across restarts.
 * - Tracks the per-account `sequence` and flags a snapshot older than one already applied as
 *   stale while still acknowledging it, which is what a real receiver should do.
 * - Optionally fails the first responses to exercise retry and backoff behavior.
 *
 * Usage:
 *   bun scripts/projection-receiver.ts [--port=4101] [--secret=<projection secret>] [--fail=<n>] [--log=<file>]
 */

import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface Args {
	port: number;
	secret: string;
	fail: number;
	log: string;
}

function parseArgs(argv: readonly string[]): Args {
	let port = 4101;
	let secret = "local-projection-secret";
	let fail = 0;
	let log = "";
	for (const arg of argv) {
		if (arg.startsWith("--port=")) port = Number.parseInt(arg.slice("--port=".length), 10);
		else if (arg.startsWith("--secret=")) secret = arg.slice("--secret=".length);
		else if (arg.startsWith("--fail=")) fail = Number.parseInt(arg.slice("--fail=".length), 10);
		else if (arg.startsWith("--log=")) log = arg.slice("--log=".length);
	}
	if (!Number.isFinite(port) || port <= 0) throw new Error("invalid --port");
	if (secret.length < 1) throw new Error("invalid --secret");
	if (!Number.isFinite(fail) || fail < 0) throw new Error("invalid --fail");
	return { port, secret, fail, log };
}

const args = parseArgs(process.argv.slice(2));

let acceptedCount = 0;
let rejectedCount = 0;
let lastPayload: unknown = null;
let lastHeaders: Record<string, string> = {};
let lastSequenceByAccount: Record<string, number> = {};
let deliveries: Array<{
	at: string;
	reason: string;
	billingAccountId: string;
	status: "accepted" | "stale" | "rejected" | "deliberate-failed";
	payload: unknown;
	headers: Record<string, string>;
}> = [];

async function ensureFile(): Promise<void> {
	if (args.log === "") return;
	try {
		await mkdir(dirname(args.log), { recursive: true });
	} catch {}
	try {
		const buf = await readFile(args.log, "utf8");
		if (buf.length > 0) {
			const parsed = JSON.parse(buf);
			if (Array.isArray(parsed.deliveries)) deliveries = parsed.deliveries;
			if (typeof parsed.acceptedCount === "number") acceptedCount = parsed.acceptedCount;
			if (typeof parsed.rejectedCount === "number") rejectedCount = parsed.rejectedCount;
			if ("lastPayload" in parsed) lastPayload = parsed.lastPayload;
			if (parsed.lastHeaders && typeof parsed.lastHeaders === "object")
				lastHeaders = parsed.lastHeaders;
			if (parsed.lastSequenceByAccount && typeof parsed.lastSequenceByAccount === "object")
				lastSequenceByAccount = parsed.lastSequenceByAccount;
		}
	} catch {
		await writeFile(
			args.log,
			JSON.stringify(
				{
					deliveries: [],
					acceptedCount: 0,
					rejectedCount: 0,
					lastPayload: null,
					lastHeaders: {},
					lastSequenceByAccount: {},
				},
				null,
				2,
			),
		);
	}
}

async function persist(): Promise<void> {
	if (args.log === "") return;
	await writeFile(
		args.log,
		JSON.stringify(
			{ deliveries, acceptedCount, rejectedCount, lastPayload, lastHeaders, lastSequenceByAccount },
			null,
			2,
		),
	);
}

await ensureFile();

const replayWindowMs = 5 * 60 * 1000;
const requiredEnvelope = { success: true };

function expectedSignature(secret: string, timestamp: string, body: string): string {
	const digest = new Bun.CryptoHasher("sha256", secret)
		.update(`${timestamp}.${body}`)
		.digest("hex");
	return `sha256=${digest}`;
}

function constantTimeEquals(a: string, b: string): boolean {
	const ab = Buffer.from(a, "utf8");
	const bb = Buffer.from(b, "utf8");
	if (ab.byteLength !== bb.byteLength) return false;
	return timingSafeEqual(ab, bb);
}

function verifyRequest(
	body: string,
	timestampHeader: string | null,
	signatureHeader: string | null,
): { ok: boolean; reason: string } {
	if (timestampHeader === null) return { ok: false, reason: "missing X-Billing-Timestamp" };
	if (signatureHeader === null) return { ok: false, reason: "missing X-Billing-Signature" };
	const timestampSeconds = Number.parseInt(timestampHeader, 10);
	if (!Number.isSafeInteger(timestampSeconds) || String(timestampSeconds) !== timestampHeader) {
		return { ok: false, reason: "invalid X-Billing-Timestamp" };
	}
	const ageMs = Math.abs(Date.now() - timestampSeconds * 1000);
	if (ageMs > replayWindowMs) return { ok: false, reason: "stale X-Billing-Timestamp" };
	const expected = expectedSignature(args.secret, timestampHeader, body);
	if (!constantTimeEquals(signatureHeader, expected)) {
		return { ok: false, reason: "bad X-Billing-Signature" };
	}
	return { ok: true, reason: "ok" };
}

function summarize(value: unknown): {
	reason: string;
	billingAccountId: string;
	sequence: number | null;
	purchase?: string;
	reversal?: string;
} {
	if (typeof value !== "object" || value === null) {
		return { reason: "n/a", billingAccountId: "n/a", sequence: null };
	}
	const obj = value as Record<string, unknown>;
	const reason = typeof obj.reason === "string" ? obj.reason : "n/a";
	const billingAccountId = typeof obj.billingAccountId === "string" ? obj.billingAccountId : "n/a";
	const sequence =
		typeof obj.sequence === "number" && Number.isSafeInteger(obj.sequence) ? obj.sequence : null;
	const purchase =
		typeof obj.purchase === "object" && obj.purchase !== null
			? JSON.stringify(obj.purchase)
			: undefined;
	const reversal =
		typeof obj.reversal === "object" && obj.reversal !== null
			? JSON.stringify(obj.reversal)
			: undefined;
	return { reason, billingAccountId, sequence, purchase, reversal };
}

const server = Bun.serve({
	port: args.port,
	hostname: "127.0.0.1",
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);
		const stamp = new Date().toISOString();
		if (request.method === "GET" && url.pathname === "/__stats") {
			return Response.json({
				accepted: acceptedCount,
				rejected: rejectedCount,
				failModeRemaining: args.fail,
				lastPayload,
				lastHeaders,
				lastSequenceByAccount,
				deliveries,
			});
		}
		if (request.method === "GET" && url.pathname === "/__reset") {
			acceptedCount = 0;
			rejectedCount = 0;
			lastPayload = null;
			lastHeaders = {};
			lastSequenceByAccount = {};
			deliveries = [];
			await persist();
			return new Response("ok");
		}
		if (url.pathname !== "/internal/billing/projections") {
			return new Response("not found", { status: 404 });
		}
		const body = await request.text();
		const ts = request.headers.get("x-billing-timestamp");
		const sig = request.headers.get("x-billing-signature");
		const auth = request.headers.get("authorization") ?? "";
		const expectedAuth = `Bearer ${args.secret}`;
		const headerMap: Record<string, string> = {};
		for (const [k, v] of request.headers.entries()) headerMap[k] = v;
		if (!constantTimeEquals(auth, expectedAuth)) {
			rejectedCount += 1;
			console.log(`[receiver ${stamp}] REJECT 401 bad authorization`);
			deliveries.push({
				at: stamp,
				reason: "bad-authorization",
				billingAccountId: "-",
				status: "rejected",
				payload: null,
				headers: headerMap,
			});
			await persist();
			return new Response("unauthorized", { status: 401 });
		}
		const verification = verifyRequest(body, ts, sig);
		if (!verification.ok) {
			rejectedCount += 1;
			console.log(`[receiver ${stamp}] REJECT 401 ${verification.reason}`);
			deliveries.push({
				at: stamp,
				reason: verification.reason,
				billingAccountId: "-",
				status: "rejected",
				payload: null,
				headers: headerMap,
			});
			await persist();
			return new Response("unauthorized", { status: 401 });
		}
		if (args.fail > 0) {
			args.fail -= 1;
			rejectedCount += 1;
			console.log(`[receiver ${stamp}] DELIBERATE 503 fail=${args.fail} remaining`);
			deliveries.push({
				at: stamp,
				reason: "deliberate-503",
				billingAccountId: "-",
				status: "deliberate-failed",
				payload: null,
				headers: headerMap,
			});
			await persist();
			return new Response("deliberate failure", { status: 503 });
		}
		let parsed: unknown = body;
		try {
			parsed = JSON.parse(body);
		} catch {}
		lastPayload = parsed;
		lastHeaders = headerMap;
		acceptedCount += 1;
		const summary = summarize(parsed);
		// A lower sequence than one already applied for the account is an older snapshot: a real
		// receiver keeps its newer state, records any purchase or reversal facts, and still acks.
		const applied = lastSequenceByAccount[summary.billingAccountId];
		const stale = summary.sequence !== null && applied !== undefined && summary.sequence < applied;
		if (summary.sequence !== null && !stale) {
			lastSequenceByAccount[summary.billingAccountId] = summary.sequence;
		}
		console.log(
			`[receiver ${stamp}] ${stale ? "STALE" : "ACCEPT"} #${acceptedCount} reason=${summary.reason} billingAccountId=${summary.billingAccountId} sequence=${summary.sequence ?? "-"} purchase=${summary.purchase ?? "-"} reversal=${summary.reversal ?? "-"}`,
		);
		deliveries.push({
			at: stamp,
			reason: summary.reason,
			billingAccountId: summary.billingAccountId,
			status: stale ? "stale" : "accepted",
			payload: parsed,
			headers: headerMap,
		});
		await persist();
		return Response.json(requiredEnvelope);
	},
});

console.log(
	`projection receiver listening on http://127.0.0.1:${server.port} (secret="${args.secret}", deliberate-fail-remaining=${args.fail}, log=${args.log || "stdout only"})`,
);

// Keep the event loop alive even if Bun's --hot / async cleanup ends.
setInterval(() => {}, 1 << 30);
