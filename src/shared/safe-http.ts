import { lookup } from "node:dns/promises";
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

export interface PublicHttpsPostDependencies {
	lookup?: (
		hostname: string,
		options: { all: true },
	) => Promise<Array<{ address: string; family: number }>>;
	request?: typeof request;
}

/** Resolve before connecting and pin the verified address while keeping hostname TLS verification. */
export async function publicHttpsPost(
	urlString: string,
	body: string,
	headers: Record<string, string>,
	{
		lookup: resolveAddresses = lookup,
		request: sendRequest = request,
	}: PublicHttpsPostDependencies = {},
): Promise<{ status: number; body: string }> {
	const url = new URL(urlString);
	if (url.protocol !== "https:" || url.username || url.password || url.hash)
		throw new Error("A public HTTPS URL is required");
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
	if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
		throw new Error("A public HTTPS destination is required");
	const target = addresses[0];
	if (!target) throw new Error("Destination unavailable");
	return new Promise((resolve, reject) => {
		const req = sendRequest(
			url,
			{
				method: "POST",
				family: target.family,
				headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
				lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
				timeout: 10_000,
				signal: AbortSignal.timeout(10_000),
			},
			(res) => {
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
			},
		);
		req.on("timeout", () => req.destroy(new Error("Receiver request timed out")));
		req.on("error", () => reject(new Error("Receiver request failed")));
		req.end(body);
	});
}
