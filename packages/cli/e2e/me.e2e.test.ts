import { apiRequest } from "@neon/e2e-harness";
import { describe, expect, it } from "vitest";
import { runCliJson } from "./helpers.js";

type AuthDetails = { account_id: string; auth_method: string };

/**
 * Agents run `neon me` as their sign-in check, and CI's key is organization-scoped, which
 * `GET /users/me` refuses. The harness key may also belong to a user, so the expected
 * answer comes from `GET /auth`.
 */
describe("e2e — neon me against the real API", () => {
	it("reports the identity of the configured key", async () => {
		const auth = await apiRequest<AuthDetails>("/auth");
		const me = await runCliJson<Record<string, unknown>>(["me"]);
		if (auth.auth_method === "api_key_org") {
			expect(me).toEqual({
				account_id: auth.account_id,
				auth_method: "api_key_org",
			});
		} else {
			expect(me.id).toBe(auth.account_id);
		}
	});
});
