import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { test } from "../test_utils/fixtures";

const esbuildBin = join(process.cwd(), "node_modules", ".bin", "esbuild");

let fnDir: string;
beforeAll(() => {
	fnDir = mkdtempSync(join(tmpdir(), "neonctl-fn-"));
	writeFileSync(join(fnDir, "index.ts"), "export default {};\n");
});
afterAll(() => {
	rmSync(fnDir, { recursive: true, force: true });
});

describe("functions", () => {
	test("deploy --no-wait", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"nowaitfunc",
				"--src",
				fnDir,
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: esbuildBin,
				},
				stderr:
					"INFO: Function deployment triggered for function nowaitfunc. " +
					"INFO: Check status with: neon function get nowaitfunc " +
					"--project-id test-project-123456 --branch br-main-branch-123456",
			},
		);
	});

	test("list (yaml)", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"list",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org" },
		);
	});

	test("list (table)", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"list",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org", outputTable: true },
		);
	});

	test("list with implicit project and branch", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["functions", "list"], { mockDir: "single_org" });
	});

	test('list resolves via the primary "function" command', async ({
		testCliCommand,
	}) => {
		await testCliCommand(["function", "list"], { mockDir: "single_org" });
	});

	test("get (yaml)", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"get",
				"my-func",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org" },
		);
	});

	test("get (table)", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"get",
				"my-func",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org", outputTable: true },
		);
	});

	test("get with no active deployment", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"get",
				"other-func",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org", outputTable: true },
		);
	});

	test("get (table) with only an active deployment (old server)", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"get",
				"activeonly",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org", outputTable: true },
		);
	});

	test("get (table) shows the build failure reason", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"get",
				"brokenfunc",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org", outputTable: true },
		);
	});

	test("get (yaml) includes the build failure reason", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"get",
				"brokenfunc",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org" },
		);
	});

	test("get (table) shows plain failed status when there is no error", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"get",
				"failednoerr",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org", outputTable: true },
		);
	});

	test("get --list-env-variables lists env variable names", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"get",
				"envnames",
				"--list-env-variables",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org", outputTable: true },
		);
	});

	test("get -E with no env variables prints an empty message", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"get",
				"my-func",
				"-E",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org", outputTable: true },
		);
	});

	test("get --list-env-variables with no active deployment prints an empty message", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"get",
				"other-func",
				"--list-env-variables",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org", outputTable: true },
		);
	});

	test("get (yaml) includes environment names", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"get",
				"envnames",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org" },
		);
	});

	test("get (yaml) -E is a no-op", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"get",
				"envnames",
				"-E",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org" },
		);
	});

	test("deploy --wait until completed", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"redeploy",
				"--src",
				fnDir,
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: esbuildBin,
				},
				stderr:
					"INFO: Function deployment triggered for function redeploy. " +
					"INFO: Function deployment redeploy/2 completed.",
			},
		);
	});

	test("deploy --wait on first deploy (no prior active version)", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"newfunc",
				"--src",
				fnDir,
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: esbuildBin,
				},
				stderr:
					"INFO: Function deployment triggered for function newfunc. " +
					"INFO: Function deployment newfunc/1 completed.",
			},
		);
	});

	test("deploy --wait exits 1 when the deployment fails", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"failfunc",
				"--src",
				fnDir,
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				outputTable: true,
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: esbuildBin,
				},
				stderr:
					"INFO: Function deployment triggered for function failfunc. " +
					"ERROR: Function deployment failfunc/1 failed.",
			},
		);
	});

	test("deploy --wait times out when the deployment never becomes active", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"stuckstart",
				"--src",
				fnDir,
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_FUNCTIONS_POLL_TIMEOUT_MS: "10",
					NEON_ESBUILD_PATH: esbuildBin,
				},
				stderr:
					"INFO: Function deployment triggered for function stuckstart. " +
					"INFO: Check status with: neon function get stuckstart " +
					"--project-id test-project-123456 --branch br-main-branch-123456 " +
					"ERROR: Timed out waiting for the deployment of stuckstart to start. " +
					"It may still be in progress.",
			},
		);
	});

	test("deploy --wait times out while the new version is still building", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"stuckbuild",
				"--src",
				fnDir,
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_FUNCTIONS_POLL_TIMEOUT_MS: "10",
					NEON_ESBUILD_PATH: esbuildBin,
				},
				stderr:
					"INFO: Function deployment triggered for function stuckbuild. " +
					"INFO: Check status with: neon function get stuckbuild " +
					"--project-id test-project-123456 --branch br-main-branch-123456 " +
					"ERROR: Timed out waiting for function deployment stuckbuild/1 to finish. " +
					"It may still be building.",
			},
		);
	});

	test("deploy --env encodes environment as JSON", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"envfunc",
				"--src",
				fnDir,
				"--no-wait",
				"--env",
				"KEY=VALUE",
				"--env",
				"A=B",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: esbuildBin,
				},
				stderr:
					"INFO: Function deployment triggered for function envfunc. " +
					"INFO: Check status with: neon function get envfunc " +
					"--project-id test-project-123456 --branch br-main-branch-123456",
			},
		);
	});

	test("deploy rejects malformed --env", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"myfunc",
				"--src",
				fnDir,
				"--no-wait",
				"--env",
				"NOEQUALS",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: 'ERROR: Invalid --env value "NOEQUALS". Expected KEY=VALUE.',
			},
		);
	});

	test("deploy rejects an invalid slug", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"Bad_Slug",
				"--src",
				fnDir,
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: 'ERROR: Invalid function slug "Bad_Slug". Use 1-20 lowercase letters and digits (no hyphens or other characters).',
			},
		);
	});

	test("deploy rejects a hyphenated slug", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"my-func",
				"--src",
				fnDir,
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: 'ERROR: Invalid function slug "my-func". Use 1-20 lowercase letters and digits (no hyphens or other characters).',
			},
		);
	});

	test("delete", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"delete",
				"my-func",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				stderr: "INFO: Function my-func deleted from branch br-main-branch-123456",
			},
		);
	});

	test("delete reports a friendly error when the function is missing", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"delete",
				"ghost-func",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: 'ERROR: Function "ghost-func" not found on branch br-main-branch-123456.',
			},
		);
	});

	test("domains list (yaml)", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"domains",
				"list",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org" },
		);
	});

	test("domains list (table)", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"domains",
				"list",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org", outputTable: true },
		);
	});

	test("domain alias lists custom domains", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"function",
				"domain",
				"list",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{ mockDir: "single_org" },
		);
	});

	test("domains register (yaml)", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"domains",
				"register",
				"docs.example.com",
				"--slug",
				"api",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				stderr: "INFO: CNAME docs.example.com to abc.custom.neon.tech",
			},
		);
	});

	test("domains register rejects an invalid slug", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"domains",
				"register",
				"docs.example.com",
				"--slug",
				"Bad_Slug",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: 'ERROR: Invalid function slug "Bad_Slug". Use 1-20 lowercase letters and digits (no hyphens or other characters).',
			},
		);
	});

	test("domains delete", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"domains",
				"delete",
				"docs.example.com",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				stderr: "INFO: Custom domain docs.example.com deleted from branch br-main-branch-123456",
			},
		);
	});

	test("domains delete reports a friendly error when the domain is missing", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"domains",
				"delete",
				"missing.example.com",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: 'ERROR: Custom domain "missing.example.com" not found on branch br-main-branch-123456.',
			},
		);
	});

	test("deploy errors when the entry file is missing", async ({
		testCliCommand,
	}) => {
		const emptyDir = mkdtempSync(join(tmpdir(), "neonctl-empty-"));
		await testCliCommand(
			[
				"functions",
				"deploy",
				"myfunc",
				"--src",
				emptyDir,
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: `ERROR: No entry file found in ${emptyDir}. Expected one of: index.ts, index.js, index.mjs.`,
			},
		);
		rmSync(emptyDir, { recursive: true, force: true });
	});

	test("deploy requires at least one option", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"myfunc",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr:
					"ERROR: Provide at least one option to deploy, e.g. --src, --env, or --no-bundle. " +
					"See: neon function deploy --help.",
			},
		);
	});

	test("deploy picks index.ts over index.mjs and index.js", async ({
		testCliCommand,
	}) => {
		const dir = mkdtempSync(join(tmpdir(), "neonctl-tsjs-"));
		writeFileSync(join(dir, "index.ts"), "export default {};\n");
		// Broken decoys: if discovery picks either, bundling fails and so does the test.
		writeFileSync(join(dir, "index.mjs"), "export default {\n");
		writeFileSync(join(dir, "index.js"), "export default {\n");
		await testCliCommand(
			[
				"functions",
				"deploy",
				"tsoverjs",
				"--src",
				dir,
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: esbuildBin,
				},
				stderr:
					"INFO: Function deployment triggered for function tsoverjs. " +
					"INFO: Check status with: neon function get tsoverjs " +
					"--project-id test-project-123456 --branch br-main-branch-123456",
			},
		);
		rmSync(dir, { recursive: true, force: true });
	});

	test("deploy picks index.js over index.mjs", async ({ testCliCommand }) => {
		const dir = mkdtempSync(join(tmpdir(), "neonctl-jsmjs-"));
		writeFileSync(join(dir, "index.js"), "export default {};\n");
		// Broken decoy: if discovery picks index.mjs, bundling fails and so does the test.
		writeFileSync(join(dir, "index.mjs"), "export default {\n");
		await testCliCommand(
			[
				"functions",
				"deploy",
				"jsovermjs",
				"--src",
				dir,
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: esbuildBin,
				},
				stderr:
					"INFO: Function deployment triggered for function jsovermjs. " +
					"INFO: Check status with: neon function get jsovermjs " +
					"--project-id test-project-123456 --branch br-main-branch-123456",
			},
		);
		rmSync(dir, { recursive: true, force: true });
	});

	test("deploy bundles index.js when it is the only entry", async ({
		testCliCommand,
	}) => {
		const dir = mkdtempSync(join(tmpdir(), "neonctl-jsonly-"));
		writeFileSync(join(dir, "index.js"), "export default {};\n");
		await testCliCommand(
			[
				"functions",
				"deploy",
				"jsonly",
				"--src",
				dir,
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: esbuildBin,
				},
				stderr:
					"INFO: Function deployment triggered for function jsonly. " +
					"INFO: Check status with: neon function get jsonly " +
					"--project-id test-project-123456 --branch br-main-branch-123456",
			},
		);
		rmSync(dir, { recursive: true, force: true });
	});

	test("deploy --src pointing at a file uses it as the entry", async ({
		testCliCommand,
	}) => {
		const dir = mkdtempSync(join(tmpdir(), "neonctl-srcfile-"));
		writeFileSync(join(dir, "custom.ts"), "export default {};\n");
		// Broken decoy: if --src=<file> still ran directory discovery, index.ts
		// would win, bundling would fail, and so would the test.
		writeFileSync(join(dir, "index.ts"), "export default {\n");
		await testCliCommand(
			[
				"functions",
				"deploy",
				"srcfile",
				"--src",
				join(dir, "custom.ts"),
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: esbuildBin,
				},
				stderr:
					"INFO: Function deployment triggered for function srcfile. " +
					"INFO: Check status with: neon function get srcfile " +
					"--project-id test-project-123456 --branch br-main-branch-123456",
			},
		);
		rmSync(dir, { recursive: true, force: true });
	});

	test("deploy --no-bundle zips a directory without esbuild", async ({
		testCliCommand,
	}) => {
		const dir = mkdtempSync(join(tmpdir(), "neonctl-nobundle-"));
		writeFileSync(
			join(dir, "index.mjs"),
			"export default { fetch: () => new Response('ok') };\n",
		);
		writeFileSync(join(dir, "chunk.mjs"), "export const x = 1;\n");
		await testCliCommand(
			[
				"functions",
				"deploy",
				"nobundle",
				"--src",
				dir,
				"--no-bundle",
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: join(tmpdir(), "no-such-esbuild"),
				},
				stderr:
					"INFO: Function deployment triggered for function nobundle. " +
					"INFO: Check status with: neon function get nobundle " +
					"--project-id test-project-123456 --branch br-main-branch-123456",
			},
		);
		rmSync(dir, { recursive: true, force: true });
	});

	test("deploy --no-bundle without --src zips the working directory", async ({
		testCliCommand,
	}) => {
		const dir = mkdtempSync(join(tmpdir(), "neonctl-nobundle-cwd-"));
		writeFileSync(
			join(dir, "index.mjs"),
			"export default { fetch: () => new Response('ok') };\n",
		);
		await testCliCommand(
			[
				"functions",
				"deploy",
				"nbcwd",
				"--no-bundle",
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				cwd: dir,
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: join(tmpdir(), "no-such-esbuild"),
				},
				stderr:
					"INFO: Function deployment triggered for function nbcwd. " +
					"INFO: Check status with: neon function get nbcwd " +
					"--project-id test-project-123456 --branch br-main-branch-123456",
			},
		);
		rmSync(dir, { recursive: true, force: true });
	});

	test("deploy --no-bundle zips a single index.mjs file", async ({
		testCliCommand,
	}) => {
		const dir = mkdtempSync(join(tmpdir(), "neonctl-nobundle-file-"));
		const file = join(dir, "index.mjs");
		writeFileSync(
			file,
			"export default { fetch: () => new Response('ok') };\n",
		);
		await testCliCommand(
			[
				"functions",
				"deploy",
				"nbfile",
				"--src",
				file,
				"--no-bundle",
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: join(tmpdir(), "no-such-esbuild"),
				},
				stderr:
					"INFO: Function deployment triggered for function nbfile. " +
					"INFO: Check status with: neon function get nbfile " +
					"--project-id test-project-123456 --branch br-main-branch-123456",
			},
		);
		rmSync(dir, { recursive: true, force: true });
	});

	test("deploy --no-bundle rejects TypeScript", async ({
		testCliCommand,
	}) => {
		const dir = mkdtempSync(join(tmpdir(), "neonctl-nobundle-ts-"));
		writeFileSync(join(dir, "index.ts"), "export default {};\n");
		await testCliCommand(
			[
				"functions",
				"deploy",
				"nbts",
				"--src",
				dir,
				"--no-bundle",
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: `ERROR: TypeScript must be bundled. ${dir} has no index.mjs or index.js; omit --no-bundle to esbuild it, or emit one of those files.`,
			},
		);
		rmSync(dir, { recursive: true, force: true });
	});

	test("deploy --no-bundle rejects a file not named index.mjs or index.js", async ({
		testCliCommand,
	}) => {
		const dir = mkdtempSync(join(tmpdir(), "neonctl-nobundle-name-"));
		const file = join(dir, "handler.mjs");
		writeFileSync(file, "export default {};\n");
		await testCliCommand(
			[
				"functions",
				"deploy",
				"nbname",
				"--src",
				file,
				"--no-bundle",
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: `ERROR: ${file} must be named index.mjs or index.js to ship with --no-bundle (got "handler.mjs"). Omit --no-bundle to esbuild it, or rename the file.`,
			},
		);
		rmSync(dir, { recursive: true, force: true });
	});

	test("deploy --no-bundle rejects a directory with no root index.mjs or index.js", async ({
		testCliCommand,
	}) => {
		const dir = mkdtempSync(join(tmpdir(), "neonctl-nobundle-nested-"));
		writeFileSync(join(dir, "handler.mjs"), "export default {};\n");
		await testCliCommand(
			[
				"functions",
				"deploy",
				"nested",
				"--src",
				dir,
				"--no-bundle",
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: expect.stringContaining("no entry module at its root"),
			},
		);
		rmSync(dir, { recursive: true, force: true });
	});

	test("deploy --help documents --no-bundle and discovery order", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["functions", "deploy", "--help"], {
			mockDir: "single_org",
			stderr: expect.stringContaining("--no-bundle"),
		});
		await testCliCommand(["functions", "deploy", "--help"], {
			mockDir: "single_org",
			stderr: expect.stringContaining("index.ts, index.js, or index.mjs"),
		});
	});

	test("deploy errors when the --src path does not exist", async ({
		testCliCommand,
	}) => {
		const missing = join(tmpdir(), "neonctl-no-such-path");
		await testCliCommand(
			[
				"functions",
				"deploy",
				"myfunc",
				"--src",
				missing,
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: `ERROR: --src path not found: ${missing}.`,
			},
		);
	});

	// Passes ONLY --path (no --src/--env): also pins that the removal error fires
	// before the at-least-one-option guard.
	test("deploy rejects the removed --path flag", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"myfunc",
				"--path",
				fnDir,
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr:
					"ERROR: --path and --entry were removed. Use --src <dir>; the entry point " +
					"is discovered as index.ts, index.js, index.mjs in that directory.",
			},
		);
	});

	test("deploy rejects the removed --entry flag", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"myfunc",
				"--src",
				fnDir,
				"--entry",
				"custom.ts",
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr:
					"ERROR: --path and --entry were removed. Use --src <dir>; the entry point " +
					"is discovered as index.ts, index.js, index.mjs in that directory.",
			},
		);
	});

	test("deploy --wait retries through a transient poll error", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"flaky",
				"--src",
				fnDir,
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: esbuildBin,
				},
				stderr:
					"INFO: Function deployment triggered for function flaky. " +
					"INFO: Function deployment flaky/1 completed.",
			},
		);
	});

	test("deploy --wait surfaces a non-transient poll error", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"functions",
				"deploy",
				"denied",
				"--src",
				fnDir,
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				env: {
					NEON_FUNCTIONS_POLL_INTERVAL_MS: "1",
					NEON_ESBUILD_PATH: esbuildBin,
				},
				stderr:
					"INFO: Function deployment triggered for function denied. " +
					"ERROR: Forbidden",
			},
		);
	});

	// esbuild's diagnostic text is environment-specific, so assert the exit code
	// and the empty stdout snapshot only - not the stderr string.
	test("deploy fails cleanly when bundling fails", async ({
		testCliCommand,
	}) => {
		const badDir = mkdtempSync(join(tmpdir(), "neonctl-bad-"));
		writeFileSync(join(badDir, "index.ts"), "export default {\n");
		await testCliCommand(
			[
				"functions",
				"deploy",
				"myfunc",
				"--src",
				badDir,
				"--no-wait",
				"--project-id",
				"test-project-123456",
				"--branch",
				"main",
			],
			{
				mockDir: "single_org",
				code: 1,
				env: { NEON_ESBUILD_PATH: esbuildBin },
			},
		);
		rmSync(badDir, { recursive: true, force: true });
	});
});
