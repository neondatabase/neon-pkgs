import { BetterAuthReactAdapter } from "../adapters/better-auth-react/better-auth-react-adapter";
import { createAuthClient as createNeonAuthClient } from "../neon-auth";

export function createAuthClient() {
	// @ts-expect-error - for nextjs proxy we do not need the baseUrl
	return createNeonAuthClient(undefined, {
		adapter: BetterAuthReactAdapter(),
	});
}

// Re-export auth error classes + type guards so Next.js consumers importing
// from `@neon/auth/next` can also narrow thrown / returned errors.
export {
	AuthApiError,
	AuthError,
	isAuthApiError,
	isAuthError,
} from "../adapters/supabase/auth-interface";
