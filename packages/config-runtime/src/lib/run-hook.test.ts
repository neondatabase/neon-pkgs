import { describe, expect, test } from "vitest";
import { HookExecutionError, runHook, runShellHook } from "./run-hook.js";

describe("runHook (function form)", () => {
	test("returns undefined when no hook is configured", async () => {
		expect(await runHook(undefined, { x: 1 })).toBeUndefined();
	});

	test("awaits and returns a function hook's value", async () => {
		const result = await runHook(
			async (ctx: { inputName: string }) => ({
				name: `preview/${ctx.inputName}`,
			}),
			{ inputName: "dev-1" },
		);
		expect(result).toEqual({ name: "preview/dev-1" });
	});

	test("propagates a thrown error from a function hook (abort)", async () => {
		await expect(
			runHook(() => {
				throw new Error("nope");
			}, {}),
		).rejects.toThrow("nope");
	});
});

describe("runHook (shell form)", () => {
	test("runs a single command and streams output", async () => {
		const chunks: string[] = [];
		const result = await runHook("echo hello-from-hook", undefined, {
			onOutput: (c) => chunks.push(c),
		});
		expect(result).toBeUndefined();
		expect(chunks.join("")).toContain("hello-from-hook");
	});

	test("runs an array of commands sequentially", async () => {
		const chunks: string[] = [];
		await runHook(["echo one", "echo two"], undefined, {
			onOutput: (c) => chunks.push(c),
		});
		const out = chunks.join("");
		expect(out).toContain("one");
		expect(out).toContain("two");
		expect(out.indexOf("one")).toBeLessThan(out.indexOf("two"));
	});

	test("injects env vars into the command", async () => {
		const chunks: string[] = [];
		await runHook("echo url=$DATABASE_URL", undefined, {
			env: { DATABASE_URL: "postgres://example/neondb" },
			onOutput: (c) => chunks.push(c),
		});
		expect(chunks.join("")).toContain("url=postgres://example/neondb");
	});

	test("forces CI=1 so tools run non-interactively", async () => {
		const chunks: string[] = [];
		await runShellHook("echo ci=$CI", {
			onOutput: (c) => chunks.push(c),
		});
		expect(chunks.join("")).toContain("ci=1");
	});

	test("throws HookExecutionError with the command + exit code on non-zero exit", async () => {
		let caught: unknown;
		try {
			await runShellHook("exit 7");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(HookExecutionError);
		if (!(caught instanceof HookExecutionError))
			throw new Error("unreachable");
		expect(caught.command).toBe("exit 7");
		expect(caught.exitCode).toBe(7);
	});

	test("stops the chain at the first failing command", async () => {
		const chunks: string[] = [];
		await expect(
			runShellHook(["echo first", "exit 3", "echo third"], {
				onOutput: (c) => chunks.push(c),
			}),
		).rejects.toBeInstanceOf(HookExecutionError);
		const out = chunks.join("");
		expect(out).toContain("first");
		expect(out).not.toContain("third");
	});

	test("does not inherit stdin (commands cannot block on input)", async () => {
		// `read` from stdin would hang forever if stdin were a TTY/pipe; with stdin
		// set to "ignore" it sees EOF immediately and the command completes.
		await expect(
			runShellHook("read line; echo got=$line"),
		).resolves.toBeUndefined();
	});
});
