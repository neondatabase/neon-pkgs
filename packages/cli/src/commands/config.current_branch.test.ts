import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";

import { test } from "../test_utils/fixtures";

// End-to-end guard for `(config) status --current-branch`: it must read the pinned
// branch from `.neon` and make ZERO network calls. We point the CLI at an unreachable
// host (`unreachableHost`) — so if ANY middleware (auth token refresh, single-project
// resolution) or the handler tried the API, the command would fail instead of exiting 0.
// The fixture `.neon` deliberately omits `projectId`, which is exactly what would force
// `fillSingleProject` to hit the network if its offline guard regressed.
describe("config status --current-branch (offline, end to end)", () => {
	let workspace: string;
	let contextFile: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "neonctl-curbranch-"));
		contextFile = join(workspace, ".neon");
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	test("prints the pinned branch with no network access", async ({
		testCliCommand,
	}) => {
		writeFileSync(
			contextFile,
			JSON.stringify({ orgId: "org-x", branch: "my-feature" }),
		);

		await testCliCommand(
			[
				"config",
				"status",
				"--current-branch",
				"--context-file",
				contextFile,
			],
			{
				unreachableHost: true,
				code: 0,
				// stdout is snapshotted by the fixture; it must be exactly the branch name.
			},
		);
	});

	test("exits non-zero with empty stdout when no branch is pinned (no network access)", async ({
		testCliCommand,
	}) => {
		writeFileSync(contextFile, JSON.stringify({ orgId: "org-x" }));

		await testCliCommand(
			[
				"config",
				"status",
				"--current-branch",
				"--context-file",
				contextFile,
			],
			{
				unreachableHost: true,
				// grep-style: "no branch pinned" is a non-zero "no result", so a shell
				// prompt can guard on it directly. Empty stdout; hint on stderr.
				code: 1,
				stderr: expect.stringContaining("Run `neon checkout <branch>`"),
			},
		);
	});
});
