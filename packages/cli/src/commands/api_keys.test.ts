import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, describe as vitestDescribe } from "vitest";
import { enrichFromContext, isApiKeysCommand } from "../context.js";
import { test } from "../test_utils/fixtures";

const describe = vitestDescribe;

describe("api-keys list", () => {
	test("account keys", async ({ testCliCommand }) => {
		await testCliCommand(["api-keys", "list"]);
	});

	test("org keys carry the project each is scoped to", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["api-keys", "list", "--org-id", "org-7"]);
	});

	// `writeTable` drops columns empty in every row, so the scope column has to be filled
	// in for the table. Structured output must NOT gain that synthetic field.
	test("table output names the unscoped rows", async ({ testCliCommand }) => {
		await testCliCommand(["api-keys", "list", "--org-id", "org-7"], {
			outputTable: true,
		});
	});

	test("json output keeps the raw API shape", async ({ testCliCommand }) => {
		await testCliCommand(["api-keys", "list", "--org-id", "org-7"], {
			output: "json",
		});
	});
});

describe("api-keys create", () => {
	test("account key when no scope is given", async ({ testCliCommand }) => {
		await testCliCommand(["api-keys", "create", "--name", "ci"]);
	});

	test("org key with --org-id", async ({ testCliCommand }) => {
		await testCliCommand([
			"api-keys",
			"create",
			"--name",
			"ci",
			"--org-id",
			"org-7",
		]);
	});

	// The org is looked up from the project rather than supplied, so this also covers
	// `GET /projects/proj-in-org` returning `org_id: org-7`.
	test("project-scoped key infers the org from the project", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"api-keys",
			"create",
			"--name",
			"agent",
			"--project-id",
			"proj-in-org",
		]);
	});

	test("refuses both scope flags together", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"api-keys",
				"create",
				"--name",
				"x",
				"--org-id",
				"org-7",
				"--project-id",
				"proj-in-org",
			],
			{
				code: 1,
				stderr: "ERROR: Arguments org-id and project-id are mutually exclusive",
			},
		);
	});

	// `--project-id "$UNSET"` arrives as an empty string, which is falsy — without the
	// guard this would quietly mint an ACCOUNT key instead of the scoped one asked for.
	test("refuses an empty --project-id instead of widening the key", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["api-keys", "create", "--name", "x", "--project-id", ""],
			{
				code: 1,
				stderr: "ERROR: --project-id was given an empty value. Pass a real value, or omit the flag entirely.",
			},
		);
	});

	test("refuses an empty --org-id", async ({ testCliCommand }) => {
		await testCliCommand(
			["api-keys", "create", "--name", "x", "--org-id", ""],
			{
				code: 1,
				stderr: "ERROR: --org-id was given an empty value. Pass a real value, or omit the flag entirely.",
			},
		);
	});

	// A project outside an organization cannot have a scoped key at all: the endpoint that
	// accepts `project_id` is org-only. Fail with that reason, not a bare 404.
	test("explains a project that belongs to no organization", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["api-keys", "create", "--name", "x", "--project-id", "test"],
			{
				code: 1,
				stderr: "ERROR: Project test does not belong to an organization, so it cannot have a project-scoped API key. Create an account key by omitting --project-id.",
			},
		);
	});
});

describe("api-keys revoke", () => {
	test("account key", async ({ testCliCommand }) => {
		await testCliCommand(["api-keys", "revoke", "999"]);
	});

	test("org key", async ({ testCliCommand }) => {
		await testCliCommand([
			"api-keys",
			"revoke",
			"888",
			"--org-id",
			"org-7",
		]);
	});

	test("refuses an empty --org-id rather than hitting the account endpoint", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["api-keys", "revoke", "999", "--org-id", ""], {
			code: 1,
			stderr: "ERROR: --org-id was given an empty value. Pass a real value, or omit the flag entirely.",
		});
	});
});

// ── Context isolation ────────────────────────────────────────────────────────

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

/** A `.neon` pinning both an org and a project — the state a linked directory is in. */
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
 * How far a minted credential reaches must come from a flag the user typed, never from
 * whichever project happens to be checked out. Enriched, `api-keys create --name ci` in a
 * linked directory would arrive with `projectId` already set and silently produce a scoped
 * key. Paired with a control, so this fails if enrichment stops working everywhere rather
 * than just here.
 */
describe("api-keys is exempt from .neon enrichment", () => {
	test("control: another command IS enriched from the same file", () => {
		const args = argsFor(["projects", "list"], contextFile());
		enrichFromContext(args);
		expect(read(args).orgId).toBe("org-pinned-11111111");
		expect(read(args).projectId).toBe("pinned-project-22222222");
	});

	test("api-keys sees neither orgId nor projectId", () => {
		const args = argsFor(["api-keys", "create"], contextFile());
		enrichFromContext(args);
		expect(read(args).orgId).toBeUndefined();
		expect(read(args).projectId).toBeUndefined();
	});

	test("the api-key alias is exempt too", () => {
		const args = argsFor(["api-key", "create"], contextFile());
		enrichFromContext(args);
		expect(read(args).orgId).toBeUndefined();
		expect(read(args).projectId).toBeUndefined();
	});
});
