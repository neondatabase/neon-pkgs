import { describe, expect, it } from "vitest";

import {
	getAnalyticsEventProperties,
	getErrorAnalyticsEventProperties,
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
});
