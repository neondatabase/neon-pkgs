/**
 * The raw layer's result adapter.
 *
 * The generated `client/sdk.gen.ts` functions return hey-api's `{ data, error, request,
 * response }` envelope and are driven by two orthogonal switches (`throwOnError` and
 * `responseStyle`). {@link wrapRaw} collapses that onto the ergonomic client's contract: a
 * `{ data, error }` result by default (with the typed {@link NeonError} on the error
 * channel), or the bare resource when you pass `throwOnError: true`. `responseStyle` is
 * removed from the public raw surface — `throwOnError` is the only switch and the return
 * type always tracks it.
 *
 * The one difference from the ergonomic `NeonResult` is that the raw result also exposes the
 * underlying `response`/`request`, so power users (and the neonctl CLI) can read HTTP status
 * and headers without dropping to the low-level client.
 */

import type { NeonError } from "./errors.js";
import { NeonAbortError, toNeonError } from "./errors.js";

/**
 * Did the caller's own signal end this call?
 *
 * Read from the signal rather than the error, because the generated client reports
 * authentication, serialization, interceptor, transport and parsing faults through one
 * channel — an error named `AbortError` is not evidence about which occurred. A response
 * having arrived rules cancellation out.
 *
 * This deliberately says nothing about a signal the SDK never saw: the Neon CLI installs
 * its own request timeout inside a custom `fetch` rather than passing `signal`, so its
 * timeouts keep classifying as {@link NeonNetworkError} exactly as before.
 */
function abortedBy(
	signal: AbortSignal | undefined,
	response: Response | undefined,
): boolean {
	return response === undefined && signal?.aborted === true;
}

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
export type RawData<F extends AnyRawFn> =
	SuccessArm<Awaited<ReturnType<F>>> extends { data: infer D } ? D : never;

/** The call options for a wrapped raw function, minus the removed hey-api switches. */
export type RawOptions<F extends AnyRawFn> = Omit<
	NonNullable<Parameters<F>[0]>,
	"throwOnError" | "responseStyle"
>;

/**
 * The non-throwing result of a wrapped raw call: the ergonomic `{ data, error }` union
 * (typed {@link NeonError}), plus the underlying `response`/`request` for HTTP status and
 * headers.
 */
export type RawResult<T> =
	| { data: T; error: undefined; response?: Response; request?: Request }
	| {
			data: undefined;
			error: NeonError;
			response?: Response;
			request?: Request;
	  };

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
	): Promise<RawResult<RawData<F>>>;
	async function call(
		options: RawOptions<F> & { throwOnError?: boolean },
	): Promise<RawData<F> | RawResult<RawData<F>>> {
		const shouldThrow = options.throwOnError === true;
		const raw: RawFieldsResult<RawData<F>> = await fn({
			...options,
			throwOnError: false,
			responseStyle: "fields",
		});
		if (raw.error !== undefined && raw.error !== null) {
			const error = abortedBy(options.signal, raw.response)
				? new NeonAbortError("The request was aborted by its signal.", {
						cause: raw.error,
					})
				: toNeonError(raw.error, raw.response);
			if (shouldThrow) throw error;
			return {
				data: undefined,
				error,
				response: raw.response,
				request: raw.request,
			};
		}
		// On success the payload is present (or `void`/`undefined` for 204 endpoints); it is
		// the declared `RawData<F>` by construction of the generated response types.
		const data = raw.data as RawData<F>;
		if (shouldThrow) return data;
		return {
			data,
			error: undefined,
			response: raw.response,
			request: raw.request,
		};
	}
	return call;
}
