/**
 * JSON-compatible sealed representation of one exact live query.
 *
 * The query is a short-lived bearer credential. Transport it over
 * HTTPS and do not put it in URLs, logs, or persistent browser storage.
 *
 * @typeParam Row - Row produced by the sealed query.
 */
export interface SealedLiveQuery<Row> {
	/** Opaque encrypted bearer capability. */
	readonly capability: string;
	/** Stable identity used to prevent accidentally renewing a different query. */
	readonly queryFingerprint: string;
	/** Capability expiry as Unix milliseconds. */
	readonly expiresAt: number;
	/** @internal Carries the inferred row type without adding runtime data. */
	readonly __row?: Row;
}

export function validateSealedQuery<Row>(query: SealedLiveQuery<Row>): void {
	if (
		!query ||
		typeof query.capability !== "string" ||
		!validCompactJweHeader(query.capability) ||
		typeof query.queryFingerprint !== "string" ||
		!/^[0-9a-f]{64}$/.test(query.queryFingerprint) ||
		!Number.isSafeInteger(query.expiresAt) ||
		query.expiresAt <= 0
	) {
		throw new Error("Invalid sealed live query");
	}
}

function validCompactJweHeader(capability: string): boolean {
	try {
		const segments = capability.split(".");
		if (
			segments.length !== 5 ||
			segments[1] !== "" ||
			segments.some((part, index) => index !== 1 && !part)
		)
			return false;
		const encodedHeader = segments[0];
		if (!encodedHeader) return false;
		const header = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				decodeBase64Url(encodedHeader),
			),
		) as unknown;
		return (
			isRecord(header) &&
			Object.keys(header).sort().join(",") === "alg,enc,v" &&
			header.alg === "dir" &&
			header.enc === "A256GCM" &&
			header.v === 1
		);
	} catch {
		return false;
	}
}

function decodeBase64Url(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
	const standard = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
