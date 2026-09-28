import { describe, expect, test } from "vitest";
import { HookExecutionError, runHook, runShellHook } from "./run-hook.js";

describe("runHook", () => {
	test("runs a function hook and returns its result", async () => {
		const result = await runHook(
			(ctx: { inputName: string }) => ({
				name: `preview/${ctx.inputName}`,
			}),
			{ inputName: "dev-1" },
		);
		expect(result).toEqual({ name: "preview/dev-1" });
	});

	test("awaits an async function hook", async () => {
		const result = await runHook(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			return 42;
		}, undefined);
		expect(result).toBe(42);
	});

	test("returns undefined for an undefined hook", async () => {
		expect(await runHook(undefined, {})).toBeUndefined();
	});

	test("propagates a thrown error from a function hook", async () => {
		await expect(
			runHook(() => {
				throw new Error("nope");
			}, undefined),
		).rejects.toThrow("nope");
	});

	test("runs a shell-command hook (string) and returns undefined", async () => {
		const result = await runHook("exit 0", undefined);
		expect(result).toBeUndefined();
	});

	test("runs a shell-command hook (sequential array) in order", async () => {
		const chunks: string[] = [];
		await runHook(["echo one", "echo two"], undefined, {
			onOutput: (chunk) => chunks.push(chunk.trim()),
		});
		expect(chunks.join("")).toContain("one");
		expect(chunks.join("")).toContain("two");
	});

	test("injects extra env vars into a shell-command hook", async () => {
		const chunks: string[] = [];
		await runHook("echo $HOOK_TEST_VAR", undefined, {
			env: { HOOK_TEST_VAR: "hello" },
			onOutput: (chunk) => chunks.push(chunk.trim()),
		});
		expect(chunks.join("")).toContain("hello");
	});

	test("throws HookExecutionError on a non-zero exit", async () => {
		await expect(runHook("exit 3", undefined)).rejects.toThrow(
			HookExecutionError,
		);
	});

	test("forces CI=1 and detaches stdin (non-interactive)", async () => {
		const chunks: string[] = [];
		await runHook("echo $CI", undefined, {
			onOutput: (chunk) => chunks.push(chunk.trim()),
		});
		expect(chunks.join("")).toBe("1");
	});
});

describe("runShellHook", () => {
	test("stops the sequence on the first failing command", async () => {
		const chunks: string[] = [];
		await expect(
			runShellHook(["echo first", "exit 1", "echo never"], {
				onOutput: (chunk) => chunks.push(chunk.trim()),
			}),
		).rejects.toThrow(HookExecutionError);
		expect(chunks.join("")).not.toContain("never");
	});
});
