/**
 * Every field optional at every depth, but no field the type lacks. A provider fixture written as
 * `{ ... } satisfies DeepPartial<Stripe.Subscription>` may leave out what a test does not need,
 * and fails to compile if it carries a field the pinned API version does not have.
 *
 * Strings stay strings, since Stripe widens its enums with a branded string the compiler treats
 * as an object, and records such as metadata keep their value type.
 */
export type DeepPartial<T> = T extends string | number | boolean | bigint | null | undefined
	? T
	: T extends object
		? string extends keyof T
			? { [K in keyof T]: DeepPartial<T[K]> }
			: { [K in keyof T]?: DeepPartial<T[K]> }
		: T;
