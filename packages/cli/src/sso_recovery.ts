import open from "open";
import prompts from "prompts";
import { codeFromBody, type NeonApiError } from "./api.js";
import { isCi } from "./env.js";
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

/** Whether this process can drive an interactive open-browser-then-confirm-and-retry flow. */
function canInteract(): boolean {
	return (
		!isCi() && Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY)
	);
}

/**
 * Recover from an SSO authorization error.
 *
 * Detection is by the machine `code` in the response body, NOT the HTTP status: Neon masks org
 * access-denials as 404 (existence-hiding), so the error arrives as 403 or 404 with the code in the
 * body.
 *   - SSO_AUTHORIZATION_REQUIRED: the user must complete a one-time SSO authorization in a browser.
 *     On an interactive terminal we open the step-up URL and wait for the user to confirm they've
 *     finished before signalling a retry. Unattended (CI / no TTY) we print the URL and fail, since
 *     no browser round-trip is possible.
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

	// Unattended runs (CI, no TTY, piped I/O) cannot complete a browser authorization, and must
	// never spawn a browser or block on a prompt. Print the URL (all our logs go to stderr) and
	// fail so the caller exits non-zero — mirroring how the interactive pickers refuse without a
	// TTY. The operator authorizes out of band, then re-runs the command.
	if (!canInteract()) {
		log.error(
			"This organization requires a one-time SSO authorization, which needs an interactive " +
				"browser session. Open this URL in a browser to authorize, then re-run the command:\n" +
				stepUpUrl,
		);
		return false;
	}

	// Print the URL BEFORE launching the browser. `open()` resolves as soon as the OS launcher is
	// spawned, and a launcher that then fails in its child (e.g. `spawn ENOENT`, or a browser that
	// exits non-zero) surfaces only on the child process — never as a rejection here. Printing first
	// guarantees the user always has the URL to open manually.
	log.info(
		"This organization requires SSO authorization. Opening your browser to authorize; if it " +
			`doesn't open, visit this URL manually:\n${stepUpUrl}`,
	);

	try {
		const child = await open(stepUpUrl);
		// Deferred launcher failures land on the child, after open() has already fulfilled. Log them
		// (the URL is already printed above) rather than let them go unnoticed or crash the process.
		child.once("error", (err: Error) => {
			log.warning(
				`Could not launch a browser automatically: ${err.message}`,
			);
		});
	} catch {
		// Synchronous launch failure: the URL is already printed above, so fall through to the
		// confirmation prompt — the user can open it manually and still complete authorization.
		log.warning(
			"Could not launch a browser automatically; open the URL above manually.",
		);
	}

	// `open()` returning does NOT mean authorization finished — it only means the browser launched.
	// Retrying now would race the user and almost always re-hit SSO_AUTHORIZATION_REQUIRED, wasting
	// the single retry. Block on an explicit confirmation so the retry fires only once the user has
	// actually completed the step-up.
	const { confirmed } = await prompts({
		type: "confirm",
		name: "confirmed",
		message:
			"Press Enter once you've completed authorization in the browser to retry (or 'n' to cancel)",
		initial: true,
	});

	if (confirmed !== true) {
		log.error(
			`SSO authorization was not completed. Re-run the command after authorizing at:\n${stepUpUrl}`,
		);
		return false;
	}

	return true;
};
