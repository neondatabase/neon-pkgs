import { describe, expect, it } from "vitest";

import {
	getAnalyticsCommand,
	getAnalyticsErrorKind,
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
			reason: "resource_conflict",
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
			reason: "unknown_error",
		});
		expect(properties).not.toHaveProperty("command");
	});

	it("preserves the existing raw error diagnostics", () => {
		const error = new Error("Could not connect to the database");
		const properties = getErrorAnalyticsEventProperties(
			error,
			"UNKNOWN_ERROR",
		);

		expect(properties.reason).toBe("unknown_error");
		expect(properties.message).toBe(error.message);
		expect(properties.stack).toBe(error.stack);
	});
});

describe("analytics allowlist", () => {
	it("keeps only known command roots", () => {
		expect(
			getAnalyticsCommand(["branches", "create", "feature-branch"]),
		).toBe("branches");
		expect(
			getAnalyticsCommand([
				"psql",
				"postgresql://user:password@host/neondb?sslmode=require",
			]),
		).toBe("psql");
		expect(getAnalyticsCommand(["unrecognized-command"])).toBe("unknown");
	});

	it("classifies known errors without retaining their message", () => {
		expect(
			getAnalyticsErrorKind(
				"Branch production not found",
				"UNKNOWN_ERROR",
				undefined,
			),
		).toBe("resource_not_found");
		expect(
			getAnalyticsErrorKind("branch already exists", "API_ERROR", 409),
		).toBe("resource_conflict");
		expect(
			getAnalyticsErrorKind(
				"Authentication timed out after 60 seconds",
				"UNKNOWN_ERROR",
				undefined,
			),
		).toBe("authentication_timeout");
		expect(
			getAnalyticsErrorKind(
				"Unknown commands: endpoints, list",
				"UNKNOWN_ERROR",
				undefined,
			),
		).toBe("unknown_command");
	});

	it("continues to preserve the existing output value", () => {
		expect(
			getAnalyticsEventProperties({
				_: ["branches", "list"],
				output: "secret-value",
			}).flags.output,
		).toBe("secret-value");
	});
});
