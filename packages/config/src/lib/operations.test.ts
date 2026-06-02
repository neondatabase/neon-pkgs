import { describe, expect, test } from "vitest";
import { defineConfig } from "./define-config.js";
import { FakeNeonApi } from "./fake-neon-api.js";
import { deploy, pull, status } from "./operations.js";

function seededFake() {
	const api = new FakeNeonApi();
	const projectId = "proj-ops";
	api.seedProject({
		project: {
			id: projectId,
			name: "ops-test",
			regionId: "aws-us-east-1",
			pgVersion: 17,
			orgId: "org-ops",
		},
		branches: [
			{ branch: { id: "br-main", name: "main", isDefault: true } },
		],
	});
	return { api, projectId };
}

describe("pull", () => {
	test("returns the selected branch's live state", async () => {
		const { api, projectId } = seededFake();
		const result = await pull("main", { api, projectId });
		expect(result.project.name).toBe("ops-test");
		expect(result.branch.name).toBe("main");
		expect(result.config).toBeDefined();
	});
});

describe("status", () => {
	test("computes a dry-run plan without mutating", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig(() => ({ auth: {} }));
		const result = await status(config, "main", { api, projectId });
		expect(result.dryRun).toBe(true);
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "service",
					identifier: "auth",
				}),
			]),
		);
		// No mutation happened: a fresh status still plans the same enable.
		const again = await status(config, "main", { api, projectId });
		expect(again.applied).toEqual(result.applied);
	});
});

describe("deploy", () => {
	test("applies the branch policy to the selected branch", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig(() => ({ auth: {} }));
		const result = await deploy(config, "main", {
			api,
			projectId,
			updateExisting: true,
		});
		expect(result.dryRun).toBe(false);
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "service",
					identifier: "auth",
				}),
			]),
		);
	});
});
