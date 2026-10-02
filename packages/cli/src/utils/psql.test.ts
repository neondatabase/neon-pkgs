import { describe, expect, it } from "vitest";

import { connectionSummary } from "./psql";

describe("connectionSummary", () => {
	it("names the database, role, and host", () => {
		expect(
			connectionSummary(
				"postgresql://neondb_owner:s3cret@ep-cool-sun-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
			),
		).toBe(
			"Neon connection: neondb as neondb_owner on ep-cool-sun-123456-pooler.us-east-2.aws.neon.tech",
		);
	});

	it("never includes the password or the query string", () => {
		const summary = connectionSummary(
			"postgresql://app:s3cret@ep-x.neon.tech/app?sslmode=require",
		);
		expect(summary).not.toContain("s3cret");
		expect(summary).not.toContain("sslmode");
	});

	it("decodes names, keeps an explicit port, and strips control characters", () => {
		expect(
			connectionSummary(
				"postgresql://my%20role:pw@localhost:5433/my%2Fdb%0Aevil",
			),
		).toBe("Neon connection: my/dbevil as my role on localhost:5433");
	});

	it("falls back to a generic line for a URI it cannot read", () => {
		expect(connectionSummary("not a uri")).toBe(
			"Connecting to the database",
		);
		expect(connectionSummary("postgresql://a:b@host/%E0%A4%A")).toBe(
			"Connecting to the database",
		);
		expect(connectionSummary("postgresql://host/db")).toBe(
			"Connecting to the database",
		);
	});
});
