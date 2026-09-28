import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCredentialInputs } from "@neon-internals/cli-core/auth_selection";
import { afterEach, describe, expect, test } from "vitest";
import { runAuthenticatedMcp } from "./auth.js";

const host = "https://console.neon.tech/api/v2";

const clearCredentialInputs = () =>
	recordCredentialInputs({
		apiKeyFlag: "",
		apiKeyEnv: "",
		profileEnv: "",
		profileFlag: "",
		configDir: "",
	});

describe("runAuthenticatedMcp", () => {
	const dirs: string[] = [];

	afterEach(() => {
		clearCredentialInputs();
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Regression test: ensureAuth's own `isMcpOauth` skip reads the real process.argv for
	// `--oauth`, which a `neon init`/`bootstrap` process never has (it has `--mcp-auth
	// oauth` instead). Without the `options.oauth` short-circuit in runAuthenticatedMcp,
	// this used to attempt full credential resolution and could throw on an unrelated bad
	// profile or expired session, even though the oauth install path never reads a
	// credential at all.
	test("oauth install succeeds even with an invalid profile configured", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "neon-mcp-auth-oauth-"));
		const cwd = mkdtempSync(join(tmpdir(), "neon-mcp-auth-cwd-"));
		mkdirSync(join(cwd, ".cursor"));
		dirs.push(configDir, cwd);
		recordCredentialInputs({
			apiKeyFlag: "",
			apiKeyEnv: "",
			profileEnv: "",
			profileFlag: "missing-profile",
			configDir,
		});

		const outcome = await runAuthenticatedMcp({
			apiClient: undefined as never,
			apiKey: "",
			apiHost: host,
			contextFile: join(cwd, ".neon"),
			configDir,
			cwd,
			yes: true,
			oauth: true,
			project: true,
			agent: ["cursor"],
		});

		expect(outcome.auth).toBe("oauth");
		expect(outcome.rows).toEqual([
			{ agent: "cursor", status: "installed" },
		]);
	});

	// Without --oauth and without any stored/explicit credential, this must surface the
	// same graceful error the standalone `neon mcp` command gives (see
	// commands/mcp.ts's own check) rather than crash or hang on an interactive login —
	// `ensureAuth`'s `isMcpCommand` branch is what keeps it from trying one.
	test("api-key install with no credentials surfaces the standalone auth-required error", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "neon-mcp-auth-none-"));
		const cwd = mkdtempSync(join(tmpdir(), "neon-mcp-auth-cwd2-"));
		mkdirSync(join(cwd, ".cursor"));
		dirs.push(configDir, cwd);
		recordCredentialInputs({
			apiKeyFlag: "",
			apiKeyEnv: "",
			profileEnv: "",
			profileFlag: "",
			configDir,
		});

		await expect(
			runAuthenticatedMcp({
				apiClient: undefined as never,
				apiKey: "",
				apiHost: host,
				contextFile: join(cwd, ".neon"),
				configDir,
				cwd,
				yes: true,
				oauth: false,
				project: true,
				agent: ["cursor"],
			}),
		).rejects.toThrow(/Authentication required/);
	});
});
