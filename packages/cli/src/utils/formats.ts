const HAIKU_REGEX = /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/;

export const looksLikeBranchId = (branch: string) =>
	branch.startsWith("br-") && HAIKU_REGEX.test(branch.substring(3));

const LSN_REGEX = /^[a-fA-F0-9]{1,8}\/[a-fA-F0-9]{1,8}$/;

export const looksLikeLSN = (lsn: string) => LSN_REGEX.test(lsn);

/** Normalize a user-supplied date to an ISO 8601 string, or throw a friendly error. */
export const toIso = (value: string, flag: string): string => {
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) {
		throw new Error(
			`Invalid ${flag} value: "${value}". Use an RFC 3339 timestamp, e.g. 2025-12-31T23:59:59Z.`,
		);
	}
	return new Date(ms).toISOString();
};

export const looksLikeTimestamp = (timestamp: string) => {
	if (isNaN(Date.parse(timestamp))) return false;

	/**
	 * @info
	 * Check for ISO 8601/RFC 3339 format patterns
	 * Must contain 'T' separator and end with 'Z' or timezone offset
	 *
	 * `Date.parse` aggressive parsing will attempt a date out of any string.
	 * so if a branch name has a number, `Date.parse` will return a valid timestamp.
	 */
	const iso8601Regex =
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?([+-]\d{2}:\d{2}|Z)$/;
	return iso8601Regex.test(timestamp);
};
