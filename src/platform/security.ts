import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { MerchantCapability, MerchantRole } from "./contracts";

export class MerchantError extends Error {
	constructor(
		public code: string,
		message: string,
		public status = 400,
		public retryAfter?: number,
	) {
		super(message);
	}
}
export const SESSION_COOKIE = "__Host-quotum_session";
export const CSRF_COOKIE = "__Host-quotum_csrf";
export const IDLE_MS = 30 * 60_000;
export const ABSOLUTE_MS = 12 * 60 * 60_000;
export const STEP_UP_MS = 10 * 60_000;
export const INVITATION_MS = 7 * 24 * 60 * 60_000;
export function randomToken(): string {
	return randomBytes(32).toString("base64url");
}
export function tokenHash(token: string, secret: string): string {
	return createHmac("sha256", secret).update(token).digest("hex");
}
export function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
export function secureEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}
export function cookieValue(headers: Headers, name: string): string | null {
	const parts = (headers.get("cookie") ?? "").split(";").map((p) => p.trim());
	return parts.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}
export function sessionCookie(token: string, maxAge = ABSOLUTE_MS / 1000): string {
	return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function csrfCookie(token: string): string {
	return `${CSRF_COOKIE}=${token}; Path=/; Secure; SameSite=Lax; Max-Age=${ABSOLUTE_MS / 1000}`;
}
export function assertCsrf(request: Request, origin: string): void {
	if (request.headers.get("origin") !== origin)
		throw new MerchantError("ORIGIN_REJECTED", "Refresh this page and try again.", 403);
	const token = cookieValue(request.headers, CSRF_COOKIE);
	const supplied = request.headers.get("x-csrf-token");
	if (!token || !supplied || !secureEqual(token, supplied))
		throw new MerchantError("CSRF_REJECTED", "Refresh this page and try again.", 403);
}
export function safeReturnTo(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		/[\\\r\n]/.test(value)
	)
		return "/";
	const url = new URL(value, "https://app.quotum.dev");
	if (
		url.pathname.includes("%") ||
		!/^\/(?:$|organizations$|team$|invite$|onboarding\/(?:organization|project|provisioning|ready)$|orgs\/[a-z0-9-]+\/projects\/[a-z0-9_-]+\/(?:sandbox|production)(?:\/[^?#]*)?$)/.test(
			url.pathname,
		)
	)
		return "/";
	return `${url.pathname}${url.search}`;
}
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}
export function maskEmail(email: string): string {
	const [local, host] = email.split("@");
	return `${local?.slice(0, 1) ?? ""}***@${host ?? "***"}`;
}
const allCapabilities: MerchantCapability[] = [
	"billing.read",
	"team.manage",
	"project.create",
	"sandbox.configure",
	"sandbox.credentials.rotate",
	"catalog.author",
	"catalog.publish.sandbox",
	"catalog.publish.production",
	"operations.recover",
	"operations.write",
	"production.manage",
	"production.connections.manage",
	"production.activate",
	"production.credentials.rotate",
];
const roleCapabilities: Record<MerchantRole, readonly MerchantCapability[]> = {
	Owner: allCapabilities,
	Admin: allCapabilities,
	Developer: [
		"billing.read",
		"project.create",
		"sandbox.configure",
		"sandbox.credentials.rotate",
		"catalog.author",
		"catalog.publish.sandbox",
	],
	Operator: ["billing.read", "operations.recover"],
	Viewer: ["billing.read"],
};
export function capabilitiesFor(role: MerchantRole): MerchantCapability[] {
	return [...roleCapabilities[role]];
}
export function requireCapability(role: MerchantRole, capability: MerchantCapability): void {
	if (!roleCapabilities[role].includes(capability))
		throw new MerchantError("FORBIDDEN", "You do not have permission to perform this action.", 403);
}
export function idempotencyKey(request: Request): string {
	const value = request.headers.get("idempotency-key");
	if (!value || !/^[A-Za-z0-9._:-]{8,128}$/.test(value))
		throw new MerchantError("IDEMPOTENCY_KEY_REQUIRED", "An idempotency key is required.");
	return value;
}
