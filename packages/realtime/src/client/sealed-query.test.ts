import { type inferRouterOutputs, initTRPC } from "@trpc/server";
import { Hono } from "hono";
import { hc, type InferResponseType } from "hono/client";
import type { Jsonify } from "type-fest";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createRealtime, rawSql } from "../server/realtime.js";
import type { SealedLiveQuery } from "./sealed-query.js";
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

const server = createRealtime({
	secret: "nrt_live_1BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
	db: "app",
});
const sql = rawSql<TimestampRow>("select id, created_at from items");
const initialData: TimestampRow[] = [
	{ id: 1, created_at: new Date("2026-10-15T10:00:00.000Z") },
];
async function loadRows() {
	return { query: await server.seal({ query: sql }), initialData };
}

const app = new Hono().get("/rows", async (context) =>
	context.json(await loadRows()),
);
const rpc = hc<typeof app>("https://unused.invalid");
type HonoPayload = InferResponseType<typeof rpc.rows.$get>;

describe("sealed query row types", () => {
	it("preserves Hono RPC query rows while serializing actual preload rows", async () => {
		expectTypeOf<
			QueryRow<HonoPayload["query"]>
		>().toEqualTypeOf<TimestampRow>();
		expectTypeOf<
			HonoPayload["initialData"][number]["created_at"]
		>().toEqualTypeOf<string>();

		const response = await app.request("/rows");
		const payload = await response.json();
		expect(payload.initialData).toEqual([
			{ id: 1, created_at: "2026-10-15T10:00:00.000Z" },
		]);
		expect(Object.keys(payload.query).sort()).toEqual([
			"capability",
			"expiresAt",
			"queryFingerprint",
		]);
	});

	it("preserves rows through tRPC's default JSON output typing", () => {
		const trpc = initTRPC.create();
		const router = trpc.router({ rows: trpc.procedure.query(loadRows) });
		type Payload = inferRouterOutputs<typeof router>["rows"];
		expectTypeOf<
			QueryRow<Payload["query"]>
		>().toEqualTypeOf<TimestampRow>();
		expectTypeOf<
			Payload["initialData"][number]["created_at"]
		>().toEqualTypeOf<string>();
	});

	it("preserves the complete phantom through general-purpose JSON typing", () => {
		type Row = {
			created_at: Date | null;
			history: readonly Date[];
			nested: { count: bigint };
		};
		type Tuple = readonly [id: number, created_at: Date];
		expectTypeOf<
			QueryRow<Jsonify<SealedLiveQuery<Row>>>
		>().toEqualTypeOf<Row>();
		expectTypeOf<
			QueryRow<Jsonify<SealedLiveQuery<Tuple>>>
		>().toEqualTypeOf<Tuple>();
		expectTypeOf<
			QueryRow<Jsonify<SealedLiveQuery<unknown>>>
		>().toBeUnknown();
		expectTypeOf<QueryRow<Jsonify<SealedLiveQuery<never>>>>().toBeNever();
	});

	it("infers decoded subscription rows from Hono query responses", () => {
		// Checked by tsc during build; never subscribe or open a socket here.
		function check(client: RealtimeClient, payload: HonoPayload) {
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
