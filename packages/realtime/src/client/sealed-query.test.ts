import { readFileSync } from "node:fs";

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

const envelopeFixtures = JSON.parse(
	readFileSync(
		new URL(
			"../../schema/realtime-envelope-v3.fixtures.json",
			import.meta.url,
		),
		"utf8",
	),
) as {
	readonly valid: readonly {
		readonly name: string;
		readonly envelope: string;
	}[];
	readonly invalid: readonly {
		readonly name: string;
		readonly envelope: string;
	}[];
};
const V3_HEADER = Buffer.from(
	'{"alg":"HPKE-P256-SHA256-A256GCM","kid":"V0jKYYUsyVy0kRrL17dVJA","v":3}',
).toString("base64url");

function withCapability(capability: string): SealedLiveQuery<unknown> {
	return { capability, queryFingerprint: "0".repeat(64), expiresAt: 1 };
}

describe("sealed query envelope check", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each(
		envelopeFixtures.valid.map((fixture) => [
			fixture.name,
			fixture.envelope,
		]),
	)("accepts the v3 %s envelope", (_, envelope) => {
		expect(() =>
			validateSealedQuery(withCapability(envelope)),
		).not.toThrow();
	});

	it("accepts a v3 envelope without TextDecoder or atob", () => {
		vi.stubGlobal("TextDecoder", undefined);
		vi.stubGlobal("atob", undefined);
		expect(() =>
			validateSealedQuery(
				withCapability(`${V3_HEADER}.enc..ciphertext.`),
			),
		).not.toThrow();
	});

	it.each([
		"dir_alg_v3",
		"hpke_alg_v2",
		"extra_header_key",
		"non_empty_segment_3",
		"non_empty_segment_5",
		"four_segments",
		"six_segments",
	])("rejects the %s fixture", (name) => {
		const fixture = envelopeFixtures.invalid.find(
			(entry) => entry.name === name,
		);
		expect(() =>
			validateSealedQuery(withCapability(fixture?.envelope ?? "")),
		).toThrow("Invalid sealed live query");
	});

	it.each([
		["an empty enc segment", `${V3_HEADER}...ciphertext.`],
		["an empty ciphertext", `${V3_HEADER}.enc...`],
		[
			"a header without kid",
			`${Buffer.from('{"alg":"HPKE-P256-SHA256-A256GCM","v":3}').toString("base64url")}.enc..ciphertext.`,
		],
		[
			"an empty kid",
			`${Buffer.from('{"alg":"HPKE-P256-SHA256-A256GCM","kid":"","v":3}').toString("base64url")}.enc..ciphertext.`,
		],
		[
			"an unknown alg",
			`${Buffer.from('{"alg":"HPKE-X25519","kid":"k","v":3}').toString("base64url")}.enc..ciphertext.`,
		],
		[
			"a v1/v2 header in the v3 layout",
			`${sealedQuery().capability.split(".")[0]}.enc..ciphertext.`,
		],
	])("rejects %s", (_, capability) => {
		expect(() => validateSealedQuery(withCapability(capability))).toThrow(
			"Invalid sealed live query",
		);
	});
});

describe("sealed query row types", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each([
		1, 2,
	])("validates capability v%s without TextDecoder", (version) => {
		vi.stubGlobal("TextDecoder", undefined);

		expect(() =>
			validateSealedQuery(sealedQuery({}, version)),
		).not.toThrow();
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
	version = 1,
): SealedLiveQuery<unknown> {
	const header = Buffer.from(
		JSON.stringify({
			alg: "dir",
			enc: "A256GCM",
			v: version,
			...extraHeader,
		}),
	).toString("base64url");
	return {
		capability: `${header}..iv.ciphertext.tag`,
		queryFingerprint: "0".repeat(64),
		expiresAt: 1,
	};
}
