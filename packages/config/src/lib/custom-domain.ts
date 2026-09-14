export function normalizeCustomDomain(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, "");
}

const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const CUSTOM_DOMAIN_RE = new RegExp(
	`^(?=.{3,254}$)(?:${DNS_LABEL}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$`,
);

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
