import open from "open";
import { codeFromBody, type NeonApiError } from "./api.js";
import { log } from "./log.js";

/**
 * Extract the SSO step-up URL from the error message.
 *
 * The Neon public API carries the recovery URL in the human-readable `message`
 * ("...Open <url> in your browser to authorize, then retry."), not a structured field — so this
 * works against the API's standard error shape without a bespoke contract.
 */
function extractStepUpUrl(message: string | undefined): string | undefined {
	if (typeof message !== "string") {
		return undefined;
	}
	const match = message.match(/(https?:\/\/[^\s)]+)/);
	return match ? match[1] : undefined;
}

/**
 * Recover from an SSO authorization error.
 *
 * Detection is by the machine `code` in the response body, NOT the HTTP status: Neon masks org
 * access-denials as 404 (existence-hiding), so the error arrives as 403 or 404 with the code in the
 * body.
 *   - SSO_AUTHORIZATION_REQUIRED: open the step-up URL (from the message) in a browser so the user
 *     completes the one-time SSO authorization, then return true so the caller retries once.
 *   - SSO_ORG_CREDS_ONLY: terminal — no browser step resolves it; the user must use an
 *     organization-scoped API key. Return false (no retry).
 *
 * @param error   the API error
 * @param canRetry whether the caller is willing to retry (false once we've already retried)
 * @returns true if the caller should retry the command, false otherwise
 */
export const recoverFromSSO = async (
	error: NeonApiError,
	canRetry: boolean,
): Promise<boolean> => {
	const code = codeFromBody(error.data);

	if (code === "SSO_ORG_CREDS_ONLY") {
		// Terminal: no authorization round-trip helps; the message explains to use an org key.
		log.error(error.message);
		return false;
	}

	if (code !== "SSO_AUTHORIZATION_REQUIRED") {
		return false; // not an SSO error we handle
	}

	if (!canRetry) {
		// Already retried once after authorizing and still denied — surface the error, don't loop.
		log.error(error.message);
		return false;
	}

	const stepUpUrl = extractStepUpUrl(error.message);
	if (!stepUpUrl) {
		log.error(error.message);
		return false;
	}

	log.info(
		"This organization requires SSO authorization. Opening browser for authentication...",
	);
	log.info(
		"After completing authentication, we will automatically retry your command.",
	);

	try {
		await open(stepUpUrl);
	} catch {
		log.error(
			`Failed to open web browser. Please open this URL in your browser to authorize, then retry:\n${stepUpUrl}`,
		);
		return false;
	}

	return true;
};
