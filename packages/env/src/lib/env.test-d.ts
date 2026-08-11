import { type Config, defineConfig } from "@neon/config/v1";
import type {
	FetchEnvOptions,
	FilteredNeonEnv,
	NeonAiGatewayEnv,
	NeonAuthEnv,
	NeonBranchEnv,
	NeonDataApiEnv,
	NeonEnv,
	NeonPostgresEnv,
	NeonStorageEnv,
	SelectableEnvKey,
	SelectedNeonEnv,
} from "@neon-internals/env-core/env";
import { fetchEnv } from "@neon-internals/env-core/env";
import { describe, expectTypeOf, test } from "vitest";
import type {
	FunctionSlugOf,
	NeonFunctionEnv,
	NoFunctionScopeHint,
} from "./parse-env.js";
import { parseEnv } from "./parse-env.js";

// Type-level tests for `parseEnv`. Run via `pnpm --filter @neon/env test:types`
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
		// `NEON_BRANCH` is always selectable: every branch has an identity, so the namespace
		// is present on every `NeonEnv`.
		expectTypeOf<SelectableEnvKey<typeof config>>().toEqualTypeOf<
			"DATABASE_URL" | "DATABASE_URL_UNPOOLED" | "NEON_BRANCH"
		>();
	});
});

describe("fetchEnv key filter (types)", () => {
	test("keeps an inline literal selection exact", () => {
		const config = defineConfig({});
		const env = fetchEnv(config, {
			projectId: "proj",
			branch: "main",
			keys: ["DATABASE_URL"],
		});

		expectTypeOf(env).toEqualTypeOf<
			Promise<{ postgres: { databaseUrl: string } }>
		>();
	});

	test("makes a dynamic selection safely optional", () => {
		const config = defineConfig({});
		const keys: Array<"DATABASE_URL" | "NEON_BRANCH"> =
			Math.random() > 0.5 ? ["DATABASE_URL"] : ["NEON_BRANCH"];
		const env = fetchEnv(config, {
			projectId: "proj",
			branch: "main",
			keys,
		});

		expectTypeOf(env).toEqualTypeOf<
			Promise<{
				postgres?: { databaseUrl?: string };
				branch?: { name?: string };
			}>
		>();
	});

	test("an empty dynamic selection does not claim its element type is present", () => {
		const config = defineConfig({});
		const keys: "DATABASE_URL"[] = [];
		const env = fetchEnv(config, {
			projectId: "proj",
			branch: "main",
			keys,
		});

		expectTypeOf(env).toEqualTypeOf<
			Promise<{ postgres?: { databaseUrl?: string } }>
		>();
	});

	test("a tuple containing a union-valued key stays conservative", () => {
		const config = defineConfig({});
		const key =
			Math.random() > 0.5
				? ("DATABASE_URL" as const)
				: ("NEON_BRANCH" as const);
		const env = fetchEnv(config, {
			projectId: "proj",
			branch: "main",
			keys: [key],
		});

		expectTypeOf(env).toEqualTypeOf<
			Promise<{
				postgres?: { databaseUrl?: string };
				branch?: { name?: string };
			}>
		>();
	});

	test("a rest tuple never overstates which repeated keys are present", () => {
		const config = defineConfig({});
		const keys: readonly ["DATABASE_URL", ..."NEON_BRANCH"[]] = [
			"DATABASE_URL",
		];
		const env = fetchEnv(config, {
			projectId: "proj",
			branch: "main",
			keys,
		});

		expectTypeOf(env).toEqualTypeOf<
			Promise<{
				postgres?: { databaseUrl?: string };
				branch?: { name?: string };
			}>
		>();
	});

	test("a union of whole literal tuples preserves its exact alternatives", () => {
		const config = defineConfig({});
		const keys =
			Math.random() > 0.5
				? (["DATABASE_URL"] as const)
				: (["NEON_BRANCH"] as const);
		const env = fetchEnv(config, {
			projectId: "proj",
			branch: "main",
			keys,
		});

		expectTypeOf(env).toEqualTypeOf<
			Promise<
				| { postgres: { databaseUrl: string } }
				| { branch: { name: string } }
			>
		>();
	});

	test("keeps existing explicit generic calls exact", () => {
		const config = defineConfig({});
		const env = fetchEnv<typeof config, "DATABASE_URL">(config, {
			projectId: "proj",
			branch: "main",
			keys: ["DATABASE_URL"],
		});

		expectTypeOf(env).toEqualTypeOf<
			Promise<{ postgres: { databaseUrl: string } }>
		>();
	});

	test("requires both storage credential halves in a literal selection", () => {
		const config = defineConfig({
			preview: { buckets: { uploads: {} } },
		});
		const env = fetchEnv(config, {
			projectId: "proj",
			branch: "main",
			keys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
		});
		expectTypeOf(env).toEqualTypeOf<
			Promise<{
				storage: { accessKeyId: string; secretAccessKey: string };
			}>
		>();

		// @ts-expect-error storage credential halves must be selected together
		fetchEnv(config, {
			projectId: "proj",
			branch: "main",
			keys: ["AWS_ACCESS_KEY_ID"],
		});
	});

	test("requires both storage credential halves in every tuple alternative", () => {
		const config = defineConfig({
			preview: { buckets: { uploads: {} } },
		});
		const keys =
			Math.random() > 0.5
				? (["AWS_ACCESS_KEY_ID"] as const)
				: (["AWS_SECRET_ACCESS_KEY"] as const);

		const options = {
			projectId: "proj",
			branch: "main",
			keys,
		};
		// @ts-expect-error every tuple alternative must contain both credential halves
		fetchEnv(config, options);
	});

	test("requires both storage credential halves in every tuple-position alternative", () => {
		const config = defineConfig({
			preview: { buckets: { uploads: {} } },
		});
		const eitherCredential =
			Math.random() > 0.5
				? ("AWS_ACCESS_KEY_ID" as const)
				: ("AWS_SECRET_ACCESS_KEY" as const);
		const secretOrRegion =
			Math.random() > 0.5
				? ("AWS_SECRET_ACCESS_KEY" as const)
				: ("AWS_REGION" as const);

		// @ts-expect-error each runtime alternative contains only one credential half
		fetchEnv(config, {
			projectId: "proj",
			branch: "main",
			keys: [eitherCredential],
		});
		// @ts-expect-error the secret key is not guaranteed to accompany the access key
		fetchEnv(config, {
			projectId: "proj",
			branch: "main",
			keys: ["AWS_ACCESS_KEY_ID", secretOrRegion],
		});
	});

	test("preserves valid storage tuple alternatives exactly", () => {
		const config = defineConfig({
			preview: { buckets: { uploads: {} } },
		});
		const keys =
			Math.random() > 0.5
				? (["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const)
				: (["AWS_ENDPOINT_URL_S3"] as const);
		const env = fetchEnv(config, {
			projectId: "proj",
			branch: "main",
			keys,
		});

		expectTypeOf(env).toEqualTypeOf<
			Promise<
				| {
						storage: {
							accessKeyId: string;
							secretAccessKey: string;
						};
				  }
				| { storage: { endpoint: string } }
			>
		>();
	});

	test("does not infer the explicit-generic overload from a contextual return", () => {
		const config = defineConfig({
			preview: { buckets: { uploads: {} } },
		});
		// @ts-expect-error an invalid selection cannot produce a complete storage credential
		const completeStorage: Promise<{
			storage: { accessKeyId: string; secretAccessKey: string };
		}> =
			// @ts-expect-error inferred callers cannot bypass the storage pair rule
			fetchEnv(config, {
				projectId: "proj",
				branch: "main",
				keys: ["AWS_ACCESS_KEY_ID"],
			});
		void completeStorage;
	});

	test("accepts a dynamic storage selection for runtime validation", () => {
		const config = defineConfig({
			preview: { buckets: { uploads: {} } },
		});
		const keys: Array<"AWS_ACCESS_KEY_ID" | "AWS_SECRET_ACCESS_KEY"> = [];
		const env = fetchEnv(config, {
			projectId: "proj",
			branch: "main",
			keys,
		});
		expectTypeOf(env).toEqualTypeOf<
			Promise<{
				storage?: { accessKeyId?: string; secretAccessKey?: string };
			}>
		>();
	});

	test("rejects unknown and policy-disabled keys", () => {
		const config = defineConfig({});
		// @ts-expect-error not a real Neon env var
		fetchEnv(config, { projectId: "proj", branch: "main", keys: ["NOPE"] });
		fetchEnv(config, {
			projectId: "proj",
			branch: "main",
			// @ts-expect-error auth is not enabled by this policy
			keys: ["NEON_AUTH_BASE_URL"],
		});
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
		parseEnv(defineConfig({}), ["NEON_NOPE"]);
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
// Function-slug scope. The slug is the one `parseEnv` argument whose accepted values come
// from the *policy* rather than a fixed list, so these pin both halves of that contract:
// only declared slugs type-check, and the chosen slug alone decides the `function` namespace.
// The matching editor-autocomplete behaviour is covered by `env.completions.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

describe("parseEnv function slug scope (types)", () => {
	const twoFunctions = defineConfig({
		preview: {
			functions: {
				hello: {
					name: "Hello",
					source: "./hello.ts",
					env: { resendApiKey: "" },
				},
				world: {
					name: "World",
					source: "./world.ts",
					env: { otherKey: "" },
				},
			},
		},
	});

	test("FunctionSlugOf is exactly the declared slugs", () => {
		expectTypeOf<FunctionSlugOf<typeof twoFunctions>>().toEqualTypeOf<
			"hello" | "world"
		>();
	});

	test("the function namespace carries only the selected function's env keys", () => {
		// A widened slug (the whole union instead of the one passed) would leak `otherKey`
		// in here, which is why the two fixtures declare *different* env keys.
		expectTypeOf(parseEnv(twoFunctions, "hello").function).toEqualTypeOf<{
			resendApiKey: string;
		}>();
		expectTypeOf(parseEnv(twoFunctions, "world").function).toEqualTypeOf<{
			otherKey: string;
		}>();
	});

	test("accepts a slug held in a narrowed variable", () => {
		// Callers don't always inline the literal; a `const` binding keeps its literal type
		// and must resolve to that one function's env keys.
		const slug = "world";
		expectTypeOf(parseEnv(twoFunctions, slug).function).toEqualTypeOf<{
			otherKey: string;
		}>();
	});

	test("rejects a slug the policy does not declare", () => {
		// @ts-expect-error "nope" is not a declared function slug
		parseEnv(twoFunctions, "nope");
	});

	test("rejects a value only known to be a string", () => {
		// Guards the constraint itself: if `FunctionSlugOf` ever widened to `string`, every
		// assertion above would still pass while any slug became acceptable.
		const widened: string = "hello";
		// @ts-expect-error a plain string could name a function the policy never declared
		parseEnv(twoFunctions, widened);
	});

	test("a key array still selects the filtered overload, not the slug one", () => {
		// The slug overload is deliberately declared *first* (see the overload-order test
		// below), so this pins that it doesn't shadow the array overload for a policy that
		// declares functions — the case where both overloads are live at once.
		expectTypeOf(parseEnv(twoFunctions, ["DATABASE_URL"])).toEqualTypeOf<{
			postgres: { databaseUrl: string };
		}>();
	});

	test("a policy with no functions has no slug to pass", () => {
		const noFunctions = defineConfig({ auth: true });
		expectTypeOf<
			FunctionSlugOf<typeof noFunctions>
		>().toEqualTypeOf<never>();
		// The expected type collapses to the readable hint instead of a bare `never`.
		// @ts-expect-error no functions are declared, so no scope is accepted
		parseEnv(noFunctions, "hello");
	});

	test("an untyped policy exposes no slugs", () => {
		// A bare `Config` carries no literal function info, so it must not optimistically
		// accept arbitrary slugs.
		expectTypeOf<FunctionSlugOf<Config>>().toEqualTypeOf<never>();
	});

	test("the no-functions hint stays a literal, not a bare string", () => {
		// Load-bearing: the hint *is* the expected type of `scope` for a policy without
		// functions, so widening it to `string` would silently accept any slug there.
		expectTypeOf<NoFunctionScopeHint>().not.toEqualTypeOf<string>();
		expectTypeOf<NoFunctionScopeHint>().toExtend<string>();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Overload order.
//
// `parseEnv`'s overloads must keep the function-slug signature ahead of the key-array one:
// the editor takes string-literal completions from the *first* candidate overload, so with
// the array overload first, typing `parseEnv(config, "…")` offers no slugs at all. That is
// invisible to every assertion above — the types stay sound either way — which is exactly why
// it regressed once. `env.completions.test.ts` catches it through the real language service;
// this locks the same invariant in the type system, so `tsc` fails on a reorder too.
// ─────────────────────────────────────────────────────────────────────────────

describe("parseEnv overload order (types)", () => {
	test("the key-array overload is declared last", () => {
		// `Parameters<>` of an overloaded function resolves to its **last** signature, which
		// makes the declaration order observable: if the slug overload were moved after the
		// array one, this would resolve to the slug/hint parameter instead.
		expectTypeOf<Parameters<typeof parseEnv>[1]>().toEqualTypeOf<
			readonly SelectableEnvKey<Config>[]
		>();
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
		expectTypeOf<
			SelectedNeonEnv<readonly ["DATABASE_URL"]>
		>().not.toBeAny();
		expectTypeOf<SelectableEnvKey<typeof sample>>().not.toBeAny();
	});
});
