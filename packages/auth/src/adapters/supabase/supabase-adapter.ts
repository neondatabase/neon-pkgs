import type {
	AuthChangeEvent,
	JwtHeader,
	JwtPayload,
	Provider,
	Session,
	Subscription,
	VerifyEmailOtpParams,
} from "@supabase/auth-js";
import {
	type AuthClient as BetterAuthClient,
	createAuthClient,
	getGlobalBroadcastChannel,
} from "better-auth/client";
import { base64url, decodeJwt, decodeProtectedHeader } from "jose";
import {
	NeonAuthAdapterCore,
	type NeonAuthAdapterCoreAuthOptions,
	type SupportedBetterAuthClientPlugins,
} from "../../core/adapter-core";
import {
	mapBetterAuthIdentity,
	mapBetterAuthSession,
	normalizeBetterAuthError,
} from "../../core/better-auth-helpers";
import {
	BETTER_AUTH_METHODS_CACHE,
	BETTER_AUTH_METHODS_HOOKS,
	CURRENT_TAB_CLIENT_ID,
	type NeonAuthChangeEvent,
} from "../../core/better-auth-methods";
import type { CachedSessionData } from "../../core/session-cache-manager";
import {
	isAuthError,
	type SupabaseAuthClientInterface,
} from "./auth-interface";
import { AuthErrorCode, createAuthError } from "./errors/definitions";

export type SupabaseAuthAdapterOptions = Omit<
	NeonAuthAdapterCoreAuthOptions,
	"baseURL"
>;

/**
 * Duck-type check for Better Auth API errors.
 * Replaces `instanceof APIError` to avoid importing server-side code.
 */
function isBetterAuthAPIError(
	error: unknown,
): error is { status: number; body?: { message?: string; code?: string } } {
	return (
		error !== null &&
		typeof error === "object" &&
		"status" in error &&
		typeof (error as { status: unknown }).status === "number"
	);
}

/**
 * Internal implementation class - use SupabaseAuthAdapter factory function instead
 */
class SupabaseAuthAdapterImpl
	extends NeonAuthAdapterCore
	implements SupabaseAuthClientInterface
{
	admin: SupabaseAuthClientInterface["admin"] = undefined as never;
	mfa: SupabaseAuthClientInterface["mfa"] = undefined as never;
	oauth: SupabaseAuthClientInterface["oauth"] = undefined as never;
	private _betterAuth: BetterAuthClient<{
		plugins: SupportedBetterAuthClientPlugins;
	}>;
	private _stateChangeEmitters = new Map<string, Subscription>();

	constructor(betterAuthClientOptions: NeonAuthAdapterCoreAuthOptions) {
		super(betterAuthClientOptions);
		this._betterAuth = createAuthClient(this.betterAuthOptions);

		/**
		 * useSession() - Automatic Session Management
		 *
		 * Enabled by Default:
		 * - ✅ Refetch on Window Focus: Automatically refetches session when user returns to the tab
		 * - ✅ Cross-Tab Sync: Syncs session state across all browser tabs (sign out in one = sign out in all)
		 * - ✅ Online/Offline Detection: Refetches session when network connection is restored
		 * - ❌ Interval Polling: Disabled (refetchInterval: 0)
		 *
		 * Returns:
		 * - data: Session object (user + session)
		 * - isPending: Loading state
		 * - isRefetching: Refetch in progress
		 * - error: Error object if any
		 * - refetch(): Manual refetch function
		 *
		 * Customize with:
		 * createAuthClient({
		 *   sessionOptions: {
		 *     refetchOnWindowFocus: true,  // default
		 *     refetchInterval: 0,           // default (seconds, 0 = off)
		 *     refetchWhenOffline: false     // default
		 *   }
		 * })
		 */
		this._betterAuth.useSession.subscribe((value) => {
			// If session is null/undefined, clear cache (sign-out detected from any tab)
			if (!value.data?.session || !value.data?.user) {
				BETTER_AUTH_METHODS_CACHE.clearSessionCache();
				return;
			}

			// If session exists, don't cache it here - it has opaque token
			// JWT-injected sessions are cached by getSession() immediately after fetch
		});

		// Set up cross-tab event listener for Better Auth broadcasts
		// This listens to events from other tabs and notifies local subscribers
		// triggers on: signOut | getSession | updateUser
		getGlobalBroadcastChannel().subscribe((message) => {
			if (message.clientId === CURRENT_TAB_CLIENT_ID) {
				return; // Skip - this is my own broadcast
			}

			// Handle broadcasts with Better Auth native format (sessionData)
			if (message.data && "sessionData" in message.data) {
				const sessionData = message.data
					.sessionData as CachedSessionData | null;
				const trigger = message.data.trigger as NeonAuthChangeEvent;

				// Update cache with session data (already in Better Auth format)
				if (sessionData) {
					BETTER_AUTH_METHODS_CACHE.setCachedSession(sessionData);
				} else {
					BETTER_AUTH_METHODS_CACHE.clearSessionCache();
				}

				// Map to Supabase format for onAuthStateChange callbacks
				const supabaseSession = sessionData
					? mapBetterAuthSession(
							sessionData.session,
							sessionData.user,
						)
					: null;

				// Notify all subscribers with Supabase format (for onAuthStateChange compatibility)
				const promises = [...this._stateChangeEmitters.values()].map(
					(subscription) => {
						try {
							return Promise.resolve(
								subscription.callback(trigger, supabaseSession),
							);
						} catch {
							return Promise.resolve();
						}
					},
				);

				Promise.allSettled(promises);
			}
		});
	}
	getBetterAuthInstance(): ReturnType<
		typeof createAuthClient<{
			plugins: SupportedBetterAuthClientPlugins;
		}>
	> {
		return this._betterAuth;
	}

	initialize: SupabaseAuthClientInterface["initialize"] = async () => {
		try {
			const session = await this.getSession();

			if (session.error) {
				throw session.error;
			}

			return {
				data: session.data,
				error: null,
			};
		} catch (error) {
			if (isAuthError(error)) {
				return { data: { session: null }, error };
			}
			if (isBetterAuthAPIError(error)) {
				return {
					data: { session: null },
					error: normalizeBetterAuthError(error),
				};
			}
			throw error;
		}
	};
	//#endregion

	//#region PUBLIC API - Session Management
	async getSession(options?: {
		forceFetch?: boolean;
	}): ReturnType<SupabaseAuthClientInterface["getSession"]> {
		try {
			const currentSession = await this._betterAuth.getSession(
				options?.forceFetch
					? { fetchOptions: { headers: { "X-Force-Fetch": "true" } } }
					: undefined,
			);

			if (!currentSession.data?.session) {
				return { data: { session: null }, error: null };
			}

			const session = mapBetterAuthSession(
				currentSession.data.session,
				currentSession.data.user,
			);

			return {
				data: {
					session: session as Session,
				},
				error: null,
			};
		} catch (error) {
			if (isAuthError(error)) {
				return { data: { session: null }, error };
			}
			if (isBetterAuthAPIError(error)) {
				return {
					data: { session: null },
					error: normalizeBetterAuthError(error),
				};
			}
			throw error;
		}
	}

	refreshSession: SupabaseAuthClientInterface["refreshSession"] =
		async () => {
			try {
				const sessionResult = await this.getSession();

				if (sessionResult.error) {
					throw sessionResult.error;
				}

				return {
					data: {
						user: sessionResult.data.session?.user ?? null,
						session: sessionResult.data.session,
					},
					error: null,
				};
			} catch (error) {
				if (isAuthError(error)) {
					return { data: { user: null, session: null }, error };
				}
				if (isBetterAuthAPIError(error)) {
					return {
						data: { user: null, session: null },
						error: normalizeBetterAuthError(error),
					};
				}
				throw error;
			}
		};

	// TODO: we need to implement a custom plugin to allow setting external sessions
	setSession: SupabaseAuthClientInterface["setSession"] = async () => {
		return {
			data: { user: null, session: null },
			error: createAuthError(
				AuthErrorCode.NotImplemented,
				"setSession() is not supported by Better Auth. Use signInWithPassword() instead.",
			),
		};
	};

	//#region PUBLIC API - Authentication
	signUp: SupabaseAuthClientInterface["signUp"] = async (credentials) => {
		try {
			if (
				"email" in credentials &&
				credentials.email &&
				credentials.password
			) {
				const displayName =
					credentials.options?.data &&
					"displayName" in credentials.options.data &&
					typeof credentials.options.data.displayName === "string"
						? credentials.options.data.displayName
						: "";

				// TODO: for channels (sms/whatsapp), we would need to implement the channel-based plugins
				// TODO: for captcha, we would need to implement the captcha plugin
				const result = await this._betterAuth.signUp.email({
					email: credentials.email,
					password: credentials.password,
					name: displayName,
					callbackURL: credentials.options?.emailRedirectTo,
					// TODO: user's metadata, we need to define them at the server adapter, else this won't be stored I think
					...credentials.options?.data,
				});

				if (result.error) {
					throw normalizeBetterAuthError(result.error);
				}

				const sessionResult = await this.getSession();

				if (!sessionResult.data.session?.user) {
					throw createAuthError(
						AuthErrorCode.SessionNotFound,
						"Failed to retrieve user session",
					);
				}

				const data = {
					user: sessionResult.data.session.user,
					session: sessionResult.data.session,
				};

				return { data, error: null };
			} else if ("phone" in credentials && credentials.phone) {
				// TODO: we would need to add the phone-number plugin
				throw createAuthError(
					AuthErrorCode.PhoneProviderDisabled,
					"Phone sign-up not supported",
				);
			} else {
				throw createAuthError(
					AuthErrorCode.ValidationFailed,
					"Invalid credentials format",
				);
			}
		} catch (error) {
			if (isAuthError(error)) {
				return { data: { user: null, session: null }, error };
			}
			if (isBetterAuthAPIError(error)) {
				return {
					data: { user: null, session: null },
					error: normalizeBetterAuthError(error),
				};
			}
			throw error;
		}
	};

	signInAnonymously: SupabaseAuthClientInterface["signInAnonymously"] =
		async () => {
			return {
				data: {
					user: null,
					session: null,
				},
				error: createAuthError(
					AuthErrorCode.AnonymousProviderDisabled,
					`Anonymous sign-in is not supported. To allow unauthenticated access with an anonymous JWT, use the allowAnonymous option in your Auth configuration instead.`,
				),
			};
		};

	signInWithPassword: SupabaseAuthClientInterface["signInWithPassword"] =
		async (credentials) => {
			try {
				if ("email" in credentials && credentials.email) {
					// TODO: for captcha, we would need to add the captcha plugin
					const result = await this._betterAuth.signIn.email({
						email: credentials.email,
						password: credentials.password,
					});

					if (result.error) {
						throw normalizeBetterAuthError(result.error);
					}

					const sessionResult = await this.getSession();
					if (!sessionResult.data.session?.user) {
						throw createAuthError(
							AuthErrorCode.SessionNotFound,
							"Failed to retrieve user session",
						);
					}

					const data = {
						user: sessionResult.data.session.user,
						session: sessionResult.data.session,
					};

					return { data, error: null };
				} else if ("phone" in credentials && credentials.phone) {
					// TODO: we would need to add the phone-number plugin
					throw createAuthError(
						AuthErrorCode.PhoneProviderDisabled,
						"Phone sign-in not supported",
					);
				} else {
					throw createAuthError(
						AuthErrorCode.ValidationFailed,
						"Invalid credentials format",
					);
				}
			} catch (error) {
				if (isAuthError(error)) {
					return { data: { user: null, session: null }, error };
				}
				if (isBetterAuthAPIError(error)) {
					return {
						data: { user: null, session: null },
						error: normalizeBetterAuthError(error),
					};
				}
				throw error;
			}
		};

	// TODO: we should omit queryParams from the credentials
	signInWithOAuth: SupabaseAuthClientInterface["signInWithOAuth"] = async (
		credentials,
	) => {
		try {
			const { provider, options } = credentials;

			await this._betterAuth.signIn.social({
				provider,
				// Convert scopes from space-separated string to Better Auth format (array)
				scopes: options?.scopes?.split(" "),
				disableRedirect: options?.skipBrowserRedirect,
				callbackURL:
					options?.redirectTo ||
					(globalThis.window === undefined
						? ""
						: globalThis.location.origin),
			});

			return {
				data: {
					provider,
					url:
						options?.redirectTo ||
						(globalThis.window === undefined
							? ""
							: globalThis.location.origin),
				},
				error: null,
			};
		} catch (error) {
			if (isAuthError(error)) {
				return {
					data: { provider: credentials.provider, url: null },
					error,
				};
			}
			if (isBetterAuthAPIError(error)) {
				return {
					data: { provider: credentials.provider, url: null },
					error: normalizeBetterAuthError(error),
				};
			}
			throw error;
		}
	};

	signInWithOtp: SupabaseAuthClientInterface["signInWithOtp"] = async (
		credentials,
	) => {
		try {
			if ("phone" in credentials) {
				return {
					data: { user: null, session: null, messageId: undefined },
					error: createAuthError(
						AuthErrorCode.PhoneProviderDisabled,
						"Phone OTP authentication is not supported. Use email-based authentication instead.",
					),
				};
			}

			if ("email" in credentials) {
				await this._betterAuth.emailOtp.sendVerificationOtp({
					email: credentials.email,
					type: "sign-in",
				});

				return {
					data: { user: null, session: null, messageId: undefined },
					error: null,
				};
			}

			throw createAuthError(
				AuthErrorCode.ValidationFailed,
				"Invalid OTP credentials format",
			);
		} catch (error) {
			if (isAuthError(error)) {
				return {
					data: { user: null, session: null, messageId: undefined },
					error,
				};
			}
			if (isBetterAuthAPIError(error)) {
				return {
					data: { user: null, session: null, messageId: undefined },
					error: normalizeBetterAuthError(error),
				};
			}
			throw error;
		}
	};

	signInWithIdToken: SupabaseAuthClientInterface["signInWithIdToken"] =
		async (credentials) => {
			try {
				const result = await this._betterAuth.signIn.social({
					provider: credentials.provider,
					idToken: {
						token: credentials.token,
						accessToken: credentials.access_token,
						nonce: credentials.nonce,
					},
				});

				if (result.error) {
					throw normalizeBetterAuthError(result.error);
				}

				if (!("user" in result.data) || !result.data.user) {
					throw createAuthError(
						AuthErrorCode.OAuthCallbackFailed,
						"Failed to sign in with ID token",
					);
				}

				const session = await this.getSession();
				if (session.error || !session.data.session) {
					throw (
						session.error ||
						createAuthError(
							AuthErrorCode.SessionNotFound,
							"Failed to get session",
						)
					);
				}

				return {
					data: {
						user: session.data.session.user,
						session: session.data.session,
					},
					error: null,
				};
			} catch (error) {
				if (isAuthError(error)) {
					return { data: { user: null, session: null }, error };
				}
				if (isBetterAuthAPIError(error)) {
					return {
						data: { user: null, session: null },
						error: normalizeBetterAuthError(error),
					};
				}
				throw error;
			}
		};

	// TODO: we need to add the sso plugin to the server adapter
	signInWithSSO: SupabaseAuthClientInterface["signInWithSSO"] = async (
		params,
	) => {
		const attemptedWith =
			"providerId" in params
				? `provider ID: ${params.providerId}`
				: `domain: ${"domain" in params ? params.domain : "unknown"}`;

		return {
			data: null,
			error: createAuthError(
				AuthErrorCode.SsoProviderDisabled,
				`Better Auth does not support enterprise SAML SSO. Attempted with ${attemptedWith}. Use signInWithOAuth() for OAuth providers instead.`,
			),
		};
	};

	// TODO: we need to add the SIWE plugin to the server adapter
	signInWithWeb3: SupabaseAuthClientInterface["signInWithWeb3"] = async (
		credentials,
	) => {
		const attemptedChain = credentials.chain;

		return {
			data: {
				user: null,
				session: null,
			},
			error: createAuthError(
				AuthErrorCode.Web3ProviderDisabled,
				`Better Auth does not support Web3 authentication. Attempted with chain: ${attemptedChain}. Supported: OAuth, email/password, magic link.`,
			),
		};
	};

	signOut: SupabaseAuthClientInterface["signOut"] = async () => {
		try {
			const result = await this._betterAuth.signOut();

			if (result.error) {
				throw normalizeBetterAuthError(result.error);
			}

			return { error: null };
		} catch (error) {
			if (isAuthError(error)) {
				return { error };
			}
			if (isBetterAuthAPIError(error)) {
				return { error: normalizeBetterAuthError(error) };
			}
			throw error;
		}
	};
	//#endregion

	//#region PUBLIC API - User Management
	getUser: SupabaseAuthClientInterface["getUser"] = async () => {
		try {
			const sessionResult = await this.getSession();

			if (sessionResult.error || !sessionResult.data.session) {
				throw (
					sessionResult.error ||
					createAuthError(
						AuthErrorCode.SessionNotFound,
						"No user session found",
					)
				);
			}

			return {
				data: {
					user: sessionResult.data.session.user,
				},
				error: null,
			};
		} catch (error) {
			if (isAuthError(error)) {
				return { data: { user: null }, error };
			}
			if (isBetterAuthAPIError(error)) {
				return {
					data: { user: null },
					error: normalizeBetterAuthError(error),
				};
			}
			throw error;
		}
	};

	// TODO: we dont have the options param, like JWKS
	getClaims = async (jwtArg?: string) => {
		try {
			let jwt = jwtArg;

			// Get session if JWT not provided
			if (!jwt) {
				const sessionResult = await this.getSession();

				if (sessionResult.error || !sessionResult.data?.session) {
					throw (
						sessionResult.error ||
						createAuthError(
							AuthErrorCode.SessionNotFound,
							"No user session found",
						)
					);
				}

				jwt = sessionResult.data.session.access_token;
			}

			if (!jwt) {
				throw createAuthError(
					AuthErrorCode.SessionNotFound,
					"No access token found",
				);
			}

			// Split JWT into parts
			const tokenParts = jwt.split(".");
			if (tokenParts.length !== 3) {
				throw createAuthError(
					AuthErrorCode.BadJwt,
					"Invalid token format",
				);
			}

			// Decode header using JOSE
			const header = decodeProtectedHeader(jwt) as JwtHeader;

			// Decode payload using JOSE
			const claims = decodeJwt(jwt) as JwtPayload;

			// Decode signature to Uint8Array using JOSE's base64url
			const signature = base64url.decode(jwt.split(".")[2]);

			return {
				data: {
					header,
					claims,
					signature,
				},
				error: null,
			};
		} catch (error) {
			if (isAuthError(error)) {
				return { data: null, error };
			}
			if (isBetterAuthAPIError(error)) {
				return { data: null, error: normalizeBetterAuthError(error) };
			}
			throw error;
		}
	};

	updateUser: SupabaseAuthClientInterface["updateUser"] = async (
		attributes,
	) => {
		try {
			if (attributes.password) {
				throw createAuthError(
					AuthErrorCode.FeatureNotSupported,
					"The password cannot be updated through the updateUser method, use the changePassword method instead.",
				);
			}

			if (attributes.email) {
				throw createAuthError(
					AuthErrorCode.FeatureNotSupported,
					"The email cannot be updated through the updateUser method, use the changeEmail method instead.",
				);
			}

			const result = await this._betterAuth.updateUser({
				...attributes.data,
			});

			if (result.data?.status) {
				throw createAuthError(
					AuthErrorCode.InternalError,
					"Failed to update user",
				);
			}

			if (result?.error) {
				throw normalizeBetterAuthError(result.error);
			}

			const updatedSessionResult = await this.getSession({
				forceFetch: true,
			});
			if (!updatedSessionResult.data.session) {
				throw createAuthError(
					AuthErrorCode.SessionNotFound,
					"Failed to retrieve updated user",
				);
			}

			return {
				data: { user: updatedSessionResult.data.session.user },
				error: null,
			};
		} catch (error) {
			if (isAuthError(error)) {
				return { data: { user: null }, error };
			}
			if (isBetterAuthAPIError(error)) {
				return {
					data: { user: null },
					error: normalizeBetterAuthError(error),
				};
			}
			throw error;
		}
	};

	getUserIdentities: SupabaseAuthClientInterface["getUserIdentities"] =
		async () => {
			try {
				const sessionResult = await this.getSession();

				if (sessionResult.error || !sessionResult.data.session) {
					throw (
						sessionResult.error ||
						createAuthError(
							AuthErrorCode.SessionNotFound,
							"No user session found",
						)
					);
				}

				// Fetch-level deduplication handles concurrent requests automatically
				const result = await this._betterAuth.listAccounts();

				if (!result) {
					throw createAuthError(
						AuthErrorCode.InternalError,
						"Failed to list accounts",
					);
				}

				if (result.error) {
					throw normalizeBetterAuthError(result.error);
				}

				const identitiesPromises = result.data.map(async (account) => {
					let accountInfo = null;
					try {
						const infoResult = await this._betterAuth.accountInfo({
							query: { accountId: account.accountId },
						});
						accountInfo = infoResult.data;
					} catch (error) {
						// If getAccountInfo fails, continue with basic data
						console.warn(
							`Failed to get account info for ${account.providerId}:`,
							error,
						);
					}

					return mapBetterAuthIdentity(account, accountInfo ?? null);
				});

				const identities = await Promise.all(identitiesPromises);

				return {
					data: { identities },
					error: null,
				};
			} catch (error) {
				if (isAuthError(error)) {
					return { data: null, error };
				}
				if (isBetterAuthAPIError(error)) {
					return {
						data: null,
						error: normalizeBetterAuthError(error),
					};
				}
				throw error;
			}
		};

	// TODO: we need to enable the account/accountLinking plugin to the server adapter
	linkIdentity: SupabaseAuthClientInterface["linkIdentity"] = async (
		credentials,
	) => {
		const provider = credentials.provider as Provider;
		try {
			const sessionResult = await this.getSession();

			if (sessionResult.error || !sessionResult.data.session) {
				throw (
					sessionResult.error ||
					createAuthError(
						AuthErrorCode.SessionNotFound,
						"No user session found",
					)
				);
			}

			// Link with ID token (direct)
			if ("token" in credentials) {
				const result = await this._betterAuth.linkSocial({
					provider,
					idToken: {
						token: credentials.token,
						accessToken: credentials.access_token,
						nonce: credentials.nonce,
					},
				});

				if (result.error) {
					throw normalizeBetterAuthError(result.error);
				}

				return {
					data: {
						user: sessionResult.data.session.user,
						session: sessionResult.data.session,
						provider,
						url: result.data?.url,
					},
					error: null,
				};
			}

			// OAuth flow (redirect)
			const callbackURL =
				credentials.options?.redirectTo ||
				(globalThis.window === undefined
					? ""
					: globalThis.location.origin);
			const scopes = credentials.options?.scopes
				?.split(" ")
				.filter((s: string) => s.length > 0);

			const result = await this._betterAuth.linkSocial({
				provider,
				callbackURL,
				errorCallbackURL: callbackURL
					? `${callbackURL}?error=linking-failed`
					: undefined,
				scopes,
			});

			if (result.error) {
				throw normalizeBetterAuthError(result.error);
			}

			return {
				data: {
					provider,
					url: result.data?.url,
					user: sessionResult.data.session.user,
					session: sessionResult.data.session,
				},
				error: null,
			};
		} catch (error) {
			if (isAuthError(error)) {
				return {
					data: { provider, url: null, user: null, session: null },
					error,
				};
			}
			if (isBetterAuthAPIError(error)) {
				return {
					data: { provider, url: null, user: null, session: null },
					error: normalizeBetterAuthError(error),
				};
			}
			throw error;
		}
	};

	unlinkIdentity: SupabaseAuthClientInterface["unlinkIdentity"] = async (
		identity,
	) => {
		try {
			const sessionResult = await this.getSession();
			if (sessionResult.error || !sessionResult.data.session) {
				throw (
					sessionResult.error ||
					createAuthError(
						AuthErrorCode.SessionNotFound,
						"No user session found",
					)
				);
			}

			const identities = await this.getUserIdentities();
			if (identities.error || !identities.data) {
				throw (
					identities.error ||
					createAuthError(
						AuthErrorCode.InternalError,
						"Failed to fetch identities",
					)
				);
			}

			// Find the identity by internal DB ID
			const targetIdentity = identities.data.identities.find(
				(i) => i.id === identity.identity_id,
			);
			if (!targetIdentity) {
				throw createAuthError(
					AuthErrorCode.IdentityNotFound,
					"Identity not found",
				);
			}

			// Map to better-auth fields
			const providerId = targetIdentity.provider; // e.g., "google"
			const accountId = targetIdentity.identity_id; // e.g., "google-user-id-12345"

			// Call better-auth
			const result = await this._betterAuth.unlinkAccount({
				providerId,
				accountId,
			});

			if (result?.error) {
				throw normalizeBetterAuthError(result.error);
			}

			const updatedSession = await this.getSession({ forceFetch: true });
			if (updatedSession.data.session) {
				BETTER_AUTH_METHODS_HOOKS.updateUser.onSuccess(
					updatedSession.data.session,
				);
			}

			return {
				data: {},
				error: null,
			};
		} catch (error) {
			if (isAuthError(error)) {
				return { data: null, error };
			}
			if (isBetterAuthAPIError(error)) {
				return { data: null, error: normalizeBetterAuthError(error) };
			}
			throw error;
		}
	};
	//#endregion

	//#region PUBLIC API - Verification & Password Reset
	verifyOtp: SupabaseAuthClientInterface["verifyOtp"] = async (params) => {
		try {
			// Phone/SMS verification is not supported
			if ("phone" in params && params.phone) {
				return {
					data: { user: null, session: null },
					error: createAuthError(
						AuthErrorCode.PhoneProviderDisabled,
						"Phone OTP verification is not supported. Use email-based authentication instead.",
					),
				};
			}

			// Magic link verification is not supported
			if ("email" in params && params.type === "magiclink") {
				return {
					data: { user: null, session: null },
					error: createAuthError(
						AuthErrorCode.MagicLinkNotSupported,
						"Magic link verification is not supported. Use email OTP authentication instead.",
					),
				};
			}

			if ("email" in params && params.email) {
				return await this.verifyEmailOtp(params);
			}

			if ("token_hash" in params && params.token_hash) {
				throw createAuthError(
					AuthErrorCode.FeatureNotSupported,
					"Token hash verification not supported",
				);
			}
			throw createAuthError(
				AuthErrorCode.ValidationFailed,
				"Invalid OTP verification parameters",
			);
		} catch (error) {
			if (isAuthError(error)) {
				return { data: { user: null, session: null }, error };
			}
			if (isBetterAuthAPIError(error)) {
				return {
					data: { user: null, session: null },
					error: normalizeBetterAuthError(error),
				};
			}
			throw error;
		}
	};

	// TODO: this will only work with a magic link and not with the OTP token flow
	// we need to derive which flow is being used and handle it accordingly
	resetPasswordForEmail: SupabaseAuthClientInterface["resetPasswordForEmail"] =
		async (email, options) => {
			try {
				// TODO: this will fail, we need to setup `sendResetPassword` in the server adapter
				const result = await this._betterAuth.requestPasswordReset({
					email,
					redirectTo:
						options?.redirectTo ||
						(globalThis.window === undefined
							? ""
							: globalThis.location.origin),
				});

				if (result?.error) {
					throw normalizeBetterAuthError(result.error);
				}

				return {
					data: {},
					error: null,
				};
			} catch (error) {
				if (isAuthError(error)) {
					return { data: null, error };
				}
				if (isBetterAuthAPIError(error)) {
					return {
						data: null,
						error: normalizeBetterAuthError(error),
					};
				}
				throw error;
			}
		};

	// TODO: we would need a custom plugin to be able to actually recreate the session
	reauthenticate: SupabaseAuthClientInterface["reauthenticate"] =
		async () => {
			try {
				const newSession = await this.getSession();

				if (newSession.error || !newSession.data.session) {
					throw (
						newSession.error ||
						createAuthError(
							AuthErrorCode.SessionNotFound,
							"No session found",
						)
					);
				}

				return {
					data: {
						user: newSession.data.session?.user || null,
						session: newSession.data.session,
					},
					error: null,
				};
			} catch (error) {
				if (isAuthError(error)) {
					return { data: { user: null, session: null }, error };
				}
				if (isBetterAuthAPIError(error)) {
					return {
						data: { user: null, session: null },
						error: normalizeBetterAuthError(error),
					};
				}
				throw error;
			}
		};

	resend: SupabaseAuthClientInterface["resend"] = async (credentials) => {
		try {
			if ("email" in credentials) {
				const { email, type, options } = credentials;

				if (type === "signup" || type === "email_change") {
					const result = await this._betterAuth.sendVerificationEmail(
						{
							email,
							callbackURL:
								options?.emailRedirectTo ||
								(globalThis.window === undefined
									? ""
									: globalThis.location.origin),
						},
					);

					if (result?.error) {
						throw normalizeBetterAuthError(result.error);
					}

					return {
						data: { user: null, session: null },
						error: null,
					};
				}

				throw createAuthError(
					AuthErrorCode.ValidationFailed,
					`Unsupported resend type: ${type}`,
				);
			}

			if ("phone" in credentials) {
				return {
					data: { user: null, session: null },
					error: createAuthError(
						AuthErrorCode.PhoneProviderDisabled,
						"SMS resend is not supported. Use email-based authentication instead.",
					),
				};
			}

			throw createAuthError(
				AuthErrorCode.ValidationFailed,
				"Invalid credentials format",
			);
		} catch (error) {
			if (isAuthError(error)) {
				return { data: { user: null, session: null }, error };
			}
			if (isBetterAuthAPIError(error)) {
				return {
					data: { user: null, session: null },
					error: normalizeBetterAuthError(error),
				};
			}
			throw error;
		}
	};

	exchangeCodeForSession: SupabaseAuthClientInterface["exchangeCodeForSession"] =
		async (_authCode: string) => {
			try {
				const sessionResult = await this.getSession();

				if (sessionResult.data.session) {
					return {
						data: {
							session: sessionResult.data.session,
							user: sessionResult.data.session.user,
						},
						error: null,
					};
				}

				throw createAuthError(
					AuthErrorCode.OAuthCallbackFailed,
					"OAuth callback completed but no session was created. Make sure the OAuth callback has been processed.",
				);
			} catch (error) {
				if (isAuthError(error)) {
					return { data: { session: null, user: null }, error };
				}
				if (isBetterAuthAPIError(error)) {
					return {
						data: { session: null, user: null },
						error: normalizeBetterAuthError(error),
					};
				}
				throw error;
			}
		};
	//#endregion

	//#region PUBLIC API - Event System
	onAuthStateChange: SupabaseAuthClientInterface["onAuthStateChange"] = (
		callback,
	) => {
		const id = crypto.randomUUID();

		const subscription: Subscription = {
			id,
			callback,
			unsubscribe: () => {
				this._stateChangeEmitters.delete(id);
			},
		};

		this._stateChangeEmitters.set(id, subscription);

		this.emitInitialSession(callback);

		return {
			data: {
				subscription: {
					id,
					callback,
					unsubscribe: subscription.unsubscribe,
				},
			},
		};
	};
	//#endregion

	//#region PUBLIC API - Auto Refresh & Configuration
	isThrowOnErrorEnabled: SupabaseAuthClientInterface["isThrowOnErrorEnabled"] =
		() => false;

	startAutoRefresh: SupabaseAuthClientInterface["startAutoRefresh"] =
		async () => {
			return;
		};

	stopAutoRefresh: SupabaseAuthClientInterface["stopAutoRefresh"] =
		async () => {
			return;
		};
	//#endregion

	//#region PRIVATE HELPERS - Verification
	private async verifyEmailOtp(params: VerifyEmailOtpParams) {
		const { type } = params;

		if (type === "email") {
			const result = await this._betterAuth.signIn.emailOtp({
				email: params.email,
				otp: params.token,
			});
			if (result.error) {
				return {
					data: { user: null, session: null },
					error: normalizeBetterAuthError(result.error),
				};
			}
			const sessionResult = await this.getSession({ forceFetch: true });
			if (!sessionResult.data.session) {
				return {
					data: { user: null, session: null },
					error: createAuthError(
						AuthErrorCode.SessionNotFound,
						"Failed to retrieve session after OTP verification. Make sure the magic link callback has been processed.",
					),
				};
			}

			return {
				data: {
					user: sessionResult.data.session.user,
					session: sessionResult.data.session,
				},
				error: null,
			};
		}

		if (type === "magiclink") {
			return {
				data: { user: null, session: null },
				error: createAuthError(
					AuthErrorCode.MagicLinkNotSupported,
					"Magic link verification is not supported. Use email OTP authentication instead.",
				),
			};
		}

		if (type === "signup" || type === "invite") {
			const result = await this._betterAuth.emailOtp.verifyEmail({
				email: params.email,
				otp: params.token,
			});

			if (result?.error) {
				return {
					data: { user: null, session: null },
					error: normalizeBetterAuthError(result.error),
				};
			}

			const sessionResult = await this.getSession({ forceFetch: true });

			return {
				data: {
					user: sessionResult.data.session?.user ?? null,
					session: sessionResult.data.session,
				},
				error: null,
			};
		}

		if (type === "recovery") {
			// First, check if OTP is valid
			const checkResult =
				await this._betterAuth.emailOtp.checkVerificationOtp({
					email: params.email,
					otp: params.token,
					type: "forget-password",
				});

			if (checkResult.error || !checkResult.data?.success) {
				return {
					data: { user: null, session: null },
					error: normalizeBetterAuthError(checkResult.error),
				};
			}
			// For recovery, user needs to call resetPassword separately
			// Return success but no session yet
			return {
				data: { user: null, session: null },
				error: null,
			};
		}

		if (type === "email_change") {
			const result = await this._betterAuth.verifyEmail({
				query: {
					token: params.token,
					callbackURL: params.options?.redirectTo,
				},
			});

			if (result?.error) {
				return {
					data: { user: null, session: null },
					error: normalizeBetterAuthError(result.error),
				};
			}

			// Get current session
			const sessionResult = await this.getSession({ forceFetch: true });
			if (sessionResult.error || !sessionResult.data) {
				return {
					data: { user: null, session: null },
					error:
						sessionResult.error ||
						createAuthError(
							AuthErrorCode.InternalError,
							"Failed to get session",
						),
				};
			}

			if (sessionResult.data.session) {
				BETTER_AUTH_METHODS_HOOKS.updateUser.onSuccess(
					sessionResult.data.session,
				);
			}

			return {
				data: {
					user: sessionResult.data?.session?.user || null,
					session: sessionResult.data?.session || null,
				},
				error: null,
			};
		}

		if (type === "invite") {
			const result = await this._betterAuth.organization.acceptInvitation(
				{
					invitationId: params.token, // The token is the invitation ID
				},
			);

			if (result.error) {
				return {
					data: { user: null, session: null },
					error: normalizeBetterAuthError(result.error),
				};
			}

			// Get current session
			const sessionResult = await this.getSession({ forceFetch: true });
			if (sessionResult.error || !sessionResult.data) {
				return {
					data: { user: null, session: null },
					error:
						sessionResult.error ||
						createAuthError(
							AuthErrorCode.InternalError,
							"Failed to get session",
						),
				};
			}

			return {
				data: {
					user: sessionResult.data?.session?.user || null,
					session: sessionResult.data?.session,
				},
				error: null,
			};
		}

		return {
			data: { user: null, session: null },
			error: createAuthError(
				AuthErrorCode.ValidationFailed,
				`Unsupported email OTP type: ${type}`,
			),
		};
	}

	//#endregion

	//#region PRIVATE HELPERS - Event System
	private async emitInitialSession(
		callback: (
			event: AuthChangeEvent,
			session: Session | null,
		) => void | Promise<void>,
	): Promise<void> {
		try {
			const { data, error } = await this.getSession();

			if (error) {
				await callback("INITIAL_SESSION", null);
				return;
			}

			await callback("INITIAL_SESSION", data.session);
		} catch {
			await callback("INITIAL_SESSION", null);
		}
	}

	//#endregion
}

/** Instance type for SupabaseAuthAdapter */
export type SupabaseAuthAdapterInstance = SupabaseAuthAdapterImpl;

/** Builder type that creates adapter instances */
export type SupabaseAuthAdapterBuilder = (
	url: string,
	fetchOptions?: { headers?: Record<string, string> },
) => SupabaseAuthAdapterInstance;

/**
 * Factory function that returns an adapter builder.
 * The builder is called by createClient/createAuthClient with the URL.
 *
 * @param options - Optional adapter configuration (baseURL is injected separately)
 * @returns A builder function that creates the adapter instance
 *
 * @example
 * ```typescript
 * const client = createClient({
 *   auth: {
 *     url: 'https://auth.example.com',
 *     adapter: SupabaseAuthAdapter(),
 *   },
 *   dataApi: { url: 'https://data-api.example.com' },
 * });
 * ```
 */
export function SupabaseAuthAdapter(
	options?: SupabaseAuthAdapterOptions,
): SupabaseAuthAdapterBuilder {
	return (url: string, fetchOptions?: { headers?: Record<string, string> }) =>
		new SupabaseAuthAdapterImpl({
			baseURL: url,
			...options,
			fetchOptions: {
				...options?.fetchOptions,
				headers: {
					...options?.fetchOptions?.headers,
					...fetchOptions?.headers,
				},
			},
		});
}
