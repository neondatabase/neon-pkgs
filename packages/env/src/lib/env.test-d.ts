import { type Config, defineConfig } from "@neondatabase/config/v1";
import { describe, expectTypeOf, test } from "vitest";
import type {
	FetchEnvOptions,
	FilteredNeonEnv,
	FunctionSlugOf,
	NeonAiGatewayEnv,
	NeonAuthEnv,
	NeonBranchEnv,
	NeonDataApiEnv,
	NeonFunctionEnv,
	NeonPostgresEnv,
	NeonStorageEnv,
} from "./env.js";
import { type NeonEnv, parseEnv, type SelectableEnvKey } from "./env.js";

// Type-level tests for `parseEnv`. Run via `pnpm --filter @neondatabase/env test:types`
// (Vitest typecheck mode) and additionally enforced by `tsc --noEmit` during the build,
// since this file lives under `src`.

describe("parseEnv key filter (types)", () => {
	test("narrows a single postgres key to just that property", () => {
		const env = parseEnv(defineConfig({}), ["DATABASE_URL"]);
		expectTypeOf(env).toEqualTypeOf<{
			postgres: { databaseUrl: string };
		}>();
	});

	test("keeps both postgres keys when both are selected", () => {
		const env = parseEnv(defineConfig({}), [
			"DATABASE_URL",
			"DATABASE_URL_UNPOOLED",
		]);
		expectTypeOf(env).toEqualTypeOf<{
			postgres: { databaseUrl: string; databaseUrlUnpooled: string };
		}>();
	});

	test("spans multiple namespaces, partial within each", () => {
		const env = parseEnv(defineConfig({ auth: true }), [
			"DATABASE_URL",
			"NEON_AUTH_BASE_URL",
		]);
		expectTypeOf(env).toEqualTypeOf<{
			postgres: { databaseUrl: string };
			auth: { baseUrl: string };
		}>();
	});

	test("an empty selection yields an empty object", () => {
		const env = parseEnv(defineConfig({}), []);
		expectTypeOf(env).toEqualTypeOf<Record<never, never>>();
	});

	test("storage keys are selectable once the policy declares buckets", () => {
		const config = defineConfig({
			preview: { buckets: { uploads: {} } },
		});
		const env = parseEnv(config, ["AWS_REGION"]);
		expectTypeOf(env).toEqualTypeOf<{ storage: { region: string } }>();
	});

	test("SelectableEnvKey reflects exactly the policy's namespaces", () => {
		const config = defineConfig({});
		expectTypeOf<SelectableEnvKey<typeof config>>().toEqualTypeOf<
			"DATABASE_URL" | "DATABASE_URL_UNPOOLED"
		>();
	});
});

describe("parseEnv key filter (negative types)", () => {
	test("rejects a key whose namespace the policy does not enable", () => {
		// auth is off → NEON_AUTH_BASE_URL is not a selectable key.
		// @ts-expect-error not selectable without `auth`
		parseEnv(defineConfig({}), ["NEON_AUTH_BASE_URL"]);
	});

	test("rejects an unknown env var key", () => {
		// @ts-expect-error not a real Neon env var
		parseEnv(defineConfig({}), ["NEON_BRANCH"]);
	});

	test("rejects a storage key without a buckets policy", () => {
		// @ts-expect-error storage is not enabled
		parseEnv(defineConfig({}), ["AWS_ACCESS_KEY_ID"]);
	});

	test("a dropped namespace is not present on the result", () => {
		const env = parseEnv(defineConfig({}), ["DATABASE_URL"]);
		// @ts-expect-error filtered result has no `auth` namespace
		env.auth;
		// @ts-expect-error the unselected key is gone from the kept namespace
		env.postgres.databaseUrlUnpooled;
	});
});

describe("parseEnv existing overloads still type", () => {
	test("no scope returns the full NeonEnv", () => {
		const config = defineConfig({ auth: true });
		const env = parseEnv(config);
		expectTypeOf(env).toEqualTypeOf<NeonEnv<typeof config>>();
	});

	test("a function slug adds the typed function namespace", () => {
		const config = defineConfig({
			preview: {
				functions: {
					hello: {
						name: "Hello",
						source: "./hello.ts",
						env: { resendApiKey: "" },
					},
				},
			},
		});
		const env = parseEnv(config, "hello");
		expectTypeOf(env.function).toEqualTypeOf<{ resendApiKey: string }>();
		expectTypeOf(env.function.resendApiKey).toEqualTypeOf<string>();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// NeonEnv<C> namespace-presence matrix.
//
// `NeonEnv<C>` is the crown-jewel userspace type: the shape every consumer reads
// (`env.postgres.databaseUrl`, `env.auth.baseUrl`, …). Its optional namespaces are derived
// from the static policy, and a regression there (e.g. `storage` always present, or `auth`
// never inferred) breaks user code *silently* — the resolved indexed type can still look
// right while presence flips. These assertions pin which namespaces each policy yields.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reduce a policy's `NeonEnv` to a boolean-per-namespace presence record, so an entire
 * policy's namespace set can be asserted in one exact `toEqualTypeOf`. `postgres` and the
 * optional `branch` key are always present; the rest are gated on the policy.
 */
type NamespacePresence<C extends Config> = {
	postgres: "postgres" extends keyof NeonEnv<C> ? true : false;
	branch: "branch" extends keyof NeonEnv<C> ? true : false;
	auth: "auth" extends keyof NeonEnv<C> ? true : false;
	dataApi: "dataApi" extends keyof NeonEnv<C> ? true : false;
	storage: "storage" extends keyof NeonEnv<C> ? true : false;
	aiGateway: "aiGateway" extends keyof NeonEnv<C> ? true : false;
};

/** The presence record of a postgres-only policy (no secret namespaces). */
type PostgresOnly = {
	postgres: true;
	branch: true;
	auth: false;
	dataApi: false;
	storage: false;
	aiGateway: false;
};

describe("NeonEnv namespace presence (types)", () => {
	test("an empty policy yields only postgres (+ optional branch)", () => {
		const empty = defineConfig({});
		expectTypeOf<
			NamespacePresence<typeof empty>
		>().toEqualTypeOf<PostgresOnly>();
	});

	test("auth toggles add (or omit) the auth namespace", () => {
		const authTrue = defineConfig({ auth: true });
		const authObj = defineConfig({ auth: {} });
		const authFalse = defineConfig({ auth: false });
		const authDisabled = defineConfig({ auth: { enabled: false } });
		expectTypeOf<
			NamespacePresence<typeof authTrue>["auth"]
		>().toEqualTypeOf<true>();
		expectTypeOf<
			NamespacePresence<typeof authObj>["auth"]
		>().toEqualTypeOf<true>();
		// Disabled toggles must NOT add the namespace.
		expectTypeOf<
			NamespacePresence<typeof authFalse>["auth"]
		>().toEqualTypeOf<false>();
		expectTypeOf<
			NamespacePresence<typeof authDisabled>["auth"]
		>().toEqualTypeOf<false>();
		// When present, the namespace is exactly NeonAuthEnv.
		expectTypeOf<
			NeonEnv<typeof authTrue>["auth"]
		>().toEqualTypeOf<NeonAuthEnv>();
	});

	test("dataApi toggles add (or omit) the dataApi namespace", () => {
		// External Data API: enabled, no Neon Auth required.
		const external = defineConfig({
			dataApi: {
				authProvider: "external",
				jwksUrl: "https://idp.example.com/jwks.json",
			},
		});
		const neon = defineConfig({ auth: true, dataApi: true });
		const disabled = defineConfig({ dataApi: false });
		expectTypeOf<
			NamespacePresence<typeof external>["dataApi"]
		>().toEqualTypeOf<true>();
		expectTypeOf<
			NeonEnv<typeof external>["dataApi"]
		>().toEqualTypeOf<NeonDataApiEnv>();
		// Neon Data API (requires auth) is enabled too.
		expectTypeOf<
			NamespacePresence<typeof neon>["dataApi"]
		>().toEqualTypeOf<true>();
		// Disabled → omitted.
		expectTypeOf<
			NamespacePresence<typeof disabled>["dataApi"]
		>().toEqualTypeOf<false>();
	});

	test("preview.buckets adds the storage namespace (only when non-empty)", () => {
		const withBucket = defineConfig({
			preview: { buckets: { uploads: {} } },
		});
		const emptyBuckets = defineConfig({ preview: { buckets: {} } });
		expectTypeOf<
			NamespacePresence<typeof withBucket>["storage"]
		>().toEqualTypeOf<true>();
		expectTypeOf<
			NeonEnv<typeof withBucket>["storage"]
		>().toEqualTypeOf<NeonStorageEnv>();
		// An empty buckets record declares no bucket → no storage namespace.
		expectTypeOf<
			NamespacePresence<typeof emptyBuckets>["storage"]
		>().toEqualTypeOf<false>();
	});

	test("preview.aiGateway adds (or omits) the aiGateway namespace", () => {
		const on = defineConfig({ preview: { aiGateway: true } });
		const off = defineConfig({ preview: { aiGateway: false } });
		expectTypeOf<
			NamespacePresence<typeof on>["aiGateway"]
		>().toEqualTypeOf<true>();
		expectTypeOf<
			NeonEnv<typeof on>["aiGateway"]
		>().toEqualTypeOf<NeonAiGatewayEnv>();
		expectTypeOf<
			NamespacePresence<typeof off>["aiGateway"]
		>().toEqualTypeOf<false>();
	});

	test("preview.functions alone adds no env namespace (functions are not secrets here)", () => {
		const fnOnly = defineConfig({
			preview: {
				functions: { hello: { name: "H", source: "./h.ts" } },
			},
		});
		expectTypeOf<
			NamespacePresence<typeof fnOnly>
		>().toEqualTypeOf<PostgresOnly>();
	});

	test("a fully-enabled policy yields every namespace", () => {
		const everything = defineConfig({
			auth: true,
			dataApi: true,
			preview: { buckets: { uploads: {} }, aiGateway: true },
		});
		expectTypeOf<NamespacePresence<typeof everything>>().toEqualTypeOf<{
			postgres: true;
			branch: true;
			auth: true;
			dataApi: true;
			storage: true;
			aiGateway: true;
		}>();
	});

	test("a bare, untyped Config yields only postgres (no namespace leakage)", () => {
		// The default `Config` (no literal toggle info) must not optimistically add the
		// secret namespaces — an untyped policy reads as "postgres only".
		expectTypeOf<NamespacePresence<Config>>().toEqualTypeOf<PostgresOnly>();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Type-export presence lock. Type-only exports can't be enumerated at runtime, so this
// references every public type from `./env.js`. Removing or renaming one fails compilation
// here — a deliberate tripwire for an accidental breaking change to the type surface.
// ─────────────────────────────────────────────────────────────────────────────

describe("env type-export surface", () => {
	test("every public type is exported (compile-time tripwire)", () => {
		const sample = defineConfig({
			preview: { functions: { hello: { name: "H", source: "./h.ts" } } },
		});
		expectTypeOf<FetchEnvOptions>().not.toBeAny();
		expectTypeOf<FilteredNeonEnv<"DATABASE_URL">>().not.toBeAny();
		expectTypeOf<FunctionSlugOf<typeof sample>>().not.toBeAny();
		expectTypeOf<NeonAiGatewayEnv>().not.toBeAny();
		expectTypeOf<NeonAuthEnv>().not.toBeAny();
		expectTypeOf<NeonBranchEnv>().not.toBeAny();
		expectTypeOf<NeonDataApiEnv>().not.toBeAny();
		expectTypeOf<NeonEnv>().not.toBeAny();
		expectTypeOf<NeonFunctionEnv<typeof sample, "hello">>().not.toBeAny();
		expectTypeOf<NeonPostgresEnv>().not.toBeAny();
		expectTypeOf<NeonStorageEnv>().not.toBeAny();
		expectTypeOf<SelectableEnvKey<typeof sample>>().not.toBeAny();
	});
});
