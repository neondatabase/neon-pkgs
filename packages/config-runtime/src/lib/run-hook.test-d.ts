import { describe, expectTypeOf, test } from "vitest";
import { type RunHookOptions, runHook, runShellHook } from "./run-hook.js";

// Type-level tests for the hook runner's generic return typing. Run via
// `pnpm --filter @neondatabase/config-runtime test:types` and enforced by `tsc --noEmit`
// during the build (this file lives under `src`).

describe("runHook return typing", () => {
	test("a function hook resolves to `Result | undefined`, inferred from the function", () => {
		const fn = (ctx: { inputName: string }): { name: string } => ({
			name: ctx.inputName,
		});
		expectTypeOf(runHook(fn, { inputName: "x" })).toEqualTypeOf<
			Promise<{ name: string } | undefined>
		>();
	});

	test("an async function hook unwraps its awaited result", () => {
		const fn = async (): Promise<number> => 1;
		expectTypeOf(runHook(fn, undefined)).toEqualTypeOf<
			Promise<number | undefined>
		>();
	});

	test("an absent hook (undefined) still resolves to `Result | undefined`", () => {
		expectTypeOf(
			runHook<{ inputName: string }, { name: string }>(undefined, {
				inputName: "x",
			}),
		).toEqualTypeOf<Promise<{ name: string } | undefined>>();
	});

	test("a shell-command hook has no typed return channel (resolves to unknown)", () => {
		// A bare string carries no `Result`, so the generic resolves to `unknown`
		// (`unknown | undefined` collapses to `unknown`).
		expectTypeOf(runHook("drizzle-kit migrate", undefined)).toEqualTypeOf<
			Promise<unknown>
		>();
	});
});

describe("runShellHook typing", () => {
	test("accepts a string or string[] and resolves to void", () => {
		expectTypeOf(runShellHook("echo hi")).toEqualTypeOf<Promise<void>>();
		expectTypeOf(runShellHook(["a", "b"])).toEqualTypeOf<Promise<void>>();
	});

	test("a non-shell value is rejected", () => {
		// @ts-expect-error a ShellHook is a string or string[] — not a number.
		runShellHook(42);
	});
});

describe("RunHookOptions shape", () => {
	test("env values allow `string | undefined` (so unset keys can be passed through)", () => {
		expectTypeOf<NonNullable<RunHookOptions["env"]>>().toEqualTypeOf<
			Record<string, string | undefined>
		>();
		expectTypeOf<RunHookOptions["cwd"]>().toEqualTypeOf<
			string | undefined
		>();
	});
});
