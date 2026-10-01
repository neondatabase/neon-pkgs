import {
	createNeonLive,
	pgParam,
	type SealedLiveQuery,
} from "@neon/live/server";
import {
	CamelCasePlugin,
	Kysely,
	type KyselyPlugin,
	PostgresDialect,
	type PostgresPool,
	sql,
} from "kysely";
import { describe, expect, expectTypeOf, it } from "vitest";
import { kyselyAdapter } from "./index.js";

interface Database {
	messages: {
		id: number;
		channel_id: string;
		body: string;
		note: string | null;
		sent_at: Date;
		metadata: { readonly visible: boolean };
		labels: string[];
		payload: Uint8Array;
	};
}

interface CamelCaseDatabase {
	messageTable: {
		messageId: number;
		bodyText: string;
	};
}

const SECRET =
	"neon_live_v1_eyJ2IjoxLCJraWQiOiJjdXJyZW50IiwiaXNzIjoidGVzdCIsImtleSI6IkJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2MifQ";

describe("Kysely query adapter", () => {
	it("seals a concrete select while preserving its inferred row type", async () => {
		const db = createDatabase<Database>();
		const neonLive = createNeonLive({
			secret: SECRET,
			db: "app",
			adapter: kyselyAdapter(),
		});
		const channelId = "general";
		const query = db
			.selectFrom("messages")
			.select(["id", "body", "note"])
			.where("channel_id", "=", channelId);

		const sealedQuery = await neonLive.seal({ query });

		expectTypeOf(sealedQuery).toEqualTypeOf<
			SealedLiveQuery<{
				id: number;
				body: string;
				note: string | null;
			}>
		>();
		expect(JSON.stringify(sealedQuery)).not.toContain(channelId);
		const prepared = kyselyAdapter().prepare(query);
		expect(prepared.sql).toBe(
			'select "id", "body", "note" from "messages" where "channel_id" = $1',
		);
		expect(prepared.parameters).toEqual([{ typeOid: 0, value: channelId }]);
	});

	it("uses node-postgres-compatible encodings for ordinary Kysely values", () => {
		const db = createDatabase<Database>();
		const sentAt = new Date(2026, 8, 11, 12, 34, 56, 789);
		const query = db
			.selectFrom("messages")
			.select("id")
			.where("sent_at", ">=", sentAt)
			.where("metadata", "@>", { visible: true })
			.where("labels", "&&", sql.val(["important", "unread"]))
			.where("payload", "=", Uint8Array.of(0, 1, 127, 255));

		const prepared = kyselyAdapter().prepare(query);

		expect(prepared.parameters).toEqual([
			{
				typeOid: 0,
				value: expect.stringMatching(
					/^2026-09-11T12:34:56\.789[+-]\d{2}:\d{2}$/,
				),
			},
			{ typeOid: 0, value: '{"visible":true}' },
			{ typeOid: 0, value: '{"important","unread"}' },
			{ typeOid: 0, value: "\\x00017fff" },
		]);
	});

	it("accepts pgParam as an explicit encoding escape hatch", () => {
		const db = createDatabase<Database>();
		const query = db
			.selectFrom("messages")
			.select("id")
			.where(
				sql<boolean>`channel_id = ${pgParam.text("uuid", "123e4567-e89b-12d3-a456-426614174000")}`,
			);

		expect(kyselyAdapter().prepare(query).parameters).toEqual([
			{
				typeOid: 2950,
				value: "123e4567-e89b-12d3-a456-426614174000",
			},
		]);
	});

	it("compiles the transformed operation tree as PostgreSQL", () => {
		const db = createDatabase<CamelCaseDatabase>([new CamelCasePlugin()]);
		const query = db
			.selectFrom("messageTable")
			.select(["messageId", "bodyText"])
			.where("messageId", "=", 7);

		expect(kyselyAdapter().prepare(query)).toMatchObject({
			sql: 'select "message_id", "body_text" from "message_table" where "message_id" = $1',
			parameters: [{ typeOid: 0, value: "7" }],
		});
	});

	it("preserves explicit PostgreSQL result aliases", () => {
		const db = createDatabase<Database>();
		const query = db
			.selectFrom("messages")
			.select(["id as messageId", "body"]);

		expect(kyselyAdapter().prepare(query).sql).toBe(
			'select "id" as "messageId", "body" from "messages"',
		);
	});

	it("rejects non-select operation nodes at runtime", () => {
		const db = createDatabase<Database>();
		const update = db
			.updateTable("messages")
			.set({ body: "changed" })
			.where("id", "=", 1);

		expect(() => kyselyAdapter().prepare(update as never)).toThrow(
			"requires a concrete select builder",
		);
	});
});

function createDatabase<DB>(plugins: readonly KyselyPlugin[] = []) {
	const pool: PostgresPool = {
		async connect() {
			throw new Error("Tests must not open a database connection");
		},
		async end() {},
	};
	return new Kysely<DB>({
		dialect: new PostgresDialect({ pool }),
		plugins: [...plugins],
	});
}
