import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";

interface Call {
	url: string;
	method: string;
	body: unknown;
}

/** A client whose only stub is the network boundary, answering from a queue. */
function neonQueued(responses: unknown[]) {
	const calls: Call[] = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		fetch: async (input, init) => {
			const request = input instanceof Request ? input : undefined;
			const url = request ? request.url : String(input);
			const raw = request ? await request.clone().text() : init?.body;
			calls.push({
				url,
				method: request?.method ?? init?.method ?? "GET",
				body:
					typeof raw === "string" && raw.length > 0
						? JSON.parse(raw)
						: undefined,
			});
			const body = responses[calls.length - 1];
			if (body === undefined) {
				throw new Error(`unqueued request ${calls.length} to ${url}`);
			}
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { neon, calls };
}

const member = (memberId: string) => ({
	member_id: memberId,
	user_id: `user-${memberId}`,
	org_role: "member",
	project_role: "editor",
});

describe("projects.members.list", () => {
	it("unwraps project_members and follows the pagination cursor", async () => {
		const { neon, calls } = neonQueued([
			{
				project_members: [member("m-1")],
				pagination: { next: "c1" },
			},
			{ project_members: [member("m-2")] },
		]);

		const { data, error } = await neon.projects.members.list("p-1").all();

		expect(error).toBeUndefined();
		expect(data?.map((m) => m.member_id)).toEqual(["m-1", "m-2"]);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.url).toContain("/projects/p-1/members");
		expect(calls[1]?.url).toContain("cursor=c1");
	});

	it("forwards the limit query parameter", async () => {
		const { neon, calls } = neonQueued([{ project_members: [] }]);

		await neon.projects.members.list("p-1", { limit: 25 }).all();

		expect(calls[0]?.url).toContain("limit=25");
	});
});

describe("projects.members.setRole", () => {
	const roleResponse = {
		project_id: "p-1",
		member_id: "m-1",
		user_id: "user-m-1",
		org_role: "member",
		project_role: "viewer",
		credential_rotation_recommended: true,
		org_api_key_rotation_recommended: false,
	};

	it("sends the role and withholds the self-demotion acknowledgement", async () => {
		const { neon, calls } = neonQueued([roleResponse]);

		await neon.projects.members.setRole("p-1", "m-1", "viewer");

		expect(calls[0]?.method).toBe("PUT");
		expect(calls[0]?.url).toContain("/projects/p-1/members/m-1/role");
		expect(calls[0]?.url).not.toContain("confirm_self_demotion");
		expect(calls[0]?.body).toEqual({ role: "viewer" });
	});

	it("adds confirm_self_demotion only when acknowledged", async () => {
		const { neon, calls } = neonQueued([roleResponse]);

		await neon.projects.members.setRole("p-1", "m-1", "viewer", {
			confirmSelfDemotion: true,
		});

		expect(calls[0]?.url).toContain("confirm_self_demotion=true");
	});

	it("returns the rotation hints rather than just the role", async () => {
		const { neon } = neonQueued([roleResponse]);

		const { data } = await neon.projects.members.setRole(
			"p-1",
			"m-1",
			"viewer",
		);

		expect(data?.credential_rotation_recommended).toBe(true);
		expect(data?.org_api_key_rotation_recommended).toBe(false);
	});
});

describe("projects.members.removeRole", () => {
	const removed = {
		project_id: "p-1",
		member_id: "m-1",
		user_id: "user-m-1",
		org_role: "member",
	};

	it("withholds the self-lockout acknowledgement by default", async () => {
		const { neon, calls } = neonQueued([removed]);

		await neon.projects.members.removeRole("p-1", "m-1");

		expect(calls[0]?.method).toBe("DELETE");
		expect(calls[0]?.url).toContain("/projects/p-1/members/m-1/role");
		expect(calls[0]?.url).not.toContain("confirm_self_lockout");
	});

	it("adds confirm_self_lockout only when acknowledged", async () => {
		const { neon, calls } = neonQueued([removed]);

		await neon.projects.members.removeRole("p-1", "m-1", {
			confirmSelfLockout: true,
		});

		expect(calls[0]?.url).toContain("confirm_self_lockout=true");
	});
});
