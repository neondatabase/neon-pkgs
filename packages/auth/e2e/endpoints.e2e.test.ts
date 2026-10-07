import { describe, expect, test } from "vitest";
import { API_ENDPOINTS } from "../src/server/endpoints";
import { authBaseUrl } from "./helpers";

/**
 * `src/server/endpoints.ts` is the single source of truth for the paths the server-side
 * proxy calls, and three of its declarations name routes that do not exist anywhere in
 * better-auth 1.6.23 (the version this package pins):
 *
 * - `revokeOtherSessions: "revoke-all-sessions"` — better-auth serves
 *   `revoke-other-sessions` (`better-auth/dist/api/routes/session.d.mts`);
 * - `jwks: "jwt"` — the jwt plugin serves `/jwks` (`jwksPath` defaults to `"/jwks"` in
 *   `better-auth/dist/plugins/jwt/index.mjs`);
 * - `emailOtp.resetPassword: "email-otp/passcode"` — the email-otp plugin serves
 *   `email-otp/reset-password` (`better-auth/dist/plugins/email-otp/index.d.mts`).
 *
 * Neon Auth may run custom aliases on top, which is exactly what only the live service
 * can answer. Each probe asserts the declared path is not a 404; the failure message
 * names better-auth's spelling so the fix is a one-line change either way.
 */

const SUSPICIOUS_ENDPOINTS = [
	{
		key: "revokeOtherSessions",
		config: API_ENDPOINTS.revokeOtherSessions,
		betterAuthPath: "revoke-other-sessions",
	},
	{
		key: "jwks",
		config: API_ENDPOINTS.jwks,
		betterAuthPath: "jwks",
	},
	{
		key: "emailOtp.resetPassword",
		config: API_ENDPOINTS.emailOtp.resetPassword,
		betterAuthPath: "email-otp/reset-password",
	},
] as const;

/**
 * `getSession` is better-auth's own route and in no doubt, so it doubles as the control:
 * if it 404s the service URL is wrong and every other failure in this file would be
 * blaming the endpoint table for a provisioning problem.
 */
const CONTROL_ENDPOINT = API_ENDPOINTS.getSession;

async function probe(path: string, method: "GET" | "POST"): Promise<Response> {
	return fetch(`${authBaseUrl()}/${path}`, {
		method,
		headers: { "content-type": "application/json" },
		// Some POST routes 400 on an empty body; that still proves the route exists.
		...(method === "POST" ? { body: "{}" } : {}),
	});
}

describe("declared server endpoints exist on the live service", () => {
	test(`control: ${CONTROL_ENDPOINT.method} ${CONTROL_ENDPOINT.path} answers`, async () => {
		const response = await probe(
			CONTROL_ENDPOINT.path,
			CONTROL_ENDPOINT.method,
		);
		expect(
			response.status,
			`${CONTROL_ENDPOINT.method} ${CONTROL_ENDPOINT.path} on ${authBaseUrl()} returned ` +
				"404 — the service URL is wrong, so every other result in this file would be " +
				"meaningless",
		).not.toBe(404);
	});

	for (const { key, config, betterAuthPath } of SUSPICIOUS_ENDPOINTS) {
		test(`${key} → ${config.method} ${config.path} is not a 404`, async () => {
			const response = await probe(config.path, config.method);
			expect(
				response.status !== 404,
				`${config.method} ${config.path} (API_ENDPOINTS.${key}) returned 404 on ` +
					`${authBaseUrl()}. better-auth 1.6.23 serves this as "${betterAuthPath}" — ` +
					"if the live service agrees, the path in src/server/endpoints.ts is wrong.",
			).toBe(true);
		});
	}
});
