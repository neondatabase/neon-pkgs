import { fork } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { gzipSync } from "fflate";
import { type IPty, spawn as spawnPty } from "node-pty";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import YAML from "yaml";
import { takeCommandSuccessExtras } from "../analytics.js";
import { AGENT_SETUP_MESSAGE } from "../init/copy.js";

const deployTemplate = vi.hoisted(() =>
	vi.fn(async (_options: Record<string, unknown>) => ({
		envFile: "",
		generated: [] as string[],
	})),
);
vi.mock("../init/deploy.js", () => ({ deployTemplate }));

// --deploy is staging-only, so its tests point the CLI at the staging API host.
const STAGING = { NEON_API_HOST: "https://console-stage.neon.build/api/v2" };

// A fixture file in the template repo: its POSIX `mode`/`type` decide whether it
// lands as a regular file, an executable, or a symlink.
type FixtureFile =
	| { type: "file"; mode: number; content: string }
	| { type: "symlink"; target: string };

// Keyed by repo-relative path. The `with-hono` subdir mirrors what the real
// `hono` template uses; `with-remix/...` must be filtered out as a sibling.
const FIXTURE: Record<string, FixtureFile> = {
	"with-hono/package.json": {
		type: "file",
		mode: 0o644,
		content: '{\n  "name": "with-hono"\n}\n',
	},
	"with-hono/src/index.ts": {
		type: "file",
		mode: 0o644,
		content: 'export const app = "hono";\n',
	},
	"with-hono/scripts/run.sh": {
		type: "file",
		mode: 0o755,
		content: "#!/bin/sh\necho hi\n",
	},
	"with-hono/.claude/skills/neon": {
		type: "symlink",
		target: "../../package.json",
	},
	"with-remix/package.json": {
		type: "file",
		mode: 0o644,
		content: '{ "name": "with-remix" }\n',
	},
	"updated-hono/selected.txt": {
		type: "file",
		mode: 0o644,
		content: "selected catalog template\n",
	},
	// A deployable template: a neon.ts plus the inputs its deploy needs.
	"with-queue/package.json": {
		type: "file",
		mode: 0o644,
		content: '{\n  "name": "with-queue",\n  "private": true\n}\n',
	},
	"with-queue/neon.ts": {
		type: "file",
		mode: 0o644,
		content: "export default {};\n",
	},
	"with-queue/template.json": {
		type: "file",
		mode: 0o644,
		content:
			'{ "id": "queue", "inputs": [{ "name": "QUEUE_API_KEY", "secret": true, "generate": "token" }] }\n',
	},
};

const MANIFEST_YAML = `templates:
  - id: hono
    title: "Hono API (Drizzle, Lakebase Postgres) on Neon Functions"
    description: "A Hono API using Drizzle ORM and Lakebase Postgres, ready to deploy as a Neon Function."
    services:
      - Postgres
      - Functions
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-hono
  - id: plain
    title: "Plain"
    description: "A template with no services listed."
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-hono
`;

// Build a ustar header block, matching what GitHub's codeload tarballs emit.
const tarHeader = (
	name: string,
	size: number,
	mode: number,
	typeflag: string,
	linkname = "",
): Buffer => {
	const header = Buffer.alloc(512, 0);
	header.write(name, 0, "utf8");
	header.write(`${(mode & 0o7777).toString(8).padStart(7, "0")}\0`, 100);
	header.write("0000000\0", 108);
	header.write("0000000\0", 116);
	header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
	header.write("00000000000\0", 136);
	header.write("        ", 148);
	header.write(typeflag, 156, 1);
	header.write(linkname, 157, "utf8");
	header.write("ustar\0", 257);
	header.write("00", 263);
	let sum = 0;
	for (let i = 0; i < 512; i++) {
		sum += header[i];
	}
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return header;
};

const padTo512 = (buf: Buffer): Buffer => {
	const rem = buf.length % 512;
	return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem)]);
};

// Pack the fixture into a gzipped tar shaped like codeload: a single
// "examples-main/" top-level dir wrapping every repo-relative path.
const makeTarball = (): Buffer => {
	const blocks: Buffer[] = [tarHeader("pax_global_header", 0, 0o644, "g")];
	for (const [path, file] of Object.entries(FIXTURE)) {
		const name = `examples-main/${path}`;
		if (file.type === "symlink") {
			blocks.push(tarHeader(name, 0, 0o777, "2", file.target));
		} else {
			const content = Buffer.from(file.content);
			blocks.push(tarHeader(name, content.length, file.mode, "0"));
			blocks.push(padTo512(content));
		}
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.from(gzipSync(new Uint8Array(Buffer.concat(blocks))));
};

// A real local HTTP server standing in for the codeload tarball host + the
// manifest host, so the whole download/extract path runs end to end with no
// mocking of our own code.
const startGithubFixtureServer = (): Promise<Server> => {
	const app = express();

	app.get("/manifest/bootstrap.yaml", (_req, res) => {
		res.type("text/yaml").send(MANIFEST_YAML);
	});

	// Mirrors https://codeload.github.com/:owner/:repo/tar.gz/:ref
	app.get("/:owner/:repo/tar.gz/:ref", (_req, res) => {
		res.type("application/gzip").send(makeTarball());
	});

	return new Promise((resolve) => {
		const server = app.listen(0, () => {
			resolve(server);
		});
	});
};

const HONO_LIST_ROW = {
	id: "hono",
	title: "Hono API (Drizzle, Lakebase Postgres) on Neon Functions",
	description:
		"A Hono API using Drizzle ORM and Lakebase Postgres, ready to deploy as a Neon Function.",
	services: ["Postgres", "Functions"],
};

const PLAIN_LIST_ROW: typeof HONO_LIST_ROW = {
	id: "plain",
	title: "Plain",
	description: "A template with no services listed.",
	services: [],
};

const TABLE_LIST_OUTPUT = `${HONO_LIST_ROW.id} — ${HONO_LIST_ROW.description} [Postgres · Functions]\n${PLAIN_LIST_ROW.id} — ${PLAIN_LIST_ROW.description}\n`;

const runBootstrap = (
	server: Server,
	args: string[],
	env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> => {
	const base = `http://localhost:${(server.address() as AddressInfo).port}`;
	const argv = [
		"bootstrap",
		...args,
		"--api-key",
		"test-key",
		"--no-analytics",
	];
	if (!args.includes("--output") && !args.includes("-o")) {
		argv.push("--output", "yaml");
	}
	return new Promise((resolve, reject) => {
		const cp = fork(join(process.cwd(), "./dist/index.js"), argv, {
			stdio: "pipe",
			env: {
				...process.env,
				CI: "true",
				NEON_BOOTSTRAP_GITHUB_CODELOAD: base,
				NEON_BOOTSTRAP_MANIFEST_URL: `${base}/manifest/bootstrap.yaml`,
				...env,
			},
		});
		let stdout = "";
		let stderr = "";
		cp.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		cp.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		cp.on("error", reject);
		cp.on("close", (code) => {
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
};

const waitForText = (
	term: IPty,
	output: () => string,
	text: string,
): Promise<void> =>
	new Promise((resolve, reject) => {
		if (stripAnsi(output()).includes(text)) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			subscription.dispose();
			reject(
				new Error(
					`Timed out waiting for "${text}". Output:\n${stripAnsi(output())}`,
				),
			);
		}, 10_000);
		const subscription = term.onData(() => {
			if (!stripAnsi(output()).includes(text)) {
				return;
			}
			clearTimeout(timer);
			subscription.dispose();
			resolve();
		});
	});

const waitForExit = (term: IPty): Promise<number> =>
	new Promise((resolve) => {
		term.onExit(({ exitCode }) => resolve(exitCode));
	});

const parseListedTemplates = (stdout: string): unknown[] => {
	const parsed: unknown = JSON.parse(stdout.trim());
	if (!Array.isArray(parsed)) {
		throw new Error(`Expected a JSON array, got: ${stdout}`);
	}
	return parsed;
};

describe("bootstrap", () => {
	let server: Server;
	let dest: string;

	beforeEach(async () => {
		server = await startGithubFixtureServer();
		dest = mkdtempSync(join(tmpdir(), "neonctl-bootstrap-"));
	});

	afterEach(async () => {
		takeCommandSuccessExtras();
		rmSync(dest, { recursive: true, force: true });
		await new Promise<void>((resolve, reject) => {
			server.close((err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	});

	test("copies the template subtree, preserving files, exec bits, and symlinks", async () => {
		const { code, stderr } = await runBootstrap(server, [
			dest,
			"--template",
			"hono",
			"--force",
		]);
		expect(code, stderr).toBe(0);

		// Regular + nested files are written with the subdir prefix stripped.
		expect(readFileSync(join(dest, "package.json"), "utf8")).toBe(
			'{\n  "name": "with-hono"\n}\n',
		);
		expect(readFileSync(join(dest, "src/index.ts"), "utf8")).toBe(
			'export const app = "hono";\n',
		);

		// The executable bit survives the round-trip.
		expect(lstatSync(join(dest, "scripts/run.sh")).mode & 0o111).not.toBe(
			0,
		);

		// The symlink is recreated as a real symlink pointing at its target.
		const link = join(dest, ".claude/skills/neon");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readlinkSync(link)).toBe("../../package.json");

		// A sibling example in the same repo must not leak into the copy.
		expect(() =>
			readFileSync(join(dest, "with-remix/package.json")),
		).toThrow();
	});

	test("finishes interactive agent setup before asking to link", async () => {
		const base = `http://localhost:${(server.address() as AddressInfo).port}`;
		const target = join(dest, "app");
		const spawnHelper = join(
			process.cwd(),
			"node_modules",
			"node-pty",
			"prebuilds",
			`${process.platform}-${process.arch}`,
			"spawn-helper",
		);
		if (existsSync(spawnHelper)) {
			chmodSync(spawnHelper, 0o755);
		}
		const npxBin = join(dest, "npx-bin");
		mkdirSync(npxBin);
		writeFileSync(
			join(npxBin, "npx"),
			"#!/usr/bin/env node\nprocess.exit(0);\n",
		);
		chmodSync(join(npxBin, "npx"), 0o755);
		let output = "";
		const term = spawnPty(
			process.execPath,
			[
				join(process.cwd(), "./dist/index.js"),
				"bootstrap",
				target,
				"--template",
				"plain",
				"--no-install",
				"--no-git",
				"--api-key",
				"test-key",
				"--config-dir",
				join(dest, "config"),
				"--context-file",
				join(target, ".neon"),
				"--no-analytics",
			],
			{
				name: "xterm-256color",
				cols: 120,
				rows: 40,
				env: {
					...process.env,
					CI: "",
					PATH: `${npxBin}:${process.env.PATH ?? ""}`,
					NEON_BOOTSTRAP_GITHUB_CODELOAD: base,
					NEON_BOOTSTRAP_MANIFEST_URL: `${base}/manifest/bootstrap.yaml`,
				},
			},
		);
		term.onData((chunk) => {
			output += chunk;
		});

		await waitForText(term, () => output, AGENT_SETUP_MESSAGE);
		term.write("\r");
		await waitForText(
			term,
			() => output,
			"Which coding agents should get the Neon plugin?",
		);
		term.write("\r");
		await waitForText(
			term,
			() => output,
			"Link this project to a Neon project now?",
		);

		const rendered = stripAnsi(output);
		expect(rendered).not.toContain(
			"Install the Neon plugin into these agents?",
		);
		expect(
			rendered.indexOf("Which coding agents should get the Neon plugin?"),
		).toBeLessThan(
			rendered.indexOf("Link this project to a Neon project now?"),
		);
		expect(rendered).not.toContain("(runs neon link)");

		term.write("n\r");
		expect(await waitForExit(term)).toBe(0);
	}, 20_000);

	test("refuses a non-empty directory without --force", async () => {
		writeFileSync(join(dest, "keep.txt"), "mine\n");
		const { code, stderr } = await runBootstrap(server, [
			dest,
			"--template",
			"hono",
		]);
		expect(code).toBe(1);
		expect(stderr).toContain("not empty");
		// The existing file is left untouched and nothing was scaffolded.
		expect(readFileSync(join(dest, "keep.txt"), "utf8")).toBe("mine\n");
		expect(() => readFileSync(join(dest, "package.json"))).toThrow();
	});

	test("rejects an unknown template id", async () => {
		const { code, stderr } = await runBootstrap(server, [
			dest,
			"--template",
			"does-not-exist",
			"--force",
		]);
		expect(code).toBe(1);
		expect(stderr).toContain("Unknown template");
	});

	test("--list prints available templates to stdout from the remote manifest", async () => {
		const { code, stdout, stderr } = await runBootstrap(server, [
			"--list",
			"--output",
			"table",
		]);
		expect(code, stderr).toBe(0);
		expect(stdout).toBe(TABLE_LIST_OUTPUT);
	});

	test("--list-templates --output json prints id, title, description, and services", async () => {
		const { code, stdout, stderr } = await runBootstrap(server, [
			"--list-templates",
			"--output",
			"json",
		]);
		expect(code, stderr).toBe(0);
		const rows = parseListedTemplates(stdout);
		expect(rows).toEqual([HONO_LIST_ROW, PLAIN_LIST_ROW]);
		for (const row of rows) {
			if (typeof row !== "object" || row === null) {
				throw new Error(`Expected an object row, got: ${stdout}`);
			}
			expect(Object.keys(row).sort()).toEqual([
				"description",
				"id",
				"services",
				"title",
			]);
		}
	});

	test("--list-templates --output yaml prints the same rows", async () => {
		const { code, stdout, stderr } = await runBootstrap(server, [
			"--list-templates",
			"--output",
			"yaml",
		]);
		expect(code, stderr).toBe(0);
		expect(YAML.parse(stdout)).toEqual([HONO_LIST_ROW, PLAIN_LIST_ROW]);
	});

	test("--agent without a value is refused", async () => {
		const { code, stdout, stderr } = await runBootstrap(server, [
			"--agent",
		]);
		expect(code).toBe(1);
		expect(stdout.trim()).toBe("");
		expect(stderr).toMatch(/--agent needs a value/);
	});

	test("help describes --agent forwarding", async () => {
		const { code, stdout, stderr } = await runBootstrap(server, ["--help"]);
		expect(code, stderr).toBe(0);
		const flat = stdout.replace(/\s+/g, " ");
		expect(flat).toContain("--list-templates");
		expect(flat).toContain("--agent-setup");
		expect(flat).toContain("host CLI agent");
		expect(flat).toContain("omit --default in a terminal");
		expect(flat).toMatch(/forwarded to plugins, or to skills and mcp/i);
		expect(flat).toMatch(/skips agent selection/i);
		expect(stdout).toMatch(/Plugin agents/);
		expect(stdout).toMatch(/Skills and MCP agents/);
		expect(stdout).toMatch(/(?<![-\w])--agent(?![-\w])/);
		expect(stdout).not.toContain("--skip-template");
		expect(stdout).not.toMatch(/Skip the template/);
		expect(stderr).toBe("");
	});

	test("mixed --agent fails before scaffold", async () => {
		const { code, stderr } = await runBootstrap(server, [
			dest,
			"--agent",
			"cursor",
			"--agent",
			"vscode",
			"--default",
			"--no-install",
			"--force",
			"--no-link",
		]);
		expect(code).toBe(1);
		expect(stderr).toMatch(/plugin and skills\/MCP/);
		expect(stderr).toMatch(/Plugin: cursor/);
		expect(stderr).toMatch(/Skills\/MCP: vscode/);
		expect(stderr).toContain(
			`neon bootstrap ${dest} --default --agent cursor`,
		);
		expect(stderr).toContain(
			`neon bootstrap ${dest} --default --agent vscode`,
		);
		expect(stderr).toMatch(/Re-run `.*` or `/);
		expect(existsSync(join(dest, "package.json"))).toBe(false);
	});

	test("unknown --agent fails before scaffold", async () => {
		const { code, stderr } = await runBootstrap(server, [
			dest,
			"--agent",
			"not-an-agent",
			"--default",
			"--no-install",
			"--force",
			"--no-agent-setup",
			"--no-link",
		]);
		expect(code).toBe(1);
		expect(stderr).toMatch(/Unknown agent: "not-an-agent"/);
		expect(existsSync(join(dest, "package.json"))).toBe(false);
	});

	test("--default scaffolds and inits git without prompting", async () => {
		// --no-install keeps the test offline/fast; git init still runs.
		const { code, stdout, stderr } = await runBootstrap(server, [
			dest,
			"--default",
			"--no-install",
			"--force",
			"--no-agent-setup",
			"--no-link",
			"--agent",
			"cursor",
		]);
		expect(code, stderr).toBe(0);
		expect(stdout).toContain("Project scaffolded.");
		expect(stdout).not.toContain("INFO:");
		expect(`${stdout}${stderr}`).not.toContain("██████");
		expect(stderr).not.toMatch(/Done\. Scaffolded/);

		// The default template was scaffolded with no template/dir prompt.
		expect(readFileSync(join(dest, "package.json"), "utf8")).toBe(
			'{\n  "name": "with-hono"\n}\n',
		);
		// git init ran as part of the quick start.
		expect(existsSync(join(dest, ".git"))).toBe(true);
	});

	test("announces the dependency install with the package manager it runs", async () => {
		// The fixture package.json has no dependencies, so an offline npm install
		// succeeds without touching a registry.
		const { code, stderr } = await runBootstrap(
			server,
			[
				dest,
				"--default",
				"--force",
				"--no-git",
				"--no-agent-setup",
				"--no-link",
			],
			{
				npm_config_user_agent: "npm/11.0.0 node/v22.0.0",
				npm_config_offline: "true",
				npm_config_audit: "false",
				npm_config_fund: "false",
			},
		);
		expect(code, stderr).toBe(0);
		expect(stderr).toContain("Installing dependencies with npm…");
		expect(existsSync(join(dest, "package-lock.json"))).toBe(true);
	});

	test("selectedTemplate scaffolds the catalog source for a known id", async () => {
		const base = `http://localhost:${(server.address() as AddressInfo).port}`;
		const previousCodeload = process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD;
		const previousCi = process.env.CI;
		process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD = base;
		process.env.CI = "true";
		const { handler } = await import("./bootstrap.js");
		try {
			await handler({
				apiClient: {} as never,
				apiKey: "test-key",
				apiHost: "https://console.neon.tech/api/v2",
				output: "table",
				contextFile: join(dest, ".neon"),
				directory: dest,
				force: true,
				listTemplates: false,
				default: false,
				install: false,
				git: false,
				link: false,
				agentSetup: false,
				analytics: false,
				printBanner: false,
				skipDoneSummary: true,
				selectedTemplate: {
					id: "hono",
					title: "Updated REST API",
					description: "Updated template source",
					requires: ["database"],
					source: {
						owner: "neondatabase",
						repo: "examples",
						ref: "main",
						subdir: "updated-hono",
					},
				},
			});
		} finally {
			if (previousCodeload === undefined) {
				delete process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD;
			} else {
				process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD = previousCodeload;
			}
			if (previousCi === undefined) {
				delete process.env.CI;
			} else {
				process.env.CI = previousCi;
			}
		}

		expect(readFileSync(join(dest, "selected.txt"), "utf8")).toBe(
			"selected catalog template\n",
		);
		expect(() => readFileSync(join(dest, "src/index.ts"))).toThrow();
		expect(takeCommandSuccessExtras()).toEqual({
			template: "hono",
			agent_setup: "skip",
		});
	});

	// Regression test: `windsurf` only installs via skills+MCP (no plugin target), so a
	// named `--agent windsurf` must reach `installMcp` as `{ agent: ["windsurf"] }`, not
	// under skills/plugins' `agents` key — a prior planner bug sent MCP `agents` too,
	// which `setupNeonMcp` doesn't read, so it silently redetected agents instead.
	test("named MCP-only --agent reaches installMcp with agent (not agents)", async () => {
		const base = `http://localhost:${(server.address() as AddressInfo).port}`;
		const previousCodeload = process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD;
		const previousCi = process.env.CI;
		process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD = base;
		process.env.CI = "true";
		const { handler } = await import("./bootstrap.js");
		const installSkills = vi.fn().mockResolvedValue({
			scope: "global",
			agents: [],
			rows: [],
			failed: [],
		});
		const installMcp = vi.fn().mockResolvedValue({
			scope: "global",
			rows: [],
			failedAgents: [],
			url: "https://mcp.neon.tech/mcp",
			auth: "oauth",
		});
		try {
			await handler({
				apiClient: {} as never,
				apiKey: "test-key",
				apiHost: "https://console.neon.tech/api/v2",
				output: "table",
				contextFile: join(dest, ".neon"),
				directory: dest,
				force: true,
				listTemplates: false,
				template: "hono",
				default: true,
				install: false,
				git: false,
				link: false,
				analytics: false,
				printBanner: false,
				skipDoneSummary: true,
				agent: ["windsurf"],
				operations: { installSkills, installMcp },
			});
		} finally {
			if (previousCodeload === undefined) {
				delete process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD;
			} else {
				process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD = previousCodeload;
			}
			if (previousCi === undefined) {
				delete process.env.CI;
			} else {
				process.env.CI = previousCi;
			}
		}

		expect(installSkills).toHaveBeenCalledWith(
			expect.objectContaining({ agents: ["windsurf"] }),
		);
		expect(installMcp).toHaveBeenCalledWith(
			expect.objectContaining({ agent: ["windsurf"] }),
		);
	});

	test("--list-templates does not record a scaffolded template", async () => {
		const base = `http://localhost:${(server.address() as AddressInfo).port}`;
		const previousManifest = process.env.NEON_BOOTSTRAP_MANIFEST_URL;
		process.env.NEON_BOOTSTRAP_MANIFEST_URL = `${base}/manifest/bootstrap.yaml`;
		const { handler } = await import("./bootstrap.js");
		try {
			await handler({
				apiClient: {} as never,
				apiKey: "test-key",
				apiHost: "https://console.neon.tech/api/v2",
				output: "table",
				contextFile: join(dest, ".neon"),
				force: false,
				listTemplates: true,
				default: false,
				install: false,
				git: false,
				link: false,
				agentSetup: false,
				analytics: false,
				printBanner: false,
				skipDoneSummary: true,
			});
		} finally {
			if (previousManifest === undefined) {
				delete process.env.NEON_BOOTSTRAP_MANIFEST_URL;
			} else {
				process.env.NEON_BOOTSTRAP_MANIFEST_URL = previousManifest;
			}
		}
		expect(takeCommandSuccessExtras()).toEqual({});
	});
	test("--deploy refuses --no-install", async () => {
		const { code, stderr } = await runBootstrap(
			server,
			[
				dest,
				"--template",
				"hono",
				"--deploy",
				"--default",
				"--no-install",
			],
			STAGING,
		);
		expect(code).toBe(1);
		expect(stderr).toContain("remove --no-install and --no-link");
	});

	test("--deploy outside a terminal needs -y", async () => {
		const { code, stderr } = await runBootstrap(
			server,
			[dest, "--template", "hono", "--deploy"],
			STAGING,
		);
		expect(code).toBe(1);
		expect(stderr).toContain("--deploy outside a terminal needs -y");
	});

	test("--deploy refuses a template without neon.ts", async () => {
		const { code, stderr } = await runBootstrap(
			server,
			[
				dest,
				"--template",
				"hono",
				"--deploy",
				"--default",
				"--force",
				"--no-git",
				"--no-agent-setup",
			],
			STAGING,
		);
		expect(code).toBe(1);
		expect(stderr).toContain('Template "hono" has no neon.ts');
	});

	test("--deploy links a new project, then deploys with the --env values", async () => {
		const base = `http://localhost:${(server.address() as AddressInfo).port}`;
		const previousCodeload = process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD;
		process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD = base;
		const target = join(dest, "my-queue");
		const linked: Record<string, unknown>[] = [];
		deployTemplate.mockClear();
		const { handler } = await import("./bootstrap.js");
		try {
			const result = await handler({
				apiClient: {} as never,
				apiKey: "test-key",
				apiHost: STAGING.NEON_API_HOST,
				output: "table",
				contextFile: join(target, ".neon"),
				directory: target,
				force: false,
				listTemplates: false,
				default: true,
				install: true,
				git: false,
				link: true,
				agentSetup: false,
				analytics: false,
				printBanner: false,
				skipDoneSummary: true,
				deploy: true,
				env: ["QUEUE_API_KEY=from-flag"],
				regionId: "aws-us-east-2",
				linkProject: async (props) => {
					linked.push({ ...props });
				},
				selectedTemplate: {
					id: "queue",
					title: "Job queue",
					description: "A durable job queue.",
					requires: ["database", "functions"],
					source: {
						owner: "neondatabase",
						repo: "examples",
						ref: "main",
						subdir: "with-queue",
					},
				},
			});
			expect(result?.deployed).toBe(true);
		} finally {
			if (previousCodeload === undefined) {
				delete process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD;
			} else {
				process.env.NEON_BOOTSTRAP_GITHUB_CODELOAD = previousCodeload;
			}
		}

		// Always a new project, named after the directory, with no env pull before the
		// template's inputs exist.
		expect(linked).toHaveLength(1);
		expect(linked[0]).toMatchObject({
			projectName: "my-queue",
			regionId: "aws-us-east-2",
			envPull: false,
			config: false,
		});
		expect(linked[0]).not.toHaveProperty("projectId");
		expect(deployTemplate).toHaveBeenCalledTimes(1);
		expect(deployTemplate).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: target,
				env: ["QUEUE_API_KEY=from-flag"],
			}),
		);
		// -y never prompts for an input.
		expect(deployTemplate.mock.calls[0]?.[0]).not.toHaveProperty("ask");
	});
	test("--deploy is refused outside staging", async () => {
		const { code, stderr } = await runBootstrap(server, [
			dest,
			"--template",
			"hono",
			"--deploy",
			"--default",
		]);
		expect(code).toBe(1);
		expect(stderr).toContain(
			"Deploying templates with `neon bootstrap --deploy` is coming soon!",
		);
		// Refused before anything is scaffolded.
		expect(existsSync(join(dest, "package.json"))).toBe(false);
	});

	test("help lists --deploy only against staging", async () => {
		const production = await runBootstrap(server, ["--help"]);
		expect(production.code, production.stderr).toBe(0);
		expect(production.stdout).not.toContain("--deploy");
		expect(production.stdout).not.toContain("--project-name");

		const staging = await runBootstrap(server, ["--help"], STAGING);
		expect(staging.code, staging.stderr).toBe(0);
		expect(staging.stdout).toContain("--deploy");
		expect(staging.stdout).toContain("--project-name");
	});
});
