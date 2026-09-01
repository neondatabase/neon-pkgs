import { readFileSync } from "node:fs";
import { defineConfig } from "@neon/config/v1";
import {
	NEON_ENV_VAR_KEYS,
	type NeonEnv,
	toEntries,
} from "@neon-internals/env-core/env";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { parseEnv } from "./parse-env.js";
import { stubCleanNeonEnv } from "./test-utils.js";

beforeEach(() => stubCleanNeonEnv());

// ─────────────────────────────────────────────────────────────────────────────
// Userspace-contract regression tests for the env package.
//
// These guard the contracts users (and platform integrations) depend on but that no
// behavioral test exercises directly:
//   1. The OS-level env-var NAMES (`DATABASE_URL`, `NEON_AUTH_BASE_URL`, …) — renaming one
//      silently breaks every `.env` file and platform integration.
//   2. The internal maps that must stay in sync — `NEON_ENV_VAR_KEYS` (names) ↔ the per-
//      namespace zod schemas ↔ `FILTERABLE_ENV_KEYS` (filter reverse map) ↔ the `parseEnv`
//      filter types. Adding a var to one and forgetting the others means `parseEnv` silently
//      stops validating / returning it.
//   3. The `toEntries` → `parseEnv` round-trip (the cross-process transport contract).
//   4. The public value-export surface of `@neon/env`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every **input** OS env-var the package reads back via `parseEnv`, paired with the
 * {@link NeonEnv} namespace + camelCase property it populates. This is the test's source of
 * truth; the cross-checks below tie it to `NEON_ENV_VAR_KEYS`, the per-namespace zod schemas,
 * and the `parseEnv` key filter. Output-only aliases (see {@link OUTPUT_ONLY_ENV_VARS}) are
 * intentionally excluded — they are emitted by `toEntries` but never parsed back.
 */
const INPUT_ENV_KEYS = [
	{ key: "DATABASE_URL", namespace: "postgres", prop: "databaseUrl" },
	{
		key: "DATABASE_URL_UNPOOLED",
		namespace: "postgres",
		prop: "databaseUrlUnpooled",
	},
	{ key: "NEON_AUTH_BASE_URL", namespace: "auth", prop: "baseUrl" },
	{ key: "NEON_AUTH_JWKS_URL", namespace: "auth", prop: "jwksUrl" },
	{ key: "NEON_DATA_API_URL", namespace: "dataApi", prop: "url" },
	{ key: "AWS_ACCESS_KEY_ID", namespace: "storage", prop: "accessKeyId" },
	{
		key: "AWS_SECRET_ACCESS_KEY",
		namespace: "storage",
		prop: "secretAccessKey",
	},
	{ key: "AWS_ENDPOINT_URL_S3", namespace: "storage", prop: "endpoint" },
	{ key: "AWS_REGION", namespace: "storage", prop: "region" },
	{
		key: "NEON_AI_GATEWAY_TOKEN",
		namespace: "aiGateway",
		prop: "apiKey",
	},
	{
		key: "NEON_AI_GATEWAY_BASE_URL",
		namespace: "aiGateway",
		prop: "baseUrl",
	},
] as const;

/**
 * Env-vars `toEntries` emits but `parseEnv` never reads back: only the branch name, which is
 * optional on parse. Listed so the completeness check below can prove every *other* env-var in
 * `NEON_ENV_VAR_KEYS` is a covered input — i.e. adding a new input var without a test fails
 * loudly.
 */
const OUTPUT_ONLY_ENV_VARS: ReadonlySet<string> = new Set(["NEON_BRANCH"]);

/**
 * A policy that turns on every secret-bearing namespace, so every input env-var above is
 * type-level *selectable* by the `parseEnv(config, keys)` filter. (Filtered `parseEnv` does
 * not consult the policy at runtime, but the overload constrains `keys` to the policy's
 * `SelectableEnvKey`, so the config must enable each namespace for the keys to type-check.)
 */
const allNamespacesConfig = defineConfig({
	auth: true,
	dataApi: true,
	preview: { buckets: { uploads: {} }, aiGateway: true },
});

describe("NEON_ENV_VAR_KEYS (public OS env-var names)", () => {
	test("is a stable public contract (rename = breaking change for users + platforms)", () => {
		expect(NEON_ENV_VAR_KEYS).toMatchInlineSnapshot(`
			{
			  "aiGateway": {
			    "apiKey": "NEON_AI_GATEWAY_TOKEN",
			    "baseUrl": "NEON_AI_GATEWAY_BASE_URL",
			  },
			  "auth": {
			    "baseUrl": "NEON_AUTH_BASE_URL",
			    "jwksUrl": "NEON_AUTH_JWKS_URL",
			  },
			  "branch": {
			    "name": "NEON_BRANCH",
			  },
			  "dataApi": {
			    "url": "NEON_DATA_API_URL",
			  },
			  "postgres": {
			    "databaseUrl": "DATABASE_URL",
			    "databaseUrlUnpooled": "DATABASE_URL_UNPOOLED",
			  },
			  "storage": {
			    "accessKeyId": "AWS_ACCESS_KEY_ID",
			    "endpoint": "AWS_ENDPOINT_URL_S3",
			    "region": "AWS_REGION",
			    "secretAccessKey": "AWS_SECRET_ACCESS_KEY",
			  },
			}
		`);
	});
});

describe("env-var map consistency (names ↔ schemas ↔ filter)", () => {
	test.each(
		INPUT_ENV_KEYS,
	)("$key maps to $namespace.$prop and round-trips through the parseEnv filter", (entry) => {
		// (a) The OS name matches NEON_ENV_VAR_KEYS for that namespace/property.
		expect(NEON_ENV_VAR_KEYS).toHaveProperty(
			[entry.namespace, entry.prop],
			entry.key,
		);
		// (b) Selecting the key returns its value under the right namespace/property —
		//     this exercises the runtime filter reverse map + the filter result type.
		vi.stubEnv(entry.key, `value-${entry.key}`);
		expect(parseEnv(allNamespacesConfig, [entry.key])).toHaveProperty(
			[entry.namespace, entry.prop],
			`value-${entry.key}`,
		);
	});

	test.each(
		INPUT_ENV_KEYS,
	)("$key is required when selected (unset → EnvNotInjected naming it)", (entry) => {
		// No stub: the var is unset, so selecting it must throw and name it (this drives
		// the per-namespace zod `min(1)` / required check via the filter path).
		expect(() => parseEnv(allNamespacesConfig, [entry.key])).toThrowError(
			new RegExp(`${entry.key} is missing`),
		);
	});

	test("every input env-var in NEON_ENV_VAR_KEYS is covered by a map test", () => {
		// Catches *additions*: a new input var added to NEON_ENV_VAR_KEYS (but not to
		// INPUT_ENV_KEYS / the filter) shows up here as an uncovered key.
		const allNames = Object.values(NEON_ENV_VAR_KEYS).flatMap((namespace) =>
			Object.values(namespace),
		);
		const inputNames = allNames
			.filter((name) => !OUTPUT_ONLY_ENV_VARS.has(name))
			.sort();
		const coveredNames = INPUT_ENV_KEYS.map((e) => e.key).sort();
		expect(inputNames).toEqual(coveredNames);
	});
});

describe("toEntries → parseEnv round-trip (cross-process transport)", () => {
	test("every namespace survives projection to OS env and back", () => {
		const config = defineConfig({
			auth: true,
			dataApi: true,
			preview: {
				buckets: { uploads: {} },
				aiGateway: true,
				functions: { hello: { name: "Hello", source: "./hello.ts" } },
			},
		});
		const env: NeonEnv<typeof config> = {
			postgres: {
				databaseUrl: "postgres://pooled",
				databaseUrlUnpooled: "postgres://direct",
			},
			branch: { name: "preview/foo" },
			auth: {
				baseUrl: "https://auth.example.com",
				jwksUrl: "https://auth.example.com/.well-known/jwks.json",
			},
			dataApi: { url: "https://data.example.com" },
			storage: {
				accessKeyId: "nak_live_abc",
				secretAccessKey: "s".repeat(64),
				endpoint: "https://br.storage.neon.build",
				region: "us-east-2",
			},
			aiGateway: {
				apiKey: "nt_live_abc_def",
				baseUrl: "https://x.neon.build",
			},
			functions: {
				hello: {
					baseUrl: "https://br-foo-hello.compute.neon.tech/",
				},
			},
		};

		// Project to OS env-vars and inject them, exactly as `neon-env run` does.
		for (const [key, value] of Object.entries(toEntries(env))) {
			vi.stubEnv(key, value);
		}

		// Re-reading through parseEnv must reconstruct the identical NeonEnv.
		expect(parseEnv(config)).toEqual(env);
	});
});

describe("@neon/env public surface", () => {
	test("value exports are stable (removing/renaming one is a breaking change)", async () => {
		const surface = await import("../index.js");
		expect(Object.keys(surface).sort()).toMatchInlineSnapshot(`
			[
			  "NEON_ENV_VAR_KEYS",
			  "fetchEnv",
			  "functionBaseUrlKey",
			  "isFunctionBaseUrlKey",
			  "parseEnv",
			  "parseFunctionBaseUrlKey",
			  "toEntries",
			]
		`);
	});

	test("the package stays pure — no stateful helper leaks into it", async () => {
		// `fetchEnvReusingSecrets` reads an env source and can mint and revoke credentials. It
		// is shared implementation with the `neon` CLI (`@neon-internals/env-core`), not something to
		// hand an application: a library that revokes credentials because you imported it is a
		// library you cannot safely embed. It has no entry point of its own any more, and must
		// not reappear on this one.
		const surface = await import("../index.js");
		expect(Object.keys(surface)).not.toContain("fetchEnvReusingSecrets");
	});

	test("there is exactly one entry point", async () => {
		// `./runtime` was published until 0.16.0 and is deliberately gone. A second entry point
		// would have to be added to `package.json` `exports` *and* `tsdown.config.ts` — this
		// pins the decision so neither happens by accident.
		const manifest = JSON.parse(
			readFileSync(
				new URL("../../package.json", import.meta.url),
				"utf8",
			),
		);
		expect(Object.keys(manifest.exports)).toEqual(["."]);
	});
});
