import { describe, expect, test } from "vitest";
import { defineConfig } from "./define-config.js";
import { ErrorCode } from "./errors.js";
import { FakeNeonApi } from "./fake-neon-api.js";
import { pushConfig } from "./push-config.js";

function seededFake() {
	const api = new FakeNeonApi();
	const projectId = "proj-push";
	api.seedProject({
		project: {
			id: projectId,
			name: "push-test",
			regionId: "aws-us-east-1",
			pgVersion: 17,
			orgId: "org-push",
		},
		branches: [
			{ branch: { id: "br-main", name: "main", isDefault: true } },
		],
	});
	return { api, projectId };
}

describe("pushConfig", () => {
	test("applies branch-scoped feature enables to the selected branch", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig((branch) => ({
			postgres: {
				computeSettings: {
					autoscalingLimitMaxCu: branch.name === "main" ? 4 : 1,
				},
			},
			auth: { enabled: true },
			dataApi: { enabled: true },
		}));

		const result = await pushConfig(config, {
			api,
			projectId,
			branch: "main",
			updateExisting: true,
		});

		expect(result.branchName).toBe("main");
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "feature",
					identifier: "auth",
				}),
				expect.objectContaining({
					kind: "feature",
					identifier: "dataApi",
				}),
			]),
		);
		expect(
			api.history.some(
				(h) => h.method === "enableNeonAuth" && h.args[1] === "br-main",
			),
		).toBe(true);
	});

	test("reports mutable branch drift as conflict without updateExisting", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig(() => ({
			postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
		}));

		await expect(
			pushConfig(config, { api, projectId, branch: "main" }),
		).rejects.toMatchObject({
			code: ErrorCode.PushConflict,
		});
	});

	test("dryRun surfaces selected branch plan without mutating", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig(() => ({
			protected: true,
			auth: { enabled: true },
		}));

		const result = await pushConfig(config, {
			api,
			projectId,
			branch: "main",
			dryRun: true,
			updateExisting: true,
		});

		expect(result.dryRun).toBe(true);
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "branch",
					action: "update",
					identifier: "main",
				}),
				expect.objectContaining({
					kind: "feature",
					identifier: "auth",
				}),
			]),
		);
		expect(api.history.some((h) => h.method === "updateBranch")).toBe(
			false,
		);
	});
});
