import { createNeonClient } from "@neon/sdk";
import { describe, expect, test } from "vitest";
import * as z from "zod";
import { createNeonTool, createNeonTools, toolIds } from "./index.js";
import { hiddenToolIds } from "./lib/ergonomic/ids.js";

const methodPaths = (value: object, prefix = ""): string[] => {
	const paths: string[] = [];
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) {
		for (const key of Object.getOwnPropertyNames(proto)) {
			if (key === "constructor") {
				continue;
			}
			if (typeof Reflect.get(value, key) === "function") {
				paths.push(`${prefix}${key}`);
			}
		}
	}
	for (const [key, child] of Object.entries(value)) {
		if (key === "client") {
			continue;
		}
		if (child !== null && typeof child === "object") {
			paths.push(...methodPaths(child, `${prefix}${key}.`));
		}
	}
	return paths.sort();
};

describe("ergonomic catalog coverage", () => {
	test("every public NeonClient method is published or explicitly hidden", () => {
		const neon = createNeonClient({ apiKey: "unused" });
		const publicMethods = methodPaths(neon);
		const decided = [...toolIds, ...hiddenToolIds].sort();
		expect(publicMethods).toEqual(decided);
	});

	test("hidden selectors are not tools", () => {
		for (const id of hiddenToolIds) {
			expect(toolIds).not.toContain(id);
			expect(() =>
				Reflect.apply(createNeonTool, undefined, [
					id,
					{ apiKey: "test-key" },
				]),
			).toThrow(`Neon tool "${id}" is not published`);
		}
		expect(() =>
			Reflect.apply(createNeonTool, undefined, [
				"projects.create",
				{ apiKey: "test-key" },
			]),
		).toThrow("projects.createAndConnect");
	});
});

describe("special mappings", () => {
	const jsonResponse = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});

	test("maps transfer fields onto the SDK input", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.transfer"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({});
			},
		});

		await tools["projects.transfer"].execute({
			source_org_id: "org-from",
			destination_org_id: "org-to",
			project_ids: ["project-id"],
		});

		expect(requests[0].url).toContain(
			"/organizations/org-from/projects/transfer",
		);
		expect(await requests[0].json()).toEqual({
			destination_org_id: "org-to",
			project_ids: ["project-id"],
		});
	});

	test("maps snapshot restore finalize rather than finalize_restore", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["snapshots.restore"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ branch: { id: "br-id" } });
			},
		});

		await tools["snapshots.restore"].execute({
			project_id: "project-id",
			snapshot_id: "snapshot-id",
			name: "restored",
			target_branch_id: "br-target",
			finalize: false,
		});

		expect(
			tools["snapshots.restore"].inputSchema.safeParse({
				project_id: "project-id",
				snapshot_id: "snapshot-id",
				finalize_restore: true,
			}).success,
		).toBe(false);
		expect(await requests[0].json()).toEqual({
			name: "restored",
			target_branch_id: "br-target",
			finalize_restore: false,
		});
	});

	test("maps expires_at to expiresAt on snapshot create", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["snapshots.create"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ snapshot: { id: "snap-id" } });
			},
		});

		await tools["snapshots.create"].execute({
			project_id: "project-id",
			branch_id: "branch-id",
			expires_at: "2026-09-01T00:00:00Z",
		});

		expect(requests[0].url).toContain(
			"expires_at=2026-09-01T00%3A00%3A00Z",
		);
	});

	test("maps auth.disable delete_data", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["auth.disable"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return new Response(null, { status: 204 });
			},
		});

		await tools["auth.disable"].execute({
			project_id: "project-id",
			branch_id: "branch-id",
			delete_data: true,
		});

		expect(await requests[0].json()).toEqual({ delete_data: true });
	});

	test("maps apiKeys.create key_name", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["apiKeys.create"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ id: 1, key: "napi-secret" });
			},
		});

		await tools["apiKeys.create"].execute({ key_name: "agent" });

		expect(await requests[0].json()).toEqual({ key_name: "agent" });
	});

	test("maps member confirmation flags into SDK options", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.members.setRole"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ role: "viewer" });
			},
		});

		await tools["projects.members.setRole"].execute({
			project_id: "project-id",
			member_id: "00000000-0000-0000-0000-000000000000",
			role: "viewer",
			confirm_self_demotion: true,
		});

		expect(requests[0].url).toContain("confirm_self_demotion=true");
		expect(await requests[0].json()).toEqual({ role: "viewer" });
	});

	test("walks object list pages and throws when truncated without a cursor", async () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["storage.objects.list"] as const,
			fetch: async () =>
				jsonResponse({
					folders: [],
					objects: [],
					prefix: "",
					is_truncated: true,
				}),
		});

		await expect(
			tools["storage.objects.list"].execute({
				project_id: "project-id",
				branch_id: "branch-id",
				bucket_name: "assets",
			}),
		).rejects.toThrow("truncated without a next cursor");
	});

	test("forwards region_id on endpoint create", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["postgres.endpoints.create"] as const,
			fetch: async (input, init) => {
				requests.push(
					input instanceof Request ? input : new Request(input, init),
				);
				return jsonResponse({
					endpoint: { id: "ep-id", type: "read_write" },
				});
			},
		});

		await tools["postgres.endpoints.create"].execute({
			project_id: "project-id",
			branch_id: "br-id",
			type: "read_write",
			region_id: "aws-us-west-2",
		});

		expect(await requests[0].json()).toEqual({
			endpoint: {
				branch_id: "br-id",
				type: "read_write",
				region_id: "aws-us-west-2",
			},
		});
	});

	test("regions.list takes no org_id", () => {
		const tool = createNeonTool("regions.list", { apiKey: "test-key" });
		expect(tool.inputSchema.safeParse({ org_id: "org-1" }).success).toBe(
			false,
		);
		expect(tool.inputSchema.safeParse({}).success).toBe(true);
	});

	test("resetFromParent is destructive; compareSchema is read-only", () => {
		const reset = createNeonTool("branches.resetFromParent", {
			apiKey: "test-key",
		});
		expect(reset.annotations.destructiveHint).toBe(true);
		expect(reset.requiresApproval).toBe(true);
		expect(reset.description).toContain(
			"Discards every change the branch has written since it diverged",
		);
		const preserve = z.toJSONSchema(reset.inputSchema).properties
			?.preserve_under_name;
		expect(JSON.stringify(preserve)).toContain(
			"Required when the branch has children",
		);
		expect(JSON.stringify(preserve)).not.toContain("source_branch_id");

		const compare = createNeonTool("branches.compareSchema", {
			apiKey: "test-key",
		});
		expect(compare.annotations.readOnlyHint).toBe(true);
		expect(compare.requiresApproval).toBe(false);
	});

	test("maps resetFromParent and compareSchema field names", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: [
				"branches.resetFromParent",
				"branches.compareSchema",
			] as const,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				if (request.url.includes("/restore")) {
					return jsonResponse({
						branch: { id: "br-child" },
						operations: [],
					});
				}
				if (request.url.includes("/compare_schema")) {
					return jsonResponse({ diff: "" });
				}
				return jsonResponse({
					branch: { id: "br-child", parent_id: "br-parent" },
				});
			},
		});

		await tools["branches.resetFromParent"].execute({
			project_id: "project-id",
			branch_id: "br-child",
			preserve_under_name: "old",
		});
		const restore = requests.find((request) =>
			request.url.includes("/restore"),
		);
		expect(restore).toBeDefined();
		expect(await restore?.json()).toEqual({
			source_branch_id: "br-parent",
			preserve_under_name: "old",
		});

		requests.length = 0;
		await tools["branches.compareSchema"].execute({
			project_id: "project-id",
			branch_id: "br-child",
			database_name: "neondb",
			base_branch_id: "br-parent",
		});
		expect(requests[0].url).toContain("db_name=neondb");
		expect(requests[0].url).toContain("base_branch_id=br-parent");
		expect(
			tools["branches.compareSchema"].inputSchema.safeParse({
				project_id: "project-id",
				branch_id: "br-child",
				db_name: "neondb",
			}).success,
		).toBe(false);
	});
});
