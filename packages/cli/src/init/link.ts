import { isNeonApiError } from "../api.js";
import { defaultClientID } from "../auth.js";
import { recoverFrom401 } from "../auth_recovery.js";
import { ensureAuth } from "../commands/auth.js";
import { type LinkProps, runLink } from "../commands/link.js";
import { defaultDir } from "../config.js";

export type InitLinkProps = LinkProps & {
	configDir?: string;
	profile?: string;
	oauthHost?: string;
	clientId?: string;
	forceAuth?: boolean;
	allowUnsafeTls?: boolean;
};

export type InitLinkInputs = Pick<
	InitLinkProps,
	"orgId" | "projectId" | "projectName" | "regionId" | "branch"
>;

export type RunLink = (props: InitLinkProps) => Promise<void>;

const isUnauthorized = (error: unknown): boolean =>
	isNeonApiError(error) && error.status === 401;

const authenticationFailed = (): Error => new Error("Authentication failed.");

export const runAuthenticatedLink: RunLink = async (props) => {
	const authenticated = {
		...props,
		_: ["link"],
		configDir: props.configDir ?? defaultDir,
		oauthHost:
			props.oauthHost ??
			process.env.NEON_OAUTH_HOST ??
			"https://oauth2.neon.tech",
		clientId: props.clientId ?? defaultClientID,
		help: false,
	};
	await ensureAuth(authenticated);

	try {
		await runLink(authenticated);
		return;
	} catch (error) {
		if (!isUnauthorized(error)) {
			throw error;
		}
		if (!(await recoverFrom401(true))) {
			throw authenticationFailed();
		}
	}

	await ensureAuth(authenticated);
	try {
		await runLink(authenticated);
	} catch (error) {
		if (!isUnauthorized(error)) {
			throw error;
		}
		await recoverFrom401(false);
		throw authenticationFailed();
	}
};
