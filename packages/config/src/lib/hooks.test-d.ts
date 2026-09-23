import { describe, expectTypeOf, test } from "vitest";
import { defineConfig } from "./define-config.js";
import type {
	CheckoutAfterContext,
	CheckoutBeforeContext,
	CheckoutBeforeResult,
	CheckoutEvent,
	CreateAfterContext,
	CreateBeforeContext,
	DeployAfterContext,
	DeployBeforeContext,
	DeployEvent,
	GitContext,
	HookBranch,
	HookEnv,
	Hooks,
	PushResult,
	ShellHook,
} from "./types.js";

// Type-level tests for the lifecycle-hooks surface. Run via
// `pnpm --filter @neon/config test:types` (Vitest typecheck mode) and additionally
// enforced by `tsc --noEmit` during the build (this file lives under `src`).

describe("GitContext shape", () => {
	test("required facts are booleans; optional facts are `string | undefined`", () => {
		expectTypeOf<GitContext["available"]>().toEqualTypeOf<boolean>();
		expectTypeOf<GitContext["isDetached"]>().toEqualTypeOf<boolean>();
		expectTypeOf<GitContext["isDirty"]>().toEqualTypeOf<boolean>();
		expectTypeOf<GitContext["branch"]>().toEqualTypeOf<
			string | undefined
		>();
		expectTypeOf<GitContext["neonSafeBranchName"]>().toEqualTypeOf<
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

describe("CheckoutEvent / DeployEvent shape", () => {
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

describe("HookEnv shape", () => {
	test("postgres is required; every other namespace is optional", () => {
		expectTypeOf<HookEnv["postgres"]>().toEqualTypeOf<{
			databaseUrl: string;
			databaseUrlUnpooled: string;
		}>();
		expectTypeOf<HookEnv["auth"]>().toEqualTypeOf<
			{ baseUrl: string; jwksUrl: string } | undefined
		>();
		expectTypeOf<HookEnv["dataApi"]>().toEqualTypeOf<
			{ url: string } | undefined
		>();
	});
});

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

	test("checkout.after sees branch + env (HookEnv) + git + event", () => {
		expectTypeOf<
			CheckoutAfterContext["branch"]
		>().toEqualTypeOf<HookBranch>();
		expectTypeOf<CheckoutAfterContext["env"]>().toEqualTypeOf<HookEnv>();
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

	test("create.after sees branch + env (HookEnv) + git + event", () => {
		expectTypeOf<
			CreateAfterContext["branch"]
		>().toEqualTypeOf<HookBranch>();
		expectTypeOf<CreateAfterContext["env"]>().toEqualTypeOf<HookEnv>();
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

	test("deploy.after sees branch + env (HookEnv) + result (PushResult) + git + event", () => {
		expectTypeOf<
			DeployAfterContext["branch"]
		>().toEqualTypeOf<HookBranch>();
		expectTypeOf<DeployAfterContext["env"]>().toEqualTypeOf<HookEnv>();
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
							expectTypeOf(ctx.env).toEqualTypeOf<HookEnv>();
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
							expectTypeOf(
								ctx.event.inputName,
							).toEqualTypeOf<undefined>();
							expectTypeOf(
								ctx.event.gitBranch,
							).toEqualTypeOf<string>();
						},
						after: async (ctx) => {
							expectTypeOf(ctx.env).toEqualTypeOf<HookEnv>();
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
							expectTypeOf(ctx.env).toEqualTypeOf<HookEnv>();
							expectTypeOf(
								ctx.event,
							).toEqualTypeOf<DeployEvent>();
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
			git: { available: false, isDetached: false, isDirty: false },
		};
		// @ts-expect-error before-checkout context exposes no `branch`.
		ctx.branch;
	});
});
