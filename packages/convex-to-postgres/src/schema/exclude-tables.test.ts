import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateSeedSql } from "../data/seed.js";
import { generateStagingDdl } from "../data/staging.js";
import { generateTransformSql } from "../data/transform.js";
import { field, schema, table, v } from "../test-fixtures.js";
import { generateDdl, generateIndexDdl } from "./generate-ddl.js";
import { parseExportedSchema } from "./parse.js";
import { planSchema, unknownExcludedTables } from "./plan.js";

/** The shape `@convex-dev/auth`'s `authTables` adds, plus two app tables. */
const withAuth = parseExportedSchema(
	schema([
		table({
			name: "users",
			fields: { email: field(v.string(), true) },
		}),
		table({
			name: "authSessions",
			fields: {
				userId: field(v.id("users")),
				expirationTime: field(v.number()),
			},
		}),
		table({
			name: "authAccounts",
			fields: {
				userId: field(v.id("users")),
				provider: field(v.string()),
				providerAccountId: field(v.string()),
				secret: field(v.string(), true),
			},
		}),
		table({
			name: "authRefreshTokens",
			fields: { sessionId: field(v.id("authSessions")) },
		}),
		table({
			name: "authVerificationCodes",
			fields: { accountId: field(v.id("authAccounts")) },
		}),
		table({
			name: "authVerifiers",
			fields: { sessionId: field(v.id("authSessions"), true) },
		}),
		table({
			name: "authRateLimits",
			fields: { identifier: field(v.string()) },
		}),
		table({
			name: "calendars",
			fields: { ownerId: field(v.id("users")) },
		}),
		table({
			name: "auditLog",
			fields: {
				sessionId: field(v.id("authSessions")),
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

/**
 * The Convex Auth tables in `withAuth` other than `users`. The CLI reads this
 * list from the app's `@convex-dev/auth`; the core only sees `excludeTables`.
 */
const AUTH_TABLES = [
	"authSessions",
	"authAccounts",
	"authRefreshTokens",
	"authVerificationCodes",
	"authVerifiers",
	"authRateLimits",
];

function tableNames(options: Parameters<typeof planSchema>[1]) {
	return planSchema(withAuth, options).tables.map((t) => t.convexName);
}

describe("excludeTables with Convex Auth's tables", () => {
	test("leaves out exactly the named tables", () => {
		expect(tableNames({ excludeTables: AUTH_TABLES })).toEqual([
			"users",
			"calendars",
			"auditLog",
		]);
	});

	test("left-out tables get no table, staging table, transform or index", () => {
		const options = { excludeTables: AUTH_TABLES };
		const all = [
			generateDdl(withAuth, options).sql,
			generateStagingDdl(withAuth, options),
			generateTransformSql(withAuth, options),
			generateIndexDdl(withAuth, options),
		].join("\n");
		expect(all).not.toMatch(/auth_(sessions|accounts|refresh|verif|rate)/);
		expect(all).toContain("CREATE TABLE users (");
		expect(all).toContain("CREATE TABLE _convex_users");
	});

	test("a reference into a left-out table keeps its column, loses the FK, and warns", () => {
		const { sql, warnings } = generateDdl(withAuth, {
			excludeTables: AUTH_TABLES,
		});
		expect(sql).toContain("session_id uuid NOT NULL");
		expect(sql).not.toContain("audit_log_session_id_fkey");
		// References into kept tables still get their foreign key.
		expect(sql).toContain("calendars_owner_id_fkey");
		expect(warnings).toEqual([
			`table "auditLog": reference to table "authSessions", which is excluded; emitting the column without a foreign key.`,
		]);
	});

	test("without it, every table is imported and the core adds no auth warning", () => {
		expect(tableNames({})).toHaveLength(9);
		expect(generateDdl(withAuth).warnings).toEqual([]);
	});
});

describe("excludeTables", () => {
	test("matches the Convex name or the Postgres name", () => {
		expect(tableNames({ excludeTables: ["auditLog"] })).not.toContain(
			"auditLog",
		);
		expect(tableNames({ excludeTables: ["audit_log"] })).not.toContain(
			"auditLog",
		);
		expect(
			tableNames({ excludeTables: ["authAccounts", "auth_rate_limits"] }),
		).toEqual([
			"users",
			"authSessions",
			"authRefreshTokens",
			"authVerificationCodes",
			"authVerifiers",
			"calendars",
			"auditLog",
		]);
	});

	test("combines app and auth table names", () => {
		expect(
			tableNames({ excludeTables: [...AUTH_TABLES, "calendars"] }),
		).toEqual(["users", "auditLog"]);
	});

	test("a name that matches no table is reported", () => {
		expect(
			unknownExcludedTables(withAuth, { excludeTables: ["nope"] }),
		).toEqual(["nope"]);
		expect(
			unknownExcludedTables(withAuth, {
				excludeTables: ["auditLog", "audit_log"],
			}),
		).toEqual([]);
		expect(
			generateDdl(withAuth, { excludeTables: ["nope"] }).warnings,
		).toContain(
			'excludeTables: "nope" matches no table in the schema, so nothing was excluded for it.',
		);
	});
});

describe("excluded tables in a seed script", () => {
	let exportDir: string;

	beforeAll(() => {
		exportDir = mkdtempSync(join(tmpdir(), "c2pg-exclude-"));
		for (const [name, line] of [
			[
				"users",
				`{"_id":"u1","_creationTime":1.5,"email":"a@example.com"}`,
			],
			[
				"authAccounts",
				`{"_id":"a1","_creationTime":1.5,"userId":"u1","provider":"password","providerAccountId":"a@example.com","secret":"HASH-SHOULD-NOT-APPEAR"}`,
			],
		]) {
			mkdirSync(join(exportDir, name));
			writeFileSync(
				join(exportDir, name, "documents.jsonl"),
				`${line}\n`,
			);
		}
	});

	afterAll(() => {
		rmSync(exportDir, { recursive: true, force: true });
	});

	test("a left-out table's documents never reach the script", () => {
		const sql = generateSeedSql(withAuth, exportDir, {
			excludeTables: AUTH_TABLES,
		});
		expect(sql).toContain("a@example.com");
		expect(sql).not.toContain("HASH-SHOULD-NOT-APPEAR");
		expect(generateSeedSql(withAuth, exportDir)).toContain(
			"HASH-SHOULD-NOT-APPEAR",
		);
	});
});
