import { REALTIME_RELEASE_LINE, REALTIME_SDK } from "../../usage-metadata.js";
import type { PreparedLiveQuery } from "../adapter.js";
import {
	asBufferSource,
	encodeBase64,
	encodeBase64Url,
	utf8,
	webCrypto,
} from "./crypto.js";
import {
	type EnvelopeClaims,
	type EnvelopeKey,
	type EnvelopeLogin,
	sealEnvelope,
} from "./envelope.js";
import { queryFingerprint } from "./fingerprint.js";
import type { RealtimeQueryCapabilityV2 } from "./schema/realtime-query-capability-v2.gen.js";
import type { RealtimeSecret } from "./secret.js";

const SEALED_QUERY_LIFETIME_SECONDS = 60;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_BYTES = 256 * 1024;

export interface IssuedSealedLiveQuery {
	readonly capability: string;
	readonly queryFingerprint: string;
	/** Capability expiry as Unix milliseconds. */
	readonly expiresAt: number;
}

type ProtectedHeader = RealtimeQueryCapabilityV2["protected"];
type CapabilityClaims = RealtimeQueryCapabilityV2["claims"];
type QuerySource = CapabilityClaims["issuer"]["query_source"];
type ErrorDetails = CapabilityClaims["error_details"];

/** Seals one prepared query; both schemes share this shape. */
export type CapabilityIssuer = (
	query: PreparedLiveQuery,
	querySource?: QuerySource,
) => Promise<IssuedSealedLiveQuery>;

/** Create a local Compact-JWE issuer backed by an opaque Realtime secret. */
export function createCapabilityIssuer(
	secret: RealtimeSecret,
	database: string,
	errorDetails: ErrorDetails = "safe",
	clock: () => number = Date.now,
): CapabilityIssuer {
	const keyPromise = importAesKey(secret.key);
	return async (query, querySource = "custom") => {
		const fingerprint = await queryFingerprint(query);
		const claims: CapabilityClaims = {
			v: 2,
			...queryClaims(
				query,
				fingerprint,
				database,
				errorDetails,
				querySource,
				clock,
			),
		};
		const protectedHeader: ProtectedHeader = {
			alg: "dir",
			enc: "A256GCM",
			v: 2,
		};
		const capability = await encryptCompactJwe(
			await keyPromise,
			protectedHeader,
			claims,
		);
		return issued(capability, fingerprint, claims.exp);
	};
}

interface EnvelopeIssuerOptions {
	/** Resolves the branch key to seal to. */
	readonly key: () => Promise<EnvelopeKey>;
	/** Resolves the Postgres login sealed into `auth`. */
	readonly login: () => Promise<EnvelopeLogin>;
	readonly database: string;
	readonly errorDetails?: ErrorDetails;
	readonly clock?: () => number;
	/** Tests only: fixes each envelope's ephemeral key. */
	readonly ephemeralKeyMaterial?: () => Uint8Array;
}

/** Create a v3 issuer that seals queries and a login to the branch key. */
export function createEnvelopeIssuer(
	options: EnvelopeIssuerOptions,
): CapabilityIssuer {
	const clock = options.clock ?? Date.now;
	return async (query, querySource = "custom") => {
		const [fingerprint, key, login] = await Promise.all([
			queryFingerprint(query),
			options.key(),
			options.login(),
		]);
		// The lifetime starts once any key fetch or token request has finished.
		const claims: EnvelopeClaims = {
			v: 3,
			...queryClaims(
				query,
				fingerprint,
				options.database,
				options.errorDetails ?? "safe",
				querySource,
				clock,
			),
			auth: { user: login.user, credential: login.credential },
		};
		const capability = await sealEnvelope(
			key,
			claims,
			options.ephemeralKeyMaterial?.(),
		);
		return issued(capability, fingerprint, claims.exp);
	};
}

/** The claims v2 and v3 share, in their serialized order. */
function queryClaims(
	query: PreparedLiveQuery,
	fingerprint: string,
	database: string,
	errorDetails: ErrorDetails,
	querySource: QuerySource,
	clock: () => number,
) {
	const issuedAt = Math.floor(clock() / 1_000);
	return {
		aud: "realtime-proxy" as const,
		database,
		error_details: errorDetails,
		issuer: {
			sdk: REALTIME_SDK,
			release_line: REALTIME_RELEASE_LINE,
			query_source: querySource,
		},
		query_fingerprint: fingerprint,
		sql: query.sql,
		parameters: query.parameters.map((parameter) => ({
			type_oid: parameter.typeOid,
			value:
				parameter.value === null
					? null
					: encodeBase64(utf8(parameter.value)),
		})),
		iat: issuedAt,
		exp: issuedAt + SEALED_QUERY_LIFETIME_SECONDS,
	};
}

function issued(
	capability: string,
	fingerprint: string,
	expiresAtSeconds: number,
): IssuedSealedLiveQuery {
	return Object.freeze({
		capability,
		queryFingerprint: fingerprint,
		expiresAt: expiresAtSeconds * 1_000,
	});
}

async function encryptCompactJwe(
	key: CryptoKey,
	header: ProtectedHeader,
	claims: CapabilityClaims,
): Promise<string> {
	const encodedHeader = encodeBase64Url(utf8(JSON.stringify(header)));
	const iv = webCrypto().getRandomValues(new Uint8Array(IV_BYTES));
	const encrypted = new Uint8Array(
		await webCrypto().subtle.encrypt(
			{
				name: "AES-GCM",
				iv: asBufferSource(iv),
				additionalData: asBufferSource(utf8(encodedHeader)),
				tagLength: TAG_BYTES * 8,
			},
			key,
			asBufferSource(utf8(JSON.stringify(claims))),
		),
	);
	const ciphertext = encrypted.subarray(0, encrypted.length - TAG_BYTES);
	const tag = encrypted.subarray(encrypted.length - TAG_BYTES);
	const token = [
		encodedHeader,
		"",
		encodeBase64Url(iv),
		encodeBase64Url(ciphertext),
		encodeBase64Url(tag),
	].join(".");
	if (utf8(token).length > MAX_TOKEN_BYTES) {
		throw new Error("Live-query capability exceeds the size limit");
	}
	return token;
}

async function importAesKey(key: Uint8Array): Promise<CryptoKey> {
	return webCrypto().subtle.importKey(
		"raw",
		asBufferSource(key),
		{ name: "AES-GCM" },
		false,
		["encrypt"],
	);
}
