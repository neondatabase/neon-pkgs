import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { type SealedLiveQuery, validateSealedQuery } from "./sealed-query.js";
import type {
	MaterializedLiveQuerySubscription,
	RawLiveQuerySubscription,
	RealtimeClient,
} from "./types.js";

interface TimestampRow {
	id: number;
	created_at: Date;
}

type QueryRow<Query> = Query extends SealedLiveQuery<infer Row> ? Row : never;

/** Representative recursive transformation performed by JSON-aware APIs. */
type JsonTransport<Value> = Value extends string | number | boolean | null
	? Value
	: Value extends Date
		? string
		: Value extends bigint
			? string
			: Value extends readonly unknown[]
				? { [Key in keyof Value]: JsonTransport<Value[Key]> }
				: Value extends object
					? { [Key in keyof Value]: JsonTransport<Value[Key]> }
					: never;

type Payload = JsonTransport<{
	query: SealedLiveQuery<TimestampRow>;
	initialData: readonly TimestampRow[];
}>;

describe("sealed query row types", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("validates the ASCII protected header without TextDecoder", () => {
		vi.stubGlobal("TextDecoder", undefined);

		expect(() => validateSealedQuery(sealedQuery())).not.toThrow();
	});

	it("validates the protected header without atob", () => {
		vi.stubGlobal("atob", undefined);

		expect(() => validateSealedQuery(sealedQuery())).not.toThrow();
	});

	it("rejects non-ASCII protected headers", () => {
		expect(() =>
			validateSealedQuery(sealedQuery({ note: "café" })),
		).toThrow("Invalid sealed live query");
	});

	it("preserves live rows while actual payload rows are serialized", () => {
		expectTypeOf<
			QueryRow<Payload["query"]>
		>().toEqualTypeOf<TimestampRow>();
		expectTypeOf<
			Payload["initialData"][number]["created_at"]
		>().toEqualTypeOf<string>();
	});

	it("preserves object, tuple, unknown, and never row types", () => {
		type Row = {
			created_at: Date | null;
			history: readonly Date[];
			nested: { count: bigint };
		};
		type Tuple = readonly [id: number, created_at: Date];
		expectTypeOf<
			QueryRow<JsonTransport<SealedLiveQuery<Row>>>
		>().toEqualTypeOf<Row>();
		expectTypeOf<
			QueryRow<JsonTransport<SealedLiveQuery<Tuple>>>
		>().toEqualTypeOf<Tuple>();
		expectTypeOf<
			QueryRow<JsonTransport<SealedLiveQuery<unknown>>>
		>().toBeUnknown();
		expectTypeOf<
			QueryRow<JsonTransport<SealedLiveQuery<never>>>
		>().toBeNever();
	});

	it("requires serialized rows to be restored before subscribing", () => {
		// Checked by tsc during build; never subscribe or open a socket here.
		function check(client: RealtimeClient, payload: Payload) {
			const restored = payload.initialData.map((row) => ({
				...row,
				created_at: new Date(row.created_at),
			}));
			const subscription = client.subscribe(payload.query, {
				initialData: restored,
			});
			expectTypeOf(subscription).toEqualTypeOf<
				MaterializedLiveQuerySubscription<TimestampRow>
			>();
			expectTypeOf(
				client.subscribe(payload.query, { materialize: false }),
			).toEqualTypeOf<RawLiveQuerySubscription<TimestampRow>>();
			subscription.renew(payload.query);
			client.subscribe(payload.query, {
				// @ts-expect-error JSON date strings must be restored before seeding.
				initialData: payload.initialData,
			});
		}
		expectTypeOf(check).toBeFunction();
	});
});

function sealedQuery(
	extraHeader: Record<string, unknown> = {},
): SealedLiveQuery<unknown> {
	const header = Buffer.from(
		JSON.stringify({ alg: "dir", enc: "A256GCM", v: 1, ...extraHeader }),
	).toString("base64url");
	return {
		capability: `${header}..iv.ciphertext.tag`,
		queryFingerprint: "0".repeat(64),
		expiresAt: 1,
	};
}
