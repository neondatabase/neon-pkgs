import {
	createNeonClient,
	type NeonClient,
	type NeonConfig,
	type Paginated,
} from "@neon/sdk";
import { Effect, Option, Stream } from "effect";
import { type NeonEffectError, toNeonEffectError } from "./errors.js";

/** `createNeonClient` options. `throwOnError` is fixed: failures go to the error channel. */
export type NeonEffectConfig = Omit<NeonConfig<true>, "throwOnError">;

type SdkClient = Omit<NeonClient<true>, "client">;

/** Effect interruption replaces `signal`; the error channel replaces `throwOnError`. */
type EffectOptions<O> = Omit<O, "signal" | "throwOnError">;

/**
 * SDK methods declare each call shape twice, `(…params)` then `(…params, opts)`. Most
 * have one shape; `triggers.create` and `triggers.update` have three, one per trigger
 * type. Matching six signatures reads both layouts: with a single shape, TypeScript
 * fills all three slots with it.
 */
type Overloads<F> = F extends {
	(...args: infer P1): infer R1;
	(...args: infer P2): infer R2;
	(...args: infer P3): infer R3;
	(...args: infer _O1): unknown;
	(...args: infer _O2): unknown;
	(...args: infer WithOptions): unknown;
}
	? WithOptions extends [...unknown[], infer Options]
		? {
				shapes: [P1, R1] | [P2, R2] | [P3, R3];
				signatures: EffectSignature<P1, R1, Options> &
					EffectSignature<P2, R2, Options> &
					EffectSignature<P3, R3, Options>;
				p1: P1;
			}
		: never
	: never;

type EffectSignature<Params, Result, Options> = Params extends unknown[]
	? Result extends Paginated<infer Item, true>
		? (
				...args: [...Params, options?: EffectOptions<Options>]
			) => Stream.Stream<Item, NeonEffectError>
		: Result extends Promise<infer Value>
			? (
					...args: [...Params, options?: EffectOptions<Options>]
				) => Effect.Effect<Value, NeonEffectError>
			: never
	: never;

type EffectMethod<F> =
	Overloads<F> extends { signatures: infer Signatures } ? Signatures : never;

type EffectNamespace<N> = {
	readonly [K in keyof N]: N[K] extends (...args: never[]) => unknown
		? EffectMethod<N[K]>
		: EffectNamespace<N[K]>;
};

/**
 * The `@neon/sdk` ergonomic client with every promise as an `Effect` and every
 * paginated list as a `Stream`. Method names and parameters are the SDK's.
 */
export interface NeonEffectClient extends EffectNamespace<SdkClient> {}

type ShapeKind<Shape> = Shape extends [infer Params, infer Result]
	?
			| (Result extends Paginated<unknown, true> ? "paginated" : never)
			| (Params extends [] | [unknown] | [unknown?]
					? never
					: "unsupported")
			| (Result extends Paginated<unknown, true> | Promise<unknown>
					? never
					: "unsupported")
	: "unsupported";

type MethodKind<F> =
	Overloads<F> extends {
		shapes: infer Shapes;
		p1: infer P1;
	}
		? ShapeKind<Shapes> | (P1 extends [] ? "optionsOnly" : never)
		: "unsupported";

type Paths<N, Kind, Prefix extends string = ""> = {
	[K in keyof N & string]: N[K] extends (...args: never[]) => unknown
		? Kind extends MethodKind<N[K]>
			? `${Prefix}${K}`
			: never
		: Paths<N[K], Kind, `${Prefix}${K}.`>;
}[keyof N & string];

type PaginatedPath = Paths<SdkClient, "paginated">;
type OptionsOnlyPath = Paths<SdkClient, "optionsOnly">;
/**
 * The adapter places options at index 0 or 1, so every method must take at most one
 * parameter before them. A future SDK method that doesn't fails this check.
 */
type NoneUnsupported<Path extends never> = Path;
export type _EveryMethodSupported = NoneUnsupported<
	Paths<SdkClient, "unsupported">
>;

// Which methods paginate, and which take options as their only argument, cannot be
// read off a function at runtime without calling it. Both records are keyed by
// unions derived from the SDK's types, so an SDK change that adds, removes, or
// reshapes one of these methods fails to compile here.
const PAGINATED = {
	"projects.list": true,
	"projects.members.list": true,
	"branches.list": true,
	"operations.list": true,
	"functions.list": true,
	"functions.customDomains.list": true,
	"logs.query": true,
	"consumption.perProject": true,
	"consumption.perProjectV2": true,
	"consumption.perBranchV2": true,
} as const satisfies Record<PaginatedPath, true>;

const OPTIONS_ONLY = {
	"apiKeys.list": true,
	"regions.list": true,
	"user.me": true,
	"user.organizations": true,
} as const satisfies Record<OptionsOnlyPath, true>;

const paginated: ReadonlySet<string> = new Set(Object.keys(PAGINATED));
const optionsOnly: ReadonlySet<string> = new Set(Object.keys(OPTIONS_ONLY));

function expectPromise(value: unknown, path: string): Promise<unknown> {
	if (value instanceof Promise) return value;
	throw new TypeError(`@neon/effect: ${path} did not return a Promise.`);
}

async function fetchPage(
	list: unknown,
	cursor: string | undefined,
	path: string,
): Promise<{ items: readonly unknown[]; cursor: string | undefined }> {
	if (
		typeof list === "object" &&
		list !== null &&
		"page" in list &&
		isMethod(list.page)
	) {
		const page: unknown = await Reflect.apply(list.page, list, [cursor]);
		if (
			typeof page === "object" &&
			page !== null &&
			"items" in page &&
			Array.isArray(page.items)
		) {
			const next = "cursor" in page ? page.cursor : undefined;
			return {
				items: page.items,
				cursor: typeof next === "string" ? next : undefined,
			};
		}
	}
	throw new TypeError(
		`@neon/effect: ${path} did not return a paginated list.`,
	);
}

type Method = (...args: never[]) => unknown;

const isMethod = (value: unknown): value is Method =>
	typeof value === "function";

function adaptMethod(namespace: object, method: Method, path: string) {
	const optionsIndex = optionsOnly.has(path) ? 0 : 1;

	return (...input: unknown[]) => {
		const params = input.slice(0, optionsIndex);
		const options = input[optionsIndex];
		const call = (signal: AbortSignal): unknown =>
			Reflect.apply(method, namespace, [
				...params,
				{
					...(typeof options === "object" ? options : {}),
					signal,
					throwOnError: true,
				},
			]);

		if (!paginated.has(path)) {
			return Effect.tryPromise({
				try: (signal) => expectPromise(call(signal), path),
				catch: toNeonEffectError,
			});
		}

		// A fresh SDK list per page, so each page request carries the signal of the
		// Effect that fetches it.
		return Stream.paginate<string | undefined, unknown, NeonEffectError>(
			undefined,
			(cursor) =>
				Effect.tryPromise({
					try: async (signal) => {
						const page = await fetchPage(
							call(signal),
							cursor,
							path,
						);
						const next =
							page.cursor && page.items.length > 0
								? Option.some(page.cursor)
								: Option.none();
						return [page.items, next] as const;
					},
					catch: toNeonEffectError,
				}),
		);
	};
}

function adaptNamespace(namespace: object, prefix: string): object {
	const adapted: Record<string, unknown> = {};
	for (const key of Object.getOwnPropertyNames(namespace)) {
		const value: unknown = Reflect.get(namespace, key);
		if (typeof value === "object" && value !== null) {
			adapted[key] = adaptNamespace(value, `${prefix}${key}.`);
		}
	}
	let proto: unknown = Object.getPrototypeOf(namespace);
	while (proto !== null && proto !== Object.prototype) {
		for (const key of Object.getOwnPropertyNames(proto)) {
			const value: unknown = Reflect.get(namespace, key);
			if (key === "constructor" || !isMethod(value)) continue;
			adapted[key] ??= adaptMethod(namespace, value, `${prefix}${key}`);
		}
		proto = Object.getPrototypeOf(proto);
	}
	return Object.freeze(adapted);
}

function fromSdkClient(sdk: NeonClient<true>): NeonEffectClient {
	const { client: _raw, ...namespaces } = sdk;
	// `adaptNamespace` mirrors the SDK client's shape, which is what the cast asserts.
	return adaptNamespace(namespaces, "") as NeonEffectClient;
}

/**
 * Create a client. Makes no network request.
 *
 * @throws {NeonClientError} when the SDK rejects the configuration (empty `apiKey`,
 * invalid `retries` or `requestTimeoutMs`).
 */
export function make(config: NeonEffectConfig): NeonEffectClient {
	let sdk: NeonClient<true>;
	try {
		sdk = createNeonClient({ ...config, throwOnError: true });
	} catch (error) {
		throw toNeonEffectError(error);
	}
	return fromSdkClient(sdk);
}
