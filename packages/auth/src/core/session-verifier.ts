/**
 * Error codes Neon Auth returns from a verifier-carrying get-session when the
 * verifier can never be redeemed from this browser: it is unknown, expired or
 * already used, its challenge cookie is missing, tampered or does not match,
 * or the deferred link it carried was refused. Any other failure may be
 * transient or unrelated to the verifier, so the verifier is kept for a retry.
 */
const SETTLED_SESSION_VERIFIER_ERROR_CODES: ReadonlySet<string> = new Set([
	"VERIFICATION_NOT_FOUND",
	"SESSION_CHALLENGE_COOKIE_NOT_FOUND",
	"SESSION_CHALLENGE_COOKIE_TAMPERED",
	"SESSION_CHALLENGE_VALIDATION_FAILED",
	"SESSION_COOKIE_NOT_FOUND",
	"LINK_CALLBACK_NOT_FOUND",
	"LINK_SESSION_NOT_FOUND",
	"LINK_SESSION_MISMATCH",
]);

/**
 * Reads the `code` field of an error response body without consuming the
 * response. Returns null for a non-JSON body, a body without a string code,
 * or a body that has already been read.
 */
export async function readResponseErrorCode(
	response: Response,
): Promise<string | null> {
	if (response.bodyUsed) {
		return null;
	}
	let body: unknown;
	try {
		body = await response.clone().json();
	} catch {
		return null;
	}
	if (
		body !== null &&
		typeof body === "object" &&
		"code" in body &&
		typeof body.code === "string" &&
		body.code !== ""
	) {
		return body.code;
	}
	return null;
}

/**
 * Whether a verifier-carrying get-session response means the verifier is
 * spent: redeemed (2xx), or rejected with one of the codes above.
 */
export function isSessionVerifierSettled(
	status: number,
	errorCode: string | null,
): boolean {
	if (status >= 200 && status < 300) {
		return true;
	}
	return (
		status >= 400 &&
		status < 500 &&
		errorCode !== null &&
		SETTLED_SESSION_VERIFIER_ERROR_CODES.has(errorCode)
	);
}
