/**
 * API endpoint configuration for server-side auth methods.
 * This is the single source of truth for mapping method names to REST endpoints.
 *
 * To add a new API:
 * 1. Add the endpoint configuration here (must match a key in VanillaBetterAuthClient)
 * 2. The types will automatically flow from VanillaBetterAuthClient
 *
 * TypeScript will error if you try to add a key that doesn't exist in VanillaBetterAuthClient.
 */

import type { VanillaBetterAuthClient } from "@/types";

export interface EndpointConfig {
	path: string;
	method: "GET" | "POST";
}

/**
 * Generic endpoint tree type for internal proxy use.
 */
export type EndpointTree = {
	[key: string]: EndpointConfig | EndpointTree;
};

/**
 * Constrain endpoint keys to only those that exist in VanillaBetterAuthClient.
 * This ensures type safety - you can't add an endpoint that doesn't exist in the client.
 *
 * Handles both:
 * - Simple methods (getSession) → EndpointConfig
 * - Nested methods (signIn.email) → recursive ValidEndpointTree
 * - Callable objects with nested props → EndpointConfig OR recursive
 */
type ValidEndpointTree<T> = {
	[K in keyof T]?: T[K] extends (...args: never[]) => unknown
		? // It's callable - allow EndpointConfig, or if it also has nested props, allow nesting
				| EndpointConfig
				| (T[K] extends object ? ValidEndpointTree<T[K]> : never)
		: T[K] extends object
			? ValidEndpointTree<T[K]> // Pure object - recurse
			: never;
};

export const API_ENDPOINTS = {
	// Session & token
	getSession: { path: "get-session", method: "GET" },
	getAccessToken: { path: "get-access-token", method: "GET" },
	listSessions: { path: "list-sessions", method: "GET" },
	revokeSession: { path: "revoke-session", method: "POST" },
	revokeSessions: { path: "revoke-sessions", method: "POST" },
	revokeOtherSessions: { path: "revoke-all-sessions", method: "POST" },
	refreshToken: { path: "refresh-token", method: "POST" },

	// Auth
	signIn: {
		email: { path: "sign-in/email", method: "POST" },
		social: { path: "sign-in/social", method: "POST" },
		emailOtp: { path: "sign-in/email-otp", method: "POST" },
		magicLink: { path: "sign-in/magic-link", method: "POST" },
	},
	signUp: {
		email: { path: "sign-up/email", method: "POST" },
	},
	signOut: { path: "sign-out", method: "POST" },

	// Accounts
	listAccounts: { path: "list-accounts", method: "GET" },
	accountInfo: { path: "account-info", method: "GET" },
	// TODO: Verify if neon-auth supports these two
	// unlinkAccount: { path: 'unlink-account', method: 'POST' },
	// linkSocial: { path: 'link-account', method: 'POST' },

	// User
	updateUser: { path: "update-user", method: "POST" },
	deleteUser: { path: "delete-user", method: "POST" },
	// changeEmail: { path: 'change-email', method: 'POST' }
	changePassword: { path: "change-password", method: "POST" },
	sendVerificationEmail: { path: "send-verification-email", method: "POST" },
	verifyEmail: { path: "verify-email", method: "POST" },
	resetPassword: { path: "reset-password", method: "POST" },
	requestPasswordReset: { path: "request-password-reset", method: "POST" },

	// JWT
	token: { path: "token", method: "GET" },
	jwks: { path: "jwt", method: "GET" },
	getAnonymousToken: { path: "token/anonymous", method: "GET" },

	// Admin (requires admin role)
	admin: {
		createUser: { path: "admin/create-user", method: "POST" },
		listUsers: { path: "admin/list-users", method: "GET" },
		setRole: { path: "admin/set-role", method: "POST" },
		setUserPassword: { path: "admin/set-user-password", method: "POST" },
		updateUser: { path: "admin/update-user", method: "POST" },
		banUser: { path: "admin/ban-user", method: "POST" },
		unbanUser: { path: "admin/unban-user", method: "POST" },
		listUserSessions: { path: "admin/list-user-sessions", method: "GET" },
		revokeUserSession: {
			path: "admin/revoke-user-session",
			method: "POST",
		},
		revokeUserSessions: {
			path: "admin/revoke-user-sessions",
			method: "POST",
		},
		impersonateUser: { path: "admin/impersonate-user", method: "POST" },
		stopImpersonating: { path: "admin/stop-impersonating", method: "POST" },
		removeUser: { path: "admin/remove-user", method: "POST" },
		hasPermission: { path: "admin/has-permission", method: "POST" },
	},

	// Organization
	organization: {
		// Core organization operations
		create: { path: "organization/create", method: "POST" },
		update: { path: "organization/update", method: "POST" },
		delete: { path: "organization/delete", method: "POST" },
		list: { path: "organization/list", method: "GET" },
		getFullOrganization: {
			path: "organization/get-full-organization",
			method: "GET",
		},
		setActive: { path: "organization/set-active", method: "POST" },
		checkSlug: { path: "organization/check-slug", method: "GET" },

		// Member management
		listMembers: { path: "organization/list-members", method: "GET" },
		removeMember: { path: "organization/remove-member", method: "POST" },
		updateMemberRole: {
			path: "organization/update-member-role",
			method: "POST",
		},
		leave: { path: "organization/leave", method: "POST" },
		getActiveMember: {
			path: "organization/get-active-member",
			method: "GET",
		},
		getActiveMemberRole: {
			path: "organization/get-active-member-role",
			method: "GET",
		},

		// Invitations
		inviteMember: { path: "organization/invite-member", method: "POST" },
		acceptInvitation: {
			path: "organization/accept-invitation",
			method: "POST",
		},
		rejectInvitation: {
			path: "organization/reject-invitation",
			method: "POST",
		},
		cancelInvitation: {
			path: "organization/cancel-invitation",
			method: "POST",
		},
		getInvitation: { path: "organization/get-invitation", method: "GET" },
		listInvitations: {
			path: "organization/list-invitations",
			method: "GET",
		},
		listUserInvitations: {
			path: "organization/list-user-invitations",
			method: "GET",
		},

		// Permissions
		hasPermission: { path: "organization/has-permission", method: "POST" },
	},

	// Email OTP
	emailOtp: {
		sendVerificationOtp: {
			path: "email-otp/send-verification-otp",
			method: "POST",
		},
		verifyEmail: { path: "email-otp/verify-email", method: "POST" },
		checkVerificationOtp: {
			path: "email-otp/check-verification-otp",
			method: "POST",
		},
		resetPassword: { path: "email-otp/passcode", method: "POST" },
	},

	// Magic Link
	magicLink: {
		verify: { path: "magic-link/verify", method: "GET" },
	},
} as const satisfies ValidEndpointTree<VanillaBetterAuthClient>;

export type ApiEndpoints = typeof API_ENDPOINTS;
