import { jwtVerify } from "jose";
import type { SessionData } from "@/server/types";
import { ERRORS } from "../errors";
import { parseSessionData } from "./operations";

interface SessionValidationResult {
	valid: boolean;
	payload?: SessionData;
	error?: string;
}

/**
 * Validate session data signature and expiry using jose
 * @param sessionDataString - Session data string to validate
 * @param cookieSecret - cookie secret for validation
 * @returns Validation result with payload if valid
 */
export async function validateSessionData(
	sessionDataString: string,
	cookieSecret: string,
): Promise<SessionValidationResult> {
	try {
		const secret = new TextEncoder().encode(cookieSecret);

		const { payload } = await jwtVerify<SessionData>(
			sessionDataString,
			secret,
			{
				algorithms: ["HS256"],
			},
		);
		const parsedPayload = parseSessionData(payload);
		return { valid: true, payload: parsedPayload };
	} catch (error) {
		return {
			valid: false,
			error:
				error instanceof Error ? error.message : "Invalid session data",
		};
	}
}

/**
 * Validate cookie secret
 *
 * IMPORTANT: The secret must be cryptographically random for security.
 * Generate a secure secret using: `openssl rand -base64 32`
 *
 * @param secret - cookie secret to validate
 * @throws Error if secret is missing or too short
 */
export function assertCookieSecret(secret?: string): asserts secret is string {
	assertDefined(secret, new Error(ERRORS.MISSING_COOKIE_SECRET));

	if (secret.length < 32) {
		throw new Error(ERRORS.COOKIE_SECRET_TOO_SHORT);
	}
}

export function assertDefined<T>(
	value: T | undefined,
	error: Error,
): asserts value is T {
	if (value === undefined) {
		throw error;
	}
}
