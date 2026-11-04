import {
	createProject,
	deleteProject,
	uniqueProjectName,
} from "@neon/e2e-harness";
import { enableNeonAuth } from "@neon/e2e-harness/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NeonClient } from "../src/index.js";
import { expectOk, makeClient } from "./helpers.js";

/**
 * Neon Auth branch settings against one project with Neon Auth enabled. Each test reads a
 * setting, changes it, reads the change back through a separate call, and restores it, so
 * the assertions cover the response shapes the API actually returns rather than the ones
 * the spec promises.
 *
 * Auth is enabled through the harness so that a regression in `auth.create` fails in its
 * own place instead of taking this file's setup down with it.
 */
describe.sequential("e2e — @neon/sdk Neon Auth branch settings", () => {
	let neon: NeonClient<false>;
	let ids: { projectId: string; branchId: string };

	beforeAll(async () => {
		neon = makeClient();
		const projectId = await createProject({
			name: uniqueProjectName("sdk-auth-settings"),
		});
		const main = expectOk(await neon.branches.getDefault({ projectId }));
		ids = { projectId, branchId: main.id };
		await enableNeonAuth(projectId, main.id);
	});

	afterAll(async () => {
		if (ids?.projectId) await deleteProject(ids.projectId);
	});

	it("allowLocalhost round-trips", async () => {
		const before = expectOk(await neon.auth.allowLocalhost.get(ids));
		const flipped = !before.allow_localhost;
		expect(
			expectOk(
				await neon.auth.allowLocalhost.update({
					...ids,
					allow_localhost: flipped,
				}),
			),
		).toEqual({ allow_localhost: flipped });
		expect(expectOk(await neon.auth.allowLocalhost.get(ids))).toEqual({
			allow_localhost: flipped,
		});
		expectOk(await neon.auth.allowLocalhost.update({ ...ids, ...before }));
	});

	it("emailAndPassword updates one field and leaves the rest", async () => {
		const before = expectOk(await neon.auth.emailAndPassword.get(ids));
		const updated = expectOk(
			await neon.auth.emailAndPassword.update({
				...ids,
				revoke_sessions_on_password_reset:
					!before.revoke_sessions_on_password_reset,
			}),
		);
		expect(updated).toEqual({
			...before,
			revoke_sessions_on_password_reset:
				!before.revoke_sessions_on_password_reset,
		});
		expectOk(
			await neon.auth.emailAndPassword.update({
				...ids,
				revoke_sessions_on_password_reset:
					before.revoke_sessions_on_password_reset,
			}),
		);
		expect(expectOk(await neon.auth.emailAndPassword.get(ids))).toEqual(
			before,
		);
	});

	it("emailProvider switches to SMTP, reports a failed test send, and switches back", async () => {
		const before = expectOk(await neon.auth.emailProvider.get(ids));
		expect(before.type).toBe("shared");

		const smtp = expectOk(
			await neon.auth.emailProvider.update({
				...ids,
				type: "standard",
				// RFC 6761 reserves .invalid, so the test send fails at DNS and no mail leaves.
				host: "smtp.invalid",
				port: 587,
				username: "e2e",
				password: "e2e-not-a-real-password",
				sender_email: "e2e@example.com",
				sender_name: "neon-pkgs e2e",
			}),
		);
		expect(smtp).toMatchObject({
			type: "standard",
			host: "smtp.invalid",
			port: 587,
			username: "e2e",
			password: "",
		});

		const sent = expectOk(
			await neon.auth.emailProvider.sendTest({
				...ids,
				recipient_email: "e2e@example.com",
			}),
		);
		expect(sent.success).toBe(false);
		expect(sent.error_message).toContain("smtp.invalid");

		expectOk(
			await neon.auth.emailProvider.update({ ...ids, type: "shared" }),
		);
		expect(expectOk(await neon.auth.emailProvider.get(ids))).toEqual(
			before,
		);
	});

	it("plugins.get reports every plugin and the plugin updates round-trip", async () => {
		const plugins = expectOk(await neon.auth.plugins.get(ids));
		const { magic_link, organization, phone_number } = plugins;
		if (!magic_link || !organization || !phone_number) {
			throw new Error(
				`plugins.get is missing a plugin: ${JSON.stringify(Object.keys(plugins))}`,
			);
		}

		expect(
			expectOk(
				await neon.auth.plugins.magicLink.update({
					...ids,
					expires_in: magic_link.expires_in + 1,
				}),
			),
		).toEqual({ ...magic_link, expires_in: magic_link.expires_in + 1 });
		expectOk(
			await neon.auth.plugins.magicLink.update({ ...ids, ...magic_link }),
		);

		expect(
			expectOk(
				await neon.auth.plugins.organization.update({
					...ids,
					membership_limit: organization.membership_limit + 1,
				}),
			),
		).toEqual({
			...organization,
			membership_limit: organization.membership_limit + 1,
		});
		expectOk(
			await neon.auth.plugins.organization.update({
				...ids,
				...organization,
			}),
		);

		expect(expectOk(await neon.auth.plugins.phoneNumber.get(ids))).toEqual(
			phone_number,
		);
		const otp = (phone_number.otp_expires_in ?? 300) + 60;
		expect(
			expectOk(
				await neon.auth.plugins.phoneNumber.update({
					...ids,
					otp_expires_in: otp,
				}),
			),
		).toEqual({ ...phone_number, otp_expires_in: otp });
		expectOk(
			await neon.auth.plugins.phoneNumber.update({
				...ids,
				...phone_number,
			}),
		);

		const after = expectOk(await neon.auth.plugins.get(ids));
		expect(after.magic_link).toEqual(magic_link);
		expect(after.organization).toEqual(organization);
		expect(after.phone_number).toEqual(phone_number);
	});

	it("webhooks.update replaces the configuration", async () => {
		const before = expectOk(await neon.auth.webhooks.get(ids));
		const configured = {
			enabled: true,
			webhook_url: "https://example.com/neon-auth-webhook",
			enabled_events: ["user.created" as const],
			timeout_seconds: 5,
		};
		expect(
			expectOk(
				await neon.auth.webhooks.update({ ...ids, ...configured }),
			),
		).toEqual(configured);
		expect(expectOk(await neon.auth.webhooks.get(ids))).toEqual(configured);

		const restored = expectOk(
			await neon.auth.webhooks.update({ ...ids, ...before }),
		);
		expect(restored).toEqual(before);
		expect(restored.webhook_url).toBeUndefined();
	});
});
