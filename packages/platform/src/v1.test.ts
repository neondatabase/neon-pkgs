import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FakeNeonApi } from "./lib/fake-neon-api.js";
import { makeTempRepo, stubCleanNeonEnv } from "./lib/test-utils.js";
import {
	type Config,
	defineConfig,
	loadConfigFromFile,
	loadContext,
	pullConfig,
	pushConfig,
} from "./v1.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

beforeEach(() => {
	stubCleanNeonEnv();
});

function setup(files: Record<string, string | null>) {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

describe("v1 surface — full lifecycle", () => {
	test("defineConfig + pushConfig + pullConfig form an idempotent loop on a fresh project", async () => {
		const api = new FakeNeonApi();
		const config = defineConfig({
			project: { name: "lifecycle", region: "aws-us-east-1" },
			branches: {
				production: { computeSettings: { autoscalingLimitMaxCu: 2 } },
				staging: { parent: "production" },
			},
		});

		// First push: creates the project + the staging branch. Because the production
		// blueprint defines compute settings, pushConfig seeds them as project defaults so
		// the auto-created `production` branch matches without further intervention.
		const firstPush = await pushConfig(config, { api, orgId: "org-1" });
		expect(firstPush.conflicts).toHaveLength(0);
		expect(
			firstPush.applied.some(
				(a) => a.kind === "project" && a.action === "create",
			),
		).toBe(true);
		expect(
			firstPush.applied.some(
				(a) => a.kind === "branch" && a.identifier === "staging",
			),
		).toBe(true);

		// Pull what we just pushed.
		const pulled = await pullConfig({
			api,
			projectId: firstPush.projectId,
		});
		expect(pulled.project.name).toBe("lifecycle");
		expect(pulled.branches?.production).toBeDefined();
		expect(pulled.branches?.staging).toBeDefined();

		// Pushing the same config again should be a noop — no conflicts, no plan steps.
		const secondPush = await pushConfig(config, {
			api,
			projectId: firstPush.projectId,
		});
		expect(secondPush.conflicts).toHaveLength(0);
		const mutations = secondPush.applied.filter((a) => a.action !== "noop");
		expect(mutations).toHaveLength(0);

		// Final pull should still find a production branch. pullConfig elides any compute
		// fields that match the project's default endpoint settings — and since the first
		// push seeded the production branch's compute settings as project defaults, that
		// elision is expected. The source-of-truth assertion is the remote endpoint state:
		const finalPull: Config = await pullConfig({
			api,
			projectId: firstPush.projectId,
		});
		expect(finalPull.branches?.production).toBeDefined();

		const branches = await api.listBranches(firstPush.projectId);
		const prodBranchId = branches.find((b) => b.name === "production")?.id;
		const endpoints = await api.listEndpoints(firstPush.projectId);
		const prodEndpoint = endpoints.find((e) => e.branchId === prodBranchId);
		expect(prodEndpoint?.autoscalingLimitMaxCu).toBe(2);
	});

	test("loadConfigFromFile is re-exported from v1 and loads + validates a real neon.ts", async () => {
		const platformSrc = new URL("./v1.ts", import.meta.url).pathname;
		const root = setup({
			"package.json": "{}",
			"neon.ts": `
import { defineConfig } from "${platformSrc}";
export default defineConfig({
  project: { name: "loaded-from-v1", region: "aws-us-east-1" },
  branches: { production: {} },
});
`,
		});
		const { config, resolvedPath } = await loadConfigFromFile({
			cwd: root,
		});
		expect(config.project.name).toBe("loaded-from-v1");
		expect(resolvedPath.endsWith("/neon.ts")).toBe(true);
	});

	test("end-to-end with neon.ts + .neon/project.json driving project resolution", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-e2e",
				name: "from-file",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
		});

		const platformSrc = new URL("./v1.ts", import.meta.url).pathname;
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({
				projectId: "proj-e2e",
				branchId: "br-fake-1",
			}),
			"neon.ts": `
import { defineConfig } from "${platformSrc}";
export default defineConfig({
  project: { name: "from-file", region: "aws-us-east-1" },
  branches: {
    production: {},
    staging: { parent: "production" },
  },
});
`,
		});

		const ctx = loadContext({ cwd: root });
		expect(ctx.projectId).toBe("proj-e2e");
		expect(ctx.branch).toEqual({ kind: "id", value: "br-fake-1" });

		const result = await pushConfig({ api, cwd: root });
		expect(result.projectId).toBe("proj-e2e");
		expect(
			result.applied.some(
				(a) => a.identifier === "staging" && a.action === "create",
			),
		).toBe(true);
	});
});
