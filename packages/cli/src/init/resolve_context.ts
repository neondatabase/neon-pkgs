/**
 * Resolves the Neon org/project from a DATABASE_URL in .env.
 * Parses the endpoint hostname, then queries the Neon API to find
 * which project it belongs to.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execa } from "execa";

type NeonContext = {
	orgId: string;
	projectId: string;
};

/**
 * Extracts the Neon endpoint host from .env's DATABASE_URL or PGHOST.
 * Returns the hostname (e.g. "ep-cool-name-12345.us-east-2.aws.neon.tech") or null.
 */
function extractNeonHost(cwd: string): string | null {
	for (const envFile of [".env", ".env.local"]) {
		const envPath = resolve(cwd, envFile);
		if (!existsSync(envPath)) continue;
		try {
			const content = readFileSync(envPath, "utf-8");

			// Try DATABASE_URL
			const dbUrlMatch = content.match(
				/^DATABASE_URL=.*@([^/:\s]+\.neon\.tech)/m,
			);
			if (dbUrlMatch) return dbUrlMatch[1];

			// Try PGHOST
			const pgHostMatch = content.match(/^PGHOST=([^\s]+\.neon\.tech)/m);
			if (pgHostMatch) return pgHostMatch[1];
		} catch {}
	}
	return null;
}

/**
 * Resolves the Neon org and project that own the endpoint in DATABASE_URL.
 *
 * Strategy:
 * 1. Extract endpoint hostname from .env
 * 2. List orgs via neonctl
 * 3. For each org, list projects
 * 4. For each project, get connection string and compare hostnames
 * 5. Return the matching org/project
 */
export async function resolveNeonContext(
	cwd: string,
): Promise<NeonContext | null> {
	const neonHost = extractNeonHost(cwd);
	if (!neonHost) return null;

	// List orgs
	let orgs: { id: string; name: string }[];
	try {
		const result = await execa(
			"npx",
			["-y", "neon", "orgs", "list", "--output", "json"],
			{
				stdio: "pipe",
				timeout: 30000,
				env: { ...process.env, CI: undefined },
			},
		);
		orgs = JSON.parse(result.stdout);
	} catch {
		return null;
	}

	if (orgs.length === 0) return null;

	// Search each org's projects for a matching endpoint
	for (const org of orgs) {
		let projects: { id: string; name: string }[];
		try {
			const result = await execa(
				"npx",
				[
					"-y",
					"neon",
					"projects",
					"list",
					"--org-id",
					org.id,
					"--output",
					"json",
				],
				{
					stdio: "pipe",
					timeout: 30000,
					env: { ...process.env, CI: undefined },
				},
			);
			projects = JSON.parse(result.stdout);
		} catch {
			continue;
		}

		for (const project of projects) {
			try {
				const result = await execa(
					"npx",
					[
						"-y",
						"neon",
						"connection-string",
						"--project-id",
						project.id,
					],
					{
						stdio: "pipe",
						timeout: 15000,
						env: { ...process.env, CI: undefined },
					},
				);
				const connStr = result.stdout.trim();
				if (connStr.includes(neonHost)) {
					return { orgId: org.id, projectId: project.id };
				}
			} catch {}
		}
	}

	return null;
}
