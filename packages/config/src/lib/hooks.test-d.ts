import { describe, expectTypeOf, test } from "vitest";
import { neonSafeBranchName } from "./branch-name.js";
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
	CheckoutEvent,
	Config,
	CreateAfterContext,
	CreateBeforeContext,
	DeployAfterContext,
	DeployBeforeContext,
	DeployEvent,
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
		// @ts-expect-error triggeredByGitHook moved to `event.type` on each hook context.
		expectTypeOf<GitContext["triggeredByGitHook"]>();
	});
});

describe("CheckoutEvent / DeployEvent shape", () => {
	test("CheckoutEvent narrows event.inputName by event.type", () => {
		expectTypeOf<CheckoutEvent>().toEqualTypeOf<
			| { type: "git-checkout"; gitBranch: string; inputName?: undefined }
			| { type: "neon-checkout"; inputName?: string }
		>();
	});

	test("narrowed to git-checkout: inputName is undefined, gitBranch is a string", () => {
		type GitCheckout = Extract<CheckoutEvent, { type: "git-checkout" }>;
		expectTypeOf<GitCheckout["inputName"]>().toEqualTypeOf<undefined>();
		expectTypeOf<GitCheckout["gitBranch"]>().toEqualTypeOf<string>();
	});

	test("narrowed to neon-checkout: inputName is string | undefined, no gitBranch", () => {
		type NeonCheckout = Extract<CheckoutEvent, { type: "neon-checkout" }>;
		expectTypeOf<NeonCheckout["inputName"]>().toEqualTypeOf<
			string | undefined
		>();
		// @ts-expect-error a neon-checkout event carries no gitBranch.
		expectTypeOf<NeonCheckout["gitBranch"]>();
	});

	test("DeployEvent is currently a single-member union (deploy is never git-triggered)", () => {
		expectTypeOf<DeployEvent>().toEqualTypeOf<{ type: "neon-deploy" }>();
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
	test("checkout.before sees event + git (no branch/env)", () => {
		expectTypeOf<
			CheckoutBeforeContext["event"]
		>().toEqualTypeOf<CheckoutEvent>();
		expectTypeOf<
			CheckoutBeforeContext["git"]
		>().toEqualTypeOf<GitContext>();
		// @ts-expect-error checkout.before runs before resolution — there is no `branch`.
		expectTypeOf<CheckoutBeforeContext["branch"]>();
		// @ts-expect-error checkout.before runs before env is pulled — there is no `env`.
		expectTypeOf<CheckoutBeforeContext["env"]>();
	});

	test("checkout.after sees branch + env (NeonEnv<C>) + git + event", () => {
		expectTypeOf<
			CheckoutAfterContext["branch"]
		>().toEqualTypeOf<HookBranch>();
		expectTypeOf<CheckoutAfterContext["env"]>().toEqualTypeOf<
			NeonEnv<Config>
		>();
		expectTypeOf<CheckoutAfterContext["git"]>().toEqualTypeOf<GitContext>();
		expectTypeOf<
			CheckoutAfterContext["event"]
		>().toEqualTypeOf<CheckoutEvent>();
	});

	test("create.before sees the branch name + git + triggering event (no branch/env — cannot rename)", () => {
		expectTypeOf<
			CreateBeforeContext["branchName"]
		>().toEqualTypeOf<string>();
		expectTypeOf<CreateBeforeContext["git"]>().toEqualTypeOf<GitContext>();
		expectTypeOf<
			CreateBeforeContext["event"]
		>().toEqualTypeOf<CheckoutEvent>();
		// @ts-expect-error create.before runs before creation — there is no `branch`.
		expectTypeOf<CreateBeforeContext["branch"]>();
		// @ts-expect-error create.before runs before env is pulled — there is no `env`.
		expectTypeOf<CreateBeforeContext["env"]>();
	});

	test("create.after sees branch + env (NeonEnv<C>) + git + event", () => {
		expectTypeOf<
			CreateAfterContext["branch"]
		>().toEqualTypeOf<HookBranch>();
		expectTypeOf<CreateAfterContext["env"]>().toEqualTypeOf<
			NeonEnv<Config>
		>();
		expectTypeOf<CreateAfterContext["git"]>().toEqualTypeOf<GitContext>();
		expectTypeOf<
			CreateAfterContext["event"]
		>().toEqualTypeOf<CheckoutEvent>();
	});

	test("deploy.before sees branch + git + event but no env", () => {
		expectTypeOf<
			DeployBeforeContext["branch"]
		>().toEqualTypeOf<HookBranch>();
		expectTypeOf<DeployBeforeContext["git"]>().toEqualTypeOf<GitContext>();
		expectTypeOf<
			DeployBeforeContext["event"]
		>().toEqualTypeOf<DeployEvent>();
		// @ts-expect-error deploy.before runs before env is pulled — there is no `env`.
		expectTypeOf<DeployBeforeContext["env"]>();
	});

	test("deploy.after sees branch + env (NeonEnv<C>) + result (PushResult) + git + event", () => {
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
		expectTypeOf<
			DeployAfterContext["event"]
		>().toEqualTypeOf<DeployEvent>();
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

describe("defineConfig experimental.hooks — positive (every valid form type-checks)", () => {
	test("function-form create hooks; context (incl. event) is inferred", () => {
		defineConfig({
			experimental: {
				hooks: {
					create: {
						before: (ctx) => {
							expectTypeOf(
								ctx,
							).toEqualTypeOf<CreateBeforeContext>();
							expectTypeOf(
								ctx.branchName,
							).toEqualTypeOf<string>();
							expectTypeOf(
								ctx.event,
							).toEqualTypeOf<CheckoutEvent>();
						},
						after: async (ctx) => {
							expectTypeOf<keyof typeof ctx.env>().toEqualTypeOf<
								"postgres" | "branch"
							>();
							expectTypeOf(
								ctx.branch.created,
							).toEqualTypeOf<boolean>();
						},
					},
				},
			},
		});
	});

	test("function-form checkout hooks; event.type discriminates event.inputName", () => {
		defineConfig({
			experimental: {
				hooks: {
					checkout: {
						before: (ctx) => {
							expectTypeOf(
								ctx,
							).toEqualTypeOf<CheckoutBeforeContext>();
							if (ctx.event.type === "neon-checkout") {
								expectTypeOf(ctx.event.inputName).toEqualTypeOf<
									string | undefined
								>();
								return {
									name: `preview/${ctx.event.inputName}`,
								};
							}
							// Narrowed to the git-checkout member: inputName is undefined,
							// and `event.gitBranch` is available to derive a name from.
							expectTypeOf(
								ctx.event.inputName,
							).toEqualTypeOf<undefined>();
							expectTypeOf(
								ctx.event.gitBranch,
							).toEqualTypeOf<string>();
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
							expectTypeOf(
								ctx.event,
							).toEqualTypeOf<CheckoutEvent>();
						},
					},
					deploy: {
						before: (ctx) => {
							expectTypeOf(ctx.branch.id).toEqualTypeOf<string>();
							expectTypeOf(
								ctx.event,
							).toEqualTypeOf<DeployEvent>();
						},
						after: async (ctx) => {
							expectTypeOf(
								ctx.result,
							).toEqualTypeOf<PushResult>();
							expectTypeOf<keyof typeof ctx.env>().toEqualTypeOf<
								"postgres" | "branch"
							>();
							expectTypeOf(
								ctx.event,
							).toEqualTypeOf<DeployEvent>();
						},
					},
				},
			},
		});
	});

	test("the after-hook `env` reflects the policy: `auth: true` ⇒ `env.auth` is present + typed", () => {
		defineConfig({
			auth: true,
			experimental: {
				hooks: {
					checkout: {
						after: (ctx) => {
							expectTypeOf(
								ctx.env.auth,
							).toEqualTypeOf<NeonAuthEnv>();
							expectTypeOf(
								ctx.env.postgres.databaseUrl,
							).toEqualTypeOf<string>();
						},
					},
					deploy: {
						after: (ctx) => {
							expectTypeOf(
								ctx.env.auth,
							).toEqualTypeOf<NeonAuthEnv>();
						},
					},
				},
			},
		});
	});

	test("the after-hook `env` omits namespaces the policy doesn't enable", () => {
		defineConfig({
			experimental: {
				hooks: {
					checkout: {
						after: (ctx) => {
							// @ts-expect-error no `auth` in the policy ⇒ no `env.auth`.
							ctx.env.auth;
						},
					},
				},
			},
		});
	});

	test("a `before` hook may return nothing (void) or a rename", () => {
		defineConfig({
			experimental: {
				hooks: {
					checkout: {
						before: () => {
							/* validate / abort by throwing; return nothing */
						},
					},
				},
			},
		});
	});

	test("shell-command hooks: string and array", () => {
		defineConfig({
			experimental: {
				hooks: {
					checkout: { after: "npm run db:migrate" },
					create: { after: "npm run db:seed" },
					deploy: { after: ["npm run build", "npm run db:migrate"] },
				},
			},
		});
	});

	test("hooks survive onto the returned Config, under `experimental`", () => {
		const config = defineConfig({
			experimental: { hooks: { deploy: { after: "x" } } },
		});
		expectTypeOf(config.experimental?.hooks).toEqualTypeOf<
			Hooks | undefined
		>();
	});
});

describe("defineConfig experimental.hooks — negative (@ts-expect-error)", () => {
	test("an unknown hook phase is rejected", () => {
		// @ts-expect-error `dev` is not a hook phase.
		defineConfig({ experimental: { hooks: { dev: { after: "x" } } } });
	});

	test("an unknown key inside a phase is rejected", () => {
		defineConfig({
			experimental: {
				// @ts-expect-error `during` is not a phase key (before/after only).
				hooks: { checkout: { during: "x" } },
			},
		});
	});

	test("an unknown key inside experimental is rejected", () => {
		// @ts-expect-error `dev` is not an experimental feature.
		defineConfig({ experimental: { dev: "x" } });
	});

	test("a non-function / non-shell hook value is rejected", () => {
		// @ts-expect-error 42 is neither a function nor a shell command.
		defineConfig({ experimental: { hooks: { deploy: { after: 42 } } } });
	});

	test("a checkout.before returning a wrong-typed name is rejected", () => {
		defineConfig({
			experimental: {
				hooks: {
					checkout: {
						// @ts-expect-error `name` must be a string.
						before: () => ({ name: 123 }),
					},
				},
			},
		});
	});

	test("create.before cannot return a rename — only checkout.before can", () => {
		defineConfig({
			experimental: {
				hooks: {
					create: {
						// @ts-expect-error create.before's return type is `void`, not a rename result.
						before: () => ({ name: "renamed" }),
					},
				},
			},
		});
	});

	test("reading a field absent from a phase context is a type error", () => {
		const ctx: CheckoutBeforeContext = {
			event: { type: "neon-checkout", inputName: "x" },
			git: {
				available: false,
				isDetached: false,
				isDirty: false,
			},
		};
		// @ts-expect-error before-checkout context exposes no `branch`.
		ctx.branch;
	});

	test("a git-checkout event cannot carry a gitBranch-less shape (type required)", () => {
		// @ts-expect-error a git-checkout event requires `gitBranch`.
		const event: CheckoutEvent = { type: "git-checkout" };
		void event;
	});
});

describe("neonSafeBranchName (types)", () => {
	test("returns a string", () => {
		expectTypeOf(neonSafeBranchName("x")).toEqualTypeOf<string>();
	});

	test("options are accepted (positive)", () => {
		neonSafeBranchName("x", {
			prefix: "preview/",
			maxLength: 64,
			lowercase: true,
			preserveSlashes: false,
		});
	});

	test("an unknown option is rejected", () => {
		// @ts-expect-error `unknown` is not a NeonSafeBranchNameOptions field.
		neonSafeBranchName("x", { unknown: 1 });
	});
});
