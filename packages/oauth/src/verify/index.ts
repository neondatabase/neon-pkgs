/**
 * `@neon/oauth/verify` — verify Neon Auth access tokens in any resource server. Depends on
 * `jose` only: it never loads the sign-in client or `openid-client`.
 *
 * **Stability: beta.** Minor versions may include breaking changes.
 *
 * @module
 */

export type {
	BearerAuthOptions,
	BearerGuard,
	OAuthBearerOptions,
} from "./bearer";
export { createBearerGuard, protectedResourceMetadataUrl } from "./bearer";
export type { InvalidTokenCode } from "./errors";
export {
	AuthServerUnavailableError,
	InvalidTokenError,
	OAuthConfigError,
	OAuthError,
} from "./errors";
export type {
	AuthResult,
	AuthServerMetadata,
	Verifier,
	VerifierOptions,
	VerifyResult,
} from "./verifier";
export { createVerifier } from "./verifier";
