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
