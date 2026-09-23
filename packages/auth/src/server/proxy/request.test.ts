import { afterEach, describe, expect, test, vi } from "vitest";
import {
	NEON_AUTH_LEGACY_SESSION_CHALLENGE_COOKIE_NAME,
	NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME,
} from "../constants";
import { handleAuthRequest } from "./request";

describe("handleAuthRequest cookie forwarding", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("forwards both canonical and legacy challenge cookies upstream", async () => {
		const legacyCookie = `${NEON_AUTH_LEGACY_SESSION_CHALLENGE_COOKIE_NAME}=legacy-challenge`;
		const canonicalCookie = `${NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME}=canonical-challenge`;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(null, { status: 200 }));
		const request = new Request(
			"https://app.example.com/callback?neon_auth_session_verifier=verifier",
			{
				headers: {
					Cookie: `unrelated=value; ${legacyCookie}; ${canonicalCookie}`,
				},
			},
		);

		await handleAuthRequest(
			"https://auth.example.com",
			request,
			"get-session",
		);

		const requestInit = fetchSpy.mock.calls[0]?.[1];
		const upstreamHeaders = new Headers(requestInit?.headers);
		expect(upstreamHeaders.get("cookie")).toBe(
			`${legacyCookie}; ${canonicalCookie}`,
		);
	});
});
