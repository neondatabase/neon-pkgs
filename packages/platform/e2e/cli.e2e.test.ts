import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect } from "vitest";
import { makeTempRepo } from "../src/lib/test-utils.js";
import {
	bootstrapProject,
	DEFAULT_REGION,
	detectApiKeyScope,
	e2eTest,
	makeRealApi,
	requireApiKey,
	uniqueProjectName,
} from "./helpers.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const PLATFORM_SRC = fileURLToPath(new URL("../src/v1.ts", import.meta.url));

interface CliRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runCli(
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CliRun> {
	return await new Promise((resolve, reject) => {
		if (!existsSync(CLI_PATH)) {
			reject(
				new Error(
					`CLI binary not built at ${CLI_PATH}. Run \`pnpm --filter @neondatabase/platform build\` first.`,
				),
			);
			return;
		}
		const child = spawn(process.execPath, [CLI_PATH, ...args], {
			cwd: options.cwd ?? process.cwd(),
			env: { ...process.env, ...options.env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", reject);
		child.on("close", (code) =>
			resolve({ exitCode: code ?? -1, stdout, stderr }),
		);
	});
}

describe("e2e — neon-ts CLI against real Neon API", () => {
	e2eTest(
		"`neon-ts pull` prints selected branch state JSON from the live project",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			const api = makeRealApi();

			let projectId: string;
			if (scope.kind === "org-or-user") {
				projectId = await bootstrapProject(api, {
					name: uniqueProjectName("cli-pull"),
					region: DEFAULT_REGION,
				});
				track(projectId);
			} else {
				projectId = scope.projectId;
			}

			const result = await runCli(["pull", "--project-id", projectId]);
			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.stdout);
			expect(parsed.project.name).toBeTruthy();
			expect(parsed.branch.name).toBeTruthy();
			expect(parsed.config).toBeDefined();
		},
	);

	e2eTest(
		"`neon-ts push` end-to-end against a temp repo with .neon/project.json + neon.ts",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;

			const api = makeRealApi();
			const projectName = uniqueProjectName("cli-push");

			// Bootstrap: create the project via the raw NeonApi so we have a known id to
			// put in .neon — `neon-ts push` itself never creates projects.
			const projectId = await bootstrapProject(api, {
				name: projectName,
				region: DEFAULT_REGION,
			});
			track(projectId);

			// Build a fake repo containing neon.ts (importing defineConfig from the local src)
			// and a `.neon/project.json` pointing at the just-created project.
			const repo = makeTempRepo({
				"package.json": "{}",
				".neon/project.json": JSON.stringify({
					projectId,
					branchId: (await api.listBranches(projectId)).find(
						(b) => b.isDefault,
					)?.id,
				}),
				"neon.ts": `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig((branch) => branch.name === "main" || branch.isDefault ? { protected: true } : { parent: "main" });
`,
			});

			try {
				const pushResult = await runCli(["push"], {
					cwd: repo.root,
					env: { NEON_API_KEY: requireApiKey() },
				});
				expect(pushResult.exitCode).toBe(0);
				expect(pushResult.stdout).toContain("branch");

				const branches = await api.listBranches(projectId);
				expect(branches.find((b) => b.isDefault)?.protected).toBe(true);
			} finally {
				repo.cleanup();
			}
		},
	);

	e2eTest(
		"`neon-ts context` reads NEON_PROJECT_ID + NEON_BRANCH_ID from env",
		async () => {
			const repo = makeTempRepo({ "package.json": "{}" });
			try {
				const result = await runCli(["context"], {
					cwd: repo.root,
					env: {
						NEON_PROJECT_ID: "proj-env",
						NEON_ORG_ID: "org-env",
						NEON_BRANCH_ID: "br-env-id",
					},
				});
				expect(result.exitCode).toBe(0);
				const parsed = JSON.parse(result.stdout);
				expect(parsed).toMatchObject({
					projectId: "proj-env",
					orgId: "org-env",
					branch: { kind: "id", value: "br-env-id" },
				});
			} finally {
				repo.cleanup();
			}
		},
	);

	e2eTest(
		"`neon-ts push` exits 2 (PushConflictError) when selected branch drifts and no --update-existing",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;

			const api = makeRealApi();
			const projectName = uniqueProjectName("cli-conflict");
			const projectId = await bootstrapProject(api, {
				name: projectName,
				region: DEFAULT_REGION,
			});
			track(projectId);

			const repo = makeTempRepo({
				"package.json": "{}",
				".neon/project.json": JSON.stringify({
					projectId,
					branchId: (await api.listBranches(projectId)).find(
						(b) => b.isDefault,
					)?.id,
				}),
				"neon.ts": `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig(() => ({ protected: true }));
`,
			});

			try {
				const result = await runCli(["push"], {
					cwd: repo.root,
					env: { NEON_API_KEY: requireApiKey() },
				});
				expect(result.exitCode).toBe(2);
				expect(result.stderr).toContain("conflict");
			} finally {
				repo.cleanup();
			}
		},
	);
});
