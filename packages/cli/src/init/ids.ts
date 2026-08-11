/**
 * Validates that an ID contains only safe characters for shell interpolation.
 * Neon org/project/branch IDs are UUIDs or slug-like strings.
 */
export function assertSafeId(value: string, label: string): void {
	if (!/^[\w.:-]+$/.test(value)) {
		throw new Error(
			`Invalid ${label}: "${value}". Expected alphanumeric, hyphens, underscores, dots, or colons.`,
		);
	}
}
