import { AuthRefreshError } from "./auth.js";
import {
	authFailureMessage,
	getAuthContext,
	locationFromContext,
} from "./auth_context.js";
import {
	isAccessTokenUsable,
	refreshStoredCredentials,
} from "./commands/auth.js";
import { storeFor } from "./credential_io.js";
import { log } from "./log.js";

const supersededOnDisk = (rejectedToken: string | undefined): boolean => {
	if (rejectedToken === undefined) return false;
	const context = getAuthContext();
	if (context === null) return false;
	const at = locationFromContext(context);
	if (at === null) return false;
	try {
		const loaded = storeFor(context.configDir).read(at);
		return (
			loaded !== null &&
			loaded.credentials.access_token !== rejectedToken &&
			isAccessTokenUsable(loaded.credentials, Date.now())
		);
	} catch {
		return false;
	}
};

export const recoverFrom401 = async (canRetry: boolean): Promise<boolean> => {
	const context = getAuthContext();
	if (context === null || context.source !== "stored-credentials") {
		log.error(authFailureMessage(context));
		return false;
	}

	if (context.refreshed === true || !canRetry) {
		log.error(authFailureMessage(context));
		return false;
	}

	if (supersededOnDisk(context.accessToken)) {
		log.debug(
			"The rejected token has already been replaced on disk; retrying with the current one",
		);
		return true;
	}

	const at = locationFromContext(context);
	if (
		at === null ||
		context.oauthHost === undefined ||
		context.clientId === undefined
	) {
		log.error(authFailureMessage(context));
		return false;
	}

	try {
		if (
			await refreshStoredCredentials(at, {
				apiHost: "",
				oauthHost: context.oauthHost,
				clientId: context.clientId,
				configDir: context.configDir,
			})
		) {
			log.debug("Refreshed the stored session after a 401; retrying");
			return true;
		}
	} catch (err) {
		if (err instanceof AuthRefreshError) {
			log.error(err.message);
			if (err.terminal) {
				log.error(
					`Run \`neon auth --profile ${context.profile ?? "DEFAULT"}\` to sign in again.`,
				);
			}
			return false;
		}
		log.debug(
			"Refresh after 401 failed: %s",
			err instanceof Error ? err.message : "unknown error",
		);
	}

	log.error(authFailureMessage(context));
	return false;
};
