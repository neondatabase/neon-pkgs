import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { defined } from "../defined.test-helpers.js";
import {
	createRealtime,
	pgParam,
	type RawSqlQuery,
	rawSql,
	type SealedLiveQuery,
} from "./realtime.js";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const SECRET = encodeSecret({
	v: 1,
	kid: "current",
	iss: "example-app",
	key: base64Url(KEY),
});
interface MessageRow {
	readonly id: number;
	readonly body: string;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Realtime backend SDK", () => {
	it("seals a typed raw SQL query without an adapter or network request", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const realtime = createRealtime({ secret: SECRET, db: "app" });
		const query = messagesByOwner("alice");

		const sealedQuery = await realtime.seal({ query });

		expectTypeOf(sealedQuery).toEqualTypeOf<SealedLiveQuery<MessageRow>>();
		expect(sealedQuery).toMatchObject({
			capability: expect.any(String),
			expiresAt: expect.any(Number),
			queryFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(await capabilityClaims(sealedQuery.capability)).toMatchObject({
			v: 1,
			database: "app",
			error_details: "safe",
			parameters: [{ type_oid: 0, value: "YWxpY2U=" }],
		});
		expect(fetch).not.toHaveBeenCalled();
		expectTypeOf<Parameters<typeof realtime.seal>[0]>().not.toHaveProperty(
			"params",
		);
	});

	it("requests full error details only when debug mode is enabled", async () => {
		const realtime = createRealtime({
			secret: SECRET,
			db: "app",
			debugMode: true,
		});

		const sealedQuery = await realtime.seal({
			query: messagesByOwner("alice"),
		});

		expect(await capabilityClaims(sealedQuery.capability)).toMatchObject({
			error_details: "full",
		});
	});

	it("uses stable query fingerprints but fresh capabilities", async () => {
		const realtime = createRealtime({ secret: SECRET, db: "app" });
		const first = await realtime.seal({
			query: messagesByOwner("alice"),
		});
		const repeated = await realtime.seal({
			query: messagesByOwner("alice"),
		});
		const changed = await realtime.seal({
			query: messagesByOwner("bob"),
		});

		expect(first.queryFingerprint).toBe(repeated.queryFingerprint);
		expect(first.capability).not.toBe(repeated.capability);
		expect(first.queryFingerprint).not.toBe(changed.queryFingerprint);
	});

	it("supports raw SQL without bind parameters", async () => {
		const realtime = createRealtime({ secret: SECRET, db: "app" });
		const query = rawSql<MessageRow>("select id, body from messages");

		await expect(realtime.seal({ query })).resolves.toMatchObject({
			capability: expect.any(String),
		});
	});

	it("encodes JavaScript null as PostgreSQL NULL", async () => {
		const realtime = createRealtime({ secret: SECRET, db: "app" });
		const query = rawSql<{ readonly value: string | null }>(
			"select $1::text as value",
			[null],
		);

		const sealedQuery = await realtime.seal({ query });

		expect(await capabilityClaims(sealedQuery.capability)).toMatchObject({
			parameters: [{ type_oid: 0, value: null }],
		});
	});

	it("includes explicit raw parameter OIDs in the capability", async () => {
		const realtime = createRealtime({ secret: SECRET, db: "app" });
		const query = rawSql<{ readonly id: string }>("select $1::uuid as id", [
			pgParam.text("uuid", "8ea9c0cc-6bf1-4d30-b85f-8415106215cf"),
		]);

		const sealedQuery = await realtime.seal({ query });

		expect(await capabilityClaims(sealedQuery.capability)).toMatchObject({
			parameters: [
				{
					type_oid: 2950,
					value: "OGVhOWMwY2MtNmJmMS00ZDMwLWI4NWYtODQxNTEwNjIxNWNm",
				},
			],
		});
	});

	it("always accepts branded raw SQL alongside a configured adapter", async () => {
		interface AdapterQuery {
			readonly owner: string;
		}
		const prepare = vi.fn((query: AdapterQuery) =>
			messagesByOwner(query.owner),
		);
		const realtime = createRealtime<AdapterQuery>({
			secret: SECRET,
			db: "app",
			adapter: { prepare },
		});

		await realtime.seal({ query: { owner: "adapter" } });
		const rawSealedQuery = await realtime.seal({
			query: messagesByOwner("raw"),
		});

		expectTypeOf(rawSealedQuery).toEqualTypeOf<
			SealedLiveQuery<MessageRow>
		>();
		expect(prepare).toHaveBeenCalledOnce();
		expect(prepare).toHaveBeenCalledWith({ owner: "adapter" });
	});

	it("snapshots caller-owned raw parameter arrays", () => {
		const parameters = ["alice", null] as (string | null)[];
		const query = rawSql<MessageRow>(
			"select id, body from messages where owner = $1 and note is not distinct from $2",
			parameters,
		);
		parameters.length = 0;

		expect(query.parameters[0]).toEqual({ typeOid: 0, value: "alice" });
		expect(query.parameters[1]).toEqual({ typeOid: 0, value: null });
	});

	it("validates raw SQL metadata before encrypting", async () => {
		const getRandomValues = vi.spyOn(globalThis.crypto, "getRandomValues");
		const realtime = createRealtime({ secret: SECRET, db: "app" });
		const invalid = rawSql<MessageRow>("delete from messages");

		await expect(realtime.seal({ query: invalid })).rejects.toThrow(
			"Invalid Realtime prepared query",
		);
		expect(getRandomValues).not.toHaveBeenCalled();
	});

	it("rejects invalid adapter OID hints before encrypting", async () => {
		const getRandomValues = vi.spyOn(globalThis.crypto, "getRandomValues");
		const realtime = createRealtime<object>({
			secret: SECRET,
			db: "app",
			adapter: {
				prepare: () => ({
					sql: "select $1",
					parameters: [{ typeOid: -1, value: "7" }],
				}),
			},
		});

		await expect(realtime.seal({ query: {} })).rejects.toThrow(
			"Invalid Realtime prepared parameter",
		);
		expect(getRandomValues).not.toHaveBeenCalled();
	});

	it("requires a valid opaque Realtime secret", () => {
		for (const secret of [
			"",
			"server-secret",
			`${SECRET}=`,
			`+${SECRET.slice(1)}`,
		]) {
			expect(() => createRealtime({ secret, db: "app" })).toThrow(
				"Invalid Realtime secret",
			);
		}
	});
});

function messagesByOwner(owner: string): RawSqlQuery<MessageRow> {
	return rawSql<MessageRow>(
		"select id, body from messages where owner = $1",
		[owner],
	);
}

async function capabilityClaims(
	capability: string,
): Promise<Record<string, unknown>> {
	const [
		encodedHeader,
		encryptedKey,
		encodedIv,
		encodedCiphertext,
		encodedTag,
	] = capability.split(".");
	expect(encryptedKey).toBe("");
	const header = defined(encodedHeader);
	const iv = defined(encodedIv);
	const ciphertext = defined(encodedCiphertext);
	const tag = defined(encodedTag);
	const key = await crypto.subtle.importKey(
		"raw",
		bufferSource(KEY),
		"AES-GCM",
		false,
		["decrypt"],
	);
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: bufferSource(base64UrlDecode(iv)),
			additionalData: bufferSource(new TextEncoder().encode(header)),
			tagLength: 128,
		},
		key,
		bufferSource(concat(base64UrlDecode(ciphertext), base64UrlDecode(tag))),
	);
	return JSON.parse(new TextDecoder().decode(plaintext));
}

function encodeSecret(value: object): string {
	return `neon_live_v1_${base64Url(new TextEncoder().encode(JSON.stringify(value)))}`;
}

function base64UrlDecode(value: string): Uint8Array {
	const standard = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64Url(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(
		parts.reduce((size, part) => size + part.length, 0),
	);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}

function bufferSource(value: Uint8Array): ArrayBuffer {
	return new Uint8Array(value).buffer;
}
