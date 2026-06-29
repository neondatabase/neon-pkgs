import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe } from "vitest";

import { test } from "../test_utils/fixtures";

// `neon status` is a top-level alias of `neon config status`. These guard the two
// behaviors that the alias wiring can break: (1) a bare `status` must run the handler
// rather than being swallowed by the help-fallback middleware (it must be in
// NO_SUBCOMMANDS_VERBS), and (2) `--current-branch` must work through the alias exactly
// as it does on `config status` (offline, reading `.neon`).
describe("status (alias of config status)", () => {
	let workspace: string;
	let contextFile: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "neonctl-status-alias-"));
		contextFile = join(workspace, ".neon");
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	test("`status --current-branch` prints the pinned branch offline", async ({
		testCliCommand,
	}) => {
		writeFileSync(
			contextFile,
			JSON.stringify({ orgId: "org-x", branch: "feat-alias" }),
		);

		await testCliCommand(
			["status", "--current-branch", "--context-file", contextFile],
			{
				unreachableHost: true,
				code: 0,
			},
		);
	});
});
