import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load `packages/ai-sdk-provider/.env` into `process.env` for e2e runs.
 * Existing process env wins (so CI can inject secrets without a file).
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
