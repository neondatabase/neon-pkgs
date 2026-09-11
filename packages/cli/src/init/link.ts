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

type LinkDependencies = {
	authenticate: typeof ensureAuth;
	link: RunLink;
	recover: (canRetry: boolean) => Promise<boolean>;
};

const defaultDependencies: LinkDependencies = {
	authenticate: ensureAuth,
	link: runLink,
	recover: recoverFrom401,
};

const isUnauthorized = (error: unknown): boolean =>
	isNeonApiError(error) && error.status === 401;

const authenticationFailed = (): Error => new Error("Authentication failed.");

export const runAuthenticatedLink = async (
	props: InitLinkProps,
	dependencies: LinkDependencies = defaultDependencies,
): Promise<void> => {
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
	await dependencies.authenticate(authenticated);

	try {
		await dependencies.link(authenticated);
		return;
	} catch (error) {
		if (!isUnauthorized(error)) {
			throw error;
		}
		if (!(await dependencies.recover(true))) {
			throw authenticationFailed();
		}
	}

	await dependencies.authenticate(authenticated);
	try {
		await dependencies.link(authenticated);
	} catch (error) {
		if (!isUnauthorized(error)) {
			throw error;
		}
		await dependencies.recover(false);
		throw authenticationFailed();
	}
};
