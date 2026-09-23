import { AuthApiError, AuthError } from "../auth-interface";

/**
 * Error codes for type-safe error handling
 */
export const AuthErrorCode = {
	// Authentication Errors (401)
	BadJwt: "bad_jwt",
	InvalidCredentials: "invalid_credentials",
	SessionExpired: "session_expired",
	SessionNotFound: "session_not_found",
	InvalidGrant: "invalid_grant",

	// User Management (404, 409, 422)
	UserNotFound: "user_not_found",
	UserAlreadyExists: "user_already_exists",
	EmailExists: "email_exists",
	PhoneExists: "phone_exists",

	// Verification (400, 422)
	EmailNotConfirmed: "email_not_confirmed",
	PhoneNotConfirmed: "phone_not_confirmed",

	// Validation (400)
	ValidationFailed: "validation_failed",
	BadJson: "bad_json",
	WeakPassword: "weak_password",
	EmailAddressInvalid: "email_address_invalid",

	// Features & Providers (403, 501, 503)
	FeatureNotSupported: "feature_not_supported",
	NotImplemented: "not_implemented",
	OAuthProviderNotSupported: "oauth_provider_not_supported",
	PhoneProviderDisabled: "phone_provider_disabled",
	MagicLinkNotSupported: "magic_link_not_supported",
	SsoProviderDisabled: "sso_provider_disabled",
	AnonymousProviderDisabled: "anonymous_provider_disabled",
	Web3ProviderDisabled: "web3_provider_disabled",

	// OAuth Errors (400, 500)
	BadOAuthCallback: "bad_oauth_callback",
	OAuthCallbackFailed: "oauth_callback_failed",

	// Rate Limiting (429)
	OverRequestRateLimit: "over_request_rate_limit",
	OverEmailSendRateLimit: "over_email_send_rate_limit",
	OverSmsSendRateLimit: "over_sms_send_rate_limit",

	// Server Errors (500)
	UnexpectedFailure: "unexpected_failure",
	InternalError: "internal_error",

	// Identity Management (404)
	IdentityNotFound: "identity_not_found",

	// Generic (400)
	UnknownError: "unknown_error",
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

/**
 * Error metadata including status codes and user-facing messages
 */
interface ErrorDefinition {
	code: AuthErrorCode;
	status: number;
	message: string;
	description?: string;
}

/**
 * Complete error definitions map
 * Maps error codes to HTTP status codes and default messages
 */
export const ERROR_DEFINITIONS: Record<AuthErrorCode, ErrorDefinition> = {
	// Authentication Errors (401)
	[AuthErrorCode.BadJwt]: {
		code: AuthErrorCode.BadJwt,
		status: 401,
		message: "Invalid or expired session token",
		description:
			"The JWT token is malformed, expired, or has an invalid signature",
	},
	[AuthErrorCode.InvalidCredentials]: {
		code: AuthErrorCode.InvalidCredentials,
		status: 401,
		message: "Invalid email or password",
		description: "The provided credentials do not match any user account",
	},
	[AuthErrorCode.SessionExpired]: {
		code: AuthErrorCode.SessionExpired,
		status: 401,
		message: "Session has expired",
		description: "The user session has exceeded its timeout period",
	},
	[AuthErrorCode.SessionNotFound]: {
		code: AuthErrorCode.SessionNotFound,
		status: 401,
		message: "No active session found",
		description:
			"The user does not have an active session or the session was invalidated",
	},
	[AuthErrorCode.InvalidGrant]: {
		code: AuthErrorCode.InvalidGrant,
		status: 401,
		message: "Invalid authorization grant",
		description: "OAuth/OIDC grant validation failed",
	},

	// User Management (404, 409, 422)
	[AuthErrorCode.UserNotFound]: {
		code: AuthErrorCode.UserNotFound,
		status: 404,
		message: "User not found",
		description: "No user exists with the provided identifier",
	},
	[AuthErrorCode.UserAlreadyExists]: {
		code: AuthErrorCode.UserAlreadyExists,
		status: 409,
		message: "User already exists",
		description:
			"A user with this email or phone number is already registered",
	},
	[AuthErrorCode.EmailExists]: {
		code: AuthErrorCode.EmailExists,
		status: 409,
		message: "Email address already registered",
		description: "This email address is already associated with an account",
	},
	[AuthErrorCode.PhoneExists]: {
		code: AuthErrorCode.PhoneExists,
		status: 409,
		message: "Phone number already registered",
		description: "This phone number is already associated with an account",
	},

	// Verification (400, 422)
	[AuthErrorCode.EmailNotConfirmed]: {
		code: AuthErrorCode.EmailNotConfirmed,
		status: 422,
		message: "Email verification required",
		description: "The user must verify their email before signing in",
	},
	[AuthErrorCode.PhoneNotConfirmed]: {
		code: AuthErrorCode.PhoneNotConfirmed,
		status: 422,
		message: "Phone verification required",
		description:
			"The user must verify their phone number before signing in",
	},

	// Validation (400)
	[AuthErrorCode.ValidationFailed]: {
		code: AuthErrorCode.ValidationFailed,
		status: 400,
		message: "Invalid request parameters",
		description: "One or more request parameters are invalid or missing",
	},
	[AuthErrorCode.BadJson]: {
		code: AuthErrorCode.BadJson,
		status: 400,
		message: "Invalid JSON in request body",
		description: "The request body contains malformed JSON",
	},
	[AuthErrorCode.WeakPassword]: {
		code: AuthErrorCode.WeakPassword,
		status: 400,
		message: "Password does not meet security requirements",
		description:
			"The password is too weak or does not meet complexity requirements",
	},
	[AuthErrorCode.EmailAddressInvalid]: {
		code: AuthErrorCode.EmailAddressInvalid,
		status: 400,
		message: "Invalid email address format",
		description: "The provided email address is not in a valid format",
	},

	// Features & Providers (403, 501, 503)
	[AuthErrorCode.FeatureNotSupported]: {
		code: AuthErrorCode.FeatureNotSupported,
		status: 403,
		message: "Feature not available",
		description:
			"This feature is not supported in the current configuration",
	},
	[AuthErrorCode.NotImplemented]: {
		code: AuthErrorCode.NotImplemented,
		status: 501,
		message: "Feature not implemented",
		description: "This feature has not been implemented yet",
	},
	[AuthErrorCode.OAuthProviderNotSupported]: {
		code: AuthErrorCode.OAuthProviderNotSupported,
		status: 403,
		message: "OAuth provider not supported",
		description: "The requested OAuth provider is not enabled",
	},
	[AuthErrorCode.PhoneProviderDisabled]: {
		code: AuthErrorCode.PhoneProviderDisabled,
		status: 403,
		message: "Phone authentication not available",
		description: "Phone number authentication is not enabled",
	},
	[AuthErrorCode.MagicLinkNotSupported]: {
		code: AuthErrorCode.MagicLinkNotSupported,
		status: 403,
		message: "Magic link authentication not available",
		description: "Magic link authentication is not supported",
	},
	[AuthErrorCode.SsoProviderDisabled]: {
		code: AuthErrorCode.SsoProviderDisabled,
		status: 403,
		message: "SSO not supported",
		description: "Enterprise SSO authentication is not available",
	},
	[AuthErrorCode.AnonymousProviderDisabled]: {
		code: AuthErrorCode.AnonymousProviderDisabled,
		status: 403,
		message: "Anonymous authentication not available",
		description: "Anonymous sign-in is not enabled",
	},
	[AuthErrorCode.Web3ProviderDisabled]: {
		code: AuthErrorCode.Web3ProviderDisabled,
		status: 403,
		message: "Web3 authentication not supported",
		description: "Web3/blockchain authentication is not available",
	},

	// OAuth Errors (400, 500)
	[AuthErrorCode.BadOAuthCallback]: {
		code: AuthErrorCode.BadOAuthCallback,
		status: 400,
		message: "Invalid OAuth callback",
		description:
			"The OAuth callback request is missing required parameters",
	},
	[AuthErrorCode.OAuthCallbackFailed]: {
		code: AuthErrorCode.OAuthCallbackFailed,
		status: 500,
		message: "OAuth authentication failed",
		description: "The OAuth callback completed but no session was created",
	},

	// Rate Limiting (429)
	[AuthErrorCode.OverRequestRateLimit]: {
		code: AuthErrorCode.OverRequestRateLimit,
		status: 429,
		message: "Too many requests",
		description: "Rate limit exceeded. Please try again later",
	},
	[AuthErrorCode.OverEmailSendRateLimit]: {
		code: AuthErrorCode.OverEmailSendRateLimit,
		status: 429,
		message: "Too many email requests",
		description: "Too many emails sent. Please wait before trying again",
	},
	[AuthErrorCode.OverSmsSendRateLimit]: {
		code: AuthErrorCode.OverSmsSendRateLimit,
		status: 429,
		message: "Too many SMS requests",
		description:
			"Too many SMS messages sent. Please wait before trying again",
	},

	// Server Errors (500)
	[AuthErrorCode.UnexpectedFailure]: {
		code: AuthErrorCode.UnexpectedFailure,
		status: 500,
		message: "An unexpected error occurred",
		description: "The server encountered an unexpected condition",
	},
	[AuthErrorCode.InternalError]: {
		code: AuthErrorCode.InternalError,
		status: 500,
		message: "Internal server error",
		description: "An internal error occurred while processing the request",
	},

	// Identity Management (404)
	[AuthErrorCode.IdentityNotFound]: {
		code: AuthErrorCode.IdentityNotFound,
		status: 404,
		message: "Identity not found",
		description: "The requested user identity does not exist",
	},

	// Generic (400)
	[AuthErrorCode.UnknownError]: {
		code: AuthErrorCode.UnknownError,
		status: 500,
		message: "An unknown error occurred",
		description: "The error could not be categorized",
	},
};

/**
 * Helper to get error definition by code
 */
export function getErrorDefinition(code: AuthErrorCode): ErrorDefinition {
	return ERROR_DEFINITIONS[code];
}

/**
 * Create an AuthError or AuthApiError with proper status and message
 *
 * @param code - The error code from AuthErrorCode
 * @param customMessage - Optional custom message (defaults to error definition message)
 * @returns AuthError for 5xx errors, AuthApiError for 4xx errors
 */
export function createAuthError(
	code: AuthErrorCode,
	customMessage?: string,
): AuthError {
	const def = getErrorDefinition(code);
	const message = customMessage || def.message;
	const status = def.status;

	// Use AuthApiError for client/API errors (non-500 status codes)
	if (status !== 500 && status !== 501 && status !== 503) {
		return new AuthApiError(message, status, def.code);
	}

	// Use AuthError for server errors
	return new AuthError(message, status, def.code);
}
