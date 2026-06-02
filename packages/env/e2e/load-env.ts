// Loaded by vitest.e2e.config.ts `setupFiles`; not imported statically.
// fallow-ignore-file unused-file
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Vitest setup file — loads `packages/env/.env` into `process.env` so e2e tests can
 * read `NEON_API_KEY` (and friends). Node 22 has `--env-file` but it's per-process; doing
 * it here keeps the test command short (`pnpm test:e2e`).
 *
 * Lines starting with `#` are treated as comments; everything else is parsed as
 * `KEY=value` (no quoting / interpolation — we keep this minimal on purpose).
 */
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env");

if (existsSync(envPath)) {
	const raw = readFileSync(envPath, "utf-8");
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		if (process.env[key] === undefined) process.env[key] = value;
	}
}
