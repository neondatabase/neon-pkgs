import { describe, expect, test } from "vitest";
import { parseExportedSchema } from "../schema/parse.js";
import { field, schema, table, v } from "../test-fixtures.js";
import { generateStagingDropSql } from "./staging.js";
import { generateTransformSql } from "./transform.js";

function transform(
	exported: ReturnType<typeof schema>,
	options?: Parameters<typeof generateTransformSql>[1],
) {
	return generateTransformSql(parseExportedSchema(exported), options);
}

describe("generateTransformSql expressions", () => {
	const sql = transform(
		schema([
			table({
				name: "rows",
				fields: {
					title: field(v.string()),
					score: field(v.number()),
					active: field(v.boolean()),
					big: field(v.int64()),
					blob: field(v.bytes()),
					meta: field(v.object({ k: field(v.string()) })),
				},
			}),
		]),
	);

	test.each([
		["id", "md5(doc->>'_id')::uuid"],
		[
			"created_at",
			"to_timestamp((doc->>'_creationTime')::double precision / 1000)",
		],
		["title", "doc->>'title'"],
		["score", "(doc->>'score')::double precision"],
		["active", "(doc->>'active')::boolean"],
		["big", "(doc->>'big')::bigint"],
		["blob", "decode(doc->'blob'->>'$bytes', 'base64')"],
		["meta", "doc->'meta'"],
	])("maps %s via %s", (_column, expr) => {
		expect(sql).toContain(expr);
	});

	test("reads from the staging table", () => {
		expect(sql).toContain("INSERT INTO rows (");
		expect(sql).toContain("FROM _convex_rows;");
	});
});

describe("generateTransformSql id strategy", () => {
	const s = schema([table({ name: "t", fields: { x: field(v.string()) } })]);

	test("uuid strategy hashes _id", () => {
		expect(transform(s)).toContain("md5(doc->>'_id')::uuid");
	});

	test("text strategy reads _id verbatim", () => {
		const sql = transform(s, { idStrategy: "text" });
		expect(sql).toContain("doc->>'_id'");
		expect(sql).not.toContain("md5(");
	});
});

describe("generateTransformSql foreign keys line up", () => {
	// Under the uuid strategy, a `v.id` reference must hash with the SAME
	// md5(...)::uuid expression as the target row's `_id`, so the foreign key
	// resolves with no lookup table.
	const sql = transform(
		schema([
			table({ name: "users", fields: { name: field(v.string()) } }),
			table({
				name: "messages",
				fields: { authorId: field(v.id("users")) },
			}),
		]),
	);

	test("the reference column hashes the ref string the same way _id is hashed", () => {
		expect(sql).toContain("md5(doc->>'_id')::uuid");
		expect(sql).toContain("md5(doc->>'authorId')::uuid");
	});

	test("the snake-cased column name appears in the INSERT target list", () => {
		expect(sql).toContain(
			"INSERT INTO messages (id, created_at, author_id)",
		);
	});
});

describe("generateTransformSql two tables with a cross reference", () => {
	const exported = schema([
		table({
			name: "channels",
			fields: { name: field(v.string()) },
		}),
		table({
			name: "messages",
			fields: {
				channel: field(v.id("channels")),
				body: field(v.string()),
			},
		}),
	]);
	const parsed = parseExportedSchema(exported);

	test("both INSERT...SELECT statements are present", () => {
		const sql = generateTransformSql(parsed);
		expect(sql).toContain("INSERT INTO channels (");
		expect(sql).toContain("FROM _convex_channels;");
		expect(sql).toContain("INSERT INTO messages (");
		expect(sql).toContain("FROM _convex_messages;");
	});

	test("the staging DROP statements are present", () => {
		const drop = generateStagingDropSql(parsed);
		expect(drop).toContain("DROP TABLE _convex_channels;");
		expect(drop).toContain("DROP TABLE _convex_messages;");
	});

	test("a field named `channel` is not renamed to channel_id", () => {
		const sql = generateTransformSql(parsed);
		// The column keeps its Convex name (snake_cased); only the type and FK
		// change. It is read from doc->>'channel', not doc->>'channelId'.
		expect(sql).toContain("md5(doc->>'channel')::uuid");
		expect(sql).toContain(
			"INSERT INTO messages (id, created_at, channel, body)",
		);
	});
});

describe("generateTransformSql search/vector columns", () => {
	test("a generated tsvector column is in neither the INSERT list nor the SELECT", () => {
		const sql = transform(
			schema([
				table({
					name: "messages",
					fields: {
						author: field(v.string()),
						body: field(v.string()),
					},
					searchIndexes: [
						{
							indexDescriptor: "search_body",
							searchField: "body",
							filterFields: [],
						},
					],
				}),
			]),
		);
		// Postgres computes `body_tsv`, so the loader never writes it.
		expect(sql).toContain(
			"INSERT INTO messages (id, created_at, author, body)",
		);
		expect(sql).not.toContain("body_tsv");
		expect(sql).not.toContain("to_tsvector");
	});

	test("a vector column is populated via the jsonb-text cast (not skipped)", () => {
		const sql = transform(
			schema([
				table({
					name: "foods",
					fields: {
						cuisine: field(v.string()),
						embedding: field(v.array(v.number())),
					},
					vectorIndexes: [
						{
							indexDescriptor: "by_embedding",
							vectorField: "embedding",
							dimensions: 1536,
							filterFields: ["cuisine"],
						},
					],
				}),
			]),
		);
		expect(sql).toContain(
			"INSERT INTO foods (id, created_at, cuisine, embedding)",
		);
		expect(sql).toContain("(doc->'embedding')::text::vector");
	});
});
