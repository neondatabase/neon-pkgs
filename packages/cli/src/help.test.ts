import { fork } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import express from "express";
import { describe, expect, it } from "vitest";

// A key shaped like a real one, so a regression can't pass by the value looking harmless.
const API_KEY = "napi_test_help_leak_guard_9f3a1c";

const runCli = async (
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> => {
	let stdout = "";
	let stderr = "";
	const code = await new Promise<number>((resolve, reject) => {
		const cp = fork(join(process.cwd(), "./dist/index.js"), args, {
			stdio: "pipe",
			env: {
				PATH: `mocks/bin:${process.env.PATH}`,
				CI: "true",
				...env,
			},
		});
		cp.stdout?.on("data", (c) => {
			stdout += String(c);
		});
		cp.stderr?.on("data", (c) => {
			stderr += String(c);
		});
		cp.on("error", reject);
		cp.on("close", (exitCode) => {
			resolve(exitCode ?? -1);
		});
	});
	return { code, stdout, stderr };
};

// yargs prints every option's default into its help output, so resolving NEON_API_KEY in
// the `--api-key` default printed the user's key on any help screen — including into CI
// logs and pasted bug reports.
describe("help output never prints secrets", () => {
	it("does not print NEON_API_KEY in top-level help", async () => {
		const { stdout, stderr } = await runCli(["--help"], {
			NEON_API_KEY: API_KEY,
		});

		expect(stderr + stdout).not.toContain(API_KEY);
		// The option itself is still documented, and says where it reads from.
		expect(stdout).toContain("--api-key");
		expect(stdout).toContain("NEON_API_KEY");
	});

	it("does not print NEON_API_KEY in subcommand help", async () => {
		const { stdout, stderr } = await runCli(
			["projects", "list", "--help"],
			{ NEON_API_KEY: API_KEY },
		);

		expect(stderr + stdout).not.toContain(API_KEY);
		expect(stdout).not.toContain("--api-key");
		expect(stdout).toContain("Global options: see neon --help");
		expect(stderr).toBe("");
	});

	it("does not print an explicit --api-key value in help", async () => {
		const { stdout, stderr } = await runCli([
			"--api-key",
			API_KEY,
			"--help",
		]);

		expect(stderr + stdout).not.toContain(API_KEY);
	});
});

// The key must still authenticate requests when it comes from the environment: moving the
// lookup out of the yargs default is only correct if this keeps working.
describe("NEON_API_KEY still authorizes requests", () => {
	it("sends the environment key as the bearer token", async () => {
		const authHeaders: (string | undefined)[] = [];
		const app = express();
		app.use((req, _res, next) => {
			authHeaders.push(req.headers.authorization);
			next();
		});
		app.get("/projects/shared", (_req, res) => {
			res.json({ projects: [] });
		});
		app.get("/projects", (_req, res) => {
			res.json({ projects: [] });
		});
		app.use((_req, res) => res.status(404).json({ message: "Not Found" }));

		const server = await new Promise<Server>((resolve) => {
			const s = app.listen(0, () => {
				resolve(s);
			});
		});
		const { port } = server.address() as AddressInfo;

		try {
			const { code } = await runCli(
				[
					"--api-host",
					`http://localhost:${port}`,
					"--no-analytics",
					"projects",
					"list",
				],
				{ NEON_API_KEY: API_KEY },
			);

			expect(code).toBe(0);
			expect(authHeaders).toContain(`Bearer ${API_KEY}`);
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		}
	});
});

describe("help is the answer on stdout", () => {
	it("writes --help to stdout", async () => {
		const { code, stdout, stderr } = await runCli(["--help"]);
		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain("neon <command>");
		expect(stdout).toContain("neon api");
	});

	it("writes empty-argv help to stdout", async () => {
		const { code, stdout, stderr } = await runCli([]);
		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain("neon <command>");
	});

	it("writes parent-command help to stdout", async () => {
		const { code, stdout, stderr } = await runCli(["projects"]);
		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain("neon projects");
	});

	it("does not split passthrough mid-word when piped", async () => {
		const { stdout } = await runCli(["--help"]);
		expect(stdout).toMatch(/passthrough/);
		expect(stdout).not.toMatch(/passthroug\s*\n\s*h/);
	});

	it("wraps the api description to COLUMNS", async () => {
		const { stdout } = await runCli(["--help"], { COLUMNS: "40" });
		expect(stdout).toMatch(/passthrough/);
		expect(stdout).not.toMatch(/passthroug\s*\n\s*h/);
		const apiIdx = stdout.indexOf("neon api");
		expect(apiIdx).toBeGreaterThanOrEqual(0);
		const descLines = stdout
			.slice(apiIdx, apiIdx + 500)
			.split("\n")
			.slice(1, 12);
		expect(
			descLines.some(
				(line) =>
					line.includes("authenticated") ||
					line.includes("passthrough"),
			),
		).toBe(true);
		expect(
			Math.max(...descLines.map((line) => line.length)),
		).toBeLessThanOrEqual(40);
	});
});

describe("subcommand help lists command flags before globals", () => {
	it("puts projects list flags first and points at neon --help for globals", async () => {
		const { stdout, stderr } = await runCli(["projects", "list", "--help"]);
		const trailer = "Global options: see neon --help";

		expect(stderr).toBe("");
		expect(stdout).toContain("--org-id");
		expect(stdout).toContain("--recoverable-only");
		expect(stdout).toContain(trailer);
		expect(stdout.indexOf("--org-id")).toBeLessThan(
			stdout.indexOf(trailer),
		);
		expect(stdout).not.toContain("--api-key");
		expect(stdout).not.toContain("--context-file");
	});

	it("still lists every global on top-level --help", async () => {
		const { stdout, stderr } = await runCli(["--help"]);

		expect(stderr).toBe("");
		expect(stdout).toContain("--api-key");
		expect(stdout).toContain("--output");
		expect(stdout).toContain("--context-file");
		expect(stdout).not.toContain("Global options: see");
	});

	it("treats empty argv as top-level help", async () => {
		const { stdout, stderr } = await runCli([]);

		expect(stderr).toBe("");
		expect(stdout).toContain("--api-key");
		expect(stdout).toContain("--context-file");
		expect(stdout).not.toContain("Global options: see");
	});

	it("collapses globals on a parent command that only lists subcommands", async () => {
		const { stdout, stderr } = await runCli(["projects", "--help"]);

		expect(stderr).toBe("");
		expect(stdout).toContain("Commands:");
		expect(stdout).toContain("Global options: see neon --help");
		expect(stdout).not.toContain("--api-key");
	});

	it("formats functions deploy --help through the same renderer", async () => {
		const { stdout, stderr } = await runCli([
			"functions",
			"deploy",
			"--help",
		]);
		const trailer = "Global options: see neon --help";

		expect(stderr).toBe("");
		expect(stdout).toContain("--src");
		expect(stdout).toContain(trailer);
		expect(stdout.indexOf("--src")).toBeLessThan(stdout.indexOf(trailer));
		expect(stdout).not.toContain("--api-key");
	});

	it("collapses globals on a nested parent whose Commands block follows the description", async () => {
		const { stdout, stderr } = await runCli([
			"functions",
			"domains",
			"--help",
		]);
		const trailer = "Global options: see neon --help";

		expect(stderr).toBe("");
		expect(stdout).toContain("Commands:");
		expect(stdout).toContain(trailer);
		expect(stdout.indexOf("Commands:")).toBeLessThan(
			stdout.indexOf(trailer),
		);
		expect(stdout).not.toContain("--api-key");
		expect(stdout).not.toContain("--context-file");
	});
});

const flattenHelp = (text: string): string => text.replace(/\s+/g, " ").trim();

const assertAuthHelpTeachesCredentials = (
	stdout: string,
	stderr: string,
): void => {
	const flat = flattenHelp(stdout);
	const trailer = "Global options: see neon --help";
	const local = stdout.slice(0, stdout.indexOf(trailer));

	expect(stderr).toBe("");
	expect(stdout).toContain(trailer);
	expect(flat).toContain("Sign in with a browser");
	expect(flat).toContain("auth --profile work");
	expect(flat).toContain('projects list --api-key "$KEY"');
	expect(flat).toContain('NEON_API_KEY="$KEY"');
	expect(flat).toContain('profile create agent --api-key "$KEY"');
	expect(flat).toContain("profile create agent --api-key -");
	expect(flat).toContain("profile create ci --mint");
	expect(flat).toContain("Non-interactive (CI, scripts, agents):");
	expect(flat).toContain("projects list --profile agent");
	expect(flat).toContain("--org-id");
	expect(flat).toContain("--project-id");
	expect(flat).toContain("NEON_PROFILE");
	expect(flat).toContain("profile list");
	expect(flat).toMatch(/Pass either --api-key or --profile/);
	expect(flat).toContain("tries to revoke");
	expect(flat).toContain("no recorded id stays live");
	expect(flat).toContain("Pick a new name");
	expect(flat).toContain("profile --help");
	expect(flat).toContain("profile create --help");
	expect(local).toContain("--keyring");
	expect(local).not.toContain("--api-key");
	expect(local).not.toContain("--output");
	expect(local).not.toContain("--config-dir");
	expect(local).not.toContain("--context-file");
	expect(stdout).not.toContain("--force-auth");
};

describe("auth and login help teach API keys and profiles", () => {
	it.each([
		"auth",
		"login",
	] as const)("%s --help names browser sign-in and the key/profile recipes", async (command) => {
		const { code, stdout, stderr } = await runCli([command, "--help"], {
			NEON_API_KEY: API_KEY,
		});

		expect(code).toBe(0);
		expect(stderr + stdout).not.toContain(API_KEY);
		assertAuthHelpTeachesCredentials(stdout, stderr);
	});

	it("does not print an explicit --api-key value in auth help", async () => {
		const { stdout, stderr } = await runCli([
			"--api-key",
			API_KEY,
			"auth",
			"--help",
		]);

		expect(stderr + stdout).not.toContain(API_KEY);
		assertAuthHelpTeachesCredentials(stdout, stderr);
	});

	it("prints the same help for auth and login", async () => {
		const auth = await runCli(["auth", "--help"]);
		const login = await runCli(["login", "--help"]);

		expect(login.stdout).toBe(auth.stdout);
		expect(login.stderr).toBe(auth.stderr);
	});

	it("keeps credential tokens intact when wrapped to COLUMNS=40", async () => {
		const { stdout } = await runCli(["auth", "--help"], { COLUMNS: "40" });
		const epilogueAt = stdout.indexOf("Non-interactive");
		expect(epilogueAt).toBeGreaterThanOrEqual(0);
		for (const line of stdout.slice(epilogueAt).split("\n")) {
			if (/^\s/.test(line) || line === "") {
				continue;
			}
			expect(line.length).toBeLessThanOrEqual(40);
		}
		expect(stdout).toContain("NEON_API_KEY");
		expect(stdout).toContain("NEON_PROFILE");
		expect(stdout).toContain("--api-key");
		expect(stdout).toContain("--profile");
		expect(stdout).toContain("--project-id");
		expect(stdout).toContain("--org-id");
		expect(stdout).toContain('echo "$KEY" |');
		expect(stdout).toContain("--api-key -");
	});

	it("wraps the auth catalog description to COLUMNS", async () => {
		const { stdout } = await runCli(["--help"], { COLUMNS: "40" });
		expect(flattenHelp(stdout)).toContain("Sign in with a browser");
		const authIdx = stdout.indexOf("neon auth");
		expect(authIdx).toBeGreaterThanOrEqual(0);
		const descLines = stdout
			.slice(authIdx, authIdx + 500)
			.split("\n")
			.slice(1, 12);
		expect(flattenHelp(descLines.join("\n"))).toContain("API keys");
		expect(
			Math.max(...descLines.map((line) => line.length)),
		).toBeLessThanOrEqual(40);
	});
});
