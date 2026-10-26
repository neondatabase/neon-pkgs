import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseExportedSchema } from "../schema/parse.js";
import { field, schema, table, v } from "../test-fixtures.js";
import { generateSeedSql } from "./seed.js";

const BIG_INT = "9007199254740993"; // 2^53 + 1, unrepresentable as a JS number

const parsed = parseExportedSchema(
	schema([
		table({ name: "channels", fields: { name: field(v.string()) } }),
		table({
			name: "messages",
			fields: {
				channel: field(v.id("channels")),
				body: field(v.string()),
				big: field(v.int64()),
			},
		}),
	]),
);

const channelLine = `{"_id":"chan1","_creationTime":1792787860912.0713,"name":"general"}`;
const messageLine = `{"_id":"msg1","_creationTime":1792787860912.5,"channel":"chan1","body":"hello","big":${BIG_INT}}`;

let exportDir: string;
let sql: string;

beforeAll(() => {
	exportDir = mkdtempSync(join(tmpdir(), "c2pg-seed-"));
	mkdirSync(join(exportDir, "channels"), { recursive: true });
	mkdirSync(join(exportDir, "messages"), { recursive: true });
	writeFileSync(
		join(exportDir, "channels", "documents.jsonl"),
		`${channelLine}\n`,
	);
	writeFileSync(
		join(exportDir, "messages", "documents.jsonl"),
		`${messageLine}\n`,
	);
	sql = generateSeedSql(parsed, exportDir);
});

afterAll(() => {
	rmSync(exportDir, { recursive: true, force: true });
});

describe("generateSeedSql", () => {
	test("wraps the load in a single transaction", () => {
		expect(sql.startsWith("BEGIN;")).toBe(true);
		expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
	});

	test("creates staging tables", () => {
		expect(sql).toContain(
			"CREATE TABLE _convex_channels (doc jsonb NOT NULL);",
		);
		expect(sql).toContain(
			"CREATE TABLE _convex_messages (doc jsonb NOT NULL);",
		);
	});

	test("stages each raw JSONL line as a jsonb literal", () => {
		expect(sql).toContain(
			`INSERT INTO _convex_channels (doc) VALUES ('${channelLine}'::jsonb);`,
		);
		expect(sql).toContain(
			`INSERT INTO _convex_messages (doc) VALUES ('${messageLine}'::jsonb);`,
		);
	});

	test("preserves a bare big integer verbatim (never JSON.parsed)", () => {
		expect(sql).toContain(BIG_INT);
		// The staged line carries the exact digits; nothing rounds it to a float.
		expect(sql).toContain(`"big":${BIG_INT}`);
	});

	test("includes the typed transform", () => {
		expect(sql).toContain("INSERT INTO messages (");
		expect(sql).toContain("(doc->>'big')::bigint");
		expect(sql).toContain("md5(doc->>'channel')::uuid");
		expect(sql).toContain("FROM _convex_messages;");
	});

	test("drops the staging tables at the end", () => {
		expect(sql).toContain("DROP TABLE _convex_channels;");
		expect(sql).toContain("DROP TABLE _convex_messages;");
	});

	test("omits data for a table whose documents.jsonl is absent", () => {
		const onlyChannels = parseExportedSchema(
			schema([
				table({
					name: "channels",
					fields: { name: field(v.string()) },
				}),
				table({ name: "ghost", fields: { x: field(v.string()) } }),
			]),
		);
		const out = generateSeedSql(onlyChannels, exportDir);
		expect(out).toContain(
			"CREATE TABLE _convex_ghost (doc jsonb NOT NULL);",
		);
		expect(out).not.toContain("INSERT INTO _convex_ghost");
	});

	test("a schema with no search/vector indexes ends at COMMIT (no VACUUM)", () => {
		expect(sql).not.toContain("VACUUM");
		expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
	});
});

describe("generateSeedSql search/vector post-load phase", () => {
	const withSearch = parseExportedSchema(
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

	test("the BM25 index and VACUUM ANALYZE come AFTER the COMMIT", () => {
		const out = generateSeedSql(withSearch, exportDir);
		const commitAt = out.indexOf("\nCOMMIT;");
		const bm25At = out.indexOf("lakebase_bm25");
		const vacuumAt = out.indexOf("VACUUM ANALYZE;");
		expect(commitAt).toBeGreaterThan(-1);
		expect(bm25At).toBeGreaterThan(commitAt);
		expect(vacuumAt).toBeGreaterThan(bm25At);
		expect(out.trimEnd().endsWith("VACUUM ANALYZE;")).toBe(true);
	});

	test("the transform never writes the generated tsvector column", () => {
		// The target-table CREATE TABLE (with the GENERATED clause) is emitted by
		// generateDdl, not the seed; the seed just loads and indexes. The transform
		// INSERT must omit body_tsv, and the BM25 index references it post-load.
		const out = generateSeedSql(withSearch, exportDir);
		expect(out).toContain(
			"INSERT INTO messages (id, created_at, author, body)",
		);
		expect(out).not.toContain(
			"INSERT INTO messages (id, created_at, author, body, body_tsv)",
		);
		expect(out).toContain("lakebase_bm25 (body_tsv)");
	});
});
