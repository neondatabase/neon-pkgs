import { describe, expect, it } from "vitest";
import { NeonClientError } from "../errors.js";
import {
	bootstrapPassword,
	parseRoleAccess,
	roleAccessStatements,
} from "./role-access.js";

describe("parseRoleAccess", () => {
	it("treats a missing access and admin as the API path", () => {
		expect(parseRoleAccess({ name: "app" })).toBeUndefined();
		expect(
			parseRoleAccess({ name: "app", access: "admin" }),
		).toBeUndefined();
	});

	it("defaults schemas to public and keeps an explicit database", () => {
		expect(parseRoleAccess({ name: "app", access: "read_only" })).toEqual({
			access: "read_only",
			schemas: ["public"],
		});
		expect(
			parseRoleAccess({
				name: "app",
				access: "read_write",
				databaseName: "neondb",
				schemas: ["public", "app"],
			}),
		).toEqual({
			access: "read_write",
			databaseName: "neondb",
			schemas: ["public", "app"],
		});
	});

	it.each([
		[{ name: "app", access: "readonly" }, "access must be one of"],
		[{ name: "app", databaseName: "neondb" }, "apply only to access"],
		[
			{ name: "app", access: "admin", schemas: ["public"] },
			"apply only to access",
		],
		[{ name: "app", access: "read_only", schemas: [] }, "non-empty array"],
		[
			{ name: "app", access: "read_only", schemas: [""] },
			"non-empty array",
		],
		[{ name: "app", access: "read_only", databaseName: "" }, "non-empty"],
		[{ name: "a".repeat(64), access: "read_only" }, "64 bytes"],
		[{ name: "ä".repeat(32), access: "read_only" }, "64 bytes"],
		[
			{ name: "app", access: "read_only", schemas: ["s".repeat(64)] },
			"at most 63 bytes",
		],
	])("rejects %j", (input, message) => {
		const result = parseRoleAccess(input);
		expect(result).toBeInstanceOf(NeonClientError);
		expect(result instanceof NeonClientError && result.message).toContain(
			message,
		);
	});
});

describe("roleAccessStatements", () => {
	const base = {
		name: 'App "Reader"',
		databaseName: "neondb",
		ownerName: "neondb_owner",
		schemas: ["public"],
		bootstrapPassword: "abc123",
	};

	it("grants read_only table access and future-table defaults", () => {
		expect(roleAccessStatements({ ...base, access: "read_only" })).toEqual([
			`CREATE ROLE "App ""Reader""" LOGIN PASSWORD 'abc123'`,
			`GRANT CONNECT ON DATABASE "neondb" TO "App ""Reader"""`,
			`GRANT USAGE ON SCHEMA "public" TO "App ""Reader"""`,
			`GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "App ""Reader"""`,
			`ALTER DEFAULT PRIVILEGES FOR ROLE "neondb_owner" IN SCHEMA "public" GRANT SELECT ON TABLES TO "App ""Reader"""`,
		]);
	});

	it("adds write privileges and sequences for read_write, per schema", () => {
		const statements = roleAccessStatements({
			...base,
			name: "rw",
			access: "read_write",
			schemas: ["public", "app"],
			bootstrapPassword: undefined,
		});
		expect(statements[0]).toBe(`CREATE ROLE "rw" NOLOGIN`);
		expect(statements).toContain(
			`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "app" TO "rw"`,
		);
		expect(statements).toContain(
			`ALTER DEFAULT PRIVILEGES FOR ROLE "neondb_owner" IN SCHEMA "app" GRANT USAGE, SELECT ON SEQUENCES TO "rw"`,
		);
		expect(statements).toHaveLength(2 + 2 * 5);
	});

	it("refuses a bootstrap password that could break out of the literal", () => {
		expect(() =>
			roleAccessStatements({
				...base,
				access: "read_only",
				bootstrapPassword: "x'; DROP ROLE neondb_owner; --",
			}),
		).toThrow(NeonClientError);
	});

	it("generates alphanumeric bootstrap passwords", () => {
		expect(bootstrapPassword()).toMatch(/^[0-9a-f]{64}$/);
		expect(bootstrapPassword()).not.toBe(bootstrapPassword());
	});
});
