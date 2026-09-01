import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { test } from "../test_utils/fixtures";
import {
	devBundleDir,
	diffUnits,
	formatEnvSummary,
	localFunctionUrlEnv,
	planFunctionsToUnits,
	type RunningUnit,
	type ServedUnit,
} from "./dev.js";

describe("dev", () => {
	test("exits 1 when no --source and no neon.ts is found", async ({
		testCliCommand,
	}) => {
		// Runs in the repo root, which has no neon.ts: nothing to serve.
		await testCliCommand(["dev"], {
			code: 1,
			stderr:
				"ERROR: No --source given and no neon.ts found. Pass --source <path> " +
				"to run a single function, or add a neon.ts that declares functions " +
				"under `preview.functions`.",
		});
	});

	test("exits 1 when --port is given without --source", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["dev", "--port", "3000"], {
			code: 1,
			stderr:
				"ERROR: --port can only be used with --source. To set ports for the " +
				"functions in neon.ts, give each one a `dev.port` in its config.",
		});
	});

	test("exits 1 when --source points at a file that does not exist", async ({
		testCliCommand,
	}) => {
		const missing = join(process.cwd(), "does-not-exist.ts");
		await testCliCommand(["dev", "--source", missing], { code: 1 });
	});
});

/**
 * `neon dev` leaves a function's `nativePackages` unbundled and does not copy anything, so
 * the bundle must sit somewhere Node's resolver can reach the project's real `node_modules`
 * from. It does today only because the bundle is written *inside* that directory. These pin
 * the property, because moving the directory would break local dev for native dependencies
 * with a `Cannot find module` and nothing else would catch it.
 */
describe("devBundleDir", () => {
	it("puts the bundle inside the project's node_modules", () => {
		expect(devBundleDir("/proj", "resize")).toBe(
			join("/proj", "node_modules", ".neon-dev", "resize"),
		);
		expect(devBundleDir("/proj")).toBe(
			join("/proj", "node_modules", ".neon-dev"),
		);
	});

	it("is a location an unbundled import actually resolves from", () => {
		const cwd = mkdtempSync(join(tmpdir(), "neonctl-dev-resolve-"));
		try {
			// A package only reachable by walking up into the project's node_modules — which
			// is exactly how an unbundled nativePackages entry is reached locally.
			const pkg = join(cwd, "node_modules", "only-in-project");
			mkdirSync(pkg, { recursive: true });
			writeFileSync(
				join(pkg, "package.json"),
				JSON.stringify({ name: "only-in-project", version: "1.0.0" }),
			);
			writeFileSync(
				join(pkg, "index.js"),
				"module.exports = 'resolved';\n",
			);

			const bundleDir = devBundleDir(cwd, "resize");
			mkdirSync(bundleDir, { recursive: true });
			const bundle = join(bundleDir, "index.mjs");
			writeFileSync(
				bundle,
				[
					"import { createRequire } from 'node:module';",
					// Both forms a real bundle uses: a bare ESM import, and the createRequire
					// shim the deploy banner installs (which is how sharp loads its binary).
					"import viaImport from 'only-in-project';",
					"const viaRequire = createRequire(import.meta.url)('only-in-project');",
					"process.stdout.write(viaImport + '/' + viaRequire);",
				].join("\n"),
			);

			// From an unrelated cwd, as the dev child is spawned: resolution is relative to the
			// importing file, not the working directory.
			const out = execFileSync(process.execPath, [bundle], {
				cwd: tmpdir(),
				encoding: "utf8",
			});
			expect(out).toBe("resolved/resolved");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

/**
 * The slug-keyed diff that powers neon.ts hot-reload: editing neon.ts while `neon dev` runs
 * should add new functions and drop removed ones without disturbing the functions that
 * stayed the same. These cover the decision (which units to add/remove/restart); the
 * side effects (spawn/kill) are driven by the supervisor around it.
 */
describe("diffUnits", () => {
	const unit = (slug: string, configKey: string): ServedUnit => ({
		slug,
		source: `/fns/${slug}.ts`,
		bundleDir: `/tmp/${slug}`,
		childEnv: {},
		label: slug,
		configKey,
	});

	const runningOf = (...units: ServedUnit[]): RunningUnit[] =>
		units.map((u) => ({
			unit: u,
			child: null,
			boundPort: null,
			everReady: false,
			restartTimer: null,
			watcher: null,
			status: "ready",
		}));

	it("adds a newly declared function and leaves existing ones untouched", () => {
		const existing = unit("a", "ka");
		const running = runningOf(existing);
		const desired = [unit("a", "ka"), unit("b", "kb")];

		const plan = diffUnits(running, desired);

		expect(plan.add.map((u) => u.slug)).toEqual(["b"]);
		expect(plan.remove).toEqual([]);
		expect(plan.restart).toEqual([]);
		// The existing unit's running entry is the very same object — never replaced.
		expect(running[0].unit).toBe(existing);
	});

	it("removes a function dropped from neon.ts", () => {
		const running = runningOf(unit("a", "ka"), unit("b", "kb"));

		const plan = diffUnits(running, [unit("a", "ka")]);

		expect(plan.remove.map((r) => r.unit.slug)).toEqual(["b"]);
		expect(plan.add).toEqual([]);
		expect(plan.restart).toEqual([]);
	});

	it("restarts in place a function whose config changed (new configKey)", () => {
		const running = runningOf(unit("a", "ka-old"));

		const plan = diffUnits(running, [unit("a", "ka-new")]);

		expect(plan.restart.map((r) => r.unit.slug)).toEqual(["a"]);
		expect(plan.add).toEqual([]);
		expect(plan.remove).toEqual([]);
		// Restart adopts the new config onto the same running entry (kept, not re-created).
		expect(running[0].unit.configKey).toBe("ka-new");
	});

	it("leaves an unchanged function alone (no add/remove/restart)", () => {
		const running = runningOf(unit("a", "ka"));

		const plan = diffUnits(running, [unit("a", "ka")]);

		expect(plan).toEqual({ remove: [], restart: [], add: [] });
	});

	it("removes everything when neon.ts is deleted (null desired)", () => {
		const running = runningOf(unit("a", "ka"), unit("b", "kb"));

		const plan = diffUnits(running, null);

		expect(plan.remove.map((r) => r.unit.slug)).toEqual(["a", "b"]);
		expect(plan.add).toEqual([]);
		expect(plan.restart).toEqual([]);
	});

	it("handles a mix: add one, remove one, restart one, keep one", () => {
		const keep = unit("keep", "k");
		const running = runningOf(
			keep,
			unit("drop", "d"),
			unit("change", "c-old"),
		);

		const plan = diffUnits(running, [
			unit("keep", "k"),
			unit("change", "c-new"),
			unit("new", "n"),
		]);

		expect(plan.add.map((u) => u.slug)).toEqual(["new"]);
		expect(plan.remove.map((r) => r.unit.slug)).toEqual(["drop"]);
		expect(plan.restart.map((r) => r.unit.slug)).toEqual(["change"]);
		// 'keep' is never in any bucket and its object identity is preserved.
		expect(running[0].unit).toBe(keep);
	});
});

/**
 * The transparent env line in the dev banner: shows the *names* of the env vars injected
 * into each function (Neon branch vars + the function's own neon.ts env keys), never values.
 */
describe("formatEnvSummary", () => {
	it("lists Neon branch vars and neon.ts keys, each sorted, in distinct groups", () => {
		expect(
			formatEnvSummary({
				neon: ["DATABASE_URL_UNPOOLED", "DATABASE_URL"],
				fn: ["STRIPE_KEY", "RESEND_API_KEY"],
			}),
		).toBe(
			"env: DATABASE_URL, DATABASE_URL_UNPOOLED · neon.ts: RESEND_API_KEY, STRIPE_KEY",
		);
	});

	it("shows only the Neon group when the function declares no env", () => {
		expect(formatEnvSummary({ neon: ["DATABASE_URL"], fn: [] })).toBe(
			"env: DATABASE_URL",
		);
	});

	it("shows only the neon.ts group when no Neon env was injected", () => {
		expect(formatEnvSummary({ neon: [], fn: ["RESEND_API_KEY"] })).toBe(
			"neon.ts: RESEND_API_KEY",
		);
	});

	it("returns an empty string when nothing is injected (caller skips the line)", () => {
		expect(formatEnvSummary({ neon: [], fn: [] })).toBe("");
		expect(formatEnvSummary(undefined)).toBe("");
	});
});

describe("local function URLs", () => {
	it("maps each slug to http://localhost:<port>", () => {
		expect(
			localFunctionUrlEnv([
				{ slug: "hello", port: 8787 },
				{ slug: "world", port: 8788 },
			]),
		).toEqual({
			NEON_FUNCTION_HELLO_BASE_URL: "http://localhost:8787",
			NEON_FUNCTION_WORLD_BASE_URL: "http://localhost:8788",
		});
	});

	it("overlays sibling localhost URLs onto every unit", async () => {
		const units = await planFunctionsToUnits(
			[
				{
					slug: "hello",
					name: "Hello",
					source: "/fns/hello.ts",
					port: 8787,
					env: {},
				},
				{
					slug: "world",
					name: "World",
					source: "/fns/world.ts",
					port: 8788,
					env: {},
				},
			],
			{ DATABASE_URL: "postgres://prod" },
			8787,
		);

		expect(units[0]?.childEnv.NEON_FUNCTION_HELLO_BASE_URL).toBe(
			"http://localhost:8787",
		);
		expect(units[0]?.childEnv.NEON_FUNCTION_WORLD_BASE_URL).toBe(
			"http://localhost:8788",
		);
		expect(units[1]?.childEnv.NEON_FUNCTION_HELLO_BASE_URL).toBe(
			"http://localhost:8787",
		);
		expect(units[0]?.childEnv.NEON_DEV_PORT).toBe("8787");
		expect(units[1]?.childEnv.NEON_DEV_PORT).toBe("8788");
		expect(units[0]?.childEnv.DATABASE_URL).toBe("postgres://prod");
	});

	it("keeps a search-mode port and configKey when replanned with keepPorts", async () => {
		const hello = {
			slug: "hello",
			name: "Hello",
			source: "/fns/hello.ts",
			env: {},
		};
		const [first] = await planFunctionsToUnits([hello], {}, 8787);
		const port = Number(first?.childEnv.NEON_DEV_PORT);
		const [second] = await planFunctionsToUnits(
			[hello],
			{},
			9000,
			new Map([["hello", port]]),
		);
		expect(second?.childEnv.NEON_DEV_PORT).toBe(String(port));
		expect(second?.configKey).toBe(first?.configKey);
	});

	it("changes configKey when a sibling is added so reconcile restarts callers", async () => {
		const hello = {
			slug: "hello",
			name: "Hello",
			source: "/fns/hello.ts",
			port: 8787,
			env: {},
		};
		const world = {
			slug: "world",
			name: "World",
			source: "/fns/world.ts",
			port: 8788,
			env: {},
		};
		const [alone] = await planFunctionsToUnits([hello], {}, 8787);
		const [withSibling] = await planFunctionsToUnits(
			[hello, world],
			{},
			8787,
		);
		expect(alone?.configKey).not.toBe(withSibling?.configKey);
		expect(withSibling?.childEnv.NEON_FUNCTION_WORLD_BASE_URL).toBe(
			"http://localhost:8788",
		);
	});

	it("does not give a new sibling a port reserved for a kept function", async () => {
		const hello = {
			slug: "hello",
			name: "Hello",
			source: "/fns/hello.ts",
			env: {},
		};
		const world = {
			slug: "world",
			name: "World",
			source: "/fns/world.ts",
			env: {},
		};
		const units = await planFunctionsToUnits(
			[hello, world],
			{},
			8787,
			new Map([["hello", 8787]]),
		);
		expect(units[0]?.childEnv.NEON_DEV_PORT).toBe("8787");
		expect(units[1]?.childEnv.NEON_DEV_PORT).not.toBe("8787");
		expect(units[1]?.childEnv.NEON_FUNCTION_HELLO_BASE_URL).toBe(
			"http://localhost:8787",
		);
	});
});
