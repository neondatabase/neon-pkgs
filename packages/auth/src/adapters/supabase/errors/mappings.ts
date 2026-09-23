import { AuthErrorCode } from "./definitions";

/**
 * Maps Better Auth error codes to AuthErrorCode
 * Based on Better Auth SDK error codes
 *
 * @see https://www.better-auth.com/docs/concepts/error-handling
 */
export const BETTER_AUTH_ERROR_MAP: Record<string, AuthErrorCode> = {
	// Authentication
	INVALID_EMAIL_OR_PASSWORD: AuthErrorCode.InvalidCredentials,
	INVALID_PASSWORD: AuthErrorCode.InvalidCredentials,
	INVALID_EMAIL: AuthErrorCode.EmailAddressInvalid,
	USER_NOT_FOUND: AuthErrorCode.UserNotFound,
	INVALID_TOKEN: AuthErrorCode.BadJwt,
	SESSION_EXPIRED: AuthErrorCode.SessionExpired,
	FAILED_TO_GET_SESSION: AuthErrorCode.SessionNotFound,

	// User Management
	USER_ALREADY_EXISTS: AuthErrorCode.UserAlreadyExists,
	EMAIL_NOT_VERIFIED: AuthErrorCode.EmailNotConfirmed,
	USER_EMAIL_NOT_FOUND: AuthErrorCode.UserNotFound,

	// Password Validation
	PASSWORD_TOO_SHORT: AuthErrorCode.WeakPassword,
	PASSWORD_TOO_LONG: AuthErrorCode.WeakPassword,
	USER_ALREADY_HAS_PASSWORD: AuthErrorCode.ValidationFailed,

	// Account Linking
	CREDENTIAL_ACCOUNT_NOT_FOUND: AuthErrorCode.IdentityNotFound,
	FAILED_TO_UNLINK_LAST_ACCOUNT: AuthErrorCode.ValidationFailed,
	ACCOUNT_NOT_FOUND: AuthErrorCode.IdentityNotFound,
	SOCIAL_ACCOUNT_ALREADY_LINKED: AuthErrorCode.ValidationFailed,

	// OAuth
	PROVIDER_NOT_FOUND: AuthErrorCode.OAuthProviderNotSupported,
	ID_TOKEN_NOT_SUPPORTED: AuthErrorCode.FeatureNotSupported,

	// Server Errors
	FAILED_TO_CREATE_USER: AuthErrorCode.InternalError,
	FAILED_TO_CREATE_SESSION: AuthErrorCode.InternalError,
	FAILED_TO_UPDATE_USER: AuthErrorCode.InternalError,
	EMAIL_CAN_NOT_BE_UPDATED: AuthErrorCode.FeatureNotSupported,
};

/**
 * Maps HTTP status codes from Better Auth to AuthErrorCode
 */
export const STATUS_CODE_ERROR_MAP: Record<number, AuthErrorCode> = {
	400: AuthErrorCode.ValidationFailed,
	401: AuthErrorCode.BadJwt,
	403: AuthErrorCode.FeatureNotSupported,
	404: AuthErrorCode.UserNotFound,
	409: AuthErrorCode.UserAlreadyExists,
	422: AuthErrorCode.ValidationFailed,
	429: AuthErrorCode.OverRequestRateLimit,
	500: AuthErrorCode.UnexpectedFailure,
	501: AuthErrorCode.NotImplemented,
	503: AuthErrorCode.FeatureNotSupported,
};
