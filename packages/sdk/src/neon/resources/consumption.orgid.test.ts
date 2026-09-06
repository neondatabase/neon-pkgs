import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";
import type { NeonConfig } from "../config.js";

const window = {
	from: "2024-01-01T00:00:00Z",
	to: "2024-01-02T00:00:00Z",
	granularity: "daily",
} as const;

const v2Metrics = { metrics: ["compute_unit_seconds"] };

function neonRouting(
	respond: (request: { url: string }) => { status: number; body: unknown },
	config?: Pick<NeonConfig, "orgId">,
) {
	const calls: Array<{ url: string }> = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		...config,
		fetch: async (input) => {
			const request = input instanceof Request ? input : undefined;
			const url = request ? request.url : String(input);
			calls.push({ url });
			const { status, body } = respond({ url });
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { neon, calls };
}

function orgSearch(url: string) {
	const parsed = new URL(url);
	return {
		org_id: parsed.searchParams.get("org_id"),
		hasOrgId: parsed.searchParams.has("orgId"),
	};
}

describe("consumption.perProject orgId", () => {
	const body = { projects: [], pagination: {} };

	it("defaults org_id from the client", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 200, body }), {
			orgId: "org-client",
		});
		const { error } = await neon.consumption.perProject(window).page();
		expect(error).toBeUndefined();
		expect(orgSearch(calls[0]?.url ?? "")).toEqual({
			org_id: "org-client",
			hasOrgId: false,
		});
	});

	it("lets query.orgId override the client", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 200, body }), {
			orgId: "org-client",
		});
		const { error } = await neon.consumption
			.perProject({ ...window, orgId: "org-call" })
			.page();
		expect(error).toBeUndefined();
		expect(orgSearch(calls[0]?.url ?? "")).toEqual({
			org_id: "org-call",
			hasOrgId: false,
		});
	});

	it("still accepts snake_case org_id", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 200, body }));
		const { error } = await neon.consumption
			.perProject({ ...window, org_id: "org-snake" })
			.page();
		expect(error).toBeUndefined();
		expect(orgSearch(calls[0]?.url ?? "")).toEqual({
			org_id: "org-snake",
			hasOrgId: false,
		});
	});

	it("lets orgId win over org_id", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 200, body }));
		const { error } = await neon.consumption
			.perProject({
				...window,
				orgId: "org-call",
				org_id: "org-snake",
			})
			.page();
		expect(error).toBeUndefined();
		expect(orgSearch(calls[0]?.url ?? "")).toEqual({
			org_id: "org-call",
			hasOrgId: false,
		});
	});

	it("omits org_id when none is set", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 200, body }));
		const { error } = await neon.consumption.perProject(window).page();
		expect(error).toBeUndefined();
		expect(orgSearch(calls[0]?.url ?? "")).toEqual({
			org_id: null,
			hasOrgId: false,
		});
	});
});

describe.each([
	"perProjectV2",
	"perBranchV2",
] as const)("consumption.%s orgId", (method) => {
	const body =
		method === "perProjectV2"
			? { projects: [], pagination: {} }
			: { branches: [], pagination: {} };

	function page(
		neon: ReturnType<typeof createNeonClient>,
		query: { orgId?: string; org_id?: string },
	) {
		if (method === "perProjectV2") {
			return neon.consumption
				.perProjectV2({ ...window, ...v2Metrics, ...query })
				.page();
		}
		return neon.consumption
			.perBranchV2({
				...window,
				...v2Metrics,
				project_ids: ["p-1"],
				...query,
			})
			.page();
	}

	it("defaults org_id from the client", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 200, body }), {
			orgId: "org-client",
		});
		const { error } = await page(neon, {});
		expect(error).toBeUndefined();
		expect(orgSearch(calls[0]?.url ?? "")).toEqual({
			org_id: "org-client",
			hasOrgId: false,
		});
	});

	it("lets query.orgId override the client", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 200, body }), {
			orgId: "org-client",
		});
		const { error } = await page(neon, { orgId: "org-call" });
		expect(error).toBeUndefined();
		expect(orgSearch(calls[0]?.url ?? "")).toEqual({
			org_id: "org-call",
			hasOrgId: false,
		});
	});

	it("still accepts snake_case org_id", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 200, body }));
		const { error } = await page(neon, { org_id: "org-snake" });
		expect(error).toBeUndefined();
		expect(orgSearch(calls[0]?.url ?? "")).toEqual({
			org_id: "org-snake",
			hasOrgId: false,
		});
	});

	it("lets orgId win over org_id", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 200, body }));
		const { error } = await page(neon, {
			orgId: "org-call",
			org_id: "org-snake",
		});
		expect(error).toBeUndefined();
		expect(orgSearch(calls[0]?.url ?? "")).toEqual({
			org_id: "org-call",
			hasOrgId: false,
		});
	});

	it("errors when no org is set", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 200, body }));
		const { data, error } = await page(neon, {});
		expect(data).toBeUndefined();
		expect(error?.kind).toBe("client");
		expect(error?.message).toBe("Pass orgId or set orgId on the client.");
		expect(calls).toHaveLength(0);
	});
});
