const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Return a function's hostname (including its port, when present) on the current branch. */
export function functionHostname(slug: string): string {
	if (!/^[a-z0-9]{1,20}$/.test(slug)) {
		throw new TypeError(
			"functionHostname: slug must match [a-z0-9]{1,20}.",
		);
	}

	const key = `NEON_FUNCTION_${slug.toUpperCase()}_BASE_URL`;
	const baseUrl = process.env[key];
	if (baseUrl !== undefined) {
		let url: URL;
		try {
			url = new URL(baseUrl);
		} catch {
			throw new TypeError(
				`functionHostname: ${key} must be an http(s) URL.`,
			);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new TypeError(
				`functionHostname: ${key} must be an http(s) URL.`,
			);
		}
		return url.host;
	}

	const branchId = process.env.NEON_BRANCH_ID;
	const suffix = process.env.NEON_FUNCTION_HOST_SUFFIX;
	if (!branchId || !suffix) {
		throw new TypeError(
			"functionHostname requires NEON_BRANCH_ID and NEON_FUNCTION_HOST_SUFFIX. " +
				"Run `neon env pull` or `neon dev` locally, or deploy your function to Neon.",
		);
	}
	const label = `${branchId}-${slug}`;
	const [domain, port, ...extra] = suffix.slice(1).split(":");
	if (
		!DNS_LABEL.test(label) ||
		!suffix.startsWith(".") ||
		!domain.split(".").every((part) => DNS_LABEL.test(part)) ||
		extra.length > 0 ||
		(port !== undefined &&
			(!/^\d+$/.test(port) || +port < 1 || +port > 65535)) ||
		`${label}.${domain}`.length > 253
	) {
		throw new TypeError(
			"functionHostname: NEON_BRANCH_ID and NEON_FUNCTION_HOST_SUFFIX must form a valid function hostname.",
		);
	}
	return `${label}${suffix}`;
}
