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
	FunctionArchiveEntry,
	FunctionBundle,
	FunctionBundler,
	FunctionBundlerInput,
	FunctionDef,
	FunctionDevConfig,
	FunctionRuntime,
	FunctionSourceEntry,
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
// this file references every public type of `@neon/config/v1`. Removing or renaming
// any of them fails to compile here — a deliberate tripwire against an accidental breaking
// change to the type surface. Run via `pnpm --filter @neon/config test:types` and
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
		expectTypeOf<FunctionArchiveEntry>().not.toBeAny();
		expectTypeOf<FunctionBundle>().not.toBeAny();
		expectTypeOf<FunctionBundler>().not.toBeAny();
		expectTypeOf<FunctionBundlerInput>().not.toBeAny();
		expectTypeOf<FunctionDevConfig>().not.toBeAny();
		expectTypeOf<FunctionRuntime>().not.toBeAny();
		expectTypeOf<FunctionSourceEntry>().not.toBeAny();
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

	test("ComputeUnit is the documented size table, not a subset", () => {
		type DocumentedComputeUnit =
			| 0.25
			| 0.5
			| 1
			| 2
			| 3
			| 4
			| 5
			| 6
			| 7
			| 8
			| 9
			| 10
			| 11
			| 12
			| 13
			| 14
			| 15
			| 16
			| 18
			| 20
			| 22
			| 24
			| 26
			| 28
			| 30
			| 32
			| 34
			| 36
			| 38
			| 40
			| 42
			| 44
			| 46
			| 48
			| 50
			| 52
			| 54
			| 56;
		expectTypeOf<ComputeUnit>().toEqualTypeOf<DocumentedComputeUnit>();
		expectTypeOf<7.5>().not.toExtend<ComputeUnit>();
		expectTypeOf<17>().not.toExtend<ComputeUnit>();
	});

	test("a 4-12 always-on compute type-checks on defineConfig", () => {
		const config = defineConfig({
			branch: () => ({
				postgres: {
					computeSettings: {
						autoscalingLimitMinCu: 4,
						autoscalingLimitMaxCu: 12,
						suspendTimeout: false,
					},
				},
			}),
		});
		expectTypeOf(config).toExtend<Config>();
	});

	test("bundler accepts esbuild, none, or a function, not zip-directory", () => {
		expectTypeOf<"esbuild">().toExtend<FunctionBundlerInput>();
		expectTypeOf<"none">().toExtend<FunctionBundlerInput>();
		expectTypeOf<FunctionBundler>().toExtend<FunctionBundlerInput>();
		type Retired = "zip-directory" extends FunctionBundlerInput
			? true
			: false;
		expectTypeOf<Retired>().toEqualTypeOf<false>();
	});
});
