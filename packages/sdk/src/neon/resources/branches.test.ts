import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";

function neonRouting(
	respond: (request: { url: string; method: string; body: unknown }) => {
		status: number;
		body: unknown;
	},
) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		fetch: async (input, init) => {
			const request = input instanceof Request ? input : undefined;
			const url = request ? request.url : String(input);
			const method = (
				request?.method ??
				init?.method ??
				"GET"
			).toUpperCase();
			const raw = request ? await request.clone().text() : init?.body;
			const call = {
				url,
				method,
				body:
					typeof raw === "string" && raw.length > 0
						? JSON.parse(raw)
						: raw,
			};
			calls.push(call);
			const { status, body } = respond(call);
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { neon, calls };
}

describe("branches.resetFromParent", () => {
	it("restores from the parent HEAD and unwraps the branch", async () => {
		const { neon, calls } = neonRouting(({ url }) => {
			if (url.includes("/restore")) {
				return {
					status: 200,
					body: {
						branch: { id: "br-child", name: "feature" },
						operations: [],
					},
				};
			}
			return {
				status: 200,
				body: { branch: { id: "br-child", parent_id: "br-parent" } },
			};
		});

		const { data, error } = await neon.branches.resetFromParent(
			"p-1",
			"br-child",
			{ preserveUnderName: "feature-old" },
		);

		expect(error).toBeUndefined();
		expect(data).toEqual({ id: "br-child", name: "feature" });
		expect(calls).toHaveLength(2);
		expect(calls[1]?.url).toContain(
			"/projects/p-1/branches/br-child/restore",
		);
		expect(calls[1]?.body).toEqual({
			source_branch_id: "br-parent",
			preserve_under_name: "feature-old",
		});
	});

	it("does not restore when the branch has no parent", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { branch: { id: "br-root" } },
		}));

		const { data, error } = await neon.branches.resetFromParent(
			"p-1",
			"br-root",
		);

		expect(data).toBeUndefined();
		expect(error?.kind).toBe("client");
		expect(error?.message).toBe(
			"Branch has no parent and cannot be reset.",
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).not.toContain("/restore");
	});
});

describe("branches.compareSchema", () => {
	it("sends databaseName as db_name and returns the diff", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { diff: "--- a\n+++ b\n" },
		}));

		const { data, error } = await neon.branches.compareSchema(
			"p-1",
			"br-child",
			{
				databaseName: "neondb",
				baseBranchId: "br-parent",
				lsn: "0/1",
				baseLsn: "0/2",
			},
		);

		expect(error).toBeUndefined();
		expect(data).toEqual({ diff: "--- a\n+++ b\n" });
		const url = new URL(calls[0]?.url ?? "http://invalid");
		expect(url.pathname).toBe(
			"/api/v2/projects/p-1/branches/br-child/compare_schema",
		);
		expect(url.searchParams.get("db_name")).toBe("neondb");
		expect(url.searchParams.get("base_branch_id")).toBe("br-parent");
		expect(url.searchParams.get("lsn")).toBe("0/1");
		expect(url.searchParams.get("base_lsn")).toBe("0/2");
		expect(url.searchParams.has("timestamp")).toBe(false);
	});
});
