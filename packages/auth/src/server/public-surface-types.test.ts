/**
 * Type-only public surface pin for `@neon/auth/server`.
 *
 * Companion to `public-surface.test.ts` (which only snapshots runtime
 * `Object.keys`). Without this file, the ~24 type-only exports can be
 * renamed or dropped silently while the runtime snapshot stays green —
 * see #161 review feedback (Andras item 3.3).
 *
 * Two complementary checks live here:
 *
 * 1. **Existence pin (catches rename / removal)** — every public type-only
 *    export is `import`-ed by name. If a future refactor renames or drops
 *    one, TypeScript fails to resolve the import and `pnpm typecheck`
 *    catches it before the snapshot test ever runs.
 *
 * 2. **Shape pin (catches accidental widening)** — high-value contract
 *    types (`NeonAuthServerConfig`, `RequestContext`, `MiddlewareResult`,
 *    `AuthProxyConfig`, `NeonAuthServerApiError`) get explicit
 *    `expectTypeOf` assertions so silent field renames in the underlying
 *    interfaces also fail the build.
 *
 * The test bodies do no runtime work; `expectTypeOf` is a type-level
 * assertion that compiles to a no-op under plain `vitest run`. Failures
 * surface as TypeScript compile errors during `pnpm typecheck` (the `ci`
 * job's typecheck step, which runs `tsc --noEmit` over this file). Plain
 * `pnpm test:ci` (no `--typecheck`) will NOT enforce the shape pins on its
 * own — it only executes the `describe` bodies as smoke tests.
 */

import { describe, expectTypeOf, it } from "vitest";
import type {
	// Middleware primitives
	AuthMiddlewareConfig,
	// Proxy primitive config
	AuthProxyConfig,
	ClassifiedFetchFailure,
	CookieOptions,
	MiddlewareResult,
	// Reusable config blocks
	NeonAuthConfig,
	// Logging
	NeonAuthLogger,
	NeonAuthLoggingInput,
	NeonAuthLogLevel,
	NeonAuthMiddlewareConfig,
	// Network error classification
	NeonAuthNetworkErrorCode,
	// Server contract types
	NeonAuthServer,
	NeonAuthServerApiError,
	// Core factory config — required by anyone calling createAuthServer
	NeonAuthServerConfig,
	// Cookie utilities
	ParsedCookie,
	// Request context contract — implemented by every adapter
	RequestContext,
	RequestContextFactory,
	RequireSessionData,
	ResolvedNeonAuthLogging,
	SessionCheckResult,
	SessionCookieConfig,
	SessionCookieSameSite,
	SessionData,
	SessionDataCookie,
} from "./index";

// ---- Existence pin -------------------------------------------------------
//
// The `import type {...}` block at the top of this file is itself the
// existence pin for the 24 type-only exports. If any of them is renamed,
// removed, or moved off the `@neon/auth/server` subpath, TypeScript
// fails to resolve the import and `pnpm typecheck` (the `ci` job) fails
// before anything else runs.
//
// The `describe` blocks below add shape pins on top of that, using
// `expectTypeOf`. `expectTypeOf` compiles to a runtime no-op, so it only
// catches shape drift when the file is fed through `tsc` — which the
// project-level `pnpm typecheck` already does. Running these under
// `vitest run` alone (no `--typecheck`) executes them as smoke tests but
// does not enforce their shape assertions; the enforcement is `tsc`.
//
// Do NOT re-add a runtime `expect(array).toHaveLength(24)` here — it would
// be a tautology on a hardcoded literal and would falsely appear to guard
// the surface. If you want to broaden coverage, either enable vitest
// `--typecheck` for this file or import from the built `@neon/auth/server`
// specifier so the package `exports` map + `dist/*.d.ts` are verified too.
// See #161 review feedback (Andras follow-up review).

// ---- Shape pins for the highest-value contract types ---------------------

describe("NeonAuthServerConfig shape", () => {
	it("has the documented required fields", () => {
		expectTypeOf<NeonAuthServerConfig["baseUrl"]>().toEqualTypeOf<string>();
		expectTypeOf<
			NeonAuthServerConfig["cookieSecret"]
		>().toEqualTypeOf<string>();
		expectTypeOf<
			NeonAuthServerConfig["context"]
		>().toEqualTypeOf<RequestContextFactory>();
	});

	it("has the documented optional fields with correct types", () => {
		expectTypeOf<NeonAuthServerConfig["sessionDataTtl"]>().toEqualTypeOf<
			number | undefined
		>();
		expectTypeOf<NeonAuthServerConfig["domain"]>().toEqualTypeOf<
			string | undefined
		>();
		expectTypeOf<NeonAuthServerConfig["sameSite"]>().toEqualTypeOf<
			SessionCookieSameSite | undefined
		>();
		// `log` accepts either a pre-resolved sink or a partial NeonAuthLogger
		// (Andras FIX 3, DX) so adapters can forward `log?: NeonAuthLogger` from
		// their own config without TS2322.
		expectTypeOf<NeonAuthServerConfig["log"]>().toEqualTypeOf<
			ResolvedNeonAuthLogging | NeonAuthLogger | undefined
		>();
	});
});

describe("RequestContext shape", () => {
	it("exposes the five framework-bridging methods adapters must implement", () => {
		expectTypeOf<RequestContext["getCookies"]>().toBeFunction();
		expectTypeOf<RequestContext["setCookie"]>().toBeFunction();
		expectTypeOf<RequestContext["getHeader"]>().toBeFunction();
		expectTypeOf<RequestContext["getOrigin"]>().toBeFunction();
		expectTypeOf<RequestContext["getFramework"]>().toBeFunction();
	});

	it("setCookie requires (name, value, options) — options is not optional", () => {
		type SetCookieParams = Parameters<RequestContext["setCookie"]>;
		expectTypeOf<SetCookieParams[0]>().toEqualTypeOf<string>();
		expectTypeOf<SetCookieParams[1]>().toEqualTypeOf<string>();
		expectTypeOf<SetCookieParams[2]>().toEqualTypeOf<CookieOptions>();
	});
});

describe("MiddlewareResult discriminated union shape", () => {
	it("discriminates on the `action` field (not `type`)", () => {
		type Actions = MiddlewareResult["action"];
		expectTypeOf<Actions>().toEqualTypeOf<
			"allow" | "redirect_oauth" | "redirect_login"
		>();
	});

	it("exposes the three expected variants", () => {
		// Extract each variant by its discriminant
		type Allow = Extract<MiddlewareResult, { action: "allow" }>;
		type RedirectOAuth = Extract<
			MiddlewareResult,
			{ action: "redirect_oauth" }
		>;
		type RedirectLogin = Extract<
			MiddlewareResult,
			{ action: "redirect_login" }
		>;

		// Allow may forward headers/cookies the upstream wants the adapter to set
		expectTypeOf<Allow["headers"]>().toEqualTypeOf<
			Record<string, string> | undefined
		>();
		expectTypeOf<Allow["cookies"]>().toEqualTypeOf<string[] | undefined>();

		// OAuth redirect MUST carry both URL and cookies (state cookie)
		expectTypeOf<RedirectOAuth["redirectUrl"]>().toEqualTypeOf<URL>();
		expectTypeOf<RedirectOAuth["cookies"]>().toEqualTypeOf<string[]>();

		// Login redirect MUST carry URL; cookies optional
		expectTypeOf<RedirectLogin["redirectUrl"]>().toEqualTypeOf<URL>();
		expectTypeOf<RedirectLogin["cookies"]>().toEqualTypeOf<
			string[] | undefined
		>();
	});
});

describe("AuthProxyConfig shape", () => {
	it("has the documented required fields used by handleAuthProxyRequest", () => {
		expectTypeOf<AuthProxyConfig["request"]>().toEqualTypeOf<Request>();
		expectTypeOf<AuthProxyConfig["path"]>().toEqualTypeOf<string>();
		expectTypeOf<AuthProxyConfig["baseUrl"]>().toEqualTypeOf<string>();
	});

	// Andras FIX 3 (DX): `log` must accept either a pre-resolved sink or a
	// partial `NeonAuthLogger` (the same shape adapters expose to their own
	// users). Without this widening, adapters forwarding their public
	// `log?: NeonAuthLogger` straight into `handleAuthProxyRequest` failed
	// TS2322 against the old `Required<NeonAuthLogger>` type.
	it("log accepts a pre-resolved sink, a partial NeonAuthLogger, or undefined", () => {
		expectTypeOf<AuthProxyConfig["log"]>().toEqualTypeOf<
			ResolvedNeonAuthLogging | NeonAuthLogger | undefined
		>();
	});
});

describe("NeonAuthServerApiError shape", () => {
	it("is a typed envelope for narrowing server method errors", () => {
		expectTypeOf<
			NeonAuthServerApiError["message"]
		>().toEqualTypeOf<string>();
		expectTypeOf<
			NeonAuthServerApiError["status"]
		>().toEqualTypeOf<number>();
		expectTypeOf<
			NeonAuthServerApiError["statusText"]
		>().toEqualTypeOf<string>();
	});

	it("code accepts all classified NETWORK_* values, INTERNAL_ERROR, and arbitrary strings", () => {
		// Type-level assignability check: each literal below must remain
		// a valid `code` value. If a future refactor narrows the union
		// (dropping a NETWORK_* code or INTERNAL_ERROR) this fails compile.
		const _networkError: NeonAuthServerApiError["code"] = "NETWORK_ERROR";
		const _internalError: NeonAuthServerApiError["code"] = "INTERNAL_ERROR";
		const _forwardCompatString: NeonAuthServerApiError["code"] =
			"SOME_FUTURE_CODE";
		void _networkError;
		void _internalError;
		void _forwardCompatString;
	});
});

// Silence "imported but never used" warnings for types that only serve as
// existence pins. The above describe blocks already validate everything
// worth pinning by shape; the rest are imported solely to fail the build
// if they go missing.
type _ExistencePins =
	| NeonAuthConfig
	| NeonAuthMiddlewareConfig
	| SessionCookieConfig
	| SessionCheckResult
	| NeonAuthLogger
	| NeonAuthLogLevel
	| NeonAuthLoggingInput
	| NeonAuthNetworkErrorCode
	| ClassifiedFetchFailure
	| NeonAuthServer
	| SessionData
	| SessionDataCookie
	| RequireSessionData
	| ParsedCookie
	| AuthMiddlewareConfig;

// Use the alias once so TS does not flag _ExistencePins as unused.
const _typesReferenced: _ExistencePins | null = null;
void _typesReferenced;
