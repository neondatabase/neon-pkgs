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
export type NeonAuthServer = Pick<VanillaBetterAuthClient, ServerAuthMethods>;
