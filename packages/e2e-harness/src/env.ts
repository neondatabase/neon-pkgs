import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal `KEY=value` parser — no quoting, no interpolation. Deliberately not a
 * dependency: the harness only ever reads a handful of credentials.
 */
function parse(path: string): Map<string, string> {
	const entries = new Map<string, string>();
	for (const rawLine of readFileSync(path, "utf-8").split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		entries.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
	}
	return entries;
}

/**
 * Load e2e credentials into `process.env`, checking the package's own `.env` first and
 * falling back to one at the repository root. All four suites run against the same org,
 * so the root file lets you configure them once instead of copying the same key into
 * four places.
 *
 * Real environment variables always win, which is how CI injects the secret without a
 * file existing at all.
 */
export function loadEnv(packageDir: string): void {
	const candidates = [
		resolve(packageDir, ".env"),
		resolve(packageDir, "..", "..", ".env"),
	];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		for (const [key, value] of parse(path)) {
			if (process.env[key] === undefined) process.env[key] = value;
		}
	}
}

export function requireApiKey(): string {
	const key = process.env.NEON_API_KEY;
	if (!key || key.trim() === "") {
		throw new Error(
			"NEON_API_KEY is not set. Copy .env.example to .env in this package or at the " +
				"repository root (see CONTRIBUTING.md) before running test:e2e.",
		);
	}
	return key;
}

/**
 * Pins every create and list to one organization. Redundant for an org-scoped API key,
 * which can't see anything else anyway, but essential for a user-scoped key: without it
 * the orphan sweep would range over every org the user belongs to.
 */
export function configuredOrgId(): string | undefined {
	const value = process.env.NEON_ORG_ID?.trim();
	return value ? value : undefined;
}

export function orgQuery(): { org_id?: string } {
	const org = configuredOrgId();
	return org ? { org_id: org } : {};
}

/** Neon's production Management API, used unless `NEON_API_BASE_URL` overrides it. */
export const DEFAULT_API_BASE_URL = "https://console.neon.tech/api/v2";

/**
 * Lets a whole run target a non-production API. Every suite honours it — the harness for
 * its own calls, `@neon/sdk` through `createNeonClient({ baseUrl })`, and `neonctl`
 * through `--api-host` — so pointing at staging doesn't silently leave half the run
 * talking to production.
 */
export function configuredBaseUrl(): string {
	return process.env.NEON_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
}
