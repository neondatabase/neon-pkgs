import { homedir } from "node:os";
import { describe, expect, it } from "vitest";

import { CannotMintApiKeyError } from "./mcp/mint.js";
import {
	attachToolingContext,
	classifyToolingError,
	mergeToolingContexts,
	sanitizeErrorDetail,
	tagToolingStep,
	toolingContextOf,
	toolingErrorProperties,
	withToolingStep,
} from "./tooling_error.js";

describe("classifyToolingError", () => {
	it.each([
		[
			"neon skills needs Node.js 20.0.0 or newer to run the skills CLI.",
			"node_unsupported",
		],
		[
			"neon skills needs npx (Node.js) to run the skills CLI.",
			"node_missing",
		],
		["EACCES: permission denied, open '/x/mcp.json'", "permission_denied"],
		["npm error code E403\nnpm error 403 Forbidden", "registry_blocked"],
		[
			"GET https://registry.npmjs.org/skills - 403 Forbidden",
			"registry_blocked",
		],
		["getaddrinfo ENOTFOUND registry.npmjs.org", "network"],
		["Unexpected token } in JSON at position 4", "invalid_config"],
		["something nobody planned for", "unknown"],
	])("reads %j as %s", (message, kind) => {
		expect(classifyToolingError(new Error(message), undefined)).toBe(kind);
	});

	it("does not read an unrelated number 403 as a blocked registry", () => {
		expect(
			classifyToolingError(
				new Error("wrote 403 files on port 4030"),
				undefined,
			),
		).toBe("unknown");
	});

	it("reads a child killed by a signal as a failed child, not unknown", () => {
		expect(
			classifyToolingError(new Error("skills CLI failed."), {
				signal: "SIGKILL",
			}),
		).toBe("child_failed");
	});

	it("does not read the words 'forbidden' or 'timed out' on their own as a cause", () => {
		expect(
			classifyToolingError(
				new Error("that name is forbidden here"),
				undefined,
			),
		).toBe("unknown");
		expect(
			classifyToolingError(new Error("the session timed out"), undefined),
		).toBe("unknown");
		expect(
			classifyToolingError(
				new Error("Command timed out after 120000 milliseconds"),
				undefined,
			),
		).toBe("timeout");
	});

	it("reads a timed out child as a timeout, whatever it printed", () => {
		expect(
			classifyToolingError(new Error("skills CLI failed:\nnope"), {
				timedOut: true,
				exitCode: undefined,
			}),
		).toBe("timeout");
	});

	it("reads a failed child with no other clue as child_failed", () => {
		expect(
			classifyToolingError(new Error("skills CLI failed:\nnope"), {
				exitCode: 1,
			}),
		).toBe("child_failed");
	});

	it("recognises a credential that cannot mint keys", () => {
		expect(
			classifyToolingError(new CannotMintApiKeyError(), undefined),
		).toBe("cannot_mint_key");
	});

	it("uses the detail the message doesn't carry", () => {
		expect(
			classifyToolingError(
				new Error("Failed to write Neon MCP config to any agent."),
				{ detail: "EACCES: permission denied" },
			),
		).toBe("permission_denied");
	});
});

describe("tooling context", () => {
	it("keeps the step set closest to the failure", () => {
		const error = new Error("boom");
		attachToolingContext(error, { step: "mcp" });
		tagToolingStep(error, "skills");
		expect(toolingContextOf(error)?.step).toBe("mcp");
	});

	it("tags an error that has no step yet", () => {
		const error = new Error("boom");
		attachToolingContext(error, { exitCode: 1 });
		tagToolingStep(error, "skills");
		expect(toolingContextOf(error)).toEqual({
			exitCode: 1,
			step: "skills",
		});
	});

	it("lets a later value replace an earlier one but never with undefined", () => {
		const error = new Error("boom");
		attachToolingContext(error, { scope: "project", exitCode: 2 });
		attachToolingContext(error, { scope: "global", exitCode: undefined });
		expect(toolingContextOf(error)).toEqual({
			scope: "global",
			exitCode: 2,
		});
	});

	it("ignores values that can't carry context", () => {
		expect(() =>
			attachToolingContext("a string", { step: "mcp" }),
		).not.toThrow();
		expect(toolingContextOf("a string")).toBeUndefined();
		expect(toolingContextOf(undefined)).toBeUndefined();
	});

	it("withToolingStep tags what the work throws and rethrows the same error", async () => {
		const error = new Error("boom");
		await expect(
			withToolingStep("skills", async () => {
				throw error;
			}),
		).rejects.toBe(error);
		expect(toolingContextOf(error)?.step).toBe("skills");
	});

	it("withToolingStep passes the result through", async () => {
		await expect(withToolingStep("mcp", async () => 7)).resolves.toBe(7);
	});
});

describe("sanitizeErrorDetail", () => {
	it("strips colour codes", () => {
		expect(sanitizeErrorDetail("\u001b[31mfailed\u001b[0m")).toBe("failed");
	});

	it("hides the home and working directories", () => {
		const text = `ENOENT ${homedir()}/.cursor/mcp.json and ${process.cwd()}/package.json`;
		const out = sanitizeErrorDetail(text);
		expect(out).not.toContain(homedir());
		expect(out).toContain("~/.cursor/mcp.json");
		expect(out).toContain("./package.json");
	});

	it("redacts API keys, bearer tokens and URL credentials", () => {
		const out = sanitizeErrorDetail(
			[
				"key napi_abcDEF123_-xyz",
				"Authorization: Bearer abc.def.ghi",
				"fetch https://user:hunter2@registry.example.com/x",
				'{"apiKey":"s3cret","password": "p4ss"}',
				"token=abc123",
			].join("\n"),
		);
		expect(out).not.toMatch(
			/abcDEF123|abc\.def\.ghi|hunter2|s3cret|p4ss|abc123/,
		);
		expect(out).toContain("napi_<redacted>");
		expect(out).toContain("Bearer <redacted>");
	});

	it("redacts the credential shapes registries and CI print", () => {
		const out = sanitizeErrorDetail(
			[
				"//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123",
				"clone with ghp_abcdefghijklmnopqrstuvwxyz0123456789",
				"Authorization: Basic dXNlcjpwYXNz",
				'{"password": "p 4 ss word"}',
			].join("\n"),
		);
		expect(out).not.toMatch(
			/abcdefghijklmnopqrstuvwxyz|dXNlcjpwYXNz|p 4 ss word/,
		);
	});

	it("redacts a secret passed as a flag or written with spaces", () => {
		const out = sanitizeErrorDetail(
			[
				"npx skills add --token abc123 --password=hunter2 --api-key 'k e y'",
				"password: my secret pass",
			].join("\n"),
		);
		expect(out).not.toMatch(/abc123|hunter2|k e y|my secret pass/);
	});

	it("takes the same short time however much a child printed", () => {
		// Sized so the unbounded version fails in seconds instead of hanging the suite.
		for (const text of [
			"a".repeat(60_000),
			"token".repeat(12_000),
			"--token ".repeat(7_500),
			`${" ".repeat(60_000)}x`,
			"password=".repeat(6_600),
		]) {
			const started = performance.now();
			sanitizeErrorDetail(text);
			expect(performance.now() - started).toBeLessThan(500);
		}
	});

	it("leaves a path that only shares a prefix with the working directory alone", () => {
		const cwd = process.cwd();
		const out = sanitizeErrorDetail(`${cwd}-old/x and ${cwd}/y`);
		// The sibling keeps its name (only the home directory above it is hidden).
		expect(out).toBe(`${cwd.replace(homedir(), "~")}-old/x and ./y`);
	});

	it("hides the home directory written with the other slash", () => {
		const other = homedir().replace(/\//g, "\\");
		expect(sanitizeErrorDetail(`open ${other}\\x`)).not.toContain(other);
	});

	it("keeps the end of long output, where a failed child puts the cause", () => {
		const out = sanitizeErrorDetail(
			`${"progress ".repeat(500)}the real cause`,
		);
		expect(out.length).toBeLessThanOrEqual(501);
		expect(out.endsWith("the real cause")).toBe(true);
		expect(out.startsWith("…")).toBe(true);
	});

	it("leaves short, clean text alone", () => {
		expect(sanitizeErrorDetail("  Failed to write config.  ")).toBe(
			"Failed to write config.",
		);
	});
});

describe("toolingErrorProperties", () => {
	it("is undefined for an error nothing described", () => {
		expect(
			toolingErrorProperties(new Error("boom"), "init"),
		).toBeUndefined();
	});

	it("reports the step, reason and what was being installed", () => {
		const error = new Error("skills CLI failed:\nnpm error code E403");
		attachToolingContext(error, {
			step: "skills",
			agents: ["cursor", "claude-code"],
			skills: ["neon", "neon-postgres"],
			scope: "project",
			exitCode: 1,
			initRunId: "run-1",
		});
		expect(toolingErrorProperties(error, "init")).toMatchObject({
			command: "init",
			step: "skills",
			errorKind: "registry_blocked",
			agents: ["cursor", "claude-code"],
			skills: ["neon", "neon-postgres"],
			scope: "project",
			exitCode: 1,
			initRunId: "run-1",
		});
	});

	it("sends a bounded, sanitized message and stack instead of the raw ones", () => {
		const error = new Error(
			`skills CLI failed:\n${"x".repeat(5000)}\nunder ${homedir()}/proj`,
		);
		attachToolingContext(error, { step: "skills" });
		const properties = toolingErrorProperties(error, "skills");
		expect(String(properties?.message).length).toBeLessThanOrEqual(501);
		expect(String(properties?.message)).not.toContain(homedir());
		expect(String(properties?.stack)).not.toContain("x".repeat(600));
	});

	it("keeps the stack readable when the message contains replacement patterns", () => {
		const error = new Error("child said $& and $' and $` and $$");
		attachToolingContext(error, { step: "skills" });
		const properties = toolingErrorProperties(error, "skills");
		expect(String(properties?.stack)).toContain(
			"child said $& and $' and $` and $$",
		);
	});

	it("scrubs and bounds the stack frames, not just the message", () => {
		const error = new Error("boom");
		attachToolingContext(error, { step: "skills" });
		error.stack = `Error: boom\n${`    at fn (${process.cwd()}/src/x.ts:1:1)\n`.repeat(400)}`;
		const stack = String(toolingErrorProperties(error, "skills")?.stack);
		expect(stack).not.toContain(process.cwd());
		expect(stack).toContain("at fn (./src/x.ts:1:1)");
		expect(stack.length).toBeLessThanOrEqual(2001);
	});

	it("builds the stack from the sanitized message, whatever the original stack held", () => {
		const error = new Error("secret message token=abc123");
		attachToolingContext(error, { step: "skills" });
		error.stack = "something unrelated\n    at fn (file.ts:1:1)";
		const stack = String(toolingErrorProperties(error, "skills")?.stack);
		expect(stack).toBe(
			"Error: secret message token=<redacted>\n    at fn (file.ts:1:1)",
		);
	});

	it("reports the reason of every failure behind one error", () => {
		const error = new Error("boom");
		attachToolingContext(error, {
			step: "skills",
			errorKinds: ["timeout", "permission_denied"],
		});
		expect(toolingErrorProperties(error, "skills")?.errorKinds).toEqual([
			"timeout",
			"permission_denied",
		]);
	});

	it("drops the retry command so it can't push the cause out of the bound", () => {
		const error = new Error(
			`skills CLI failed:\nnpm error code E403\nRetry with: neon skills ${"--skill x ".repeat(200)}`,
		);
		attachToolingContext(error, { step: "skills" });
		expect(toolingErrorProperties(error, "skills")?.message).toBe(
			"skills CLI failed:\nnpm error code E403",
		);
	});

	it("drops agent and skill names that aren't plain ids", () => {
		const error = new Error("boom");
		attachToolingContext(error, {
			step: "skills",
			skills: ["neon", "../../etc/passwd", "has space", "ok_1"],
			agents: ["cursor", "x".repeat(200)],
		});
		const properties = toolingErrorProperties(error, "skills");
		expect(properties?.skills).toEqual(["neon", "ok_1"]);
		expect(properties?.agents).toEqual(["cursor"]);
	});
});

describe("mergeToolingContexts", () => {
	it("takes each field from the first context that has it", () => {
		expect(
			mergeToolingContexts([
				undefined,
				{ exitCode: 1, signal: "SIGTERM" },
				{ exitCode: 2, detail: "later" },
			]),
		).toEqual({ exitCode: 1, signal: "SIGTERM", detail: "later" });
	});

	it("says timed out if any did", () => {
		expect(
			mergeToolingContexts([{ timedOut: false }, { timedOut: true }])
				.timedOut,
		).toBe(true);
		expect(mergeToolingContexts([{ timedOut: false }]).timedOut).toBe(
			false,
		);
	});

	it("is empty when nothing is known", () => {
		expect(mergeToolingContexts([undefined, undefined])).toEqual({});
	});
});
