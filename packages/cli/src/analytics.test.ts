import { describe, expect, it } from "vitest";

import {
	getAnalyticsEventProperties,
	getErrorAnalyticsEventProperties,
} from "./analytics.js";

describe("getErrorAnalyticsEventProperties", () => {
	it("adds version and CI context while preserving error diagnostics", () => {
		const properties = getErrorAnalyticsEventProperties(
			new Error("branch already exists"),
			"API_ERROR",
			{
				version: "2.33.2",
				ci: true,
			},
		);

		expect(properties).toMatchObject({
			ci: true,
			errCode: "API_ERROR",
			message: "branch already exists",
			version: "2.33.2",
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
	});

	it("preserves the existing raw error diagnostics", () => {
		const error = new Error("Could not connect to the database");
		const properties = getErrorAnalyticsEventProperties(
			error,
			"UNKNOWN_ERROR",
		);

		expect(properties.message).toBe(error.message);
		expect(properties.stack).toBe(error.stack);
	});
});

describe("getAnalyticsEventProperties", () => {
	it("continues to preserve the existing output value", () => {
		expect(
			getAnalyticsEventProperties({
				_: ["branches", "list"],
				output: "secret-value",
			}).flags.output,
		).toBe("secret-value");
	});
});
