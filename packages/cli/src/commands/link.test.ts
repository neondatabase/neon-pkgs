import { fork } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect } from "vitest";

import { test as originalTest } from "../test_utils/fixtures";

// All tests in this file share a single temporary directory whose path is
// normalized in snapshots to `<TMP>` so that absolute paths in command output
// remain stable across runs and machines.
const TEST_TMP = mkdtempSync(join(tmpdir(), "neonctl-link-"));

const TMP_TOKEN = "<TMP>";

beforeAll(() => {
	// Replace any reference to the per-run tmp directory with a stable token so
	// snapshots only carry the deterministic suffix portion of paths.
	expect.addSnapshotSerializer({
		test: (val) => typeof val === "string" && val.includes(TEST_TMP),
		serialize: (val, config, indentation, depth, refs, printer) =>
			printer(
				(val as string).split(TEST_TMP).join(TMP_TOKEN),
				config,
				indentation,
				depth,
				refs,
			),
	});
});

const test = originalTest.extend<{
	cleanupFile: (name: string) => void;
	readFile: (name: string) => string;
	tmpContext: (label: string) => string;
	runLinkInCi: (args: string[]) => Promise<{
		code: number;
		stdout: string;
		stderr: string;
	}>;
}>({
	cleanupFile: async ({}, use) => {
		let writtenFilename: string | undefined;
		await use((name) => (writtenFilename = name));
		if (writtenFilename) {
			try {
				rmSync(writtenFilename);
			} catch {
				// ignore
			}
		}
	},
	readFile: async ({ cleanupFile }, use) => {
		await use((name) => {
			const content = readFileSync(name, "utf-8");
			cleanupFile(name);
			return content;
		});
	},
	// Each test gets its OWN sub-directory under TEST_TMP so the
	// `.gitignore` scaffolded next to the `.neon` written by one test doesn't
	// affect another test in the same file.
	tmpContext: async ({}, use) => {
		await use((label) => {
			const dir = join(TEST_TMP, label);
			mkdirSync(dir, { recursive: true });
			return join(dir, ".neon");
		});
	},
	runLinkInCi: async ({ runMockServer }, use) => {
		await use(async (args) => {
			const server = await runMockServer("main");
			const port = (server.address() as AddressInfo).port;
			return new Promise((resolve, reject) => {
				const cp = fork(
					join(process.cwd(), "./dist/index.js"),
					[
						"--api-host",
						`http://localhost:${port}`,
						"--output",
						"yaml",
						"--api-key",
						"test-key",
						"--no-analytics",
						...args,
					],
					{
						stdio: "pipe",
						env: {
							PATH: `mocks/bin:${process.env.PATH}`,
							CI: "true",
						},
					},
				);
				let stdout = "";
				let stderr = "";
				cp.stdout?.on("data", (data: Buffer) => {
					stdout += data.toString();
				});
				cp.stderr?.on("data", (data: Buffer) => {
					stderr += data.toString();
				});
				cp.on("error", reject);
				cp.on("close", (code) => {
					resolve({ code: code ?? -1, stdout, stderr });
				});
			});
		});
	},
});

const expectNonInteractiveHelp = (text: string) => {
	const uniqueCommands = [
		"neon orgs list --output json",
		"neon projects list --org-id <org-id> --output json",
		"neon link --project-id <project-id> [--branch <name> | -y]",
		"neon link --org-id <org-id> --project-name <name> --region-id aws-us-east-2",
	];
	for (const command of uniqueCommands) {
		expect(text.split(command)).toHaveLength(2);
	}
	expect(text).toContain("neon link -y");
	expect(text).toContain("Organization-scoped API keys cannot list orgs");
};

describe("link", () => {
	describe("non-interactive flag mode", () => {
		test("link to existing project writes org+project, deferring the branch to checkout", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("flag_existing");
			await testCliCommand([
				"link",
				"--org-id",
				"org-2",
				"--project-id",
				"test",
				"--no-env-pull",
				"--context-file",
				ctx,
			]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("link --project-id alone infers the org from the project", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("flag_infer_org");
			await testCliCommand([
				"link",
				"--project-id",
				"proj-in-org",
				"--no-env-pull",
				"--context-file",
				ctx,
			]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("link --project-id pins the only branch", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("flag_one_branch");
			await testCliCommand([
				"link",
				"--project-id",
				"proj-one-branch",
				"--no-env-pull",
				"--context-file",
				ctx,
			]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("link --project-id -y pins the default branch, not the first listed", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("flag_yes_default");
			await testCliCommand([
				"link",
				"--project-id",
				"proj-in-org",
				"-y",
				"--no-env-pull",
				"--context-file",
				ctx,
			]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("link --project-id with no branches warns and does not pin", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("flag_no_branches");
			await testCliCommand([
				"link",
				"--project-id",
				"proj-no-branches",
				"--no-env-pull",
				"--context-file",
				ctx,
			]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("link --project-id -y with no default branch fails without writing .neon", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("flag_no_default");
			await testCliCommand(
				[
					"link",
					"--project-id",
					"proj-no-default",
					"-y",
					"--no-env-pull",
					"--context-file",
					ctx,
				],
				{
					code: 1,
					snapshot: false,
					stderr: expect.stringContaining(
						"Project 'proj-no-default' has no default branch. Pass --branch <name> to pin one.",
					),
				},
			);
			expect(existsSync(ctx)).toBe(false);
		});

		test("re-linking the same project with -y keeps the already-pinned branch", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("flag_keep_branch_yes");
			writeFileSync(
				ctx,
				JSON.stringify({
					orgId: "org-2",
					projectId: "test",
					branch: "test_branch",
				}),
			);
			await testCliCommand([
				"link",
				"--project-id",
				"test",
				"-y",
				"--no-env-pull",
				"--context-file",
				ctx,
			]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("link --branch-id pins the branch in an existing project", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("flag_branch");
			await testCliCommand([
				"link",
				"--project-id",
				"test",
				"--branch-id",
				"br-main-branch-123456",
				"--no-env-pull",
				"--context-file",
				ctx,
			]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("re-linking the same project keeps the already-pinned branch", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("flag_keep_branch");
			writeFileSync(
				ctx,
				JSON.stringify({
					orgId: "org-2",
					projectId: "test",
					branchId: "br-sunny-branch-123456",
				}),
			);
			await testCliCommand([
				"link",
				"--project-id",
				"test",
				"--no-env-pull",
				"--context-file",
				ctx,
			]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("link --params JSON behaves like flags", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("flag_params");
			await testCliCommand([
				"link",
				"--params",
				JSON.stringify({ orgId: "org-2", projectId: "test" }),
				"--no-env-pull",
				"--context-file",
				ctx,
			]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("link --org-id alone records the default org", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("flag_org_only");
			await testCliCommand([
				"link",
				"--org-id",
				"org-2",
				"--context-file",
				ctx,
			]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("link --clear empties the context file", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("flag_clear");
			writeFileSync(
				ctx,
				JSON.stringify({
					orgId: "org-2",
					projectId: "test",
					branchId: "br-main-branch-123456",
				}),
			);
			await testCliCommand(["link", "--clear", "--context-file", ctx]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("link creates a new project and writes .neon", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("flag_create");
			await testCliCommand([
				"link",
				"--org-id",
				"org-2",
				"--project-name",
				"test_project",
				"--region-id",
				"aws-us-east-2",
				"--no-env-pull",
				"--context-file",
				ctx,
			]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("conflicting inputs (--project-id with --project-name) fails", async ({
			testCliCommand,
			tmpContext,
		}) => {
			await testCliCommand(
				[
					"link",
					"--org-id",
					"org-2",
					"--project-id",
					"test",
					"--project-name",
					"test_project",
					"--context-file",
					tmpContext("flag_conflict"),
				],
				{
					code: 1,
					stderr: "ERROR: Conflicting inputs: --project-id selects an existing project; --project-name and --region-id describe a new one. Pass only one set.",
				},
			);
		});

		test("conflicting inputs (--project-name with --branch-id) fails", async ({
			testCliCommand,
			tmpContext,
		}) => {
			await testCliCommand(
				[
					"link",
					"--org-id",
					"org-2",
					"--project-name",
					"test_project",
					"--branch-id",
					"br-main-branch-123456",
					"--context-file",
					tmpContext("flag_conflict_branch"),
				],
				{
					code: 1,
					stderr: "ERROR: Conflicting inputs: --branch pins a branch of an existing project, but --project-name creates a new one. Create the project first, then `neon checkout <branch>`.",
				},
			);
		});

		test("invalid --params JSON fails with a parse error", async ({
			testCliCommand,
			tmpContext,
		}) => {
			await testCliCommand(
				[
					"link",
					"--params",
					"not-valid-json",
					"--context-file",
					tmpContext("flag_bad_params"),
				],
				{
					code: 1,
					snapshot: false,
					stderr: expect.stringContaining(
						"Failed to parse --params JSON",
					),
				},
			);
		});
	});

	describe("input verification", () => {
		test("unknown --project-id fails with a clear error", async ({
			testCliCommand,
			tmpContext,
		}) => {
			await testCliCommand(
				[
					"link",
					"--project-id",
					"ghost-project",
					"--no-env-pull",
					"--context-file",
					tmpContext("verify_no_project"),
				],
				{
					code: 1,
					stderr: "ERROR: Project 'ghost-project' not found. Double-check the project ID — or that your API key has access to it.",
				},
			);
		});

		test("--org-id that does not match the project fails with a mismatch error", async ({
			testCliCommand,
			tmpContext,
		}) => {
			await testCliCommand(
				[
					"link",
					"--project-id",
					"proj-in-org",
					"--org-id",
					"org-2",
					"--no-env-pull",
					"--context-file",
					tmpContext("verify_org_mismatch"),
				],
				{
					code: 1,
					stderr: "ERROR: Project 'proj-in-org' belongs to organization 'org-7', not 'org-2'. Omit --org-id to use the project's own org, or pass the matching ID.",
				},
			);
		});

		test("unknown --branch-id fails listing the available branches", async ({
			testCliCommand,
			tmpContext,
		}) => {
			await testCliCommand(
				[
					"link",
					"--project-id",
					"test",
					"--branch-id",
					"br-ghost-99999999",
					"--no-env-pull",
					"--context-file",
					tmpContext("verify_no_branch"),
				],
				{
					code: 1,
					stderr: expect.stringContaining(
						"Branch 'br-ghost-99999999' not found in project 'test'.",
					),
				},
			);
		});
	});

	describe("unknown --agent", () => {
		test("is an unknown argument", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const { code, stdout, stderr } = await testCliCommand(
				[
					"link",
					"--agent",
					"--context-file",
					tmpContext("agent_refused"),
				],
				{ code: 1, snapshot: false },
			);
			expect(code).toBe(1);
			expect(stdout.trim()).toBe("");
			expect(stderr).toMatch(/has no --agent/);
			expect(stderr).toMatch(/Pass --project-id/);
			expect(stderr).not.toMatch(/Unknown argument: agent/);
		});

		test("help omits --agent and lists the non-interactive commands", async ({
			testCliCommand,
		}) => {
			const { stdout, stderr } = await testCliCommand(
				["link", "--help"],
				{ snapshot: false },
			);
			const text = `${stdout}\n${stderr}`;
			expect(text).not.toContain("--agent");
			expect(text.replace(/\s+/g, "")).toContain("--no-config");
			expect(text).toContain("Select the only organization and project");
			expectNonInteractiveHelp(text);
		});
	});

	describe("org-scoped API key behavior", () => {
		test("links an existing project when org listing is forbidden", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("orgkey_project");
			await testCliCommand(
				[
					"link",
					"--project-id",
					"detected-project-12345",
					"--no-env-pull",
					"--context-file",
					ctx,
				],
				{ mockDir: "org-key" },
			);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("records --org-id when org listing is forbidden and no projects exist", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("orgkey_empty_org");
			await testCliCommand(
				["link", "--org-id", "org-from-console", "--context-file", ctx],
				{ mockDir: "org-key-empty" },
			);
			expect(readFile(ctx)).toMatchSnapshot();
		});
	});

	describe("non-interactive missing inputs", () => {
		test("errors with the replacement commands in CI", async ({
			runLinkInCi,
			tmpContext,
		}) => {
			const result = await runLinkInCi([
				"link",
				"--context-file",
				tmpContext("ci_guard"),
			]);
			expect(result.code).toBe(1);
			expect(result.stdout.trim()).toBe("");
			expect(result.stderr).toContain("no interactive terminal");
			expect(result.stderr).not.toContain("link --agent");
			expectNonInteractiveHelp(result.stderr);
		});

		test("errors with the replacement commands when there is no TTY", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const { stdout, stderr } = await testCliCommand(
				["link", "--context-file", tmpContext("no_tty_guard")],
				{ code: 1, snapshot: false },
			);
			expect(stdout.trim()).toBe("");
			expect(stderr).toContain("no interactive terminal");
			expect(stderr).not.toContain("link --agent");
			expectNonInteractiveHelp(stderr);
		});

		test("link -y in CI prints organizations instead of missing-input help", async ({
			runLinkInCi,
			tmpContext,
		}) => {
			const result = await runLinkInCi([
				"link",
				"-y",
				"--context-file",
				tmpContext("ci_yes"),
			]);
			expect(result.code).toBe(1);
			expect(result.stderr).not.toContain("no interactive terminal");
			expect(result.stderr).toContain(
				"Multiple organizations are available. Pass --org-id",
			);
			expect(result.stdout).toContain("Organization 1");
			expect(result.stdout).toContain("Organization 2");
		});
	});

	describe("-y auto-resolution", () => {
		test("one organization and one project links them", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_one");
			const { stdout } = await testCliCommand(
				["link", "-y", "--no-env-pull", "--context-file", ctx],
				{ mockDir: "link-yes-one", snapshot: false },
			);
			expect(stdout).toContain("orgId:     org-alpha");
			expect(stdout).toContain("projectId: project-api");
			expect(stdout).toContain("branch:    main");
			expect(JSON.parse(readFile(ctx))).toEqual({
				orgId: "org-alpha",
				projectId: "project-api",
				branch: "main",
			});
		});

		test("several organizations print ids and recover with --org-id", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_orgs");
			const listed = await testCliCommand(
				["link", "-y", "--no-env-pull", "--context-file", ctx],
				{
					mockDir: "link-yes-orgs",
					output: "json",
					code: 1,
					snapshot: false,
				},
			);
			expect(JSON.parse(listed.stdout)).toEqual([
				{ id: "org-alpha", name: "Alpha" },
				{ id: "org-beta", name: "Beta" },
			]);
			expect(listed.stderr).toContain(
				"Multiple organizations are available. Pass --org-id",
			);
			expect(listed.stderr).toContain("neon link -y --org-id <org-id>");
			expect(existsSync(ctx)).toBe(false);

			const linked = await testCliCommand(
				[
					"link",
					"-y",
					"--org-id",
					"org-alpha",
					"--no-env-pull",
					"--context-file",
					ctx,
				],
				{ mockDir: "link-yes-orgs", snapshot: false },
			);
			expect(linked.stderr).not.toContain("Multiple organizations");
			expect(JSON.parse(readFile(ctx))).toEqual({
				orgId: "org-alpha",
				projectId: "project-api",
				branch: "main",
			});
		});

		test("several projects print ids and name --project-id", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_projects");
			const { stdout, stderr } = await testCliCommand(
				[
					"link",
					"-y",
					"--org-id",
					"org-beta",
					"--no-env-pull",
					"--context-file",
					ctx,
				],
				{
					mockDir: "link-yes-orgs",
					output: "json",
					code: 1,
					snapshot: false,
				},
			);
			expect(JSON.parse(stdout)).toEqual([
				{ id: "project-web", name: "Web" },
				{ id: "project-worker", name: "Worker" },
			]);
			expect(stderr).toContain(
				"Multiple projects are available in organization 'org-beta'",
			);
			expect(stderr).toContain("neon link -y --project-id <project-id>");
			expect(existsSync(ctx)).toBe(false);
		});

		test("several projects keep --branch in the recovery command", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_projects_branch");
			const listed = await testCliCommand(
				[
					"link",
					"-y",
					"--org-id",
					"org-beta",
					"--branch",
					"dev",
					"--no-env-pull",
					"--context-file",
					ctx,
				],
				{
					mockDir: "link-yes-orgs",
					output: "json",
					code: 1,
					snapshot: false,
				},
			);
			expect(JSON.parse(listed.stdout)).toEqual([
				{ id: "project-web", name: "Web" },
				{ id: "project-worker", name: "Worker" },
			]);
			expect(listed.stderr).toContain(
				"neon link -y --project-id <project-id> --branch dev",
			);
			expect(existsSync(ctx)).toBe(false);

			await testCliCommand(
				[
					"link",
					"-y",
					"--project-id",
					"project-web",
					"--branch",
					"dev",
					"--no-env-pull",
					"--context-file",
					ctx,
				],
				{ mockDir: "link-yes-orgs", snapshot: false },
			);
			expect(JSON.parse(readFile(ctx))).toEqual({
				orgId: "org-beta",
				projectId: "project-web",
				branch: "dev",
			});
		});

		test("yaml ambiguity output is the candidate array", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const { stdout, stderr } = await testCliCommand(
				[
					"link",
					"--yes",
					"--no-env-pull",
					"--context-file",
					tmpContext("yes_yaml"),
				],
				{
					mockDir: "link-yes-orgs",
					output: "yaml",
					code: 1,
					snapshot: false,
				},
			);
			expect(stdout).toContain("id: org-alpha");
			expect(stdout).toContain("name: Alpha");
			expect(stdout).toContain("id: org-beta");
			expect(stderr).toContain("Pass --org-id");
		});

		test("table ambiguity output lists ids and names", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const { stdout, stderr } = await testCliCommand(
				[
					"link",
					"-y",
					"--no-env-pull",
					"--context-file",
					tmpContext("yes_table"),
				],
				{
					mockDir: "link-yes-orgs",
					output: "table",
					code: 1,
					snapshot: false,
				},
			);
			expect(stdout).toContain("Organizations");
			expect(stdout).toContain("org-alpha");
			expect(stdout).toContain("Alpha");
			expect(stdout).toContain("org-beta");
			expect(stderr).toContain("Pass --org-id");
		});

		test("one organization with no projects prints the create recipe", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_empty");
			const { stdout, stderr } = await testCliCommand(
				["link", "-y", "--no-env-pull", "--context-file", ctx],
				{ mockDir: "link-yes-empty", code: 1, snapshot: false },
			);
			expect(stdout.trim()).toBe("");
			expect(stderr).toContain(
				"No projects are available in organization 'org-alpha'",
			);
			expect(stderr).toContain(
				"neon link -y --org-id org-alpha --project-name <name> --region-id aws-us-east-2",
			);
			expect(existsSync(ctx)).toBe(false);
		});

		test("no organizations names --project-id", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_none");
			const { stdout, stderr } = await testCliCommand(
				["link", "-y", "--no-env-pull", "--context-file", ctx],
				{ mockDir: "link-yes-none", code: 1, snapshot: false },
			);
			expect(stdout.trim()).toBe("");
			expect(stderr).toContain(
				"No organizations were returned for this account",
			);
			expect(stderr).toContain("neon link -y --project-id <project-id>");
			expect(existsSync(ctx)).toBe(false);
		});

		test("no organizations keep --branch in the recovery command", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_none_branch");
			const listed = await testCliCommand(
				[
					"link",
					"-y",
					"--branch",
					"dev",
					"--no-env-pull",
					"--context-file",
					ctx,
				],
				{ mockDir: "link-yes-none", code: 1, snapshot: false },
			);
			expect(listed.stderr).toContain(
				"neon link -y --project-id <project-id> --branch dev",
			);
			expect(existsSync(ctx)).toBe(false);

			await testCliCommand(
				[
					"link",
					"-y",
					"--project-id",
					"project-api",
					"--branch",
					"dev",
					"--no-env-pull",
					"--context-file",
					ctx,
				],
				{ mockDir: "link-yes-none", snapshot: false },
			);
			expect(JSON.parse(readFile(ctx))).toEqual({
				orgId: "org-alpha",
				projectId: "project-api",
				branch: "dev",
			});
		});

		test("org-scoped key with one project auto-links it", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_orgkey");
			await testCliCommand(
				["link", "-y", "--no-env-pull", "--context-file", ctx],
				{ mockDir: "org-key", snapshot: false },
			);
			expect(JSON.parse(readFile(ctx))).toEqual({
				orgId: "org-detected-99887766",
				projectId: "detected-project-12345",
				branch: "main",
			});
		});

		test("org-scoped key with no projects asks for --org-id", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_orgkey_empty");
			const { stderr } = await testCliCommand(
				["link", "-y", "--no-env-pull", "--context-file", ctx],
				{ mockDir: "org-key-empty", code: 1, snapshot: false },
			);
			expect(stderr).toContain("organization-scoped");
			expect(stderr).toContain("--org-id");
			expect(existsSync(ctx)).toBe(false);
		});

		test("org-scoped empty org with -y --org-id prints the create recipe", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_orgkey_empty_org");
			const { stderr } = await testCliCommand(
				[
					"link",
					"-y",
					"--org-id",
					"org-from-console",
					"--no-env-pull",
					"--context-file",
					ctx,
				],
				{ mockDir: "org-key-empty", code: 1, snapshot: false },
			);
			expect(stderr).toContain(
				"No projects are available in organization 'org-from-console'",
			);
			expect(existsSync(ctx)).toBe(false);
		});

		test("link --org-id without -y still records the org only", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("org_only_no_yes");
			await testCliCommand(
				["link", "--org-id", "org-alpha", "--context-file", ctx],
				{ mockDir: "link-yes-empty", snapshot: false },
			);
			expect(JSON.parse(readFile(ctx))).toEqual({
				orgId: "org-alpha",
			});
		});

		test("--params org id with -y discovers the project", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_params_org");
			await testCliCommand(
				[
					"link",
					"-y",
					"--params",
					JSON.stringify({ orgId: "org-alpha" }),
					"--no-env-pull",
					"--context-file",
					ctx,
				],
				{ mockDir: "link-yes-orgs", snapshot: false },
			);
			expect(JSON.parse(readFile(ctx))).toEqual({
				orgId: "org-alpha",
				projectId: "project-api",
				branch: "main",
			});
		});

		test("name and region with one org creates the project", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_create");
			const { stdout } = await testCliCommand(
				[
					"link",
					"-y",
					"--project-name",
					"test_project",
					"--region-id",
					"aws-us-east-2",
					"--no-env-pull",
					"--context-file",
					ctx,
				],
				{ mockDir: "link-yes-one", snapshot: false },
			);
			expect(stdout).toContain("Created project new-project-123456");
			expect(JSON.parse(readFile(ctx))).toEqual({
				orgId: "org-alpha",
				projectId: "new-project-123456",
				branch: "main",
			});
		});

		test("name and region with several orgs keep those flags in the error", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_create_orgs");
			const { stderr } = await testCliCommand(
				[
					"link",
					"-y",
					"--project-name",
					"test_project",
					"--region-id",
					"aws-us-east-2",
					"--context-file",
					ctx,
				],
				{ mockDir: "link-yes-orgs", code: 1, snapshot: false },
			);
			expect(stderr).toContain(
				"neon link -y --org-id <org-id> --project-name test_project --region-id aws-us-east-2",
			);
			expect(existsSync(ctx)).toBe(false);
		});

		test("--project-name without --region-id names the missing flag", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_name_only");
			const { stderr } = await testCliCommand(
				[
					"link",
					"-y",
					"--org-id",
					"org-alpha",
					"--project-name",
					"test_project",
					"--context-file",
					ctx,
				],
				{ mockDir: "link-yes-one", code: 1, snapshot: false },
			);
			expect(stderr).toContain("--project-name requires --region-id");
			expect(stderr).toContain("--region-id aws-us-east-2");
			expect(existsSync(ctx)).toBe(false);
		});

		test("--org-id and --region-id without --project-name do not write org-only context", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_region_only");
			const { stderr } = await testCliCommand(
				[
					"link",
					"-y",
					"--org-id",
					"org-alpha",
					"--region-id",
					"aws-us-east-2",
					"--context-file",
					ctx,
				],
				{ mockDir: "link-yes-one", code: 1, snapshot: false },
			);
			expect(stderr).toContain("--region-id requires --project-name");
			expect(existsSync(ctx)).toBe(false);
		});

		test("--params region without name is the same incomplete-creation error", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_params_region");
			const { stderr } = await testCliCommand(
				[
					"link",
					"-y",
					"--params",
					JSON.stringify({
						orgId: "org-alpha",
						regionId: "aws-us-east-2",
					}),
					"--context-file",
					ctx,
				],
				{ mockDir: "link-yes-one", code: 1, snapshot: false },
			);
			expect(stderr).toContain("--region-id requires --project-name");
			expect(existsSync(ctx)).toBe(false);
		});

		test("existing context is left unchanged when -y cannot choose", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("yes_preserve");
			const original = {
				orgId: "org-old",
				projectId: "project-old",
				branch: "dev",
			};
			writeFileSync(ctx, JSON.stringify(original));
			const giPath = join(ctx, "..", ".gitignore");
			const configPath = join(ctx, "..", "neon.ts");
			writeFileSync(giPath, "node_modules\n");
			writeFileSync(configPath, "export default {};\n");
			await testCliCommand(
				["link", "-y", "--no-env-pull", "--context-file", ctx],
				{
					mockDir: "link-yes-orgs",
					code: 1,
					snapshot: false,
				},
			);
			expect(JSON.parse(readFileSync(ctx, "utf-8"))).toEqual(original);
			expect(readFileSync(giPath, "utf-8")).toBe("node_modules\n");
			expect(readFileSync(configPath, "utf-8")).toBe(
				"export default {};\n",
			);
		});

		test("paged project lists include every candidate", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const { stdout } = await testCliCommand(
				[
					"link",
					"-y",
					"--no-env-pull",
					"--context-file",
					tmpContext("yes_paged"),
				],
				{
					mockDir: "link-yes-paged",
					output: "json",
					code: 1,
					snapshot: false,
				},
			);
			const projects = JSON.parse(stdout) as Array<{
				id: string;
				name: string;
			}>;
			expect(projects).toHaveLength(102);
			expect(projects[0]).toEqual({
				id: "project-001",
				name: "Project 1",
			});
			expect(projects[101]).toEqual({
				id: "project-102",
				name: "Project 102",
			});
		});
	});

	describe("--no-checks (offline write)", () => {
		test("writes org+project with no API verification", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("nochecks_basic");
			await testCliCommand([
				"link",
				"--no-checks",
				"--org-id",
				"org-anything",
				"--project-id",
				"ghost-project",
				"--context-file",
				ctx,
			]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("writes org+project+branch when a branch is given", async ({
			testCliCommand,
			readFile,
			tmpContext,
		}) => {
			const ctx = tmpContext("nochecks_branch");
			await testCliCommand([
				"link",
				"--no-checks",
				"--org-id",
				"org-anything",
				"--project-id",
				"ghost-project",
				"--branch-id",
				"br-anything",
				"--context-file",
				ctx,
			]);
			expect(readFile(ctx)).toMatchSnapshot();
		});

		test("fails when org-id or project-id is missing", async ({
			testCliCommand,
			tmpContext,
		}) => {
			await testCliCommand(
				[
					"link",
					"--no-checks",
					"--project-id",
					"ghost-project",
					"--context-file",
					tmpContext("nochecks_missing"),
				],
				{
					code: 1,
					stderr: "ERROR: --no-checks writes the context with no API calls, so it needs both --org-id and --project-id (--branch is optional).",
				},
			);
		});
	});

	test("overwrites an existing .neon when re-linking non-interactively", async ({
		testCliCommand,
		readFile,
		tmpContext,
	}) => {
		const ctx = tmpContext("overwrite");
		writeFileSync(
			ctx,
			JSON.stringify({ orgId: "old", projectId: "old", branchId: "old" }),
		);
		await testCliCommand([
			"link",
			"--org-id",
			"org-2",
			"--project-id",
			"test",
			"--no-env-pull",
			"--context-file",
			ctx,
		]);
		expect(readFile(ctx)).toMatchSnapshot();
	});

	describe("gitignore scaffolding", () => {
		test("creates a .gitignore listing .neon next to the context file", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("gi_creates");
			await testCliCommand([
				"link",
				"--org-id",
				"org-2",
				"--project-id",
				"test",
				"--no-env-pull",
				"--context-file",
				ctx,
			]);
			const giPath = join(ctx, "..", ".gitignore");
			expect(readFileSync(giPath, "utf-8")).toBe(".neon\n");
		});

		test("appends .neon to an existing .gitignore without duplicating", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("gi_appends");
			const giPath = join(ctx, "..", ".gitignore");
			writeFileSync(giPath, "node_modules\ndist\n");
			await testCliCommand([
				"link",
				"--org-id",
				"org-2",
				"--project-id",
				"test",
				"--no-env-pull",
				"--context-file",
				ctx,
			]);
			expect(readFileSync(giPath, "utf-8")).toBe(
				"node_modules\ndist\n.neon\n",
			);

			// Re-link in the same dir must not produce a duplicate entry.
			await testCliCommand([
				"link",
				"--org-id",
				"org-2",
				"--project-id",
				"test",
				"--no-env-pull",
				"--context-file",
				ctx,
			]);
			expect(readFileSync(giPath, "utf-8")).toBe(
				"node_modules\ndist\n.neon\n",
			);
		});

		test("set-context also scaffolds .gitignore via the shared applyContext", async ({
			testCliCommand,
			tmpContext,
		}) => {
			const ctx = tmpContext("gi_set_context");
			await testCliCommand([
				"set-context",
				"--project-id",
				"test",
				"--context-file",
				ctx,
			]);
			const giPath = join(ctx, "..", ".gitignore");
			expect(readFileSync(giPath, "utf-8")).toBe(".neon\n");
		});
	});
});
