import { describe, expect, it } from "bun:test";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";
import { createProjectionSignatureHeaders } from "../../src/projections/http-types";

const secret = "receiver-process-test-secret";
const authorization = { authorization: `Bearer ${secret}` };
const repositoryRoot = new URL("../../", import.meta.url).pathname;

async function startReceiver(host?: string) {
	const reservation = Bun.serve({
		hostname: "127.0.0.1",
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
			`--secret=${secret}`,
			...(host === undefined ? [] : [`--host=${host}`]),
		],
		cwd: repositoryRoot,
		env: createSanitizedProcessEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const url = `http://127.0.0.1:${port}`;
	const stop = async () => {
		child.kill();
		await child.exited;
		return { stdout: await stdout, stderr: await stderr };
	};
	try {
		for (let attempt = 0; attempt < 50; attempt++) {
			try {
				const response = await fetch(`${url}/__stats`, {
					headers: authorization,
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

describe("reference projection receiver", () => {
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
		const child = Bun.spawn({
			cmd: [process.execPath, "--no-env-file", "scripts/projection-receiver.ts", `--host=${host}`],
			cwd: repositoryRoot,
			env: createSanitizedProcessEnv(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("invalid --host");
	});
});
