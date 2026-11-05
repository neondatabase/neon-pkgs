import { configuredOrgId } from "@neon/e2e-harness";
import { describe, expect, it } from "vitest";
import { orgArgs, runCli, runCliJson } from "./helpers.js";

type MemberWithUser = {
	member: { id: string; org_id: string; role: string };
	user: { email: string };
};

/**
 * Read-only against the shared test org: its one member is a real admin, an invitation
 * emails a real address, and runs from different pull requests share its spending limit.
 */
describe.sequential("e2e — neon orgs against the real API", () => {
	it("gets the organization and one of its members", async () => {
		const org = await runCliJson<{ id: string }>([
			"orgs",
			"get",
			...orgArgs(),
		]);
		expect(org.id).toMatch(/^org-/);
		expect(org.id).toBe(configuredOrgId() ?? org.id);

		const members = await runCliJson<MemberWithUser[]>([
			"orgs",
			"members",
			"list",
			...orgArgs(),
		]);
		expect(members.length).toBeGreaterThan(0);
		const first = members[0];
		expect(first.member.org_id).toBe(org.id);

		const member = await runCliJson<{ id: string; role: string }>([
			"orgs",
			"members",
			"get",
			first.member.id,
			...orgArgs(),
		]);
		expect(member).toMatchObject({
			id: first.member.id,
			role: first.member.role,
		});
	});

	it("lists invitations and reads the spending limit", async () => {
		const invitations = await runCliJson<unknown[]>([
			"orgs",
			"invitations",
			"list",
			...orgArgs(),
		]);
		expect(Array.isArray(invitations)).toBe(true);

		const limit = await runCliJson<{ spending_limit_cents: number | null }>(
			["orgs", "spending-limit", "get", ...orgArgs()],
		);
		expect("spending_limit_cents" in limit).toBe(true);
	});

	it("reports an unknown member as an error", async () => {
		const result = await runCli([
			"orgs",
			"members",
			"get",
			"00000000-0000-0000-0000-000000000000",
			...orgArgs(),
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ERROR:");
	});
});
