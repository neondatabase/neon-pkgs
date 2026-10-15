// @vitest-environment jsdom

import {
	createRealtimeClient,
	type SealedLiveQuery,
} from "@neon/realtime/client";
import { Hono } from "hono";
import { hc, type InferResponseType } from "hono/client";
import { renderToString } from "react-dom/server";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	RealtimeProvider,
	type UseLiveQueryResult,
	useLiveQuery,
} from "./index.js";

interface TimestampRow {
	id: number;
	created_at: Date;
}

const query: SealedLiveQuery<TimestampRow> = {
	capability: "unused-during-server-rendering",
	queryFingerprint: "a".repeat(64),
	expiresAt: 2_000_000_000_000,
};
const app = new Hono().get("/rows", (context) =>
	context.json({
		query,
		initialData: [
			{ id: 1, created_at: new Date("2026-10-15T10:00:00.000Z") },
		],
	}),
);
const rpc = hc<typeof app>("https://unused.invalid", {
	fetch: (input: RequestInfo | URL, init?: RequestInit) =>
		app.request(new Request(input, init)),
});
type Payload = InferResponseType<typeof rpc.rows.$get>;

describe("serialized initial data", () => {
	it("preserves decoded rows through Hono RPC typing", () => {
		// The package build type-checks this custom hook without rendering it.
		function useTypedRows(payload: Payload) {
			const restored = payload.initialData.map((row) => ({
				...row,
				created_at: new Date(row.created_at),
			}));
			const result = useLiveQuery(payload.query, {
				initialData: restored,
				refreshQuery: async () => payload.query,
			});
			expectTypeOf(result).toEqualTypeOf<
				UseLiveQueryResult<TimestampRow>
			>();
			useLiveQuery(payload.query, {
				// @ts-expect-error JSON date strings are not decoded Date values.
				initialData: payload.initialData,
			});
			return result;
		}
		expectTypeOf(useTypedRows).returns.toEqualTypeOf<
			UseLiveQueryResult<TimestampRow>
		>();
	});

	it("renders application-decoded initial dates immediately during SSR", async () => {
		const payload = await (await rpc.rows.$get()).json();
		expectTypeOf(payload.initialData[0].created_at).toEqualTypeOf<string>();
		const initialData = payload.initialData.map((row) => ({
			...row,
			created_at: new Date(row.created_at),
		}));
		const client = createRealtimeClient({ url: "ws://unused.invalid" });
		function Timestamps() {
			const { data } = useLiveQuery(payload.query, { initialData });
			expectTypeOf(data).toEqualTypeOf<
				readonly TimestampRow[] | undefined
			>();
			return <span>{data?.[0]?.created_at.toISOString()}</span>;
		}
		try {
			expect(
				renderToString(
					<RealtimeProvider client={client}>
						<Timestamps />
					</RealtimeProvider>,
				),
			).toBe("<span>2026-10-15T10:00:00.000Z</span>");
		} finally {
			client.close();
		}
	});
});
