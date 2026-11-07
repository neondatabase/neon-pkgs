import { configuredOrgId } from "@neon/e2e-harness";
import { describe, expect, it } from "vitest";
import { expectOk, makeClient } from "./helpers.js";

/**
 * Member role changes, member removal, invitations, and setting a spending limit are
 * covered by the unit suite only: the test org's one member is a real admin, an
 * invitation emails a real address and cannot be withdrawn through the API, and runs
 * from different pull requests share the org, so a set-and-restore can interleave.
 */
describe.sequential("e2e — @neon/sdk organizations against the real API", () => {
	it("reads the organization, its members, and its invitations", async () => {
		const neon = makeClient();
		const orgId = configuredOrgId();

		const org = expectOk(await neon.organizations.get());
		expect(org.id).toBe(orgId);

		const members = expectOk(await neon.organizations.members.list().all());
		expect(members.length).toBeGreaterThan(0);
		for (const { member, user } of members) {
			expect(member.org_id).toBe(orgId);
			expect(user.email).toContain("@");
		}

		const first = members[0];
		if (!first) throw new Error("unreachable");
		const member = expectOk(
			await neon.organizations.members.get({ memberId: first.member.id }),
		);
		expect(member).toMatchObject({
			id: first.member.id,
			role: first.member.role,
		});

		const invitations = expectOk(
			await neon.organizations.invitations.list(),
		);
		expect(Array.isArray(invitations)).toBe(true);
	});

	it("creates, lists, and revokes an organization API key", async () => {
		const neon = makeClient();
		const name = `neon-ts-e2e-orgkey-${Date.now()}`;

		// CI holds an org-scoped key, and Neon mints org keys for personal keys only.
		const me = await neon.user.me();
		if (me.error?.message.includes("organization API keys")) {
			const listed = expectOk(await neon.organizations.apiKeys.list());
			expect(listed.length).toBeGreaterThan(0);
			const { error } = await neon.organizations.apiKeys.create({
				keyName: name,
			});
			expect(error?.message).toContain("requires a personal API key");
			return;
		}

		const created = expectOk(
			await neon.organizations.apiKeys.create({ keyName: name }),
		);
		try {
			expect(created.key).toBeTruthy();
			expect(created.project_id).toBeUndefined();
			const listed = expectOk(await neon.organizations.apiKeys.list());
			expect(listed.map((key) => key.id)).toContain(created.id);
		} finally {
			const revoked = expectOk(
				await neon.organizations.apiKeys.revoke({ keyId: created.id }),
			);
			expect(revoked).toMatchObject({ id: created.id, revoked: true });
		}

		const after = expectOk(await neon.organizations.apiKeys.list());
		expect(after.map((key) => key.id)).not.toContain(created.id);
	});

	it("reaches the spending limit endpoints without changing the limit", async () => {
		const neon = makeClient();

		const { spending_limit_cents: current } = expectOk(
			await neon.organizations.spendingLimit.get(),
		);
		expect(current === null || Number.isInteger(current)).toBe(true);

		const { error } = await neon.organizations.spendingLimit.set({
			spendingLimitCents: 0,
		});
		expect(error?.message).toContain("spending_limit_cents");

		if (current === null) {
			expectOk(await neon.organizations.spendingLimit.delete());
		}
	});
});
