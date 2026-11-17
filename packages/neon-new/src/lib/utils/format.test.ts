import { describe, expect, test } from "vitest";
import {
	getConnectionStrings,
	maskPassword,
	redactConnectionString,
} from "./format.js";

const connString =
	"postgresql://neondb_owner:npg_s3cr%2Ft@ep-test-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";

describe("redactConnectionString", () => {
	test("hides the password and keeps everything else", () => {
		expect(redactConnectionString(connString)).toBe(
			"postgresql://neondb_owner:****@ep-test-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require",
		);
	});

	test("leaves a connection string without a password unchanged", () => {
		expect(
			redactConnectionString("postgresql://user@host.neon.tech/db"),
		).toBe("postgresql://user@host.neon.tech/db");
	});

	test("never echoes a string it cannot parse", () => {
		expect(redactConnectionString("user:npg_s3cret@host/db")).toBe(
			"<connection string hidden>",
		);
		expect(
			redactConnectionString("postgresql://u:npg_s3cret@[bad/db"),
		).toBe("<connection string hidden>");
	});

	test("hides a password that URL parsing reads as a port and fragment", () => {
		expect(redactConnectionString("postgresql://u:123#abc@host/db")).toBe(
			"<connection string hidden>",
		);
	});

	test("masks a password containing a raw @", () => {
		expect(redactConnectionString("postgresql://u:p@ss@host/db")).toBe(
			"postgresql://u:****@host/db",
		);
	});
});

describe("maskPassword", () => {
	test("masks the encoded and decoded password in arbitrary text", () => {
		expect(
			maskPassword(
				`bad url: ${connString} (password npg_s3cr/t)`,
				connString,
			),
		).toBe(
			"bad url: postgresql://neondb_owner:****@ep-test-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require (password ****)",
		);
	});

	test("finds the password in a string that is not a valid URL", () => {
		const broken = "postgresql://neondb_owner:npg_s3cret@[bad/neondb";
		expect(maskPassword(`invalid: ${broken}`, broken)).toBe(
			"invalid: postgresql://neondb_owner:****@[bad/neondb",
		);
	});

	test("masks a raw @ password in a string that is not a valid URL", () => {
		const broken = "postgresql://u:p@ss_w0rd@[bad/neondb";
		expect(maskPassword(`invalid: ${broken}`, broken)).toBe(
			"invalid: postgresql://u:****@[bad/neondb",
		);
	});

	test("masks a partly encoded password as written", () => {
		const conn = "postgresql://u:a%2Fb c@host/db";
		expect(maskPassword(`url: ${conn}`, conn)).toBe(
			"url: postgresql://u:****@host/db",
		);
	});

	test("returns the text unchanged when there is no password", () => {
		expect(maskPassword("text", "postgresql://user@host/db")).toBe("text");
	});
});

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
