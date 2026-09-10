import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";

/** Real ergonomic client whose only stub is the network boundary. */
function neonReturning(status: number, body: unknown) {
	return createNeonClient({
		apiKey: "test",
		retries: 0,
		fetch: async () =>
			new Response(body === undefined ? null : JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
	});
}

describe("phase-1 namespaces map responses to the ergonomic shape", () => {
	it("auth.get unwraps the integration body", async () => {
		const neon = neonReturning(200, {
			branch_id: "br-1",
			db_name: "neondb",
		});
		const { data, error } = await neon.auth.get("p-1", "br-1");
		expect(error).toBeUndefined();
		expect(data?.branch_id).toBe("br-1");
	});

	it("auth.oauthProviders.list unwraps the providers array", async () => {
		const neon = neonReturning(200, { providers: [{ id: "google" }] });
		const { data } = await neon.auth.oauthProviders
			.list("p-1", "br-1")
			.all();
		expect(data).toEqual([{ id: "google" }]);
	});

	it("projects.permissions.list unwraps project_permissions", async () => {
		const neon = neonReturning(200, {
			project_permissions: [
				{ id: "perm-1", granted_to_email: "a@b.c", granted_at: "now" },
			],
		});
		const { data } = await neon.projects.permissions.list("p-1").all();
		expect(data).toHaveLength(1);
		expect(data?.[0]?.granted_to_email).toBe("a@b.c");
	});

	it("projects.recover unwraps the project", async () => {
		const neon = neonReturning(200, {
			project: { id: "p-1" },
			branches: [],
		});
		const { data } = await neon.projects.recover("p-1");
		expect(data).toEqual({ id: "p-1" });
	});

	it("postgres.endpoints.list({ branchId }) unwraps endpoints", async () => {
		const neon = neonReturning(200, { endpoints: [{ id: "ep-1" }] });
		const { data } = await neon.postgres.endpoints
			.list("p-1", { branchId: "br-1" })
			.all();
		expect(data).toEqual([{ id: "ep-1" }]);
	});

	it("propagates typed errors through the ergonomic channel", async () => {
		const neon = neonReturning(403, { message: "forbidden" });
		const { data, error } = await neon.projects.permissions
			.list("p-1")
			.all();
		expect(data).toBeUndefined();
		expect(error?.kind).toBe("auth");
	});
});
