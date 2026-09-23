/**
 * Re-export all types from better-auth for convenience.
 * Users don't need to add better-auth as a direct dependency.
 *
 * This includes types from all plugins supported by NeonAuth.
 * See adapter-core.ts for the list of supported plugins.
 */

import type { createAuthClient as createVanillaAuthClient } from "better-auth/client";
import type { createAuthClient as createReactAuthClient } from "better-auth/react";
import type { SupportedBetterAuthClientPlugins } from "../core/adapter-core";

// Error types
export type { BetterFetchError } from "@better-fetch/fetch";
// ============================================
// Core types from better-auth/types
// ============================================
export * from "better-auth/types";

/**
 * Type representing the Better Auth React client
 */
export type ReactBetterAuthClient = ReturnType<
	typeof createReactAuthClient<{
		plugins: SupportedBetterAuthClientPlugins;
	}>
>;

/**
 * Type representing the Better Auth Vanilla client
 */
export type VanillaBetterAuthClient = ReturnType<
	typeof createVanillaAuthClient<{
		plugins: SupportedBetterAuthClientPlugins;
	}>
>;

// ============================================
// Plugin types (all supported plugins)
// ============================================

// Admin plugin
export type {
	AdminOptions,
	InferAdminRolesFromOption,
	SessionWithImpersonatedBy,
	UserWithRole,
} from "better-auth/plugins/admin";
// Email OTP plugin
export type { EmailOTPOptions } from "better-auth/plugins/email-otp";
// JWT plugin
export type {
	JWKOptions,
	JWSAlgorithms,
	Jwk,
	JwtOptions,
} from "better-auth/plugins/jwt";
// Magic Link plugin
export type { MagicLinkOptions } from "better-auth/plugins/magic-link";
// Organization plugin
export type {
	Invitation,
	InvitationInput,
	InvitationStatus,
	Member,
	MemberInput,
	Organization,
	OrganizationInput,
	OrganizationRole,
	Team,
	TeamInput,
	TeamMember,
	TeamMemberInput,
} from "better-auth/plugins/organization";

// Phone Number plugin
export type { PhoneNumberOptions } from "better-auth/plugins/phone-number";

// Anonymous plugin - no additional types to export

// ============================================
// Backwards compatibility aliases
// ============================================
export type BetterAuthInstance =
	| VanillaBetterAuthClient
	| ReactBetterAuthClient;

export type {
	BetterAuthErrorResponse,
	BetterAuthSession,
	BetterAuthUser,
} from "../core/better-auth-types";
