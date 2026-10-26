import type {
	BetterAuthSession as Session,
	BetterAuthUser as User,
} from "@/core/better-auth-types";
import type { VanillaBetterAuthClient } from "@/types";
import type { API_ENDPOINTS } from "./endpoints";
import type { NeonAuthNetworkErrorCode } from "./network-error";

export type RequireSessionData = {
	session: Session;
	user: User;
};

export type SessionData =
	| RequireSessionData
	| {
			session: null;
			user: null;
	  };

/**
 * Error shape returned from Neon Auth server API helpers (`auth.signIn`, `getSession`, etc.)
 * when the upstream call fails. `code` is a transport code, `'INTERNAL_ERROR'`, or a Better Auth HTTP error code string.
 */
export type NeonAuthServerApiError = {
	message: string;
	status: number;
	statusText: string;
	code: NeonAuthNetworkErrorCode | "INTERNAL_ERROR" | (string & {});
};

export interface SessionDataCookie {
	value: string;
	expiresAt: Date;
}

/**
 * Extract top-level keys from API_ENDPOINTS.
 * For nested endpoints like signIn.email, this extracts 'signIn' (not 'email').
 */
type TopLevelEndpointKeys<T> = {
	[K in keyof T]: K;
}[keyof T];

type ServerAuthMethods = TopLevelEndpointKeys<typeof API_ENDPOINTS>;

/** Keeps only the members of `T` that the endpoint tree `E` implements. */
type PickEndpoints<T, E> = {
	[P in keyof E & keyof T]: E[P] extends { path: string }
		? T[P]
		: PickEndpoints<T[P], E[P]>;
};

/**
 * `oauth2` is narrowed to the endpoints the server mounts: the client type
 * also carries client management and protocol calls that Neon rejects or that
 * belong to relying parties.
 */
export type NeonAuthServer = Pick<
	VanillaBetterAuthClient,
	Exclude<ServerAuthMethods, "oauth2">
> & {
	oauth2: PickEndpoints<
		VanillaBetterAuthClient["oauth2"],
		(typeof API_ENDPOINTS)["oauth2"]
	>;
};
