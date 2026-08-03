import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { enrichFromContext, isApiKeysCommand } from "../context.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

/** A `.neon` pinning both an org and a project, the state a linked directory is in. */
function contextFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "neon-apikeys-ctx-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const file = resolve(dir, ".neon");
	writeFileSync(
		file,
		JSON.stringify({
			orgId: "org-pinned-11111111",
			projectId: "pinned-project-22222222",
			branch: "main",
		}),
	);
	return file;
}

const argsFor = (command: string[], file: string) =>
	({ _: command, contextFile: file }) as never as Parameters<
		typeof enrichFromContext
	>[0];

const read = (args: unknown) => args as Record<string, unknown>;

describe("isApiKeysCommand", () => {
	test("matches both spellings and nothing else", () => {
		expect(isApiKeysCommand({ _: ["api-keys", "create"] })).toBe(true);
		expect(isApiKeysCommand({ _: ["api-key", "list"] })).toBe(true);
		expect(isApiKeysCommand({ _: ["api", "/projects"] })).toBe(false);
		expect(isApiKeysCommand({ _: ["projects", "list"] })).toBe(false);
	});
});

/**
 * The load-bearing guarantee of this command group: how far a minted credential reaches must
 * come from a flag the user typed, never from whichever project happens to be checked out.
 * Enriched, `api-keys create --name ci` in a linked directory would arrive with `projectId`
 * already set and silently mint a project-scoped key instead of the account key asked for.
 *
 * Paired with a control, so the test fails if enrichment simply stops working everywhere.
 */
describe("api-keys is exempt from .neon enrichment", () => {
	test("control: another command IS enriched from the same file", () => {
		const file = contextFile();
		const args = argsFor(["projects", "list"], file);
		enrichFromContext(args);
		expect(read(args).orgId).toBe("org-pinned-11111111");
		expect(read(args).projectId).toBe("pinned-project-22222222");
	});

	test("api-keys sees neither orgId nor projectId", () => {
		const file = contextFile();
		const args = argsFor(["api-keys", "create"], file);
		enrichFromContext(args);
		expect(read(args).orgId).toBeUndefined();
		expect(read(args).projectId).toBeUndefined();
	});

	test("the api-key alias is exempt too", () => {
		const file = contextFile();
		const args = argsFor(["api-key", "create"], file);
		enrichFromContext(args);
		expect(read(args).orgId).toBeUndefined();
		expect(read(args).projectId).toBeUndefined();
	});
});
