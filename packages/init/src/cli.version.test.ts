import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import pkg from "./pkg.js";

const declaredVersion = (
	JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as { version: string }
).version;

describe("--version", () => {
	// `pkg.ts` walks up to the nearest package.json so one module works both from
	// `src/` and from the bundled `dist/`. A walk that resolved somewhere else —
	// a parent workspace manifest, say — would report a wrong version rather than
	// throw, so pin what it resolves to.
	test("pkg resolves this package's own manifest", () => {
		expect(pkg.name).toBe("neon-init");
		expect(pkg.version).toBe(declaredVersion);
	});

	// The regression this guards: with no `.version()` call, yargs guesses, and in
	// an ESM bin the guess fails — `neon-init --version` printed "unknown". Run the
	// real CLI end to end rather than asserting on the builder.
	test("the CLI reports that version", () => {
		const result = spawnSync(
			fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url)),
			[fileURLToPath(new URL("./cli.ts", import.meta.url)), "--version"],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(declaredVersion);
	});
});
