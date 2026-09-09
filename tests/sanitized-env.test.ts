import { expect, it } from "bun:test";
import { createContainerTestEnv, createSanitizedProcessEnv } from "../scripts/lib/sanitized-env";

it("passes remote Docker settings to container tests without leaking application configuration", () => {
	const source = {
		PATH: "/usr/bin",
		DOCKER_HOST: "tcp://docker:2375",
		DOCKER_TLS_CERTDIR: "",
		DOCKER_CERT_PATH: "/test/certs",
		TESTCONTAINERS_HOST_OVERRIDE: "docker",
		TESTCONTAINERS_RYUK_DISABLED: "true",
		BILLING_OPERATOR_API_KEY: "ambient-key",
		POSTGRES_URI: "ambient-database",
	};
	const env = createContainerTestEnv(source);
	expect(env.DOCKER_HOST).toBe(source.DOCKER_HOST);
	expect(env.DOCKER_TLS_CERTDIR).toBe("");
	expect(env.DOCKER_CERT_PATH).toBe(source.DOCKER_CERT_PATH);
	expect(env.TESTCONTAINERS_HOST_OVERRIDE).toBe("docker");
	expect(env.TESTCONTAINERS_RYUK_DISABLED).toBe("true");
	expect(env.BILLING_OPERATOR_API_KEY).toBeUndefined();
	expect(env.POSTGRES_URI).toBeUndefined();
	expect(createSanitizedProcessEnv(env)).toEqual({ PATH: "/usr/bin" });
});
