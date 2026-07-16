import { describe, expect, it } from "vitest";

import {
	getAnalyticsEventProperties,
	getErrorAnalyticsEventProperties,
	redactAnalyticsText,
} from "./analytics.js";

describe("getErrorAnalyticsEventProperties", () => {
	it("preserves the command context captured before CLI execution fails", () => {
		const context = getAnalyticsEventProperties({
			_: ["branches", "create"],
			output: "json",
		});

		const properties = getErrorAnalyticsEventProperties(
			new Error("branch already exists"),
			"API_ERROR",
			context,
		);

		expect(properties).toMatchObject({
			command: "branches create",
			flags: { output: "json" },
			errCode: "API_ERROR",
			message: "branch already exists",
			version: expect.any(String),
		});
	});

	it("still reports errors that happen before command context is available", () => {
		const properties = getErrorAnalyticsEventProperties(
			new Error("configuration directory is unavailable"),
			"UNKNOWN_ERROR",
		);

		expect(properties).toMatchObject({
			errCode: "UNKNOWN_ERROR",
			message: "configuration directory is unavailable",
		});
		expect(properties).not.toHaveProperty("command");
	});

	it("does not send a database URL or stack trace", () => {
		const databaseUrl =
			"postgresql://user:password@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require";
		const properties = getErrorAnalyticsEventProperties(
			new Error(`Could not connect to ${databaseUrl}`),
			"UNKNOWN_ERROR",
		);

		expect(properties.message).toBe(
			"Could not connect to [REDACTED_DATABASE_URL]",
		);
		expect(properties).not.toHaveProperty("stack");
		expect(JSON.stringify(properties)).not.toContain(databaseUrl);
	});
});

describe("redactAnalyticsText", () => {
	it("redacts database URLs and credential values from command telemetry", () => {
		const value =
			"psql postgresql://user:password@host/neondb?sslmode=require token=secret-token";

		expect(redactAnalyticsText(value)).toBe(
			"psql [REDACTED_DATABASE_URL] token=[REDACTED]",
		);
	});
});
