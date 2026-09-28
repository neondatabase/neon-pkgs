import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { test as originalTest } from "../test_utils/fixtures";
import { formatCheckoutPolicyFailure } from "./checkout";
import { ENV_PULL_SKIPPED_HINT } from "./env";

// All tests in this file share a single temporary directory whose path is
// normalized in snapshots to `<TMP>` so absolute paths in command output stay
// stable across runs and machines.
const TEST_TMP = mkdtempSync(join(tmpdir(), "neonctl-checkout-"));

const test = originalTest.extend<{
	readFile: (name: string) => string;
	removeFile: (name: string) => void;
	// Each test gets its OWN sub-directory under TEST_TMP so the `.gitignore`
	// scaffolded next to the `.neon` written by one test doesn't affect another.
	tmpContext: (label: string, seed?: Record<string, unknown>) => string;
}>({
	readFile: async ({}, use) => {
		await use((name) => readFileSync(name, "utf-8"));
	},
	removeFile: async ({}, use) => {
		await use((name) => {
			try {
				rmSync(name);
			} catch {
				// ignore
			}
		});
	},
	tmpContext: async ({}, use) => {
		await use((label, seed) => {
			const dir = join(TEST_TMP, label);
			mkdirSync(dir, { recursive: true });
			const ctx = join(dir, ".neon");
			if (seed) {
				writeFileSync(ctx, JSON.stringify(seed, null, 2));
			}
			return ctx;
		});
	},
});

const parseContext = (raw: string) =>
	JSON.parse(raw) as Record<string, unknown>;

describe("checkout", () => {
	test("resolves a branch by name and writes the branch name to a fresh .neon", async ({
		testCliCommand,
		readFile,
		tmpContext,
	}) => {
		const ctx = tmpContext("by_name_fresh");
		await testCliCommand([
			"checkout",
			"main",
			"--project-id",
			"test",
			"--no-env-pull",
			"--context-file",
			ctx,
		]);
		expect(parseContext(readFile(ctx))).toEqual({
			projectId: "test",
			branch: "main",
		});
	});

	test("resolves a branch name that is only on a later list page", async ({
		testCliCommand,
		readFile,
		tmpContext,
	}) => {
		const ctx = tmpContext("paged_name");
		await testCliCommand(
			[
				"checkout",
				"page-two",
				"--project-id",
				"proj-paged-branches",
				"--no-env-pull",
				"--context-file",
				ctx,
			],
			{ snapshot: false },
		);
		const pin = parseContext(readFile(ctx));
		expect(pin.projectId).toBe("proj-paged-branches");
		expect(pin.branch).toBe("page-two");
	});

	test("announces the branch currently pinned before switching to a new one", async ({
		testCliCommand,
		removeFile,
		tmpContext,
	}) => {
		// A `.neon` already pinned to `main`: checkout should report where we are
		// ("Currently on branch main") before it pins the new branch, so the switch
		// is visible and a wrong checkout is easy to spot.
		const ctx = tmpContext("announce_current", {
			projectId: "test",
			branch: "main",
		});
		await testCliCommand(
			["checkout", "test_branch", "--no-env-pull", "--context-file", ctx],
			{
				stderr:
					`INFO: → Currently on branch main ` +
					`INFO: Checked out branch br-sunny-branch-123456 on project test. Updated ${ctx}. ` +
					`INFO: ${ENV_PULL_SKIPPED_HINT}`,
			},
		);
		removeFile(ctx);
	});

	test("resolves a branch by id and writes the branch name to a fresh .neon", async ({
		testCliCommand,
		readFile,
		tmpContext,
	}) => {
		const ctx = tmpContext("by_id_fresh");
		await testCliCommand([
			"checkout",
			"br-sunny-branch-123456",
			"--project-id",
			"test",
			"--no-env-pull",
			"--context-file",
			ctx,
		]);
		expect(parseContext(readFile(ctx))).toEqual({
			projectId: "test",
			branch: "test_branch",
		});
	});

	test("preserves orgId/projectId already present in the .neon file", async ({
		testCliCommand,
		readFile,
		tmpContext,
	}) => {
		const ctx = tmpContext("preserve_org", {
			orgId: "org-keep",
			projectId: "test",
		});
		await testCliCommand([
			"checkout",
			"test_branch",
			"--no-env-pull",
			"--context-file",
			ctx,
		]);
		expect(parseContext(readFile(ctx))).toEqual({
			orgId: "org-keep",
			projectId: "test",
			branch: "test_branch",
		});
	});

	test("heals a missing orgId by resolving it from the project", async ({
		testCliCommand,
		readFile,
		tmpContext,
	}) => {
		// The .neon only has projectId; checkout should look up the project's
		// org_id and write all three fields so the context file ends up complete.
		const ctx = tmpContext("heal_org", { projectId: "test" });
		await testCliCommand(
			["checkout", "main", "--no-env-pull", "--context-file", ctx],
			{
				mockDir: "checkout_heal_org",
			},
		);
		expect(parseContext(readFile(ctx))).toEqual({
			orgId: "org-healed-123",
			projectId: "test",
			branch: "main",
		});
	});

	test("resolves projectId from the .neon file when no flag is passed", async ({
		testCliCommand,
		readFile,
		tmpContext,
	}) => {
		const ctx = tmpContext("project_from_file", { projectId: "test" });
		await testCliCommand([
			"checkout",
			"main",
			"--no-env-pull",
			"--context-file",
			ctx,
		]);
		expect(parseContext(readFile(ctx))).toEqual({
			projectId: "test",
			branch: "main",
		});
	});

	test("auto-detects the project when the API key maps to a single project", async ({
		testCliCommand,
		readFile,
		tmpContext,
	}) => {
		// No --project-id and a fresh .neon: checkout should fall
		// back to single-project auto-detection (same behaviour as branches / cs).
		const ctx = tmpContext("autodetect_single");
		await testCliCommand(
			["checkout", "main", "--no-env-pull", "--context-file", ctx],
			{
				mockDir: "single_project",
			},
		);
		expect(parseContext(readFile(ctx))).toEqual({
			projectId: "test-project-123456",
			branch: "main",
		});
	});

	test("fails with a telling error when no project can be resolved (non-interactive)", async ({
		testCliCommand,
		removeFile,
		tmpContext,
	}) => {
		// Fresh .neon, no --project-id, and the mock account has no projects so
		// single-project auto-detection can't pick one. The forked CLI has no TTY,
		// so we expect the telling error instead of a prompt.
		const ctx = tmpContext("no_project");
		await testCliCommand(["checkout", "main", "--context-file", ctx], {
			mockDir: "checkout_no_project",
			code: 1,
			stderr: "ERROR: Could not determine which Neon project to check out a branch from. Provide one via the --project-id flag or a .neon file (created by `neon link` / `neon set-context`).",
		});
		removeFile(ctx);
	});

	test("fails with a helpful error when the branch is not found", async ({
		testCliCommand,
		removeFile,
		tmpContext,
	}) => {
		const ctx = tmpContext("not_found");
		await testCliCommand(
			[
				"checkout",
				"does-not-exist",
				"--project-id",
				"test",
				"--context-file",
				ctx,
			],
			{
				code: 1,
				stderr: "ERROR: Branch does-not-exist not found. Pass --create to create it. Available branches: main, test_branch, 123, test_branch_with_fixed_cu, test_branch_with_autoscaling, protected_branch",
			},
		);
		removeFile(ctx);
	});

	test("errors when a branch id is not found (ids are never auto-created)", async ({
		testCliCommand,
		removeFile,
		tmpContext,
	}) => {
		// A `br-…` value is treated as an id and matched strictly; a non-existent
		// id is a hard not-found error (no create offer, even interactively).
		const ctx = tmpContext("id_not_found");
		await testCliCommand(
			[
				"checkout",
				"br-missing-branch-123456",
				"--project-id",
				"test",
				"--context-file",
				ctx,
			],
			{
				code: 1,
				stderr: "ERROR: Branch br-missing-branch-123456 not found. Available branches: main, test_branch, 123, test_branch_with_fixed_cu, test_branch_with_autoscaling, protected_branch",
			},
		);
		removeFile(ctx);
	});

	test("errors when no branch is given in a non-interactive context", async ({
		testCliCommand,
		removeFile,
		tmpContext,
	}) => {
		// Project resolves fine (from --project-id), but no branch was passed and
		// the forked CLI has no TTY, so the interactive picker is not available.
		const ctx = tmpContext("no_branch");
		await testCliCommand(
			["checkout", "--project-id", "test", "--context-file", ctx],
			{
				code: 1,
				stderr: "ERROR: No branch specified. Pass a branch name or id (e.g. `neon checkout main`), or run interactively to pick one from a list.",
			},
		);
		removeFile(ctx);
	});

	test("errors when --create is passed without a branch name", async ({
		testCliCommand,
		removeFile,
		tmpContext,
	}) => {
		const ctx = tmpContext("create_no_name");
		await testCliCommand(["checkout", "--create", "--context-file", ctx], {
			code: 1,
			stderr: "ERROR: No branch specified. Pass a branch name with --create (e.g. `neon checkout dev --create`).",
		});
		removeFile(ctx);
	});

	test("does not suggest --create when a branch id is missing", async ({
		testCliCommand,
		removeFile,
		tmpContext,
	}) => {
		const ctx = tmpContext("id_not_found_create");
		await testCliCommand(
			[
				"checkout",
				"br-missing-branch-123456",
				"--create",
				"--project-id",
				"test",
				"--context-file",
				ctx,
			],
			{
				code: 1,
				stderr: "ERROR: Branch br-missing-branch-123456 not found. Available branches: main, test_branch, 123, test_branch_with_fixed_cu, test_branch_with_autoscaling, protected_branch",
			},
		);
		removeFile(ctx);
	});

	test("--create on an existing name pins it and does not create", async ({
		testCliCommand,
		readFile,
		tmpContext,
	}) => {
		const ctx = tmpContext("create_existing");
		await testCliCommand([
			"checkout",
			"main",
			"--create",
			"--project-id",
			"test",
			"--no-env-pull",
			"--env",
			"/no/such-neon-checkout.env",
			"--context-file",
			ctx,
		]);
		expect(parseContext(readFile(ctx))).toEqual({
			projectId: "test",
			branch: "main",
		});
	});
});

describe("checkout --env", () => {
	test("help describes --env as a .env file path", async ({
		testCliCommand,
	}) => {
		const { stdout, stderr } = await testCliCommand(
			["checkout", "--help"],
			{
				snapshot: false,
			},
		);
		expect(`${stdout}\n${stderr}`).toContain("Path to a .env file");
	});

	test("help describes --create and the create examples", async ({
		testCliCommand,
	}) => {
		const { stdout, stderr } = await testCliCommand(
			["checkout", "--help"],
			{
				snapshot: false,
			},
		);
		const text = `${stdout}\n${stderr}`;
		expect(text).toContain("--create");
		expect(text).toContain("checkout dev --create");
		expect(text).toContain("checkout feat --create --env .env.local");
	});

	test("checking out an existing branch does not load --env", async ({
		testCliCommand,
		tmpContext,
	}) => {
		const ctx = tmpContext("existing_skips_env");
		await testCliCommand(
			[
				"checkout",
				"main",
				"--project-id",
				"test",
				"--no-env-pull",
				"--env",
				"/no/such/neon-checkout.env",
				"--context-file",
				ctx,
			],
			{ snapshot: false },
		);
	});
});

describe("checkout lifecycle hooks (Preview)", () => {
	test("checkout.before can rewrite the branch name before resolution", async ({
		testCliCommand,
		readFile,
		tmpContext,
	}) => {
		const ctx = tmpContext("hook_checkout_before");
		const dir = join(TEST_TMP, "hook_checkout_before");
		writeFileSync(
			join(dir, "neon.ts"),
			`export default {
				experimental: {
					hooks: {
						checkout: {
							before: (ctx) => {
								if (ctx.event.type === "neon-checkout" && ctx.event.inputName === "old-name") {
									return { name: "main" };
								}
							},
						},
					},
				},
			};\n`,
		);

		const { stderr } = await testCliCommand(
			[
				"checkout",
				"old-name",
				"--project-id",
				"test",
				"--no-env-pull",
				"--context-file",
				ctx,
			],
			{ cwd: dir, snapshot: false },
		);

		// The rename is announced, and the pinned branch is the hook's rewrite, not the typed name.
		expect(stderr).toContain("checkout.before hook mapped");
		expect(stderr).toContain("old-name");
		expect(stderr).toContain("main");
		expect(parseContext(readFile(ctx))).toEqual({
			projectId: "test",
			branch: "main",
		});
	});

	test("a broken neon.ts does not break checking out an existing branch (pre-hooks behavior)", async ({
		testCliCommand,
		readFile,
		tmpContext,
	}) => {
		const ctx = tmpContext("hook_broken_config_existing");
		const dir = join(TEST_TMP, "hook_broken_config_existing");
		writeFileSync(
			join(dir, "neon.ts"),
			"export default { this is not valid TS",
		);

		await testCliCommand(
			[
				"checkout",
				"main",
				"--project-id",
				"test",
				"--no-env-pull",
				"--context-file",
				ctx,
			],
			{ cwd: dir, snapshot: false },
		);

		expect(parseContext(readFile(ctx))).toEqual({
			projectId: "test",
			branch: "main",
		});
	});

	test("create.before fires only on an actual create, sees the typed event, and can abort it", async ({
		testCliCommand,
		tmpContext,
	}) => {
		const ctx = tmpContext("hook_create_before_abort");
		const dir = join(TEST_TMP, "hook_create_before_abort");
		writeFileSync(
			join(dir, "neon.ts"),
			`export default {
				experimental: {
					hooks: {
						create: {
							before: (ctx) => {
								throw new Error(
									"create.before saw branchName=" + ctx.branchName +
									" event.type=" + ctx.event.type,
								);
							},
						},
					},
				},
			};\n`,
		);

		// Checking out an EXISTING branch never creates one, so the hook must not fire —
		// and this must succeed rather than throw the hook's error.
		await testCliCommand(
			[
				"checkout",
				"main",
				"--project-id",
				"test",
				"--no-env-pull",
				"--context-file",
				ctx,
			],
			{ cwd: dir, snapshot: false },
		);

		// A genuine create (hook-created-branch doesn't exist in the fixture) does fire the
		// hook, and the thrown error aborts the checkout before anything is created or pinned.
		// (The name deliberately avoids the `br-…` shape — that's parsed as an id and never
		// auto-created, which would skip `createCheckoutBranch` entirely.)
		await testCliCommand(
			[
				"checkout",
				"hook-created-branch",
				"--create",
				"--project-id",
				"test",
				"--no-env-pull",
				"--context-file",
				ctx,
			],
			{
				cwd: dir,
				snapshot: false,
				code: 1,
				stderr: `INFO: → Currently on branch main ERROR: create.before saw branchName=hook-created-branch event.type=neon-checkout`,
			},
		);
	});
});

describe("formatCheckoutPolicyFailure", () => {
	test("includes --env on the deploy and checkout retries when checkout had one", () => {
		const message = formatCheckoutPolicyFailure({
			branchName: "feat",
			branchId: "br-x",
			failure: "unset RESEND_API_KEY",
			env: ".env.local",
		});
		expect(message).toContain(
			"neon deploy --update-existing --env .env.local",
		);
		expect(message).toContain(
			"neon checkout feat --create --env .env.local",
		);
	});
});
