import { describe, expect, it } from "vitest";
import { codeFromBody, messageFromBody } from "../api.js";
import {
	ClaimableServiceError,
	parseClaimCodeResponse,
	parseClaimStatusResponse,
	parseCredentialsResponse,
	parseRegistrationResponse,
	parseTokenResponse,
} from "./api.js";

describe("Claimable Neon response validation", () => {
	it("accepts the registration contract without exposing extra fields", () => {
		expect(
			parseRegistrationResponse({
				registration_id: "reg-test",
				identity_assertion: "signed-assertion",
				assertion_expires: 1786718400,
				scopes: ["postgres.read", "postgres.write", "data_api.read"],
				project: {
					id: "project-test",
					branch_id: "br-test",
					expires_at: "2026-08-14T12:00:00.000Z",
				},
				capabilities: [
					{ capability: "postgres", granted: true },
					{ capability: "data_api", granted: true },
				],
				claim: {
					start_url:
						"https://claimable.neon.tech/claim?registration_id=reg-test",
				},
				ignored_by_cli: "not projected",
			}),
		).toEqual({
			registrationId: "reg-test",
			identityAssertion: "signed-assertion",
			assertionExpires: 1786718400,
			scopes: ["postgres.read", "postgres.write", "data_api.read"],
			project: {
				id: "project-test",
				branchId: "br-test",
				expiresAt: "2026-08-14T12:00:00.000Z",
			},
			capabilities: [
				{ capability: "postgres", granted: true },
				{ capability: "data_api", granted: true },
			],
			claimStartUrl:
				"https://claimable.neon.tech/claim?registration_id=reg-test",
		});
	});

	it("accepts token, credentials, and claim ceremony responses", () => {
		expect(
			parseTokenResponse({
				access_token: "short-lived-token",
				token_type: "Bearer",
				expires_in: 900,
				scope: "postgres.read postgres.write",
			}),
		).toEqual({
			accessToken: "short-lived-token",
			expiresIn: 900,
			scope: "postgres.read postgres.write",
		});
		expect(
			parseTokenResponse({
				access_token: "claim-status-token",
				token_type: "Bearer",
				expires_in: 900,
				scope: "",
			}),
		).toEqual({
			accessToken: "claim-status-token",
			expiresIn: 900,
			scope: "",
		});

		expect(
			parseCredentialsResponse({
				project_id: "project-test",
				branch_id: "br-test",
				database_url: "postgresql://user:secret@example.test/neondb",
				services: {
					data_api: { url: "https://data.example.test" },
					auth: {
						base_url: "https://auth.example.test",
						jwks_url:
							"https://auth.example.test/.well-known/jwks.json",
					},
				},
				expires_at: "2026-08-14T12:00:00.000Z",
			}),
		).toEqual({
			projectId: "project-test",
			branchId: "br-test",
			databaseUrl: "postgresql://user:secret@example.test/neondb",
			services: {
				dataApi: { url: "https://data.example.test" },
				auth: {
					baseUrl: "https://auth.example.test",
					jwksUrl: "https://auth.example.test/.well-known/jwks.json",
				},
			},
			expiresAt: "2026-08-14T12:00:00.000Z",
		});

		expect(
			parseClaimCodeResponse({
				user_code: "ABCD-2345",
				verification_uri: "https://claimable.neon.tech/claim",
				verification_uri_complete:
					"https://claimable.neon.tech/claim?user_code=ABCD-2345",
				expires_in: 900,
				interval: 5,
			}),
		).toEqual({
			userCode: "ABCD-2345",
			verificationUri: "https://claimable.neon.tech/claim",
			verificationUriComplete:
				"https://claimable.neon.tech/claim?user_code=ABCD-2345",
			expiresIn: 900,
			interval: 5,
		});

		expect(
			parseClaimStatusResponse({
				state: "accepted",
				expires_at: "2026-08-11T13:10:00.000Z",
				reconciled: false,
			}),
		).toEqual({
			state: "accepted",
			expiresAt: "2026-08-11T13:10:00.000Z",
			reconciled: false,
		});
	});

	it("refuses malformed upstream responses at the boundary", () => {
		expect(() =>
			parseRegistrationResponse({
				registration_id: "reg-test",
				identity_assertion: "signed-assertion",
			}),
		).toThrow("registering an anonymous identity");

		expect(() =>
			parseTokenResponse({
				access_token: "short-lived-token",
				token_type: "Basic",
			}),
		).toThrow("exchanging the identity assertion");
	});
});

describe("ClaimableServiceError", () => {
	it("keeps actionable metadata without placing response data in the message", () => {
		const error = new ClaimableServiceError(
			403,
			{
				code: "insufficient_scope",
				message: "This token cannot delete the project.",
				retryable: false,
				requestId: "request-test",
			},
			{ secret: "must-not-appear" },
		);

		expect(error.message).toBe("This token cannot delete the project.");
		expect(error.code).toBe("insufficient_scope");
		expect(error.retryable).toBe(false);
		expect(error.requestId).toBe("request-test");
		expect(error.message).not.toContain("must-not-appear");
	});
});

describe("proxied Neon API errors", () => {
	it("reads Claimable Neon's nested error envelope", () => {
		const body = {
			error: {
				code: "capability_requires_claim",
				message: "Claim this project before deploying functions.",
			},
		};

		expect(codeFromBody(body)).toBe("capability_requires_claim");
		expect(messageFromBody(body)).toBe(
			"Claim this project before deploying functions.",
		);
	});
});
