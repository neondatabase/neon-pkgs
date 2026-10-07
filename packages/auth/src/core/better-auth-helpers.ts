import type { BetterFetchError } from "@better-fetch/fetch";
import type { Session, User, UserIdentity } from "@supabase/auth-js";
import type { accountInfo, listUserAccounts } from "better-auth/api";
import { AuthApiError, AuthError } from "../adapters/supabase/auth-interface";
import {
	AuthErrorCode,
	getErrorDefinition,
} from "../adapters/supabase/errors/definitions";
import { BETTER_AUTH_ERROR_MAP } from "../adapters/supabase/errors/mappings";
import { toISOString } from "../utils/date";
import type {
	BetterAuthErrorResponse,
	BetterAuthSession,
	BetterAuthUser,
} from "./better-auth-types";
import { DEFAULT_SESSION_EXPIRY_MS } from "./constants";

/**
 * Normalize Better Auth errors to standard AuthError format
 *
 * Handles three error formats:
 * 1. BetterFetchError: { status, statusText, message?, code? }
 * 2. BetterAuthErrorResponse: { status, statusText, message?, code? }
 * 3. Standard Error: { message, name, stack }
 *
 * Maps Better Auth errors to appropriate AuthError/AuthApiError with:
 * - Correct HTTP status codes
 * - Standard error codes (snake_case)
 * - User-friendly, security-conscious messages
 */
export function normalizeBetterAuthError(
	error: BetterFetchError | BetterAuthErrorResponse | Error | unknown,
): AuthError {
	// Handle Better Auth error format: { message?, status, statusText, code? }
	if (
		error !== null &&
		error !== undefined &&
		typeof error === "object" &&
		"status" in error &&
		"statusText" in error
	) {
		const betterError = error as BetterFetchError | BetterAuthErrorResponse;
		const status = betterError.status;

		// Try to map Better Auth error code first (most specific)
		if (
			"code" in betterError &&
			betterError.code &&
			typeof betterError.code === "string"
		) {
			const mappedCode = BETTER_AUTH_ERROR_MAP[betterError.code];
			if (mappedCode) {
				const def = getErrorDefinition(mappedCode);
				return createNormalizedError(
					def.message,
					def.status,
					def.code,
					status,
				);
			}
		}

		// Map by HTTP status code (fallback)
		const mappedCode = mapStatusCodeToErrorCode(
			status,
			betterError.message || betterError.statusText,
		);
		const def = getErrorDefinition(mappedCode);

		// Use Better Auth's message if provided, otherwise use our default
		const message = betterError.message || def.message;

		return createNormalizedError(message, status, def.code, status);
	}

	// Handle standard Error objects
	if (error instanceof Error) {
		const mappedCode = mapMessageToErrorCode(error.message);
		const def = getErrorDefinition(mappedCode);

		return createNormalizedError(
			error.message || def.message,
			def.status,
			def.code,
			def.status,
		);
	}

	// Fallback for unknown error types
	const def = getErrorDefinition(AuthErrorCode.UnknownError);
	return new AuthError(def.message, def.status, def.code);
}

/**
 * Map HTTP status code to AuthErrorCode
 * Uses message content for disambiguation when status code is ambiguous
 */
function mapStatusCodeToErrorCode(
	status: number,
	message?: string,
): AuthErrorCode {
	const lowerMessage = message?.toLowerCase() || "";

	// Specific mappings based on status code + message content
	switch (status) {
		case 401: {
			if (
				lowerMessage.includes("token") ||
				lowerMessage.includes("jwt")
			) {
				return AuthErrorCode.BadJwt;
			}
			if (lowerMessage.includes("session")) {
				return AuthErrorCode.SessionNotFound;
			}
			if (lowerMessage.includes("expired")) {
				return AuthErrorCode.SessionExpired;
			}
			return AuthErrorCode.InvalidCredentials;
		}

		case 404: {
			if (
				lowerMessage.includes("identity") ||
				lowerMessage.includes("account")
			) {
				return AuthErrorCode.IdentityNotFound;
			}
			if (lowerMessage.includes("session")) {
				return AuthErrorCode.SessionNotFound;
			}
			return AuthErrorCode.UserNotFound;
		}

		case 409: {
			if (lowerMessage.includes("email")) {
				return AuthErrorCode.EmailExists;
			}
			if (lowerMessage.includes("phone")) {
				return AuthErrorCode.PhoneExists;
			}
			return AuthErrorCode.UserAlreadyExists;
		}

		case 422: {
			if (
				lowerMessage.includes("email") &&
				lowerMessage.includes("confirm")
			) {
				return AuthErrorCode.EmailNotConfirmed;
			}
			if (
				lowerMessage.includes("phone") &&
				lowerMessage.includes("confirm")
			) {
				return AuthErrorCode.PhoneNotConfirmed;
			}
			return AuthErrorCode.ValidationFailed;
		}

		case 429: {
			if (lowerMessage.includes("email")) {
				return AuthErrorCode.OverEmailSendRateLimit;
			}
			if (
				lowerMessage.includes("sms") ||
				lowerMessage.includes("phone")
			) {
				return AuthErrorCode.OverSmsSendRateLimit;
			}
			return AuthErrorCode.OverRequestRateLimit;
		}

		case 400: {
			if (
				lowerMessage.includes("password") &&
				lowerMessage.includes("weak")
			) {
				return AuthErrorCode.WeakPassword;
			}
			if (
				lowerMessage.includes("email") &&
				lowerMessage.includes("invalid")
			) {
				return AuthErrorCode.EmailAddressInvalid;
			}
			if (lowerMessage.includes("json")) {
				return AuthErrorCode.BadJson;
			}
			if (
				lowerMessage.includes("oauth") ||
				lowerMessage.includes("callback")
			) {
				return AuthErrorCode.BadOAuthCallback;
			}
			return AuthErrorCode.ValidationFailed;
		}

		case 403: {
			if (
				lowerMessage.includes("provider") ||
				lowerMessage.includes("oauth")
			) {
				return AuthErrorCode.OAuthProviderNotSupported;
			}
			if (lowerMessage.includes("phone")) {
				return AuthErrorCode.PhoneProviderDisabled;
			}
			if (lowerMessage.includes("sso")) {
				return AuthErrorCode.SsoProviderDisabled;
			}
			return AuthErrorCode.FeatureNotSupported;
		}

		case 501: {
			return AuthErrorCode.NotImplemented;
		}

		case 503: {
			return AuthErrorCode.FeatureNotSupported;
		}

		default: {
			if (lowerMessage.includes("oauth")) {
				return AuthErrorCode.OAuthCallbackFailed;
			}
			return AuthErrorCode.UnexpectedFailure;
		}
	}
}

/**
 * Map error message content to AuthErrorCode
 * Used as fallback when status code is not available
 */
function mapMessageToErrorCode(message: string): AuthErrorCode {
	const lower = message.toLowerCase();

	// Authentication
	if (
		lower.includes("invalid login") ||
		lower.includes("incorrect") ||
		lower.includes("wrong password")
	) {
		return AuthErrorCode.InvalidCredentials;
	}
	if (
		lower.includes("token") &&
		(lower.includes("invalid") || lower.includes("expired"))
	) {
		return AuthErrorCode.BadJwt;
	}
	if (lower.includes("session") && lower.includes("expired")) {
		return AuthErrorCode.SessionExpired;
	}
	if (lower.includes("session") && lower.includes("not found")) {
		return AuthErrorCode.SessionNotFound;
	}

	// User management
	if (
		lower.includes("already exists") ||
		lower.includes("already registered")
	) {
		return AuthErrorCode.UserAlreadyExists;
	}
	if (lower.includes("not found") && lower.includes("user")) {
		return AuthErrorCode.UserNotFound;
	}
	if (lower.includes("not found") && lower.includes("identity")) {
		return AuthErrorCode.IdentityNotFound;
	}

	// Verification
	if (lower.includes("email") && lower.includes("not confirmed")) {
		return AuthErrorCode.EmailNotConfirmed;
	}
	if (lower.includes("phone") && lower.includes("not confirmed")) {
		return AuthErrorCode.PhoneNotConfirmed;
	}

	// Validation
	if (
		lower.includes("weak password") ||
		(lower.includes("password") && lower.includes("requirements"))
	) {
		return AuthErrorCode.WeakPassword;
	}
	if (lower.includes("email") && lower.includes("invalid")) {
		return AuthErrorCode.EmailAddressInvalid;
	}

	// Rate limiting
	if (lower.includes("rate limit") || lower.includes("too many requests")) {
		return AuthErrorCode.OverRequestRateLimit;
	}

	// OAuth
	if (lower.includes("oauth") && lower.includes("failed")) {
		return AuthErrorCode.OAuthCallbackFailed;
	}
	if (lower.includes("provider") && lower.includes("not supported")) {
		return AuthErrorCode.OAuthProviderNotSupported;
	}

	// Default
	return AuthErrorCode.UnexpectedFailure;
}

/**
 * Create normalized error with correct type (AuthError vs AuthApiError)
 * Uses AuthApiError for non-500 status codes (API/client errors)
 * Uses AuthError for 500 status codes (server errors)
 */
function createNormalizedError(
	message: string,
	targetStatus: number,
	code: string,
	_originalStatus: number,
): AuthError {
	// Use target status from error definition unless we want to preserve original
	const status = targetStatus;

	// Use AuthApiError for non-500 errors (client/API errors)
	if (status !== 500 && status !== 501 && status !== 503) {
		return new AuthApiError(message, status, code);
	}

	// Use AuthError for server errors
	return new AuthError(message, status, code);
}

/**
 * Map Better Auth session to Session format
 */
export function mapBetterAuthSession(
	betterAuthSession: BetterAuthSession | null | undefined,
	betterAuthUser: BetterAuthUser | null | undefined,
): Session | null {
	if (!betterAuthSession || !betterAuthUser) {
		return null;
	}

	// Parse expiresAt
	let expiresAt: number;
	if (typeof betterAuthSession.expiresAt === "string") {
		expiresAt = Math.floor(
			new Date(betterAuthSession.expiresAt).getTime() / 1000,
		);
	} else if (
		typeof betterAuthSession.expiresAt === "object" &&
		betterAuthSession.expiresAt instanceof Date
	) {
		expiresAt = Math.floor(betterAuthSession.expiresAt.getTime() / 1000);
	} else {
		expiresAt =
			Math.floor(Date.now() / 1000) +
			Math.floor(DEFAULT_SESSION_EXPIRY_MS / 1000); // Default 1 hour if can't parse
	}

	const now = Math.floor(Date.now() / 1000);
	const expiresIn = Math.max(0, expiresAt - now);

	// Note: betterAuthSession.token is an OPAQUE token (random string), not a JWT
	// We cannot decode it to extract claims. Better Auth stores session data server-side.
	// The adapter will replace this with the JWT token when available
	const session: Session = {
		access_token: betterAuthSession.token, // Opaque token (will be replaced with JWT by adapter)
		refresh_token: "", // Better Auth doesn't expose refresh token in session
		expires_at: expiresAt,
		expires_in: expiresIn,
		token_type: "bearer" as const,
		user: mapBetterAuthUser(betterAuthUser),
	};

	return session;
}

/**
 * Map Better Auth user to User format
 */
export function mapBetterAuthUser(betterAuthUser: BetterAuthUser): User {
	const createdAt = toISOString(betterAuthUser.createdAt);
	const updatedAt = toISOString(betterAuthUser.updatedAt);

	// Extract user metadata from Better Auth user
	const userMetadata: Record<string, unknown> = {};
	if (betterAuthUser.name) {
		userMetadata.displayName = betterAuthUser.name;
	}
	if (betterAuthUser.image) {
		userMetadata.profileImageUrl = betterAuthUser.image;
	}

	// Extract any additional metadata from Better Auth user
	// Cast to Record to access dynamic keys (plugins may add extra fields)
	const userRecord = betterAuthUser as Record<string, unknown>;
	for (const key of Object.keys(userRecord)) {
		if (
			![
				"id",
				"email",
				"emailVerified",
				"name",
				"image",
				"createdAt",
				"updatedAt",
			].includes(key)
		) {
			userMetadata[key] = userRecord[key];
		}
	}

	const user: User = {
		id: betterAuthUser.id,
		email: betterAuthUser.email || "",
		email_confirmed_at: betterAuthUser.emailVerified
			? createdAt
			: undefined,
		phone: undefined,
		confirmed_at: betterAuthUser.emailVerified ? createdAt : undefined,
		last_sign_in_at: updatedAt,
		app_metadata: {},
		user_metadata: userMetadata,
		identities: [],
		created_at: createdAt,
		updated_at: updatedAt,
		aud: "authenticated",
		role: "authenticated",
	};

	return user;
}

export function mapBetterAuthIdentity(
	betterAuthUserIdentityAccount: Awaited<
		ReturnType<typeof listUserAccounts>
	>[number],
	accountInfoData: Awaited<ReturnType<typeof accountInfo>>,
): UserIdentity {
	return {
		id: betterAuthUserIdentityAccount.id,
		user_id: betterAuthUserIdentityAccount.id,
		identity_id: betterAuthUserIdentityAccount.accountId,
		provider: betterAuthUserIdentityAccount.providerId,
		created_at: toISOString(betterAuthUserIdentityAccount.createdAt),
		updated_at: toISOString(betterAuthUserIdentityAccount.updatedAt),
		// TODO: pretty sure this needs a plugin.
		last_sign_in_at: toISOString(betterAuthUserIdentityAccount.updatedAt),
		identity_data: accountInfoData
			? {
					provider: betterAuthUserIdentityAccount.providerId,
					provider_id: betterAuthUserIdentityAccount.accountId,
					scopes: betterAuthUserIdentityAccount.scopes,
					email: accountInfoData.data.email,
					name: accountInfoData.data.user.name,
					picture: accountInfoData.data.user.picture,
					email_verified: accountInfoData.data.user.email_verified,
					...accountInfoData.data,
				}
			: {
					provider: betterAuthUserIdentityAccount.providerId,
					provider_id: betterAuthUserIdentityAccount.accountId,
					scopes: betterAuthUserIdentityAccount.scopes,
				},
	};
}

/**
 * Map Supabase Session back to Better Auth format.
 * Used for cross-tab sync where broadcasts contain Supabase format
 * but cache needs Better Auth format.
 *
 * Note: Some Better Auth fields (ipAddress, userAgent) are not available
 * in Supabase Session and will be set to null/defaults.
 */
export function mapSupabaseSessionToBetterAuth(
	supabaseSession: Session,
): { session: BetterAuthSession; user: BetterAuthUser } | null {
	if (!supabaseSession?.user) {
		return null;
	}

	const user = supabaseSession.user;
	const now = new Date();

	// Convert expires_at (seconds since epoch) to Date
	const expiresAt = supabaseSession.expires_at
		? new Date(supabaseSession.expires_at * 1000)
		: new Date(Date.now() + DEFAULT_SESSION_EXPIRY_MS);

	const betterAuthSession: BetterAuthSession = {
		id: "", // Not available in Supabase Session, but not critical for cache
		userId: user.id,
		token: supabaseSession.access_token,
		expiresAt,
		createdAt: now,
		updatedAt: now,
		ipAddress: null,
		userAgent: null,
	};

	// Extract name from user_metadata
	const displayName =
		(user.user_metadata?.displayName as string) ||
		(user.user_metadata?.name as string) ||
		(user.user_metadata?.full_name as string) ||
		"";

	// Extract image from user_metadata
	const image =
		(user.user_metadata?.profileImageUrl as string) ||
		(user.user_metadata?.avatar_url as string) ||
		(user.user_metadata?.picture as string);

	// Parse dates from Supabase user
	const createdAt = user.created_at ? new Date(user.created_at) : now;
	const updatedAt = user.updated_at ? new Date(user.updated_at) : now;

	const betterAuthUser: BetterAuthUser = {
		id: user.id,
		email: user.email || "",
		emailVerified: !!user.email_confirmed_at,
		name: displayName,
		image: image || null,
		createdAt,
		updatedAt,
	};

	return {
		session: betterAuthSession,
		user: betterAuthUser,
	};
}
