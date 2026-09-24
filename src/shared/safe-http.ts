import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const denied = new BlockList();
const deniedV6 = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	denied.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
	["::", 128],
	["::1", 128],
	["::ffff:0:0", 96],
	["64:ff9b::", 96],
	["100::", 64],
	["2001::", 32],
	["2001:db8::", 32],
	["2002::", 16],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const)
	deniedV6.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
export function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	return (
		family !== 0 &&
		(family !== 6 || globalV6.check(address, "ipv6")) &&
		!(family === 4 ? denied : deniedV6).check(address, family === 4 ? "ipv4" : "ipv6")
	);
}

/** Private ranges an operator may approve for receivers. Anything else stays public-only. */
const approvableRanges = [
	["10.0.0.0", 8, "ipv4"],
	["100.64.0.0", 10, "ipv4"],
	["172.16.0.0", 12, "ipv4"],
	["192.168.0.0", 16, "ipv4"],
	["fc00::", 7, "ipv6"],
] as const;
const approvable = approvableRanges.map(([address, prefix, family]) => {
	const list = new BlockList();
	list.addSubnet(address, prefix, family);
	return { list, prefix, family };
});

/** Where a receiver may be. The default allows public HTTPS destinations only. */
export interface DestinationPolicy {
	/** Operator-approved private networks, as `address/prefix`, beside the public internet. */
	readonly allowedNetworks: readonly string[];
	/** Plain http, only when every resolved address is inside `allowedNetworks`. */
	readonly allowInsecureHttp: boolean;
}

export const publicDestinationPolicy: DestinationPolicy = Object.freeze({
	allowedNetworks: Object.freeze([]),
	allowInsecureHttp: false,
});

/**
 * Parses comma-separated networks or single addresses. Each must lie inside 10/8, 100.64/10,
 * 172.16/12, 192.168/16 or fc00::/7, so loopback, link-local and metadata addresses, IPv4-mapped
 * and NAT64 forms, public space and `/0` can never be approved.
 */
export function parseAllowedNetworks(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "")
		.map((entry) => {
			const [address = "", prefixText, ...rest] = entry.split("/");
			const family = rest.length > 0 || address.includes("%") ? 0 : isIP(address);
			const width = family === 4 ? 32 : 128;
			const prefix =
				prefixText === undefined ? width : /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : -1;
			const inside =
				family !== 0 &&
				prefix <= width &&
				approvable.some(
					(range) =>
						range.family === (family === 4 ? "ipv4" : "ipv6") &&
						prefix >= range.prefix &&
						range.list.check(address, range.family),
				);
			if (!inside) throw new Error(`${entry} is not a private network receivers may use`);
			return `${address}/${prefix}`;
		});
}

/** Validates the policy again, so a hand-built one can never approve more than the parser does. */
function approvedNetworks(policy: DestinationPolicy): (address: string) => boolean {
	const v4 = new BlockList();
	const v6 = new BlockList();
	for (const network of parseAllowedNetworks(policy.allowedNetworks.join(","))) {
		const [address = "", prefix] = network.split("/");
		if (isIP(address) === 4) v4.addSubnet(address, Number(prefix), "ipv4");
		else v6.addSubnet(address, Number(prefix), "ipv6");
	}
	// Separate lists: a single one matches an IPv4-mapped IPv6 address against its IPv4 rules.
	return (address) => {
		const family = isIP(address);
		return family === 4 ? v4.check(address, "ipv4") : family === 6 && v6.check(address, "ipv6");
	};
}

export interface PublicHttpsPostDependencies {
	lookup?: (
		hostname: string,
		options: { all: true },
	) => Promise<Array<{ address: string; family: number }>>;
	request?: typeof request;
}

export interface DestinationPostDependencies extends PublicHttpsPostDependencies {
	policy?: DestinationPolicy;
	/** Sends `http:` requests, which only an approved private network can receive. */
	httpRequest?: typeof httpRequest;
}

/** Resolve before connecting and pin the verified address while keeping hostname TLS verification. */
export async function publicHttpsPost(
	urlString: string,
	body: string,
	headers: Record<string, string>,
	dependencies: PublicHttpsPostDependencies = {},
): Promise<{ status: number; body: string }> {
	return await postToDestination(urlString, body, headers, {
		...dependencies,
		policy: publicDestinationPolicy,
	});
}

/**
 * Posts to a destination the policy allows. HTTPS may reach public addresses and approved private
 * networks; http only approved private networks. Every resolved address must qualify, and the
 * request is pinned to the first one so a second lookup cannot redirect it.
 */
export async function postToDestination(
	urlString: string,
	body: string,
	headers: Record<string, string>,
	{
		policy = publicDestinationPolicy,
		lookup: resolveAddresses = lookup,
		request: sendRequest = request,
		httpRequest: sendHttpRequest = httpRequest,
	}: DestinationPostDependencies = {},
): Promise<{ status: number; body: string }> {
	const url = new URL(urlString);
	const insecure = url.protocol === "http:" && policy.allowInsecureHttp;
	if ((url.protocol !== "https:" && !insecure) || url.username || url.password || url.hash)
		throw new Error("A public HTTPS URL is required");
	const approved = approvedNetworks(policy);
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const addresses = await Promise.race([
		resolveAddresses(hostname, { all: true }),
		new Promise<never>((_, reject) => {
			timeout = setTimeout(() => reject(new Error("Destination lookup timed out")), 5000);
		}),
	]).finally(() => {
		if (timeout) clearTimeout(timeout);
	});
	const allowed = (address: string) => approved(address) || (!insecure && isPublicAddress(address));
	if (!addresses.length || addresses.some((a) => !allowed(a.address)))
		throw new Error(
			insecure
				? "An approved private destination is required for http"
				: policy.allowedNetworks.length > 0
					? "A public or approved private HTTPS destination is required"
					: "A public HTTPS destination is required",
		);
	const target = addresses[0];
	if (!target) throw new Error("Destination unavailable");
	return new Promise((resolve, reject) => {
		const options = {
			method: "POST",
			family: target.family,
			headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
			lookup: (
				_hostname: string,
				_options: unknown,
				callback: (error: Error | null, address: string, family: number) => void,
			) => callback(null, target.address, target.family),
			timeout: 10_000,
			signal: AbortSignal.timeout(10_000),
		};
		const onResponse = (res: IncomingMessage) => {
			const chunks: Buffer[] = [];
			let length = 0;
			res.on("data", (chunk) => {
				length += chunk.length;
				if (length > 4096) {
					res.destroy();
					reject(new Error("Receiver response too large"));
					return;
				}
				chunks.push(Buffer.from(chunk));
			});
			res.on("end", () =>
				resolve({ status: res.statusCode ?? 502, body: Buffer.concat(chunks).toString("utf8") }),
			);
			res.on("error", () => reject(new Error("Receiver request failed")));
		};
		const req = insecure
			? sendHttpRequest(url, options, onResponse)
			: sendRequest(url, options, onResponse);
		req.on("timeout", () => req.destroy(new Error("Receiver request timed out")));
		req.on("error", () => reject(new Error("Receiver request failed")));
		req.end(body);
	});
}
