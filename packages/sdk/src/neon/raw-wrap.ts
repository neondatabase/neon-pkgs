/**
 * The raw layer's result adapter.
 *
 * The generated `client/sdk.gen.ts` functions return hey-api's `{ data, error, request,
 * response }` envelope and are driven by two orthogonal switches (`throwOnError` and
 * `responseStyle`). {@link wrapRaw} collapses that onto the *same* contract the ergonomic
 * client uses: a {@link NeonResult} by default, the bare resource under `throwOnError`, and
 * the typed {@link NeonError} hierarchy on the error channel either way. `responseStyle` is
 * intentionally removed from the public raw surface — `throwOnError` is the only switch, and
 * the return type always tracks it.
 */

import { toNeonError } from "./errors.js";
import { err, type NeonResult, ok } from "./result.js";

/**
 * Structural shape of any generated raw function: generic over `throwOnError`, resolving to
 * hey-api's envelope. The `any`s live only inside this adapter type so the generated
 * functions (each with their own precise option/response types) remain assignable; the
 * public {@link wrapRaw} overloads recover full type safety per function.
 */
// biome-ignore lint/suspicious/noExplicitAny: adapter boundary over generated generic fns
export type AnyRawFn = (options: any) => Promise<any>;

/** hey-api's non-throw "fields" envelope, parameterized by the success payload. */
interface RawFieldsResult<T> {
	data?: T;
	error?: unknown;
	response?: Response;
	request?: Request;
}

/** Extract the success arm of a discriminated fields envelope. */
type SuccessArm<R> = R extends { error: undefined | null } ? R : never;

/**
 * The success payload of a generated raw function — derived from its default (non-throw,
 * fields) return type, so it stays correct as the client is regenerated.
 */
export type RawData<F extends AnyRawFn> = SuccessArm<
	Awaited<ReturnType<F>>
> extends { data: infer D }
	? D
	: never;

/** The call options for a wrapped raw function, minus the removed hey-api switches. */
export type RawOptions<F extends AnyRawFn> = Omit<
	NonNullable<Parameters<F>[0]>,
	"throwOnError" | "responseStyle"
>;

/** Normalize a generated envelope into a {@link NeonResult}. */
function toOutcome<T>(raw: RawFieldsResult<T>): NeonResult<T> {
	if (raw.error !== undefined && raw.error !== null) {
		return err(toNeonError(raw.error, raw.response));
	}
	// On success the payload is present (or `void`/`undefined` for 204 endpoints); it is the
	// declared `T` by construction of the generated function's response types.
	return ok(raw.data as T);
}

/**
 * Wrap a generated raw function so it speaks the ergonomic result contract.
 *
 * @example
 * ```ts
 * import { getProject } from "@neon/sdk/raw";
 *
 * const { data, error } = await getProject({ client, path: { project_id } });
 * // or, throwing:
 * const { project } = await getProject({ client, path: { project_id }, throwOnError: true });
 * ```
 */
export function wrapRaw<F extends AnyRawFn>(fn: F & AnyRawFn) {
	function call(
		options: RawOptions<F> & { throwOnError: true },
	): Promise<RawData<F>>;
	function call(
		options: RawOptions<F> & { throwOnError?: false },
	): Promise<NeonResult<RawData<F>>>;
	async function call(
		options: RawOptions<F> & { throwOnError?: boolean },
	): Promise<RawData<F> | NeonResult<RawData<F>>> {
		const shouldThrow = options.throwOnError === true;
		const raw: RawFieldsResult<RawData<F>> = await fn({
			...options,
			throwOnError: false,
			responseStyle: "fields",
		});
		const outcome = toOutcome(raw);
		if (!shouldThrow) return outcome;
		if (outcome.error) throw outcome.error;
		return outcome.data;
	}
	return call;
}
