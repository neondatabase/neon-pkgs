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

	// Locks the layout: metadata in the table, the secret alone on the line below, where it
	// can be selected in one gesture no matter how narrow the terminal is.
	test("table output puts the secret on its own line", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"api-keys",
				"create",
				"--name",
				"agent",
				"--project-id",
				"proj-in-org",
			],
			{ outputTable: true },
		);
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
				stderr: "ERROR: --project-id needs a value. Pass one, or omit the flag entirely.",
			},
		);
	});

	test("refuses an empty --org-id", async ({ testCliCommand }) => {
		await testCliCommand(
			["api-keys", "create", "--name", "x", "--org-id", ""],
			{
				code: 1,
				stderr: "ERROR: --org-id needs a value. Pass one, or omit the flag entirely.",
			},
		);
	});

	test("refuses an empty --name", async ({ testCliCommand }) => {
		await testCliCommand(["api-keys", "create", "--name", ""], {
			code: 1,
			stderr: "ERROR: --name needs a value.",
		});
	});

	// A misspelled flag never binds, so the scope check would see it as absent and mint an
	// account key from a command line that looks like it asked for a scoped one.
	test("refuses a misspelled scope flag rather than widening the key", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"api-keys",
				"create",
				"--name",
				"x",
				"--project_id",
				"proj-in-org",
			],
			{ code: 1, stderr: "ERROR: Unknown argument: project_id" },
		);
	});

	// yargs turns `--no-x` into `false`, which is falsy — so without the guard this reads as
	// "no project given" and mints an account key from a command line that names the flag.
	test("refuses --no-project-id rather than widening the key", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["api-keys", "create", "--name", "x", "--no-project-id"],
			{
				code: 1,
				stderr: "ERROR: --no-project-id is not a valid way to skip --project-id. Omit the flag entirely.",
			},
		);
	});

	// After `--` the rest is positional, not options — so the scope flag would be ignored.
	// These subcommands take no passthrough, so the extra arguments are an error.
	test("refuses scope flags after a -- terminator", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"api-keys",
				"create",
				"--name",
				"x",
				"--",
				"--project-id",
				"proj-in-org",
			],
			{
				code: 1,
				stderr: expect.stringContaining(
					"api-keys takes no arguments after `--`",
				),
			},
		);
	});

	// Passed twice, yargs yields an array — not a string, so the emptiness check would skip
	// it and the value would reach the API as `a,b`.
	test("refuses a repeated scope flag", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"api-keys",
				"create",
				"--name",
				"x",
				"--project-id",
				"proj-in-org",
				"--project-id",
				"test",
			],
			{
				code: 1,
				stderr: "ERROR: --project-id was given more than once. Pass it at most once.",
			},
		);
	});
});

/**
 * A 2xx is not proof the key is what was asked for. These drive the mock to return
 * responses that are individually plausible and collectively unusable, and assert the CLI
 * withdraws the key and prints no secret.
 */
describe("api-keys create refuses an unusable response", () => {
	test("scoped to the wrong project — withdrawn, and says so", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"api-keys",
				"create",
				"--name",
				"mismatch",
				"--project-id",
				"proj-in-org",
			],
			{
				code: 1,
				stderr: "ERROR: Neon returned a key scoped to some-other-project rather than proj-in-org. The key has been revoked; nothing was issued.",
			},
		);
	});

	// The withdrawal itself fails here, so the message must not claim the key is gone.
	test("not scoped at all, and the withdrawal fails", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"api-keys",
				"create",
				"--name",
				"noscope",
				"--project-id",
				"proj-in-org",
			],
			{
				code: 1,
				stderr: expect.stringContaining(
					"The key could NOT be revoked and may still be live — remove it with `neon api-keys revoke 500 --org-id org-7`",
				),
			},
		);
	});

	// The whole point of refusing is that the secret never reaches the user, so assert its
	// absence directly rather than inferring it from the error text.
	test("prints no secret when it refuses", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"api-keys",
				"create",
				"--name",
				"noscope",
				"--project-id",
				"proj-in-org",
			],
			{
				code: 1,
				stderr: expect.not.stringContaining("napi_no_scope"),
			},
		);
	});

	// A narrower key than asked for is still the wrong key: reporting it as reaching the
	// whole organization would overstate what the caller can do with it.
	test("an org-wide create that comes back scoped is refused", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["api-keys", "create", "--name", "sneaky", "--org-id", "org-7"],
			{
				code: 1,
				stderr: expect.stringContaining(
					"Neon returned a key scoped to some-other-project rather than the whole organization",
				),
			},
		);
	});

	test("no key in the body", async ({ testCliCommand }) => {
		await testCliCommand(
			["api-keys", "create", "--name", "nokey", "--org-id", "org-7"],
			{
				code: 1,
				stderr: "ERROR: Neon returned no key. The key has been revoked; nothing was issued.",
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

	test("refuses a non-numeric id instead of sending NaN", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["api-keys", "revoke", "abc"], {
			code: 1,
			stderr: expect.stringContaining(
				"api-keys revoke needs a numeric key id",
			),
		});
	});

	test("refuses an empty --org-id rather than hitting the account endpoint", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["api-keys", "revoke", "999", "--org-id", ""], {
			code: 1,
			stderr: "ERROR: --org-id needs a value. Pass one, or omit the flag entirely.",
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
