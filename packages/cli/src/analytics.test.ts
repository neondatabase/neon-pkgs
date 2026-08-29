import { afterEach, describe, expect, it, vi } from "vitest";

import {
	analyticsUserId,
	getAnalyticsEventProperties,
	getErrorAnalyticsEventProperties,
	storedCredentialAttribution,
	telemetryCredential,
} from "./analytics.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

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

describe("telemetryCredential", () => {
	const DEFAULT_PATH = "/config/credentials.json";

	it("does not query a key no recorded authentication selected", () => {
		expect(
			telemetryCredential(null, "napi_never_selected", DEFAULT_PATH),
		).toEqual({
			credentialsPath: DEFAULT_PATH,
		});
	});

	it("falls back to the local default for a command that selected nothing", () => {
		expect(telemetryCredential(null, undefined, DEFAULT_PATH)).toEqual({
			credentialsPath: DEFAULT_PATH,
		});
	});

	it("asks the API about a supplied key rather than reading a file it did not use", () => {
		expect(
			telemetryCredential(
				{ source: "api-key", configDir: "/config" },
				"napi_supplied",
				DEFAULT_PATH,
			),
		).toEqual({ apiKey: "napi_supplied" });
	});

	it("reads the file a profile selected, not the default one", () => {
		expect(
			telemetryCredential(
				{
					source: "profile-api-key",
					configDir: "/config",
					profile: "work",
					credentialsPath: "/config/work.json",
				},
				"napi_from_profile",
				DEFAULT_PATH,
			),
		).toEqual({
			apiKey: "napi_from_profile",
			credentialsPath: "/config/work.json",
		});
	});

	it("uses the default file when a stored session recorded no path", () => {
		expect(
			telemetryCredential(
				{ source: "stored-credentials", configDir: "/config" },
				"access_token",
				DEFAULT_PATH,
			),
		).toEqual({
			apiKey: "access_token",
			credentialsPath: DEFAULT_PATH,
		});
	});

	it("does not invent a file path for a keyring session", () => {
		expect(
			telemetryCredential(
				{
					source: "stored-credentials",
					configDir: "/config",
					profile: "DEFAULT",
					storage: "keyring",
				},
				"access_token",
				DEFAULT_PATH,
			),
		).toEqual({ apiKey: "access_token" });
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
				agent: "codex",
			},
		);

		expect(properties).toMatchObject({
			agent: "codex",
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

	it("puts the ask prompt on command so existing CLI telemetry can list it", () => {
		expect(
			getAnalyticsEventProperties({
				_: ["ask"],
				prompt: "How do schema-only branches work?",
			}).command,
		).toBe("ask How do schema-only branches work?");
	});

	it("does not append prompt on a command that is not ask", () => {
		expect(
			getAnalyticsEventProperties({
				_: ["branches", "list"],
				prompt: "How do schema-only branches work?",
			}).command,
		).toBe("branches list");
	});

	it("does not put the assistant URL on the event", () => {
		expect(
			getAnalyticsEventProperties({
				_: ["ask"],
				prompt: "How do schema-only branches work?",
				url: "https://example.invalid/ask",
			}),
		).toEqual(
			expect.not.objectContaining({
				url: expect.anything(),
			}),
		);
		expect(
			JSON.stringify(
				getAnalyticsEventProperties({
					_: ["ask"],
					prompt: "How do schema-only branches work?",
					url: "https://example.invalid/ask",
				}),
			),
		).not.toContain("example.invalid");
	});

	it("attributes commands run by a coding agent", () => {
		vi.stubEnv("CODEX_CI", undefined);
		vi.stubEnv("CODEX_THREAD_ID", undefined);
		vi.stubEnv("CODEX_SESSION_ID", undefined);
		vi.stubEnv("CLAUDE_CODE_CHILD_SESSION", "1");

		expect(
			getAnalyticsEventProperties({
				_: ["branches", "list"],
			}).agent,
		).toBe("claude-code");
	});
});
