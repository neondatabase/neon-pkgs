import { defineConfig } from "@neondatabase/config/v1";
import { describe, expectTypeOf, test } from "vitest";
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
