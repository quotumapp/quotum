import { describe, expect, it } from "bun:test";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";
import { createProjectionSignatureHeaders } from "../../src/projections/http-types";

const secret = "receiver-process-test-secret";
const authorization = { authorization: `Bearer ${secret}` };
const repositoryRoot = new URL("../../", import.meta.url).pathname;

async function startReceiver(host?: string, options: { secret?: string } = { secret }) {
	const reservation = Bun.serve({
		hostname: host === "::1" ? "::1" : "127.0.0.1",
		port: 0,
		fetch: () => new Response("reserved"),
	});
	const port = reservation.port;
	reservation.stop(true);
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			"--no-env-file",
			"scripts/projection-receiver.ts",
			`--port=${port}`,
			...(options.secret === undefined ? [] : [`--secret=${options.secret}`]),
			...(host === undefined ? [] : [`--host=${host}`]),
		],
		cwd: repositoryRoot,
		env: createSanitizedProcessEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const url = `http://${host === "::1" ? "[::1]" : "127.0.0.1"}:${port}`;
	const headers = { authorization: `Bearer ${options.secret ?? "local-projection-secret"}` };
	const stop = async () => {
		child.kill();
		await child.exited;
		return { stdout: await stdout, stderr: await stderr };
	};
	try {
		for (let attempt = 0; attempt < 50; attempt++) {
			try {
				const response = await fetch(`${url}/__stats`, {
					headers,
					signal: AbortSignal.timeout(100),
				});
				if (response.ok && (await response.json()).accepted === 0) return { url, port, stop };
			} catch {}
			await Bun.sleep(20);
		}
		throw new Error("Reference projection receiver did not become ready");
	} catch (error) {
		await stop();
		throw error;
	}
}

async function signedPost(url: string, payload: unknown) {
	const body = JSON.stringify(payload);
	return await fetch(url, {
		method: "POST",
		headers: {
			...authorization,
			"content-type": "application/json",
			...createProjectionSignatureHeaders({ secret, body }),
		},
		body,
		signal: AbortSignal.timeout(1_000),
	});
}

async function rejectedStartup(args: string[]) {
	const child = Bun.spawn({
		cmd: [process.execPath, "--no-env-file", "scripts/projection-receiver.ts", ...args],
		cwd: repositoryRoot,
		env: createSanitizedProcessEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	// A regression that starts listening must not leave a receiver process behind.
	const timeout = setTimeout(() => child.kill(), 1_000);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exitCode };
	} finally {
		clearTimeout(timeout);
	}
}

describe("reference projection receiver", () => {
	it.each([undefined, "127.0.0.1", "::1"])(
		"retains the development secret for a loopback bind: %s",
		async (host) => {
			const receiver = await startReceiver(host, {});
			try {
				const response = await fetch(`${receiver.url}/__stats`, {
					headers: { authorization: "Bearer local-projection-secret" },
					signal: AbortSignal.timeout(1_000),
				});
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({ accepted: 0, rejected: 0 });
			} finally {
				await receiver.stop();
			}
		},
	);

	it.each([
		"0.0.0.0",
		"::",
		"192.168.1.10",
		"fd00::10",
		"receiver.internal",
		"localhost",
		"127.example.com",
	])("requires a custom secret for a non-loopback bind: %s", async (host) => {
		for (const supplied of [undefined, "local-projection-secret", " local-projection-secret "]) {
			const args = [`--host=${host}`];
			if (supplied !== undefined) args.push(`--secret=${supplied}`);
			const result = await rejectedStartup(args);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("Non-loopback --host requires a non-default --secret");
		}
	});

	it.each(["", " \t "])("rejects a blank secret for a network bind: %j", async (supplied) => {
		const result = await rejectedStartup(["--host=0.0.0.0", `--secret=${supplied}`]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("invalid --secret");
	});

	it("accepts signed verification and delivery with an explicit container bind address", async () => {
		const receiver = await startReceiver("0.0.0.0");
		try {
			const challenge = { challenge: "receiver-challenge", projectKey: "example-sandbox" };
			const verified = await signedPost(
				`${receiver.url}/internal/billing/projections/verify`,
				challenge,
			);
			expect(verified.status).toBe(200);
			expect(await verified.json()).toEqual({ success: true, challenge: challenge.challenge });
			const delivered = await signedPost(`${receiver.url}/internal/billing/projections`, {
				billingAccountId: "account-1",
				sequence: 1,
			});
			expect(delivered.status).toBe(200);
			expect(await delivered.json()).toEqual({ success: true });
			for (const path of [
				"/internal/billing/projections",
				"/internal/billing/projections/verify",
			]) {
				const response = await fetch(`${receiver.url}${path}`, {
					method: "POST",
					headers: {
						...authorization,
						...createProjectionSignatureHeaders({ secret: "wrong-secret", body: "{}" }),
					},
					body: "{}",
					signal: AbortSignal.timeout(1_000),
				});
				expect(response.status).toBe(401);
			}
		} finally {
			const output = await receiver.stop();
			expect(output.stdout).toBe("");
			expect(output.stderr).not.toContain(secret);
			const [listening] = output.stderr
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(listening).toMatchObject({
				msg: "Projection receiver listening",
				context: { url: `http://[ip]:${receiver.port}/` },
			});
		}
	});

	it("authenticates diagnostics before reading or resetting delivery state", async () => {
		const receiver = await startReceiver();
		try {
			const payload = { billingAccountId: "account-1", sequence: 1 };
			const delivered = await signedPost(`${receiver.url}/internal/billing/projections`, payload);
			expect(delivered.status).toBe(200);
			const stats = () =>
				fetch(`${receiver.url}/__stats`, {
					headers: authorization,
					signal: AbortSignal.timeout(1_000),
				}).then((response) => response.json());
			const before = await stats();
			expect(before).toMatchObject({ accepted: 1, lastPayload: payload });
			expect(before.deliveries).toHaveLength(1);
			const unauthorizedHeaders: HeadersInit[] = [{}, { authorization: "Bearer wrong-secret" }];
			for (const headers of unauthorizedHeaders) {
				for (const path of ["/__stats", "/__reset"]) {
					const response = await fetch(`${receiver.url}${path}`, {
						headers,
						signal: AbortSignal.timeout(1_000),
					});
					expect(response.status).toBe(401);
					expect(await response.text()).toBe("unauthorized");
				}
			}
			expect(await stats()).toEqual(before);
			const reset = await fetch(`${receiver.url}/__reset`, {
				headers: authorization,
				signal: AbortSignal.timeout(1_000),
			});
			expect(reset.status).toBe(200);
			expect(await reset.text()).toBe("ok");
			expect(await stats()).toEqual({
				accepted: 0,
				rejected: 0,
				failModeRemaining: 0,
				lastPayload: null,
				lastHeaders: {},
				lastSequenceByAccount: {},
				deliveries: [],
			});
		} finally {
			await receiver.stop();
		}
	});

	it.each(["", " \t "])("rejects an empty host before listening: %j", async (host) => {
		const result = await rejectedStartup([`--host=${host}`]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("invalid --host");
	});
});
