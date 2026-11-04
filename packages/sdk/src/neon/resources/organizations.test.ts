import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";

interface Call {
	url: URL;
	method: string;
	body: unknown;
}

/** A client whose only stub is the network boundary, answering from a queue. */
function neonQueued(responses: unknown[], orgId?: string) {
	const calls: Call[] = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		...(orgId === undefined ? {} : { orgId }),
		fetch: async (input, init) => {
			const request =
				input instanceof Request ? input : new Request(input, init);
			const raw = await request.clone().text();
			calls.push({
				url: new URL(request.url),
				method: request.method,
				body: raw.length > 0 ? JSON.parse(raw) : undefined,
			});
			const body = responses[calls.length - 1];
			if (body === undefined) {
				throw new Error(
					`unqueued request ${calls.length} to ${request.url}`,
				);
			}
			return Response.json(body);
		},
	});
	return { neon, calls };
}

const member = (id: string) => ({
	member: { id, user_id: `user-${id}`, org_id: "org-1", role: "member" },
	user: { email: `${id}@example.com` },
});

describe("organizations", () => {
	it("defaults orgId to the client's and lets the call override it", async () => {
		const { neon, calls } = neonQueued(
			[{ id: "org-1" }, { id: "org-2" }],
			"org-1",
		);

		await neon.organizations.get();
		await neon.organizations.get({ orgId: "org-2" });

		expect(calls.map((c) => c.url.pathname)).toEqual([
			"/api/v2/organizations/org-1",
			"/api/v2/organizations/org-2",
		]);
	});

	it("fails before fetching when neither the call nor the client names an org", async () => {
		const { neon, calls } = neonQueued([]);

		const { error } = await neon.organizations.spendingLimit.get();

		expect(error).toMatchObject({
			kind: "client",
			message: expect.stringContaining("requires orgId"),
		});
		expect(calls).toHaveLength(0);
	});

	it("members.list follows pagination.next and forwards sorting", async () => {
		const { neon, calls } = neonQueued([
			{ members: [member("m-1")], pagination: { next: "c1" } },
			{ members: [member("m-2")] },
		]);

		const { data } = await neon.organizations.members
			.list({ orgId: "org-1", sort_by: "email", limit: 1 })
			.all();

		expect(data?.map((m) => m.member.id)).toEqual(["m-1", "m-2"]);
		expect(calls[0]?.url.searchParams.get("sort_by")).toBe("email");
		expect(calls[0]?.url.searchParams.get("limit")).toBe("1");
		expect(calls[1]?.url.searchParams.get("cursor")).toBe("c1");
	});

	it("members.update sends only the role and members.remove resolves to void", async () => {
		const { neon, calls } = neonQueued([member("m-1").member, {}]);

		await neon.organizations.members.update({
			orgId: "org-1",
			memberId: "m-1",
			role: "admin",
		});
		const removed = await neon.organizations.members.remove({
			orgId: "org-1",
			memberId: "m-1",
		});

		expect(calls[0]).toMatchObject({
			method: "PATCH",
			body: { role: "admin" },
		});
		expect(calls[0]?.url.pathname).toBe(
			"/api/v2/organizations/org-1/members/m-1",
		);
		expect(calls[1]?.method).toBe("DELETE");
		expect(removed).toEqual({ data: undefined, error: undefined });
	});

	it("invitations unwrap the invitations array", async () => {
		const invitation = {
			id: "i-1",
			email: "a@example.com",
			org_id: "org-1",
			invited_by: "u-1",
			invited_at: "2026-11-04T00:00:00Z",
			role: "member",
		};
		const { neon, calls } = neonQueued([
			{ invitations: [invitation] },
			{ invitations: [invitation] },
		]);

		const listed = await neon.organizations.invitations.list({
			orgId: "org-1",
		});
		const created = await neon.organizations.invitations.create({
			orgId: "org-1",
			invitations: [{ email: "a@example.com", role: "member" }],
		});

		expect(listed.data).toEqual([invitation]);
		expect(created.data).toEqual([invitation]);
		expect(calls[1]?.body).toEqual({
			invitations: [{ email: "a@example.com", role: "member" }],
		});
	});

	it("spendingLimit.set maps spendingLimitCents onto the body", async () => {
		const { neon, calls } = neonQueued([
			{ spending_limit_cents: 5000 },
			{},
		]);

		const { data } = await neon.organizations.spendingLimit.set({
			orgId: "org-1",
			spendingLimitCents: 5000,
		});
		await neon.organizations.spendingLimit.delete({ orgId: "org-1" });

		expect(data).toEqual({ spending_limit_cents: 5000 });
		expect(calls[0]).toMatchObject({
			method: "PUT",
			body: { spending_limit_cents: 5000 },
		});
		expect(calls[1]?.method).toBe("DELETE");
		expect(calls[1]?.url.pathname).toBe(
			"/api/v2/organizations/org-1/billing/spending_limit",
		);
	});

	it("apiKeys.create sends project_id only when projectId is given", async () => {
		const key = {
			id: 1,
			key: "secret",
			name: "ci",
			created_at: "",
			created_by: "",
		};
		const { neon, calls } = neonQueued([
			key,
			{ ...key, project_id: "p-1" },
		]);

		await neon.organizations.apiKeys.create({
			orgId: "org-1",
			keyName: "ci",
		});
		await neon.organizations.apiKeys.create({
			orgId: "org-1",
			keyName: "ci",
			projectId: "p-1",
		});

		expect(calls[0]?.body).toEqual({ key_name: "ci" });
		expect(calls[1]?.body).toEqual({ key_name: "ci", project_id: "p-1" });
		expect(calls[1]?.url.pathname).toBe(
			"/api/v2/organizations/org-1/api_keys",
		);
	});
});
