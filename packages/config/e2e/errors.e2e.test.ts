import { describe, expect } from "vitest";
import { createRealNeonApi, ErrorCode, type PlatformError } from "../src/v1.js";
import { detectApiKeyScope, e2eTest } from "./helpers.js";

describe("e2e — error wrapping against real Neon API", () => {
	e2eTest(
		"bad API key yields PLATFORM_UNAUTHORIZED with key-rotation guidance",
		async () => {
			const api = createRealNeonApi({
				apiKey: "napi_definitely_not_a_real_key_xxxxxxxxxxxxxxxxxx",
			});
			await expect(api.listProjects({})).rejects.toMatchObject({
				code: ErrorCode.Unauthorized,
			});
			try {
				await api.listProjects({});
			} catch (err) {
				const p = err as PlatformError;
				expect(p.message).toContain(
					"Bearer token sent to the Neon API was rejected",
				);
				expect(p.message).toContain(
					"https://console.neon.tech/app/settings/api-keys",
				);
				expect(p.message).toContain("neon auth");
			}
		},
	);

	e2eTest(
		"getProject on a non-existent id yields PLATFORM_NOT_FOUND with the offending id in the message",
		async () => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;
			const api = createRealNeonApi({
				apiKey: process.env.NEON_API_KEY ?? "",
			});
			await expect(
				api.getProject("proj-definitely-not-real-12345"),
			).rejects.toMatchObject({
				code: ErrorCode.NotFound,
			});
			try {
				await api.getProject("proj-definitely-not-real-12345");
			} catch (err) {
				const p = err as PlatformError;
				expect(p.message).toContain("proj-definitely-not-real-12345");
				expect(p.details.status).toBe(404);
			}
		},
	);
});
