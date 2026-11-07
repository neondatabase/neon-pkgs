import { describe, expect, it } from "vitest";

import { parseEnvPullKeys } from "./env_services.js";
import { isNetworkError, matchErrorCode } from "./errors.js";

describe("matchErrorCode", () => {
	it("counts --env NEON_FUNCTION_<SLUG>_BASE_URL apart from unknown errors", () => {
		let thrown: unknown;
		try {
			parseEnvPullKeys(["NEON_FUNCTION_HELLO_BASE_URL"], "--env");
		} catch (error) {
			thrown = error;
		}
		if (!(thrown instanceof Error)) {
			throw new Error(
				"parseEnvPullKeys accepted a legacy function URL key",
			);
		}
		expect(matchErrorCode(thrown.message)).toBe("LEGACY_FUNCTION_ENV_KEY");
	});

	it("maps known message shapes to their codes", () => {
		expect(matchErrorCode("Unknown command: frobnicate")).toBe(
			"UNKNOWN_COMMAND",
		);
		expect(matchErrorCode("Missing required argument: project-id")).toBe(
			"MISSING_ARGUMENT",
		);
		expect(matchErrorCode("Setup did not finish.")).toBe(
			"NEON_INIT_FAILED",
		);
	});

	it("classifies neon init and agent-setup failures by their message", () => {
		const cases: [string, string][] = [
			[
				"No interactive terminal. Re-run with -y to set up this directory with Recommended defaults: `neon init -y`.",
				"NON_INTERACTIVE",
			],
			["Authentication timed out after 60 seconds", "AUTH_TIMEOUT"],
			[
				"neon skills needs Node.js 22.20.0 or newer to run the skills CLI. This process is Node.js 22.14.0. Upgrade Node.js, then retry.",
				"NODE_VERSION_UNSUPPORTED",
			],
			[
				"neon plugins needs npx (Node.js) to run the plugins CLI. Install Node.js, then retry.",
				"NPX_NOT_FOUND",
			],
			[
				"skills CLI failed:\nFailed to clone https://github.com/neondatabase/agent-skills.git: Error: spawn git ENOENT",
				"GIT_NOT_FOUND",
			],
			["skills CLI failed:\nboom", "SKILLS_CLI_FAILED"],
			[
				"Failed to install Neon agent skills for: Cursor.\nskills CLI failed:\nboom\nRetry with: neon skills --agent cursor -y",
				"SKILLS_CLI_FAILED",
			],
			[
				'Cannot install the Neon plugin for GitHub Copilot CLI: "copilot" was not found on PATH. Install it or add it to PATH, then retry.',
				"AGENT_COMMAND_UNAVAILABLE",
			],
			[
				"Failed to install the Neon plugin for: github-copilot-cli.\nplugins CLI failed:\nboom\nRetry with: neon plugins --agent github-copilot-cli -y",
				"PLUGINS_CLI_FAILED",
			],
			[
				"plugins CLI failed:\nboom\nRetry with: neon plugins --agent cursor -y",
				"PLUGINS_CLI_FAILED",
			],
			[
				"plugins CLI timed out after 120 seconds.\nRetry with: neon plugins --agent cursor -y",
				"PLUGINS_CLI_FAILED",
			],
			[
				"Could not install the Neon dependencies with npm (ERESOLVE).",
				"DEPENDENCY_INSTALL_FAILED",
			],
		];
		for (const [message, code] of cases) {
			expect(matchErrorCode(message), message).toBe(code);
		}
	});

	it("falls back to UNKNOWN_ERROR for unmatched / empty messages", () => {
		expect(matchErrorCode("something else entirely")).toBe("UNKNOWN_ERROR");
		expect(matchErrorCode(undefined)).toBe("UNKNOWN_ERROR");
	});
});

describe("isNetworkError", () => {
	it("detects a Node fetch failure whose cause carries the socket code", () => {
		// What `await fetch(...)` rejects with when the host is unreachable: a bare
		// `TypeError: fetch failed` with the real code one level down on `cause`.
		const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
			code: "ENOTFOUND",
		});
		const err = Object.assign(new TypeError("fetch failed"), { cause });
		expect(isNetworkError(err)).toBe(true);
	});

	it('detects a browser-style "Failed to fetch" message', () => {
		expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
	});

	it('detects a "Network Error" message', () => {
		expect(isNetworkError(new Error("Network Error"))).toBe(true);
	});

	it("detects a top-level socket code without a wrapping message", () => {
		expect(
			isNetworkError(
				Object.assign(new Error("connect failed"), {
					code: "ECONNREFUSED",
				}),
			),
		).toBe(true);
	});

	it("does not treat an HTTP API error as a network error", () => {
		// A real 4xx/5xx must still surface to the user, never be swallowed as "offline".
		const apiError = {
			response: { status: 404, data: { message: "not found" } },
		};
		expect(isNetworkError(apiError)).toBe(false);
		expect(isNetworkError(new Error("Project not found"))).toBe(false);
	});

	it("does not treat an axios timeout (ECONNABORTED) as a network error", () => {
		// Timeouts have their own dedicated message in the CLI; keep them distinct.
		const timeout = Object.assign(
			new Error("timeout of 60000ms exceeded"),
			{
				code: "ECONNABORTED",
			},
		);
		expect(isNetworkError(timeout)).toBe(false);
	});

	it("returns false for non-error values", () => {
		expect(isNetworkError(null)).toBe(false);
		expect(isNetworkError(undefined)).toBe(false);
		expect(isNetworkError("fetch failed")).toBe(false);
	});
});
