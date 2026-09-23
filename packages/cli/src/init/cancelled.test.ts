import { describe, expect, test } from "vitest";
import { InitCancelled, raceSigint } from "./cancelled.js";

const microtask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("raceSigint", () => {
	test("resolves with the work's value when no signal arrives", async () => {
		await expect(raceSigint(Promise.resolve("done"))).resolves.toBe("done");
	});

	test("rejects with the work's error when no signal arrives", async () => {
		await expect(
			raceSigint(Promise.reject(new Error("boom"))),
		).rejects.toThrow("boom");
	});

	test("rejects with InitCancelled on SIGINT while work is still pending", async () => {
		let resolveWork: (() => void) | undefined;
		const work = new Promise<void>((resolve) => {
			resolveWork = resolve;
		});
		const raced = raceSigint(work);
		await microtask();
		process.emit("SIGINT");
		await expect(raced).rejects.toBeInstanceOf(InitCancelled);
		// The lost work promise settling afterward must not throw an unhandled rejection.
		resolveWork?.();
	});

	test("removes its SIGINT listener once work settles", async () => {
		const before = process.listenerCount("SIGINT");
		await expect(raceSigint(Promise.resolve("done"))).resolves.toBe("done");
		expect(process.listenerCount("SIGINT")).toBe(before);
	});

	test("removes its SIGINT listener after winning the race", async () => {
		const before = process.listenerCount("SIGINT");
		const work = new Promise<void>(() => {});
		const raced = raceSigint(work);
		await microtask();
		process.emit("SIGINT");
		await expect(raced).rejects.toBeInstanceOf(InitCancelled);
		expect(process.listenerCount("SIGINT")).toBe(before);
	});
});
