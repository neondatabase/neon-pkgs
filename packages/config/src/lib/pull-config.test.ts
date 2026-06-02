import { describe, expect, test } from "vitest";
import { FakeNeonApi } from "./fake-neon-api.js";
import { pullConfig } from "./pull-config.js";

describe("pullConfig", () => {
	test("returns selected branch state as JSON-friendly branch config", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-pull";
		api.seedProject({
			project: {
				id: projectId,
				name: "pull-test",
				regionId: "aws-us-east-1",
				pgVersion: 17,
				orgId: "org-pull",
			},
			branches: [
				{ branch: { id: "br-main", name: "main", isDefault: true } },
				{
					branch: {
						id: "br-dev",
						name: "dev-a",
						isDefault: false,
						parentId: "br-main",
						protected: true,
					},
					endpoint: { autoscalingLimitMaxCu: 2 },
				},
			],
		});

		const pulled = await pullConfig({ api, projectId, branchId: "br-dev" });

		expect(pulled.project).toMatchObject({
			id: projectId,
			name: "pull-test",
			orgId: "org-pull",
		});
		expect(pulled.branch).toMatchObject({
			id: "br-dev",
			name: "dev-a",
			parent: "main",
			protected: true,
		});
		expect(pulled.config).toMatchObject({
			parent: "main",
			protected: true,
			postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } },
		});
	});
});
