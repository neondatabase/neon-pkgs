import { describe, expect, test } from "vitest";
import { field, schema, table, v } from "../test-fixtures.js";
import { generateDdl, generateIndexDdl } from "./generate-ddl.js";
import { parseExportedSchema } from "./parse.js";

function ddl(
	exported: ReturnType<typeof schema>,
	options?: Parameters<typeof generateDdl>[1],
) {
	return generateDdl(parseExportedSchema(exported), options);
}

function indexDdl(
	exported: ReturnType<typeof schema>,
	options?: Parameters<typeof generateIndexDdl>[1],
) {
	return generateIndexDdl(parseExportedSchema(exported), options);
}

/** A table with one text search index on `body`, no filter fields. */
function searchSchema() {
	return schema([
		table({
			name: "messages",
			fields: { author: field(v.string()), body: field(v.string()) },
			searchIndexes: [
				{
					indexDescriptor: "search_body",
					searchField: "body",
					filterFields: [],
				},
			],
		}),
	]);
}

/** A table with one vector index on `embedding` (1536-d), filtering `cuisine`. */
function vectorSchema() {
	return schema([
		table({
			name: "foods",
			fields: {
				description: field(v.string()),
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
	]);
}

describe("generateDdl column types", () => {
	const { sql } = ddl(
		schema([
			table({
				name: "everything",
				fields: {
					title: field(v.string()),
					score: field(v.number()),
					active: field(v.boolean()),
					big: field(v.int64()),
					blob: field(v.bytes()),
					meta: field(v.object({ k: field(v.string()) })),
					tags: field(v.array(v.string())),
					bag: field(v.record()),
					whatever: field(v.any()),
					nothing: field(v.null()),
				},
			}),
		]),
	);

	test.each([
		["title text NOT NULL"],
		["score double precision NOT NULL"],
		["active boolean NOT NULL"],
		["big bigint NOT NULL"],
		["blob bytea NOT NULL"],
		["meta jsonb NOT NULL"],
		["tags jsonb NOT NULL"],
		["bag jsonb NOT NULL"],
		["whatever jsonb NOT NULL"],
		["nothing jsonb NOT NULL"],
	])("emits `%s`", (line) => {
		expect(sql).toContain(line);
	});
});

describe("generateDdl id strategies", () => {
	const s = schema([table({ name: "t", fields: { x: field(v.string()) } })]);

	test("uuid strategy (default): uuid primary key", () => {
		expect(ddl(s).sql).toContain("id uuid PRIMARY KEY");
	});

	test("text strategy: text primary key", () => {
		expect(ddl(s, { idStrategy: "text" }).sql).toContain(
			"id text PRIMARY KEY",
		);
	});
});

describe("generateDdl synthesized columns", () => {
	const { sql } = ddl(
		schema([table({ name: "t", fields: { x: field(v.string()) } })]),
	);

	test("creation time maps to created_at timestamptz NOT NULL", () => {
		expect(sql).toContain("created_at timestamptz NOT NULL");
	});

	test("id comes before created_at before user columns", () => {
		expect(sql.indexOf("id uuid")).toBeLessThan(sql.indexOf("created_at"));
		expect(sql.indexOf("created_at")).toBeLessThan(sql.indexOf("x text"));
	});
});

describe("generateDdl optionality", () => {
	const { sql } = ddl(
		schema([
			table({
				name: "users",
				fields: {
					name: field(v.string()),
					bio: field(v.string(), true),
				},
			}),
		]),
	);

	test("required fields are NOT NULL", () => {
		expect(sql).toContain("name text NOT NULL");
	});

	test("optional fields are nullable (no NOT NULL)", () => {
		expect(sql).toContain("bio text");
		expect(sql).not.toContain("bio text NOT NULL");
	});
});

describe("generateDdl unions and literals", () => {
	test("string-literal union -> text + CHECK IN by default", () => {
		const { sql } = ddl(
			schema([
				table({
					name: "posts",
					fields: {
						status: field(
							v.union(v.literal("draft"), v.literal("published")),
						),
					},
				}),
			]),
		);
		expect(sql).toContain("status text NOT NULL");
		expect(sql).toContain("CHECK (status IN ('draft', 'published'))");
	});

	test("checkConstraints:false drops the CHECK", () => {
		const { sql } = ddl(
			schema([
				table({
					name: "posts",
					fields: {
						status: field(
							v.union(v.literal("draft"), v.literal("published")),
						),
					},
				}),
			]),
			{ checkConstraints: false },
		);
		expect(sql).toContain("status text NOT NULL");
		expect(sql).not.toContain("CHECK");
	});

	test("union-with-null is nullable and maps on the remaining member", () => {
		const { sql } = ddl(
			schema([
				table({
					name: "t",
					fields: { nickname: field(v.union(v.null(), v.string())) },
				}),
			]),
		);
		expect(sql).toContain("nickname text");
		expect(sql).not.toContain("nickname text NOT NULL");
	});

	test("mixed union -> jsonb", () => {
		const { sql } = ddl(
			schema([
				table({
					name: "t",
					fields: { x: field(v.union(v.literal("a"), v.literal(1))) },
				}),
			]),
		);
		expect(sql).toContain("x jsonb NOT NULL");
	});

	test("lone literal maps to its scalar type", () => {
		const { sql } = ddl(
			schema([
				table({
					name: "t",
					fields: { kind: field(v.literal("only")) },
				}),
			]),
		);
		expect(sql).toContain("kind text NOT NULL");
	});
});

describe("generateDdl foreign keys", () => {
	test("emits a deferrable foreign key via ALTER when the target table is in the schema", () => {
		const { sql, warnings } = ddl(
			schema([
				table({ name: "users", fields: { name: field(v.string()) } }),
				table({
					name: "messages",
					fields: { authorId: field(v.id("users")) },
				}),
			]),
		);
		expect(sql).toContain("author_id uuid NOT NULL");
		expect(sql).toContain(
			"ALTER TABLE messages ADD CONSTRAINT messages_author_id_fkey FOREIGN KEY (author_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;",
		);
		expect(warnings).toEqual([]);
	});

	test("a foreign key to a table declared later in the schema still applies (ALTER after all CREATEs)", () => {
		const { sql } = ddl(
			schema([
				// `parent` references `child`, which is defined afterwards.
				table({
					name: "parent",
					fields: { childId: field(v.id("child")) },
				}),
				table({ name: "child", fields: { label: field(v.string()) } }),
			]),
		);
		// Both tables are created before any foreign key is added.
		expect(sql.indexOf("CREATE TABLE child")).toBeLessThan(
			sql.indexOf("ALTER TABLE parent ADD CONSTRAINT"),
		);
	});

	test("omits REFERENCES and warns when the target is outside the schema", () => {
		const { sql, warnings } = ddl(
			schema([
				table({
					name: "files",
					fields: { storageId: field(v.id("_storage")) },
				}),
			]),
		);
		expect(sql).toContain("storage_id uuid NOT NULL");
		expect(sql).not.toContain("REFERENCES");
		expect(warnings.some((w) => w.includes("_storage"))).toBe(true);
	});

	test("optional foreign key is nullable", () => {
		const { sql } = ddl(
			schema([
				table({ name: "users", fields: { name: field(v.string()) } }),
				table({
					name: "messages",
					fields: { authorId: field(v.id("users"), true) },
				}),
			]),
		);
		expect(sql).toContain("author_id uuid");
		expect(sql).not.toContain("author_id uuid NOT NULL");
		expect(sql).toContain(
			"ALTER TABLE messages ADD CONSTRAINT messages_author_id_fkey FOREIGN KEY (author_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;",
		);
	});
});

describe("generateDdl indexes", () => {
	test("single and multi-column indexes with snake-cased columns", () => {
		const { sql } = ddl(
			schema([
				table({
					name: "messages",
					fields: {
						authorId: field(v.id("users")),
						channelId: field(v.string()),
					},
					indexes: [
						{ indexDescriptor: "by_author", fields: ["authorId"] },
						{
							indexDescriptor: "by_author_and_channel",
							fields: ["authorId", "channelId"],
						},
					],
				}),
				table({ name: "users", fields: { name: field(v.string()) } }),
			]),
		);
		expect(sql).toContain(
			"CREATE INDEX messages_by_author ON messages (author_id);",
		);
		expect(sql).toContain(
			"CREATE INDEX messages_by_author_and_channel ON messages (author_id, channel_id);",
		);
	});

	test("nested-path index fields are skipped with a warning", () => {
		const { sql, warnings } = ddl(
			schema([
				table({
					name: "events",
					fields: {
						payload: field(v.object({ kind: field(v.string()) })),
					},
					indexes: [
						{
							indexDescriptor: "by_kind",
							fields: ["payload.kind"],
						},
					],
				}),
			]),
		);
		expect(sql).not.toContain("CREATE INDEX events_by_kind");
		expect(warnings.some((w) => w.includes("payload.kind"))).toBe(true);
	});
});

describe("generateDdl naming", () => {
	const s = schema([
		table({
			name: "userProfiles",
			fields: { displayName: field(v.string()) },
		}),
	]);

	test("snakeCase (default) converts table and column names", () => {
		const { sql } = ddl(s);
		expect(sql).toContain("CREATE TABLE user_profiles (");
		expect(sql).toContain("display_name text NOT NULL");
	});

	test("snakeCase:false keeps names verbatim and quotes them", () => {
		const { sql } = ddl(s, { snakeCase: false });
		expect(sql).toContain('CREATE TABLE "userProfiles" (');
		expect(sql).toContain('"displayName" text NOT NULL');
	});
});

describe("generateDdl schemaless fallback", () => {
	test("falls back to id, created_at, and a doc jsonb column", () => {
		const { sql, warnings } = ddl(
			schema([table({ name: "freeform", documentType: v.any() })]),
		);
		expect(sql).toContain("CREATE TABLE freeform (");
		expect(sql).toContain("doc jsonb NOT NULL");
		expect(
			warnings.some(
				(w) => w.includes("schemaless") || w.includes("no declared"),
			),
		).toBe(true);
	});

	test("an index on a schemaless table's declared field is skipped with a warning", () => {
		const { sql, warnings } = ddl(
			schema([
				table({
					name: "freeform",
					documentType: v.any(),
					indexes: [{ indexDescriptor: "by_bool", fields: ["bool"] }],
				}),
			]),
		);
		expect(sql).not.toContain("freeform_by_bool");
		expect(
			warnings.some(
				(w) =>
					w.includes("by_bool") && w.includes("not a materialized"),
			),
		).toBe(true);
	});
});

describe("generateDdl column name collisions", () => {
	test("a user field named `id` is renamed so it does not clash with the primary key", () => {
		const { sql, warnings } = ddl(
			schema([
				table({ name: "empty", fields: {} }),
				table({
					name: "primitiveTypes",
					fields: { id: field(v.id("empty")) },
				}),
			]),
		);
		// The synthesized primary key keeps `id`; the user field is suffixed.
		expect(sql).toContain("id uuid PRIMARY KEY");
		expect(sql).toContain("id_1 uuid NOT NULL");
		expect(sql).toContain(
			"ALTER TABLE primitive_types ADD CONSTRAINT primitive_types_id_1_fkey FOREIGN KEY (id_1) REFERENCES empty (id) DEFERRABLE INITIALLY DEFERRED;",
		);
		expect(warnings.some((w) => w.includes("renamed"))).toBe(true);
	});

	test("a reserved-keyword column is emitted quoted", () => {
		const { sql } = ddl(
			schema([
				table({
					name: "presence",
					fields: { user: field(v.string()) },
				}),
			]),
		);
		expect(sql).toContain('"user" text NOT NULL');
	});
});

describe("Lakebase extensions", () => {
	test("a vector index pulls in lakebase_vector with CASCADE", () => {
		const { sql } = ddl(vectorSchema());
		expect(sql).toContain(
			"CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE;",
		);
		// pgvector comes via CASCADE; only the text extension is absent here.
		expect(sql).not.toContain("lakebase_text");
	});

	test("a search index pulls in lakebase_text, no CASCADE", () => {
		const { sql } = ddl(searchSchema());
		expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS lakebase_text;");
		expect(sql).not.toContain("lakebase_text CASCADE");
		expect(sql).not.toContain("lakebase_vector");
	});

	test("the extension line precedes the first CREATE TABLE", () => {
		const { sql } = ddl(vectorSchema());
		expect(sql.indexOf("CREATE EXTENSION")).toBeLessThan(
			sql.indexOf("CREATE TABLE"),
		);
	});

	test("a schema with neither emits no extension lines (byte-identical DDL)", () => {
		const plain = schema([
			table({ name: "t", fields: { x: field(v.string()) } }),
		]);
		const withHelper = generateDdl(parseExportedSchema(plain));
		const direct = generateDdl(parseExportedSchema(plain));
		expect(withHelper.sql).not.toContain("CREATE EXTENSION");
		// The exact prior shape: starts with CREATE TABLE, no leading blank line.
		expect(withHelper.sql.startsWith("CREATE TABLE t (")).toBe(true);
		expect(direct.sql).toBe(withHelper.sql);
	});
});

describe("generateDdl vector column", () => {
	test("retypes the embedding column to vector(<dimensions>) NOT NULL", () => {
		const { sql } = ddl(vectorSchema());
		expect(sql).toContain("embedding vector(1536) NOT NULL");
		// It is no longer a jsonb column.
		expect(sql).not.toContain("embedding jsonb");
	});

	test("an optional embedding is a nullable vector column", () => {
		const { sql } = ddl(
			schema([
				table({
					name: "foods",
					fields: {
						embedding: field(v.array(v.number()), true),
					},
					vectorIndexes: [
						{
							indexDescriptor: "by_embedding",
							vectorField: "embedding",
							dimensions: 8,
							filterFields: [],
						},
					],
				}),
			]),
		);
		expect(sql).toContain("embedding vector(8)");
		expect(sql).not.toContain("embedding vector(8) NOT NULL");
	});

	test("warns and leaves the schema untouched when the vector field is absent", () => {
		const { sql, warnings } = ddl(
			schema([
				table({
					name: "foods",
					fields: { description: field(v.string()) },
					vectorIndexes: [
						{
							indexDescriptor: "by_embedding",
							vectorField: "embedding",
							dimensions: 8,
							filterFields: [],
						},
					],
				}),
			]),
		);
		expect(sql).not.toContain("vector(");
		expect(sql).not.toContain("lakebase_vector");
		expect(
			warnings.some(
				(w) =>
					w.includes("by_embedding") &&
					w.includes("not a materialized column"),
			),
		).toBe(true);
	});
});

describe("generateDdl generated tsvector column", () => {
	test("emits a STORED GENERATED tsvector column from the search field", () => {
		const { sql } = ddl(searchSchema());
		expect(sql).toContain(
			"body_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED",
		);
	});

	test("honours a custom searchLanguage", () => {
		const { sql } = ddl(searchSchema(), { searchLanguage: "simple" });
		expect(sql).toContain(
			"body_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED",
		);
	});

	test("quotes a reserved-word search column inside the generated expression", () => {
		const { sql } = ddl(
			schema([
				table({
					name: "docs",
					fields: { user: field(v.string()) },
					searchIndexes: [
						{
							indexDescriptor: "search_user",
							searchField: "user",
							filterFields: [],
						},
					],
				}),
			]),
		);
		// The tsv column name `user_tsv` is safe unquoted; only the source
		// column `"user"` (a reserved word) is quoted inside the expression.
		expect(sql).toContain(
			`user_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', "user")) STORED`,
		);
	});
});

describe("generateIndexDdl post-load indexes", () => {
	test("empty for a schema with no search or vector indexes", () => {
		expect(
			indexDdl(
				schema([
					table({
						name: "t",
						fields: { x: field(v.string()) },
						indexes: [{ indexDescriptor: "by_x", fields: ["x"] }],
					}),
				]),
			),
		).toBe("");
	});

	test("bm25 index on the tsvector column with the default WITH params", () => {
		expect(indexDdl(searchSchema())).toContain(
			"CREATE INDEX messages_body_bm25 ON messages USING lakebase_bm25 (body_tsv) WITH (k1 = 1.2, b = 0.75);",
		);
	});

	test("searchK1 / searchB flow into the BM25 WITH clause", () => {
		expect(
			indexDdl(searchSchema(), { searchK1: 2, searchB: 0.5 }),
		).toContain("WITH (k1 = 2, b = 0.5);");
	});

	test("ann index on the vector column with the default opclass", () => {
		expect(indexDdl(vectorSchema())).toContain(
			"CREATE INDEX foods_embedding_ann ON foods USING lakebase_ann (embedding vector_cosine_ops);",
		);
	});

	test("vectorOps overrides the ann opclass", () => {
		expect(
			indexDdl(vectorSchema(), { vectorOps: "vector_l2_ops" }),
		).toContain("USING lakebase_ann (embedding vector_l2_ops);");
	});

	test("one btree per filter field, emitted before the ann index", () => {
		const sql = indexDdl(vectorSchema());
		expect(sql).toContain("CREATE INDEX foods_cuisine ON foods (cuisine);");
		expect(sql.indexOf("foods_cuisine")).toBeLessThan(
			sql.indexOf("lakebase_ann"),
		);
	});

	test("deduplicates a filter field shared by two indexes", () => {
		const sql = indexDdl(
			schema([
				table({
					name: "items",
					fields: {
						title: field(v.string()),
						embedding: field(v.array(v.number())),
						tag: field(v.string()),
					},
					searchIndexes: [
						{
							indexDescriptor: "search_title",
							searchField: "title",
							filterFields: ["tag"],
						},
					],
					vectorIndexes: [
						{
							indexDescriptor: "by_embedding",
							vectorField: "embedding",
							dimensions: 4,
							filterFields: ["tag"],
						},
					],
				}),
			]),
		);
		const matches = sql.match(/CREATE INDEX items_tag ON/g) ?? [];
		expect(matches).toHaveLength(1);
	});
});

describe("generateIndexDdl maxAnnDimensions", () => {
	test("default: the ann index is emitted regardless of dimensions", () => {
		const { warnings } = ddl(vectorSchema());
		expect(indexDdl(vectorSchema())).toContain("lakebase_ann");
		expect(warnings.some((w) => w.includes("maxAnnDimensions"))).toBe(
			false,
		);
	});

	test("when exceeded: column still vector(d), ann skipped, warning raised", () => {
		const options = { maxAnnDimensions: 1000 };
		const { sql, warnings } = ddl(vectorSchema(), options);
		// The column is still retyped and the extension is still required.
		expect(sql).toContain("embedding vector(1536) NOT NULL");
		expect(sql).toContain("lakebase_vector CASCADE");
		// ...but no ANN index is created.
		expect(indexDdl(vectorSchema(), options)).not.toContain("lakebase_ann");
		expect(
			warnings.some(
				(w) =>
					w.includes("maxAnnDimensions") &&
					w.includes("by_embedding"),
			),
		).toBe(true);
	});

	test("under the cap: the ann index is still emitted", () => {
		const options = { maxAnnDimensions: 4096 };
		expect(indexDdl(vectorSchema(), options)).toContain("lakebase_ann");
	});
});
