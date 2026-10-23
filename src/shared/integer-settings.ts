/** A deployment override and its existing default. No default means inherit from the caller. */
export interface IntegerSetting {
	variable: string;
	default?: number;
	min?: number;
	max?: number;
}

export type IntegerOverrides<Settings> = { [Key in keyof Settings]?: number };
export type ResolvedIntegers<Settings> = {
	[Key in keyof Settings as Settings[Key] extends { default: number } ? Key : never]: number;
} & {
	[Key in keyof Settings as Settings[Key] extends { default: number } ? never : Key]?: number;
};

/** Environment values must be canonical base-ten integers; blank values are configuration errors. */
export function loadIntegerSettings<Settings extends Record<string, IntegerSetting>>(
	settings: Settings,
	source: Record<string, string | undefined>,
): IntegerOverrides<Settings> {
	const result: IntegerOverrides<Settings> = {};
	for (const key of Object.keys(settings) as Array<keyof Settings>) {
		const setting = settings[key];
		const raw = source[setting.variable];
		if (raw === undefined) continue;
		const text = raw.trim();
		const value = Number(text);
		if (String(value) !== text) throw invalidSetting(setting);
		result[key] = validateIntegerSetting(setting, value);
	}
	return result;
}

/** Also validates programmatic configuration, without reading the process environment. */
export function resolveIntegerSettings<Settings extends Record<string, IntegerSetting>>(
	settings: Settings,
	overrides: IntegerOverrides<Settings>,
): ResolvedIntegers<Settings> {
	const result: IntegerOverrides<Settings> = {};
	for (const key of Object.keys(settings) as Array<keyof Settings>) {
		const setting = settings[key];
		const value = overrides[key] ?? setting.default;
		if (value !== undefined) result[key] = validateIntegerSetting(setting, value);
	}
	return result as ResolvedIntegers<Settings>;
}

function validateIntegerSetting(setting: IntegerSetting, value: number): number {
	if (
		!Number.isSafeInteger(value) ||
		value < (setting.min ?? 1) ||
		value > (setting.max ?? 2_147_483_647)
	) {
		throw invalidSetting(setting);
	}
	return value;
}

function invalidSetting(setting: IntegerSetting): Error {
	return new Error(
		`${setting.variable} must be an integer between ${setting.min ?? 1} and ${setting.max ?? 2_147_483_647}`,
	);
}
