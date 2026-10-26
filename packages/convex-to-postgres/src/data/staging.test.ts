import { describe, expect, test } from "vitest";
import { parseExportedSchema } from "../schema/parse.js";
import { field, schema, table, v } from "../test-fixtures.js";
import { generateStagingDdl, generateStagingDropSql } from "./staging.js";

const parsed = parseExportedSchema(
	schema([
		table({ name: "users", fields: { name: field(v.string()) } }),
		table({ name: "userProfiles", fields: { bio: field(v.string()) } }),
	]),
);

describe("generateStagingDdl", () => {
	test("creates one jsonb staging table per source table", () => {
		const sql = generateStagingDdl(parsed);
		expect(sql).toContain(
			"CREATE TABLE _convex_users (doc jsonb NOT NULL);",
		);
		expect(sql).toContain(
			"CREATE TABLE _convex_user_profiles (doc jsonb NOT NULL);",
		);
	});

	test("quotes a staging name derived from a verbatim camelCase table", () => {
		const sql = generateStagingDdl(parsed, { snakeCase: false });
		expect(sql).toContain(
			'CREATE TABLE "_convex_userProfiles" (doc jsonb NOT NULL);',
		);
	});
});

describe("generateStagingDropSql", () => {
	test("drops every staging table", () => {
		const sql = generateStagingDropSql(parsed);
		expect(sql).toContain("DROP TABLE _convex_users;");
		expect(sql).toContain("DROP TABLE _convex_user_profiles;");
	});
});
