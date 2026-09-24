import { expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { request as httpRequest, IncomingMessage } from "node:http";
import type { request as httpsRequest } from "node:https";
import {
	type DestinationPolicy,
	isPublicAddress,
	parseAllowedNetworks,
	postToDestination,
	publicHttpsPost,
} from "../../../src/shared/safe-http";

it("denies private, metadata, mapped, reserved and non-global addresses", () => {
	for (const address of [
		"127.0.0.1",
		"10.0.0.1",
		"172.31.255.255",
		"192.168.0.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"::1",
		"::ffff:127.0.0.1",
		"64:ff9b::a00:1",
		"fc00::1",
		"fe80::1",
		"2001:db8::1",
		"2002:a00:1::1",
		"4000::1",
		"example.com",
		"::ffff:10.0.0.1",
		"255.255.255.255",
		"192.0.0.8",
		"198.18.0.1",
	])
		expect(isPublicAddress(address)).toBe(false);
	for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
		expect(isPublicAddress(address)).toBe(true);
});

it("rejects insecure URLs without calling lookup or request", async () => {
	let lookups = 0;
	let requests = 0;
	for (const url of [
		"http://example.com",
		"https://user:pw@example.com",
		"https://example.com/#frag",
	]) {
		await expect(
			publicHttpsPost(
				url,
				"private",
				{},
				{
					lookup: async () => {
						lookups += 1;
						return [];
					},
					request: ((..._args: Parameters<typeof httpsRequest>) => {
						requests += 1;
						throw new Error("request should not run");
					}) as typeof httpsRequest,
				},
			),
		).rejects.toThrow("A public HTTPS URL is required");
	}
	expect(lookups).toBe(0);
	expect(requests).toBe(0);
});

it("rejects private, mixed, empty, and literal loopback destinations without requesting", async () => {
	let requests = 0;
	const request = ((..._args: Parameters<typeof httpsRequest>) => {
		requests += 1;
		throw new Error("request should not run");
	}) as typeof httpsRequest;
	await expect(
		publicHttpsPost(
			"https://example.com",
			"body",
			{},
			{
				lookup: async () => [{ address: "10.0.0.1", family: 4 }],
				request,
			},
		),
	).rejects.toThrow("A public HTTPS destination is required");
	await expect(
		publicHttpsPost(
			"https://example.com",
			"body",
			{},
			{
				lookup: async () => [
					{ address: "1.1.1.1", family: 4 },
					{ address: "10.0.0.1", family: 4 },
				],
				request,
			},
		),
	).rejects.toThrow("A public HTTPS destination is required");
	await expect(
		publicHttpsPost(
			"https://example.com",
			"body",
			{},
			{
				lookup: async () => [],
				request,
			},
		),
	).rejects.toThrow("A public HTTPS destination is required");
	await expect(
		publicHttpsPost(
			"https://127.0.0.1",
			"body",
			{},
			{
				lookup: async () => [{ address: "127.0.0.1", family: 4 }],
				request,
			},
		),
	).rejects.toThrow("A public HTTPS destination is required");
	await expect(
		publicHttpsPost(
			"https://[::1]",
			"body",
			{},
			{
				lookup: async () => [{ address: "::1", family: 6 }],
				request,
			},
		),
	).rejects.toThrow("A public HTTPS destination is required");
	expect(requests).toBe(0);
});

it("posts through a pinned public address and records request shape", async () => {
	const body = "€";
	let pinned: { address: string; family: number } | undefined;
	const result = await publicHttpsPost(
		"https://example.com/path",
		body,
		{ "x-test": "1" },
		{
			lookup: async () => [{ address: "1.1.1.1", family: 4 }],
			request: ((_url, options, onResponse) => {
				const req = new EventEmitter() as EventEmitter & {
					end: (payload?: string) => void;
					destroy: (error?: Error) => void;
				};
				req.destroy = (error) => {
					req.emit("error", error ?? new Error("destroyed"));
				};
				req.end = (payload) => {
					expect(options.method).toBe("POST");
					expect(options.family).toBe(4);
					expect(new Headers(options.headers as HeadersInit).get("content-length")).toBe(
						String(Buffer.byteLength(body)),
					);
					expect(payload).toBe(body);
					options.lookup?.("example.com", {}, (error, address, family) => {
						if (error) throw error;
						pinned = { address: String(address), family: Number(family) };
					});
					const res = new EventEmitter() as EventEmitter & {
						statusCode: number;
						destroy: () => void;
					};
					res.statusCode = 202;
					res.destroy = () => undefined;
					onResponse?.(res as IncomingMessage);
					res.emit("data", Buffer.from("ok"));
					res.emit("end");
				};
				return req;
			}) as typeof httpsRequest,
		},
	);
	expect(result).toEqual({ status: 202, body: "ok" });
	expect(pinned).toEqual({ address: "1.1.1.1", family: 4 });
});

it("rejects oversized responses, request errors, and timeouts", async () => {
	await expect(
		publicHttpsPost(
			"https://example.com",
			"body",
			{},
			{
				lookup: async () => [{ address: "1.1.1.1", family: 4 }],
				request: ((_url, _options, onResponse) => {
					const req = new EventEmitter() as EventEmitter & {
						end: () => void;
						destroy: () => void;
					};
					let destroyed = false;
					req.destroy = () => {
						destroyed = true;
					};
					req.end = () => {
						const res = new EventEmitter() as EventEmitter & {
							statusCode: number;
							destroy: () => void;
						};
						res.statusCode = 200;
						res.destroy = () => {
							destroyed = true;
						};
						onResponse?.(res as IncomingMessage);
						res.emit("data", Buffer.alloc(4097));
						expect(destroyed).toBe(true);
					};
					return req;
				}) as typeof httpsRequest,
			},
		),
	).rejects.toThrow("Receiver response too large");

	await expect(
		publicHttpsPost(
			"https://example.com",
			"body",
			{},
			{
				lookup: async () => [{ address: "1.1.1.1", family: 4 }],
				request: (() => {
					const req = new EventEmitter() as EventEmitter & {
						end: () => void;
						destroy: () => void;
					};
					req.destroy = () => undefined;
					req.end = () => {
						req.emit("error", new Error("boom"));
					};
					return req;
				}) as unknown as typeof httpsRequest,
			},
		),
	).rejects.toThrow("Receiver request failed");

	await expect(
		publicHttpsPost(
			"https://example.com",
			"body",
			{},
			{
				lookup: async () => [{ address: "1.1.1.1", family: 4 }],
				request: (() => {
					const req = new EventEmitter() as EventEmitter & {
						end: () => void;
						destroy: (error?: Error) => void;
					};
					req.destroy = (error) => {
						req.emit("error", error ?? new Error("destroyed"));
					};
					req.end = () => {
						req.emit("timeout");
					};
					return req;
				}) as unknown as typeof httpsRequest,
			},
		),
	).rejects.toThrow("Receiver request failed");
});

it("approves only private networks for receivers", () => {
	expect(
		parseAllowedNetworks(
			" 10.20.0.0/16, 192.168.1.10 ,172.16.0.0/12,100.64.0.0/10, fd12:3456::/48, ",
		),
	).toEqual([
		"10.20.0.0/16",
		"192.168.1.10/32",
		"172.16.0.0/12",
		"100.64.0.0/10",
		"fd12:3456::/48",
	]);
	for (const entry of [
		"127.0.0.1",
		"::1",
		"169.254.169.254",
		"fe80::1",
		"fe80::1%eth0",
		"::ffff:10.0.0.1",
		"64:ff9b::a00:1",
		"8.8.8.8",
		"0.0.0.0/0",
		"::/0",
		"10.0.0.0/7",
		"172.16.0.0/11",
		"fc00::/6",
		"10.0.0.0/33",
		"10.0.0.0/8/8",
		"10.0.0.0/x",
		"receiver.internal",
	])
		expect(() => parseAllowedNetworks(entry)).toThrow(
			`${entry} is not a private network receivers may use`,
		);
});

/** A request double that answers `status` and reports what it was asked to send. */
function answering(status: number, sent: Array<{ url: string; pinned: string }>) {
	return ((
		url: URL,
		options: Parameters<typeof httpsRequest>[1],
		onResponse?: (res: IncomingMessage) => void,
	) => {
		const req = new EventEmitter() as EventEmitter & {
			end: () => void;
			destroy: (error?: Error) => void;
		};
		req.destroy = (error) => {
			req.emit("error", error ?? new Error("destroyed"));
		};
		req.end = () => {
			options?.lookup?.(url.hostname, {}, (_error, address) => {
				sent.push({ url: url.toString(), pinned: String(address) });
			});
			const res = new EventEmitter() as EventEmitter & { statusCode: number; destroy: () => void };
			res.statusCode = status;
			res.destroy = () => undefined;
			onResponse?.(res as IncomingMessage);
			res.emit("end");
		};
		return req;
	}) as unknown as typeof httpsRequest & typeof httpRequest;
}

const refuse = (() => {
	throw new Error("request should not run");
}) as unknown as typeof httpsRequest & typeof httpRequest;

it("reaches approved private networks over HTTPS and keeps every other address out", async () => {
	const policy: DestinationPolicy = { allowedNetworks: ["10.20.0.0/16"], allowInsecureHttp: false };
	const sent: Array<{ url: string; pinned: string }> = [];
	await expect(
		postToDestination(
			"https://receiver.internal/hook",
			"body",
			{},
			{
				policy,
				lookup: async () => [{ address: "10.20.1.5", family: 4 }],
				request: answering(200, sent),
				httpRequest: refuse,
			},
		),
	).resolves.toEqual({ status: 200, body: "" });
	expect(sent).toEqual([{ url: "https://receiver.internal/hook", pinned: "10.20.1.5" }]);
	// Public addresses stay reachable; unapproved private, loopback, metadata and IPv4-mapped forms
	// of an approved network do not.
	await expect(
		postToDestination(
			"https://example.com",
			"body",
			{},
			{
				policy,
				lookup: async () => [{ address: "1.1.1.1", family: 4 }],
				request: answering(200, sent),
			},
		),
	).resolves.toEqual({ status: 200, body: "" });
	for (const [address, family] of [
		["10.30.0.1", 4],
		["127.0.0.1", 4],
		["169.254.169.254", 4],
		["::ffff:10.20.0.1", 6],
	] as const)
		await expect(
			postToDestination(
				"https://receiver.internal",
				"body",
				{},
				{ policy, lookup: async () => [{ address, family }], request: refuse },
			),
		).rejects.toThrow("A public or approved private HTTPS destination is required");
});

it("sends plain http only when every address is in an approved network", async () => {
	const policy: DestinationPolicy = { allowedNetworks: ["10.20.0.0/16"], allowInsecureHttp: true };
	const sent: Array<{ url: string; pinned: string }> = [];
	await expect(
		postToDestination(
			"http://receiver.internal:8080/hook",
			"body",
			{},
			{
				policy,
				lookup: async () => [{ address: "10.20.0.9", family: 4 }],
				request: refuse,
				httpRequest: answering(204, sent),
			},
		),
	).resolves.toEqual({ status: 204, body: "" });
	expect(sent).toEqual([{ url: "http://receiver.internal:8080/hook", pinned: "10.20.0.9" }]);
	for (const addresses of [
		[{ address: "1.1.1.1", family: 4 }],
		[
			{ address: "10.20.0.9", family: 4 },
			{ address: "1.1.1.1", family: 4 },
		],
		[{ address: "10.30.0.1", family: 4 }],
	])
		await expect(
			postToDestination(
				"http://receiver.internal",
				"body",
				{},
				{ policy, lookup: async () => addresses, request: refuse, httpRequest: refuse },
			),
		).rejects.toThrow("An approved private destination is required for http");
});

it("refuses http unless the policy allows it, and never trusts an unvalidated policy", async () => {
	let lookups = 0;
	const lookup = async () => {
		lookups += 1;
		return [{ address: "10.20.0.9", family: 4 }];
	};
	await expect(
		postToDestination(
			"http://receiver.internal",
			"body",
			{},
			{
				policy: { allowedNetworks: ["10.20.0.0/16"], allowInsecureHttp: false },
				lookup,
				request: refuse,
				httpRequest: refuse,
			},
		),
	).rejects.toThrow("A public HTTPS URL is required");
	await expect(
		postToDestination(
			"http://receiver.internal",
			"body",
			{},
			{
				policy: { allowedNetworks: ["127.0.0.0/8"], allowInsecureHttp: true },
				lookup,
				request: refuse,
				httpRequest: refuse,
			},
		),
	).rejects.toThrow("127.0.0.0/8 is not a private network receivers may use");
	expect(lookups).toBe(0);
});
