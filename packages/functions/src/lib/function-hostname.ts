const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Return a function's hostname (including its port, when present) on the current branch. */
export function functionHostname(slug: string): string {
	if (!/^[a-z0-9]{1,20}$/.test(slug)) {
		throw new TypeError(
			"functionHostname: slug must match [a-z0-9]{1,20}.",
		);
	}

	const localPorts = process.env.NEON_DEV_FUNCTION_PORTS;
	if (localPorts !== undefined) {
		const invalidPorts = () =>
			new TypeError(
				"functionHostname: invalid local function ports. Restart `neon dev`.",
			);
		let ports: unknown;
		try {
			ports = JSON.parse(localPorts);
		} catch {
			throw invalidPorts();
		}
		if (
			ports === null ||
			typeof ports !== "object" ||
			Array.isArray(ports)
		) {
			throw invalidPorts();
		}
		if (Object.hasOwn(ports, slug)) {
			const port = (ports as Record<string, unknown>)[slug];
			if (
				typeof port !== "number" ||
				!Number.isInteger(port) ||
				port < 1 ||
				port > 65535
			) {
				throw invalidPorts();
			}
			return `localhost:${port}`;
		}
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
