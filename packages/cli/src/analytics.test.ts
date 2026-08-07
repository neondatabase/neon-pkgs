import { describe, expect, it } from "vitest";

import {
	analyticsUserId,
	getAnalyticsEventProperties,
	getErrorAnalyticsEventProperties,
	storedCredentialAttribution,
} from "./analytics.js";

describe("analyticsUserId", () => {
	it("reports a run nothing identified as anonymous, not as an empty identity", () => {
		expect(analyticsUserId("")).toBe("anonymous");
	});

	it("treats an id the API never returned the same as an empty one", () => {
		expect(analyticsUserId(undefined)).toBe("anonymous");
	});

	it("attributes an identified run to the user", () => {
		expect(analyticsUserId("1234")).toBe("1234");
	});
});

describe("storedCredentialAttribution", () => {
	it("claims no account when nothing identified the invocation", () => {
		expect(storedCredentialAttribution("")).toEqual({});
	});

	it("never names an auth method for an account it could not name", () => {
		expect(storedCredentialAttribution("").authMethod).toBeUndefined();
		expect(
			storedCredentialAttribution(undefined).authMethod,
		).toBeUndefined();
	});

	it("reports a stored session as the account it belongs to", () => {
		expect(storedCredentialAttribution("1234")).toEqual({
			accountId: "1234",
			authMethod: "oauth",
		});
	});
});

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
