import { describe, expectTypeOf, test } from "vitest";
import { toNeonBranchName } from "./branch-name.js";
import { defineConfig } from "./define-config.js";
import type {
	NeonAiGatewayEnv,
	NeonAuthEnv,
	NeonDataApiEnv,
	NeonEnv,
	NeonStorageEnv,
} from "./env.js";
import type {
	CheckoutAfterContext,
	CheckoutBeforeContext,
	CheckoutBeforeResult,
	Config,
	DeployAfterContext,
	DeployBeforeContext,
	GitContext,
	HookBranch,
	Hooks,
	PushResult,
	ShellHook,
} from "./types.js";

// Type-level tests for the lifecycle-hooks + branch-name surface. Run via
// `pnpm --filter @neondatabase/config test:types` (Vitest typecheck mode) and additionally
// enforced by `tsc --noEmit` during the build (this file lives under `src`).
//
// These go beyond the `v1.test-d.ts` presence tripwires (`.not.toBeAny()`): they pin the
// exact shape of every hook context, the function-vs-shell union, the `before` rename/abort
// contract, and the deriver return types — so a regression in the authored surface fails to
// compile here.

describe("GitContext shape", () => {
	test("required facts are booleans; optional facts are `string | undefined`", () => {
		expectTypeOf<GitContext["available"]>().toEqualTypeOf<boolean>();
		expectTypeOf<GitContext["isDetached"]>().toEqualTypeOf<boolean>();
		expectTypeOf<GitContext["isDirty"]>().toEqualTypeOf<boolean>();
		expectTypeOf<
			GitContext["triggeredByGitHook"]
		>().toEqualTypeOf<boolean>();
		expectTypeOf<GitContext["branch"]>().toEqualTypeOf<
			string | undefined
		>();
		expectTypeOf<GitContext["sha"]>().toEqualTypeOf<string | undefined>();
		expectTypeOf<GitContext["defaultBranch"]>().toEqualTypeOf<
			string | undefined
		>();
		expectTypeOf<GitContext["repoRoot"]>().toEqualTypeOf<
			string | undefined
		>();
	});
});

describe("NeonEnv<C> — exact per-policy env shape (the after-hook `env`)", () => {
	test("postgres is always present; branch is optional", () => {
		expectTypeOf<NeonEnv["postgres"]>().toEqualTypeOf<{
			databaseUrl: string;
			databaseUrlUnpooled: string;
		}>();
		expectTypeOf<NeonEnv["branch"]>().toEqualTypeOf<
			{ name: string } | undefined
		>();
	});

	test("a bare policy carries only postgres + branch (no auth/dataApi/storage/aiGateway)", () => {
		type Bare = NeonEnv<Config>;
		expectTypeOf<keyof Bare>().toEqualTypeOf<"postgres" | "branch">();
	});

	test("enabling `auth` adds `env.auth` (typed), and only then", () => {
		type WithAuth = NeonEnv<typeof authConfig>;
		expectTypeOf<WithAuth["auth"]>().toEqualTypeOf<NeonAuthEnv>();
		// @ts-expect-error a policy without `auth` has no `env.auth`.
		type _NoAuth = NeonEnv<Config>["auth"];
	});

	test("enabling `dataApi` adds `env.dataApi` (typed)", () => {
		type WithDataApi = NeonEnv<typeof dataApiConfig>;
		expectTypeOf<WithDataApi["dataApi"]>().toEqualTypeOf<NeonDataApiEnv>();
	});

	test("declaring `preview.buckets` adds `env.storage` (typed)", () => {
		type WithStorage = NeonEnv<typeof bucketConfig>;
		expectTypeOf<WithStorage["storage"]>().toEqualTypeOf<NeonStorageEnv>();
	});

	test("enabling `preview.aiGateway` adds `env.aiGateway` (typed)", () => {
		type WithAi = NeonEnv<typeof aiConfig>;
		expectTypeOf<WithAi["aiGateway"]>().toEqualTypeOf<NeonAiGatewayEnv>();
	});
});

// Representative policies whose `typeof` drives the NeonEnv presence-matrix assertions above.
const authConfig = defineConfig({ auth: true });
const dataApiConfig = defineConfig({ auth: true, dataApi: true });
const bucketConfig = defineConfig({
	preview: { buckets: { uploads: {} } },
});
const aiConfig = defineConfig({ preview: { aiGateway: true } });

describe("HookBranch shape", () => {
	test("identity + state fields are typed (created/isDefault/isProtected are booleans)", () => {
		expectTypeOf<HookBranch["projectId"]>().toEqualTypeOf<string>();
		expectTypeOf<HookBranch["id"]>().toEqualTypeOf<string>();
		expectTypeOf<HookBranch["name"]>().toEqualTypeOf<string>();
		expectTypeOf<HookBranch["created"]>().toEqualTypeOf<boolean>();
		expectTypeOf<HookBranch["isDefault"]>().toEqualTypeOf<boolean>();
		expectTypeOf<HookBranch["isProtected"]>().toEqualTypeOf<boolean>();
		expectTypeOf<HookBranch["parentId"]>().toEqualTypeOf<
			string | undefined
		>();
	});
});

describe("hook context shapes per phase", () => {
	test("checkout.before sees only the input name + git (no branch/env)", () => {
		expectTypeOf<
			CheckoutBeforeContext["inputName"]
		>().toEqualTypeOf<string>();
		expectTypeOf<
			CheckoutBeforeContext["git"]
		>().toEqualTypeOf<GitContext>();
		// @ts-expect-error checkout.before runs before resolution — there is no `branch`.
		expectTypeOf<CheckoutBeforeContext["branch"]>();
		// @ts-expect-error checkout.before runs before env is pulled — there is no `env`.
		expectTypeOf<CheckoutBeforeContext["env"]>();
	});

	test("checkout.after sees branch + env (NeonEnv<C>) + git", () => {
		expectTypeOf<
			CheckoutAfterContext["branch"]
		>().toEqualTypeOf<HookBranch>();
		expectTypeOf<CheckoutAfterContext["env"]>().toEqualTypeOf<
			NeonEnv<Config>
		>();
		expectTypeOf<CheckoutAfterContext["git"]>().toEqualTypeOf<GitContext>();
	});

	test("deploy.before sees branch + git but no env", () => {
		expectTypeOf<
			DeployBeforeContext["branch"]
		>().toEqualTypeOf<HookBranch>();
		expectTypeOf<DeployBeforeContext["git"]>().toEqualTypeOf<GitContext>();
		// @ts-expect-error deploy.before runs before env is pulled — there is no `env`.
		expectTypeOf<DeployBeforeContext["env"]>();
	});

	test("deploy.after sees branch + env (NeonEnv<C>) + result (PushResult) + git", () => {
		expectTypeOf<
			DeployAfterContext["branch"]
		>().toEqualTypeOf<HookBranch>();
		expectTypeOf<DeployAfterContext["env"]>().toEqualTypeOf<
			NeonEnv<Config>
		>();
		expectTypeOf<
			DeployAfterContext["result"]
		>().toEqualTypeOf<PushResult>();
		expectTypeOf<DeployAfterContext["git"]>().toEqualTypeOf<GitContext>();
	});
});

describe("checkout.before rename/abort contract", () => {
	test("the rename result is `{ name?: string }`", () => {
		expectTypeOf<CheckoutBeforeResult>().toEqualTypeOf<{ name?: string }>();
	});
});

describe("ShellHook union", () => {
	test("is a string or an array of strings", () => {
		expectTypeOf<ShellHook>().toEqualTypeOf<string | string[]>();
	});
});

describe("defineConfig hooks — positive (every valid form type-checks)", () => {
	test("function-form checkout + deploy hooks; contexts are inferred", () => {
		defineConfig({
			hooks: {
				checkout: {
					before: (ctx) => {
						expectTypeOf(
							ctx,
						).toEqualTypeOf<CheckoutBeforeContext>();
						expectTypeOf(ctx.inputName).toEqualTypeOf<string>();
						return { name: `preview/${ctx.inputName}` };
					},
					after: async (ctx) => {
						// Bare policy (no services): env is exactly postgres + branch.
						expectTypeOf<keyof typeof ctx.env>().toEqualTypeOf<
							"postgres" | "branch"
						>();
						expectTypeOf(
							ctx.env.postgres.databaseUrl,
						).toEqualTypeOf<string>();
						expectTypeOf(
							ctx.branch.created,
						).toEqualTypeOf<boolean>();
					},
				},
				deploy: {
					before: (ctx) => {
						expectTypeOf(ctx.branch.id).toEqualTypeOf<string>();
					},
					after: async (ctx) => {
						expectTypeOf(ctx.result).toEqualTypeOf<PushResult>();
						expectTypeOf<keyof typeof ctx.env>().toEqualTypeOf<
							"postgres" | "branch"
						>();
					},
				},
			},
		});
	});

	test("the after-hook `env` reflects the policy: `auth: true` ⇒ `env.auth` is present + typed", () => {
		defineConfig({
			auth: true,
			hooks: {
				checkout: {
					after: (ctx) => {
						expectTypeOf(ctx.env.auth).toEqualTypeOf<NeonAuthEnv>();
						expectTypeOf(
							ctx.env.postgres.databaseUrl,
						).toEqualTypeOf<string>();
					},
				},
				deploy: {
					after: (ctx) => {
						expectTypeOf(ctx.env.auth).toEqualTypeOf<NeonAuthEnv>();
					},
				},
			},
		});
	});

	test("the after-hook `env` omits namespaces the policy doesn't enable", () => {
		defineConfig({
			hooks: {
				checkout: {
					after: (ctx) => {
						// @ts-expect-error no `auth` in the policy ⇒ no `env.auth`.
						ctx.env.auth;
					},
				},
			},
		});
	});

	test("a `before` hook may return nothing (void) or a rename", () => {
		defineConfig({
			hooks: {
				checkout: {
					before: () => {
						/* validate / abort by throwing; return nothing */
					},
				},
			},
		});
	});

	test("shell-command hooks: string and array", () => {
		defineConfig({
			hooks: {
				checkout: { after: "drizzle-kit migrate" },
				deploy: { after: ["npm run build", "drizzle-kit migrate"] },
			},
		});
	});

	test("hooks survive onto the returned Config", () => {
		const config = defineConfig({ hooks: { deploy: { after: "x" } } });
		expectTypeOf(config.hooks).toEqualTypeOf<Hooks | undefined>();
	});
});

describe("defineConfig hooks — negative (@ts-expect-error)", () => {
	test("an unknown hook phase is rejected", () => {
		// @ts-expect-error `dev` is not a hook phase.
		defineConfig({ hooks: { dev: { after: "x" } } });
	});

	test("an unknown key inside a phase is rejected", () => {
		// @ts-expect-error `during` is not a phase key (before/after only).
		defineConfig({ hooks: { checkout: { during: "x" } } });
	});

	test("a non-function / non-shell hook value is rejected", () => {
		// @ts-expect-error 42 is neither a function nor a shell command.
		defineConfig({ hooks: { deploy: { after: 42 } } });
	});

	test("a checkout.before returning a wrong-typed name is rejected", () => {
		defineConfig({
			hooks: {
				checkout: {
					// @ts-expect-error `name` must be a string.
					before: () => ({ name: 123 }),
				},
			},
		});
	});

	test("reading a field absent from a phase context is a type error", () => {
		const ctx: CheckoutBeforeContext = {
			inputName: "x",
			git: {
				available: false,
				isDetached: false,
				isDirty: false,
				triggeredByGitHook: false,
			},
		};
		// @ts-expect-error before-checkout context exposes no `branch`.
		ctx.branch;
	});
});

describe("toNeonBranchName (types)", () => {
	test("returns a string", () => {
		expectTypeOf(toNeonBranchName("x")).toEqualTypeOf<string>();
	});

	test("options are accepted (positive)", () => {
		toNeonBranchName("x", {
			prefix: "preview/",
			maxLength: 64,
			lowercase: true,
			preserveSlashes: false,
		});
	});

	test("an unknown option is rejected", () => {
		// @ts-expect-error `unknown` is not a ToNeonBranchNameOptions field.
		toNeonBranchName("x", { unknown: 1 });
	});
});
