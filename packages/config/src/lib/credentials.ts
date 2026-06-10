import type { CredentialScope } from "./types.js";

/**
 * Which branch-scoped Preview features a policy enables, reduced to the booleans that drive
 * credential scopes. Decoupled from the full `Config` / `ResolvedPreviewConfig` shapes so it
 * can be computed from either the static policy (`parseEnv`) or the resolved branch config
 * (`fetchEnv`).
 */
export interface CredentialFeatureFlags {
	/** At least one object-storage bucket is declared (grants `storage:read` + `storage:write`). */
	storage: boolean;
	/** The AI Gateway is enabled (grants `ai_gateway:invoke`). */
	aiGateway: boolean;
	/** At least one Neon Function is declared (grants `functions:invoke`). */
	functions: boolean;
}

/**
 * Derive the set of {@link CredentialScope}s a branch credential needs from the policy's
 * enabled Preview features. Deterministic and order-stable (handy for diffing / round-trip
 * comparisons). Returns an empty array when no credential-bearing feature is enabled — the
 * signal that **no credential should be minted** (and the credentials endpoint never
 * touched), which is what keeps the non-Preview path byte-for-byte unchanged.
 */
export function deriveCredentialScopes(
	flags: CredentialFeatureFlags,
): CredentialScope[] {
	const scopes: CredentialScope[] = [];
	if (flags.storage) {
		scopes.push("storage:read", "storage:write");
	}
	if (flags.aiGateway) {
		scopes.push("ai_gateway:invoke");
	}
	if (flags.functions) {
		scopes.push("functions:invoke");
	}
	return scopes;
}

/**
 * Whether a credential granted `granted` scopes can satisfy a policy that needs `desired`
 * scopes — i.e. `desired ⊆ granted`. Used to decide whether an already-persisted credential
 * can be **reused** as-is, or must be re-minted because the policy now needs a scope the old
 * credential lacks (e.g. the user added the AI Gateway after first pulling a storage-only
 * credential).
 */
export function credentialScopesSatisfied(
	granted: readonly CredentialScope[],
	desired: readonly CredentialScope[],
): boolean {
	const grantedSet = new Set(granted);
	return desired.every((scope) => grantedSet.has(scope));
}
