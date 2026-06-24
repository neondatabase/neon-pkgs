import type { NeonError } from "./errors.js";

/**
 * The uniform result envelope returned by every ergonomic call when `throwOnError` is
 * off (the default). A discriminated union: when `error` is set, `data` is `undefined`,
 * and vice versa.
 */
export type NeonResult<T> =
	| { data: T; error: undefined }
	| { data: undefined; error: NeonError };

/**
 * The return type of a method, conditioned on whether errors are thrown. With
 * `throwOnError`, the method resolves to the bare `T` (and throws on failure); otherwise
 * it resolves to {@link NeonResult}.
 */
export type Outcome<T, Throw extends boolean> = Throw extends true
	? T
	: NeonResult<T>;

export function ok<T>(data: T): NeonResult<T> {
	return { data, error: undefined };
}

export function err<T>(error: NeonError): NeonResult<T> {
	return { data: undefined, error };
}
