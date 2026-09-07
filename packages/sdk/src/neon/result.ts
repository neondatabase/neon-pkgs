import type { NeonErrorUnion } from "./errors.js";

/**
 * The uniform result envelope returned by every ergonomic call when `throwOnError` is
 * off (the default). A discriminated union: when `error` is set, `data` is `undefined`,
 * and vice versa. `error` is {@link NeonErrorUnion} — discriminate on `error.kind`.
 */
export type NeonResult<T> =
	| { data: T; error: undefined }
	| { data: undefined; error: NeonErrorUnion };

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

export function err<T>(error: NeonErrorUnion): NeonResult<T> {
	return { data: undefined, error };
}

/**
 * Apply the `throwOnError` policy to a result: return the bare value (throwing on error)
 * when `shouldThrow`, otherwise return the {@link NeonResult} envelope.
 */
export function finalize<T>(
	result: NeonResult<T>,
	shouldThrow: boolean,
): T | NeonResult<T> {
	if (!shouldThrow) return result;
	if (result.error) throw result.error;
	return result.data;
}
