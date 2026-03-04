import { describe, expect, test } from "vitest";
import { getConnectionStrings } from "./format.js";

describe("getConnectionStrings", () => {
	test("returns the pooler and direct strings", () => {
		expect(
			getConnectionStrings(
				"postgres://user:password@host:port/database.us-east-1.aws.neon.tech",
			).pooler,
		).toMatch(
			"postgres://user:password@host:port/database-pooler.us-east-1.aws.neon.tech",
		);
		expect(
			getConnectionStrings(
				"postgres://user:password@host:port/database.us-east-1.aws.neon.tech",
			).direct,
		).toMatch(
			"postgres://user:password@host:port/database.us-east-1.aws.neon.tech",
		);
	});

	test("returns the direct string if the connection string is already a direct string", () => {
		expect(
			getConnectionStrings(
				"postgres://user:password@host:port/database.us-east-1.aws.neon.tech",
			).direct,
		).toMatch(
			"postgres://user:password@host:port/database.us-east-1.aws.neon.tech",
		);
	});

	test("converts pooler connection string to direct connection string by removing '-pooler' suffix", () => {
		expect(
			getConnectionStrings(
				"postgres://user:password@host:port/database-pooler.us-east-1.aws.neon.tech",
			).direct,
		).toMatch(
			"postgres://user:password@host:port/database.us-east-1.aws.neon.tech",
		);
		expect(
			getConnectionStrings(
				"postgres://user:password@host:port/database-pooler.us-east-1.aws.neon.tech",
			).pooler,
		).toMatch(
			"postgres://user:password@host:port/database-pooler.us-east-1.aws.neon.tech",
		);
	});
});
