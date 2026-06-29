import { describe, expectTypeOf, test } from "vitest";
import {
	type DataApiField,
	defineConfig,
	type NeonAuthRequiredHint,
} from "./define-config.js";
import type { DataApiInput } from "./types.js";

// Type-level tests for the Neon-Auth Data API cross-field guard. Run via
// `pnpm --filter @neon/config test:types` (Vitest typecheck mode) and additionally
// enforced by `tsc --noEmit` during the build, since this file lives under `src`.
//
// These lock in the regression we just fixed: a Neon-Auth `dataApi` without `auth` must
// surface the readable `NeonAuthRequiredHint` as the field's expected type (not collapse to
// `never`), while every valid form keeps its real `DataApi & DataApiInput` type.

/** `true` iff string `S` contains the substring `Sub` (template-literal match). */
type Includes<
	S extends string,
	Sub extends string,
> = S extends `${string}${Sub}${string}` ? true : false;

describe("DataApiField guard (types)", () => {
	test("a Neon-Auth dataApi (bare `true`) without auth expects the hint message", () => {
		expectTypeOf<
			DataApiField<undefined, true>
		>().toEqualTypeOf<NeonAuthRequiredHint>();
	});

	test("a Neon-Auth dataApi (object form) without auth expects the hint message", () => {
		expectTypeOf<
			DataApiField<undefined, { settings: { dbMaxRows: 10 } }>
		>().toEqualTypeOf<NeonAuthRequiredHint>();
	});

	test("an explicit `auth: false` is still treated as auth-disabled (expects the hint)", () => {
		expectTypeOf<
			DataApiField<false, true>
		>().toEqualTypeOf<NeonAuthRequiredHint>();
	});

	test("with `auth: true` a Neon-Auth dataApi keeps its real type (not the hint)", () => {
		expectTypeOf<DataApiField<true, true>>().toEqualTypeOf<
			true & DataApiInput
		>();
		expectTypeOf<
			DataApiField<true, true>
		>().not.toEqualTypeOf<NeonAuthRequiredHint>();
	});

	test("with `auth: {}` (present ⇒ enabled) a Neon-Auth dataApi keeps its real type", () => {
		expectTypeOf<
			DataApiField<Record<never, never>, true>
		>().not.toEqualTypeOf<NeonAuthRequiredHint>();
	});

	test("an external dataApi never needs auth (keeps its real type, even without auth)", () => {
		expectTypeOf<
			DataApiField<undefined, { authProvider: "external" }>
		>().not.toEqualTypeOf<NeonAuthRequiredHint>();
		expectTypeOf<
			DataApiField<
				undefined,
				{ authProvider: "external"; jwksUrl: string }
			>
		>().toEqualTypeOf<
			{ authProvider: "external"; jwksUrl: string } & DataApiInput
		>();
	});

	test("a disabled dataApi (`false` / `{ enabled: false }`) never needs auth", () => {
		expectTypeOf<
			DataApiField<undefined, false>
		>().not.toEqualTypeOf<NeonAuthRequiredHint>();
		expectTypeOf<
			DataApiField<undefined, { enabled: false }>
		>().not.toEqualTypeOf<NeonAuthRequiredHint>();
	});
});

describe("NeonAuthRequiredHint documents both fixes (types)", () => {
	test("documents enabling Neon Auth via `auth: true`", () => {
		expectTypeOf<
			Includes<NeonAuthRequiredHint, "auth: true">
		>().toEqualTypeOf<true>();
	});

	test("documents running the Data API WITHOUT Neon Auth", () => {
		expectTypeOf<
			Includes<NeonAuthRequiredHint, "WITHOUT Neon Auth">
		>().toEqualTypeOf<true>();
	});

	test("documents the external-IdP escape hatch (authProvider + jwksUrl)", () => {
		expectTypeOf<
			Includes<NeonAuthRequiredHint, "authProvider: 'external'">
		>().toEqualTypeOf<true>();
		expectTypeOf<
			Includes<NeonAuthRequiredHint, "jwksUrl">
		>().toEqualTypeOf<true>();
	});
});

describe("defineConfig surfaces the guard at the call site (negative types)", () => {
	test("a Neon-Auth dataApi (`true`) without auth is a type error", () => {
		// @ts-expect-error dataApi (neon) needs `auth` enabled.
		defineConfig({ dataApi: true });
	});

	test("a Neon-Auth dataApi (object form) without auth is a type error", () => {
		// @ts-expect-error dataApi (neon) needs `auth` enabled.
		defineConfig({ dataApi: { settings: { dbMaxRows: 10 } } });
	});

	test("an explicit `auth: false` with a Neon-Auth dataApi is a type error", () => {
		// @ts-expect-error a neon dataApi requires auth ENABLED, not `auth: false`.
		defineConfig({ auth: false, dataApi: true });
	});
});

describe("defineConfig accepts every valid form (positive types)", () => {
	test("auth + bare dataApi", () => {
		defineConfig({ auth: true, dataApi: true });
	});

	test("auth + dataApi object with settings", () => {
		defineConfig({ auth: {}, dataApi: { settings: { dbMaxRows: 10 } } });
	});

	test("external dataApi without auth", () => {
		defineConfig({
			dataApi: {
				authProvider: "external",
				jwksUrl: "https://idp.example.com/.well-known/jwks.json",
			},
		});
	});

	test("a disabled dataApi without auth", () => {
		defineConfig({ dataApi: false });
		defineConfig({ dataApi: { enabled: false } });
	});
});
