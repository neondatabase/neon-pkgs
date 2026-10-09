// Kept out of env.ts so a command that only picks a role does not load the Neon API client.

/**
 * Neon's default branch owner role, created with every project. This is the role a
 * `DATABASE_URL` should connect as.
 */
export const NEON_DEFAULT_OWNER_ROLE = "neondb_owner";

/**
 * Roles Neon provisions for the Auth / Data API (PostgREST) stack. They exist to back
 * RLS-scoped Data API requests authenticated by JWT — never to hold a `DATABASE_URL` —
 * so they're skipped when auto-picking the connection role. Enabling Neon Auth or the
 * Data API (`neon config apply`) adds these next to the owner role, which is why a plain
 * branch routinely reports more than one role.
 */
const NEON_MANAGED_AUTH_ROLES: ReadonlySet<string> = new Set([
	"authenticator",
	"anonymous",
	"authenticated",
]);

/** `undefined` when more than one app role remains (or none exist), so the caller has to ask. */
export function defaultConnectionRole(
	roleNames: readonly string[],
): string | undefined {
	if (roleNames.length === 1) return roleNames[0];
	if (roleNames.includes(NEON_DEFAULT_OWNER_ROLE)) {
		return NEON_DEFAULT_OWNER_ROLE;
	}
	const appRoles = roleNames.filter(
		(name) => !NEON_MANAGED_AUTH_ROLES.has(name),
	);
	return appRoles.length === 1 ? appRoles[0] : undefined;
}
