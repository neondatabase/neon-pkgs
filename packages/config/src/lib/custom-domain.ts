/**
 * Normalize a neon.ts custom-domain hostname the way the API does: trim, lowercase,
 * strip a trailing root dot. Callers still validate the result.
 */
export function normalizeCustomDomain(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * DNS hostname after {@link normalizeCustomDomain}. Length follows the OpenAPI bound
 * (3–254). Neon-managed / internal names are left to the API.
 */
const CUSTOM_DOMAIN_RE =
	/^(?=.{3,254}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `undefined` when `value` is a usable custom domain; otherwise the schema message. */
export function customDomainValidationError(value: string): string | undefined {
	if (typeof value !== "string") {
		return "custom domain must be a hostname string";
	}
	const normalized = normalizeCustomDomain(value);
	if (normalized.length === 0) {
		return `custom domain ${JSON.stringify(value)} is empty after normalizing`;
	}
	if (normalized.length < 3 || normalized.length > 254) {
		return `custom domain ${JSON.stringify(value)} must be 3–254 characters after normalizing`;
	}
	if (!CUSTOM_DOMAIN_RE.test(normalized)) {
		return `custom domain ${JSON.stringify(value)} is not a DNS hostname`;
	}
	return undefined;
}
