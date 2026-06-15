import { describe, expectTypeOf, test } from "vitest";
import type {
	AppliedChange,
	BranchTarget,
	BranchTuning,
	BranchTuningFn,
	BucketAccessLevel,
	BucketDef,
	ComputeSettings,
	ComputeUnit,
	ConflictReport,
	CreateBranchInput,
	CreateBucketInput,
	CreateCredentialInput,
	CreateProjectInput,
	CredentialFeatureFlags,
	CredentialPrincipalType,
	CredentialScope,
	DataApiAuthProvider,
	DataApiConfig,
	DataApiExternalAuthConfig,
	DataApiInput,
	DataApiNeonAuthConfig,
	DataApiSettings,
	DeployFunctionInput,
	DiffOptions,
	DiffResult,
	DurationString,
	DurationUnit,
	EnableDataApiInput,
	FunctionDef,
	FunctionDevConfig,
	FunctionRuntime,
	FunctionTuning,
	GetConnectionUriInput,
	LoadConfigOptions,
	NeonApi,
	NeonAuthSnapshot,
	NeonBranchSnapshot,
	NeonBranchStorageSnapshot,
	NeonBucketSnapshot,
	NeonCredentialMeta,
	NeonCredentialSecret,
	NeonDataApiSnapshot,
	NeonDatabaseSnapshot,
	NeonEndpointSnapshot,
	NeonFunctionDeploymentSnapshot,
	NeonFunctionSnapshot,
	NeonProjectSnapshot,
	NeonRoleSnapshot,
	PlanStep,
	PostgresConfig,
	PreviewInput,
	PreviewTuning,
	PushResult,
	RemotePreviewState,
	RemoteServiceState,
	RemoteState,
	ResolvedBranchConfig,
	ResolvedBucketConfig,
	ResolvedDataApiConfig,
	ResolvedFunctionConfig,
	ResolvedPreviewConfig,
	ServiceEnabled,
	ServiceToggle,
	ServiceToggleInput,
	UpdateBranchInput,
} from "./v1.js";
import { type Config, defineConfig } from "./v1.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public TYPE-export surface lock. Type-only exports cannot be enumerated at runtime, so
// this file references every public type of `@neondatabase/config/v1`. Removing or renaming
// any of them fails to compile here — a deliberate tripwire against an accidental breaking
// change to the type surface. Run via `pnpm --filter @neondatabase/config test:types` and
// enforced by `tsc --noEmit` during the build (this file lives under `src`).
// ─────────────────────────────────────────────────────────────────────────────

describe("config type-export surface", () => {
	test("every public config type is exported (compile-time tripwire)", () => {
		expectTypeOf<AppliedChange>().not.toBeAny();
		expectTypeOf<BranchTarget>().not.toBeAny();
		expectTypeOf<BranchTuning>().not.toBeAny();
		expectTypeOf<BranchTuningFn>().not.toBeAny();
		expectTypeOf<BucketAccessLevel>().not.toBeAny();
		expectTypeOf<BucketDef>().not.toBeAny();
		expectTypeOf<ComputeSettings>().not.toBeAny();
		expectTypeOf<ComputeUnit>().not.toBeAny();
		expectTypeOf<Config>().not.toBeAny();
		expectTypeOf<ConflictReport>().not.toBeAny();
		expectTypeOf<CredentialPrincipalType>().not.toBeAny();
		expectTypeOf<CredentialScope>().not.toBeAny();
		expectTypeOf<DataApiAuthProvider>().not.toBeAny();
		expectTypeOf<DataApiConfig>().not.toBeAny();
		expectTypeOf<DataApiExternalAuthConfig>().not.toBeAny();
		expectTypeOf<DataApiInput>().not.toBeAny();
		expectTypeOf<DataApiNeonAuthConfig>().not.toBeAny();
		expectTypeOf<DataApiSettings>().not.toBeAny();
		expectTypeOf<DurationString>().not.toBeAny();
		expectTypeOf<DurationUnit>().not.toBeAny();
		expectTypeOf<FunctionDef>().not.toBeAny();
		expectTypeOf<FunctionDevConfig>().not.toBeAny();
		expectTypeOf<FunctionRuntime>().not.toBeAny();
		expectTypeOf<FunctionTuning>().not.toBeAny();
		expectTypeOf<PostgresConfig>().not.toBeAny();
		expectTypeOf<PreviewInput>().not.toBeAny();
		expectTypeOf<PreviewTuning>().not.toBeAny();
		expectTypeOf<PushResult>().not.toBeAny();
		expectTypeOf<ResolvedBranchConfig>().not.toBeAny();
		expectTypeOf<ResolvedBucketConfig>().not.toBeAny();
		expectTypeOf<ResolvedDataApiConfig>().not.toBeAny();
		expectTypeOf<ResolvedFunctionConfig>().not.toBeAny();
		expectTypeOf<ResolvedPreviewConfig>().not.toBeAny();
		expectTypeOf<ServiceEnabled<true>>().not.toBeAny();
		expectTypeOf<ServiceToggle>().not.toBeAny();
		expectTypeOf<ServiceToggleInput>().not.toBeAny();
	});

	test("every public NeonApi adapter type is exported (compile-time tripwire)", () => {
		expectTypeOf<CreateBranchInput>().not.toBeAny();
		expectTypeOf<CreateBucketInput>().not.toBeAny();
		expectTypeOf<CreateCredentialInput>().not.toBeAny();
		expectTypeOf<CreateProjectInput>().not.toBeAny();
		expectTypeOf<CredentialFeatureFlags>().not.toBeAny();
		expectTypeOf<DeployFunctionInput>().not.toBeAny();
		expectTypeOf<EnableDataApiInput>().not.toBeAny();
		expectTypeOf<GetConnectionUriInput>().not.toBeAny();
		expectTypeOf<NeonApi>().not.toBeAny();
		expectTypeOf<NeonAuthSnapshot>().not.toBeAny();
		expectTypeOf<NeonBranchSnapshot>().not.toBeAny();
		expectTypeOf<NeonBranchStorageSnapshot>().not.toBeAny();
		expectTypeOf<NeonBucketSnapshot>().not.toBeAny();
		expectTypeOf<NeonCredentialMeta>().not.toBeAny();
		expectTypeOf<NeonCredentialSecret>().not.toBeAny();
		expectTypeOf<NeonDataApiSnapshot>().not.toBeAny();
		expectTypeOf<NeonDatabaseSnapshot>().not.toBeAny();
		expectTypeOf<NeonEndpointSnapshot>().not.toBeAny();
		expectTypeOf<NeonFunctionDeploymentSnapshot>().not.toBeAny();
		expectTypeOf<NeonFunctionSnapshot>().not.toBeAny();
		expectTypeOf<NeonProjectSnapshot>().not.toBeAny();
		expectTypeOf<NeonRoleSnapshot>().not.toBeAny();
		expectTypeOf<UpdateBranchInput>().not.toBeAny();
	});

	test("every public diff/loader type is exported (compile-time tripwire)", () => {
		expectTypeOf<DiffOptions>().not.toBeAny();
		expectTypeOf<DiffResult>().not.toBeAny();
		expectTypeOf<PlanStep>().not.toBeAny();
		expectTypeOf<RemotePreviewState>().not.toBeAny();
		expectTypeOf<RemoteServiceState>().not.toBeAny();
		expectTypeOf<RemoteState>().not.toBeAny();
		expectTypeOf<LoadConfigOptions>().not.toBeAny();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// `defineConfig` return-type stability. `defineConfig` infers the static toggles as `const`
// literals into `Config<Auth, DataApi, Preview>` — that literal inference is exactly what
// makes `NeonEnv<typeof config>` exact downstream (see env's NeonEnv presence matrix). If
// inference ever widens (e.g. `auth: true` → `boolean`), the env namespaces silently break.
// ─────────────────────────────────────────────────────────────────────────────

describe("defineConfig return-type stability", () => {
	test("the returned value is a Config", () => {
		const config = defineConfig({ auth: true });
		expectTypeOf(config).toExtend<Config>();
	});

	test("static toggles keep their literal type (not widened to boolean)", () => {
		const enabled = defineConfig({ auth: true });
		expectTypeOf(enabled.auth).toEqualTypeOf<true | undefined>();

		const disabled = defineConfig({ auth: false });
		expectTypeOf(disabled.auth).toEqualTypeOf<false | undefined>();

		// An omitted toggle stays `undefined` (not `boolean`), so the env namespace is absent.
		const empty = defineConfig({});
		expectTypeOf(empty.auth).toEqualTypeOf<undefined>();
	});

	test("declared function slugs are preserved on the returned Config", () => {
		const config = defineConfig({
			preview: {
				functions: {
					hello: { name: "H", source: "./h.ts" },
					world: { name: "W", source: "./w.ts" },
				},
			},
		});
		expectTypeOf<
			keyof NonNullable<NonNullable<typeof config.preview>["functions"]>
		>().toEqualTypeOf<"hello" | "world">();
	});
});
