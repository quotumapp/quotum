const preservedEnvNames = new Set([
	"CI",
	"COLORTERM",
	"FORCE_COLOR",
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LOGNAME",
	"NO_COLOR",
	"PATH",
	"SHELL",
	"TEMP",
	"TERM",
	"TMP",
	"TMPDIR",
	"USER",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
]);

export function createSanitizedProcessEnv(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) {
			continue;
		}
		if (preservedEnvNames.has(key) || key.startsWith("BUN_")) {
			env[key] = value;
		}
	}
	return env;
}

/** Container-owning test processes need the caller's Docker connection settings. */
export function createContainerTestEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = createSanitizedProcessEnv(source);
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined && (key.startsWith("DOCKER_") || key.startsWith("TESTCONTAINERS_"))) {
			env[key] = value;
		}
	}
	return env;
}
