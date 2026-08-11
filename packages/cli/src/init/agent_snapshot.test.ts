/**
 * Output snapshots for every step of the `neon init --agent` state machine.
 *
 * The init flow is a protocol: an agent reads one JSON object, does what
 * `nextAction` says, and calls back with the next `--data` payload. Every field
 * in that object is load-bearing for something we do not control, so a
 * refactor that changes one silently changes the behaviour of every agent
 * driving it. These snapshots pin the whole surface — one per (fixture, step)
 * pair — so that a change to any of it has to be looked at and accepted.
 *
 * ## Hermetic by construction
 *
 * A snapshot is only useful if it is identical on a laptop and on CI, so the
 * runs cannot touch anything real:
 *
 * - `PATH` is a directory of stub executables and nothing else, so every
 *   `execa` call in the flow (`npx`, `npm`, `neonctl`, `skills`, editor CLIs)
 *   resolves to a script with a fixed answer. The stubs also record what was
 *   invoked, which is what `records the subprocesses each step shells out to`
 *   asserts on.
 * - `HOME` and `NEON_CONFIG_DIR` are temp directories, so global MCP/skills
 *   detection and credential reads see exactly what the fixture set up.
 * - Agent identity comes from pinned env vars rather than from whatever editor
 *   is running the suite.
 * - Every temp path is replaced with a stable token before snapshotting.
 *
 * ## Proving a refactor changed nothing
 *
 * `NEON_CLI_UNDER_TEST` points the suite at another build's `dist/cli.js`.
 * Generate the snapshots from the old build, then run against the new one: a
 * clean run means the two produce the same normalised output across the whole
 * matrix. Normalisation discards a few machine-dependent spans (see
 * `normalise`), so this is equivalence of the protocol, not of every byte.
 *
 * The stubs are `/bin/sh` scripts, so the suite runs on Linux and macOS.
 *
 *     NEON_CLI_UNDER_TEST=/path/to/old/packages/cli/dist/cli.js pnpm vitest run agent_snapshot -u
 *     pnpm vitest run agent_snapshot
 */
import { spawn } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// Every case spawns the built CLI, which is far beyond Vitest's 5s default on a
// loaded CI runner. The spawn itself is bounded separately, at 60s.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const CLI =
	process.env.NEON_CLI_UNDER_TEST ??
	resolve(import.meta.dirname, "..", "..", "dist", "cli.js");

/** Every executable the init flow shells out to, with a fixed answer. */
const STUBS: Record<string, string> = {
	// `neonctl --version` and `npm view neonctl version` agreeing is what makes
	// `ensureNeonctl` report `already_current` instead of trying to install.
	neonctl: `case "$1" in
  --version) echo "2.45.0" ;;
  *) exit 0 ;;
esac`,
	npm: `if [ "$1" = "view" ]; then echo "2.45.0"; fi
exit 0`,
	npx: "exit 0",
	neon: "exit 0",
	skills: `if [ "$1" = "--version" ]; then echo "1.0.0"; fi
exit 0`,
	claude: `if [ "$1" = "--version" ]; then echo "1.0.0 (Claude Code)"; fi
exit 0`,
	// No extensions installed, and no editor app discoverable through mdfind.
	code: "exit 0",
	cursor: "exit 0",
	mdfind: "exit 0",
	git: "exit 0",
	open: "exit 0",
	"xdg-open": "exit 0",
};

/** Files each fixture project starts with, relative to its root. */
const FIXTURES: Record<string, Record<string, string>> = {
	// Nothing at all — `neon init` in an empty directory.
	greenfield: {},

	// An app with no database and no Neon anything.
	"node-app": {
		"package.json": JSON.stringify(
			{ name: "app", dependencies: { hono: "^4.0.0" } },
			null,
			2,
		),
		"src/index.ts": "export default {};\n",
	},

	// The common brownfield shape: a framework, an ORM, a schema, no migrations.
	"next-prisma": {
		"package.json": JSON.stringify(
			{
				name: "app",
				dependencies: { next: "^15.0.0", "@prisma/client": "^6.0.0" },
				devDependencies: { prisma: "^6.0.0" },
			},
			null,
			2,
		),
		"prisma/schema.prisma":
			'generator client {\n  provider = "prisma-client-js"\n}\n',
		"app/page.tsx": "export default function Page() { return null; }\n",
	},

	// Same, but migrations already exist.
	"next-prisma-migrated": {
		"package.json": JSON.stringify(
			{
				name: "app",
				dependencies: { next: "^15.0.0", "@prisma/client": "^6.0.0" },
				devDependencies: { prisma: "^6.0.0" },
			},
			null,
			2,
		),
		"prisma/schema.prisma":
			'generator client {\n  provider = "prisma-client-js"\n}\n',
		"prisma/migrations/0001_init/migration.sql": "-- init\n",
	},

	// The other ORM branch of `detectMigrations`.
	drizzle: {
		"package.json": JSON.stringify(
			{
				name: "app",
				dependencies: { hono: "^4.0.0", "drizzle-orm": "^0.36.0" },
			},
			null,
			2,
		),
		"drizzle.config.ts": "export default {};\n",
		"drizzle/0000_init.sql": "-- init\n",
	},

	// Already wired to Neon: a Neon connection string in `.env`.
	connected: {
		"package.json": JSON.stringify(
			{
				name: "app",
				dependencies: { next: "^15.0.0", "@prisma/client": "^6.0.0" },
			},
			null,
			2,
		),
		"prisma/schema.prisma":
			'generator client {\n  provider = "prisma-client-js"\n}\n',
		".env": "DATABASE_URL=postgresql://u:p@ep-test.us-east-2.aws.neon.tech/db\n",
	},

	// Nothing left to do: connection string, project-scoped MCP server, skills.
	"fully-configured": {
		"package.json": JSON.stringify(
			{
				name: "app",
				dependencies: { next: "^15.0.0", "@prisma/client": "^6.0.0" },
			},
			null,
			2,
		),
		"prisma/schema.prisma":
			'generator client {\n  provider = "prisma-client-js"\n}\n',
		"prisma/migrations/0001_init/migration.sql": "-- init\n",
		".env": "DATABASE_URL=postgresql://u:p@ep-test.us-east-2.aws.neon.tech/db\n",
		".cursor/mcp.json": JSON.stringify(
			{ mcpServers: { neon: { url: "https://mcp.neon.tech/mcp" } } },
			null,
			2,
		),
		".cursor/skills/neon/SKILL.md": "# neon\n",
		".cursor/skills/neon-postgres/SKILL.md": "# neon-postgres\n",
	},

	// A database URL that is not Neon's — `databaseUrl` true, `connectionString`
	// false, which is the branch that decides whether to offer a migration.
	"other-database": {
		"package.json": JSON.stringify(
			{ name: "app", dependencies: { express: "^4.0.0" } },
			null,
			2,
		),
		".env": "DATABASE_URL=postgresql://u:p@localhost:5432/db\n",
	},
};

/** The agent identities the flow branches on, and how each is detected. */
const AGENTS: Record<string, Record<string, string>> = {
	cursor: { CURSOR_TRACE_ID: "trace-1" },
	"claude-code": { CLAUDECODE: "1" },
	codex: { CODEX: "1" },
	// No agent env at all: `detectAgent()` returns null and `--agent` still
	// forces agent mode, so this covers the "explicitly asked, none detected" path.
	none: {},
};

/**
 * The bootstrap template manifest, served locally. A fixture with no app makes
 * the setup phase fetch this, and the real endpoint is both a network call and
 * a list that changes every time we publish a template.
 */
const TEMPLATE_MANIFEST = `templates:
  - id: hono
    title: REST API
    description: A Hono REST API on Neon Functions.
    tools:
      - Hono
      - Drizzle
    services:
      - Postgres
      - Functions
    requires:
      - database
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-hono
  - id: realtime-chat
    title: Realtime chat
    description: A Next.js chat app with Neon Auth.
    services:
      - Postgres
      - Neon Auth
    requires:
      - database
      - auth
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-realtime-chat
`;

let root: string;
let stubBin: string;
let manifestServer: Server;
let manifestUrl: string;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "neon-init-snap-"));
	stubBin = join(root, "bin");
	mkdirSync(stubBin, { recursive: true });
	for (const [name, body] of Object.entries(STUBS)) {
		const path = join(stubBin, name);
		writeFileSync(
			path,
			`#!/bin/sh\necho "$0 $*" >> "$NEON_STUB_LOG"\n${body}\n`,
		);
		chmodSync(path, 0o755);
	}

	manifestServer = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/yaml" });
		res.end(TEMPLATE_MANIFEST);
	});
	await new Promise<void>((done) => {
		manifestServer.listen(0, "127.0.0.1", () => done());
	});
	const { port } = manifestServer.address() as AddressInfo;
	manifestUrl = `http://127.0.0.1:${port}/templates.yaml`;
});

afterAll(async () => {
	await new Promise<void>((done) => {
		manifestServer.close(() => done());
	});
	rmSync(root, { recursive: true, force: true });
});

let caseCounter = 0;

type RunResult = {
	status: number | null;
	signal: NodeJS.Signals | null;
	spawnError: string | null;
	stdout: string;
	stderr: string;
	invocations: string[];
};

/**
 * Materialise a fixture in its own directory and run one `neon init`
 * invocation against it, with nothing real in reach.
 *
 * Asynchronous on purpose. `spawnSync` blocks this process's event loop, which
 * means the manifest server above can never answer the child — the fetch times
 * out and the phase silently falls back to its hardcoded template list.
 */
async function runInit(
	fixture: keyof typeof FIXTURES,
	args: string[],
	options: {
		agent?: keyof typeof AGENTS;
		/** `null` runs with no credentials file at all. */
		credentials?: string | null;
	} = {},
): Promise<RunResult> {
	const caseDir = join(root, `case-${caseCounter++}`);
	const cwd = join(caseDir, "project");
	const home = join(caseDir, "home");
	const configDir = join(caseDir, "config");
	const stubLog = join(caseDir, "stub.log");
	for (const dir of [cwd, home, configDir])
		mkdirSync(dir, { recursive: true });
	// A repo boundary, so package-manager detection stops here instead of walking
	// up through $TMPDIR — where another checkout's lockfile would decide which
	// install command the snapshots contain.
	mkdirSync(join(cwd, ".git"), { recursive: true });
	writeFileSync(stubLog, "");

	for (const [relative, contents] of Object.entries(FIXTURES[fixture])) {
		const target = join(cwd, relative);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, contents);
	}

	// A stored API key by default, so credential resolution succeeds without a
	// network call. Pass `credentials: null` for the signed-out branches.
	const credentials =
		options.credentials === undefined
			? JSON.stringify({ type: "api_key", api_key: "napi_snapshot" })
			: options.credentials;
	if (credentials !== null) {
		writeFileSync(join(configDir, "credentials.json"), credentials, {
			mode: 0o600,
		});
	}

	const child = spawn(process.execPath, [CLI, "init", ...args], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			// Deliberately not inheriting: PATH is the stub directory only, so a
			// binary the flow forgets to stub fails loudly instead of running.
			PATH: stubBin,
			HOME: home,
			NEON_CONFIG_DIR: configDir,
			NEON_STUB_LOG: stubLog,
			NEON_BOOTSTRAP_MANIFEST_URL: manifestUrl,
			NEON_NO_ANALYTICS: "1",
			CI: "true",
			NO_COLOR: "1",
			FORCE_COLOR: "0",
			...AGENTS[options.agent ?? "cursor"],
		},
	});

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const outcome = await new Promise<{
		status: number | null;
		signal: NodeJS.Signals | null;
		spawnError: string | null;
	}>((settle) => {
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.on("error", (err) => {
			clearTimeout(timer);
			settle({ status: null, signal: null, spawnError: err.message });
		});
		child.on("close", (status, signal) => {
			clearTimeout(timer);
			settle({ status, signal, spawnError: null });
		});
	});

	const invocations = readFileSync(stubLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => line.replace(stubBin, "<stub>"))
		.map((line) => normalise(line, { cwd, home, configDir }));

	return {
		...outcome,
		stdout: normalise(stdout, { cwd, home, configDir }),
		stderr: normalise(stderr, { cwd, home, configDir }),
		invocations,
	};
}

/** Replace anything that changes between runs or between machines. */
function normalise(
	text: string,
	paths: { cwd: string; home: string; configDir: string },
): string {
	return (
		text
			// `--help` prints the config directory as a yargs default and wraps it
			// mid-path, so plain substitution cannot see it. Match the option's own
			// label instead, which survives whatever width the wrap lands on.
			.replace(
				/(Path to config directory \[string\] \[default: ")[\s\S]*?("\])/,
				"$1<config>$2",
			)
			// `isCursorInstalled` / `isVSCodeInstalled` stat absolute install paths
			// (`/Applications/Cursor.app`, `/usr/share/cursor`) with no env lever, so
			// this is the one answer that legitimately differs between a laptop with
			// an editor installed and a bare CI runner. Pin the shape, not the machine.
			.replace(
				/"installedEditors": (\[[\s\S]*?\]|null)/g,
				'"installedEditors": <machine-dependent>',
			)
			// The auth phase picks the browser launcher from `process.platform`
			// (`open` on macOS, `xdg-open` on Linux, `start` on Windows). Normalise
			// the launcher and keep the URL, which is the part worth pinning.
			.replace(
				/\b(?:open|xdg-open|start) (https:\/\/\S*?signup)/g,
				"<browser-open> $1",
			)
			// The sentence derived from that probe. Both variants collapse to one
			// token, because *which* one appears is itself machine-dependent — but
			// they are matched in full, with only the editor list wildcarded, so
			// editing the guidance around it stops the match and shows up as a diff
			// rather than being silently absorbed.
			.replace(
				/No IDE detected, but the following editors are installed: [^.]*\. The \\"installedEditors\\" field in this response lists them\. If the user wants the extension installed, ask which editor to install it for and include that as the \\"ide\\" field in your reportBack data\. If not, set \\"ide\\" to \\"none\\"\.|No IDE or supported editors detected\. Set \\"ide\\" to \\"none\\" in your reportBack data\./g,
				"<ide-detection-instruction>",
			)
			.split(paths.configDir)
			.join("<config>")
			.split(paths.cwd)
			.join("<project>")
			.split(paths.home)
			.join("<home>")
			.split(root)
			.join("<root>")
			.replace(/\/var\/folders\/[^\s"']+/g, "<tmp>")
			.replace(/\/tmp\/[A-Za-z0-9._-]+/g, "<tmp>")
	);
}

/** One snapshot per case, covering everything the caller can observe. */
function snapshotOf(result: RunResult) {
	return [
		`exit: ${result.status}`,
		// Present only when something went wrong at the process level, so a killed
		// or unspawnable child is diagnosable instead of just `exit: null`.
		...(result.signal === null ? [] : [`signal: ${result.signal}`]),
		...(result.spawnError === null
			? []
			: [`spawn error: ${result.spawnError}`]),
		"--- stdout ---",
		result.stdout.trimEnd(),
		"--- stderr ---",
		result.stderr.trimEnd(),
		"--- subprocesses ---",
		result.invocations.join("\n"),
	].join("\n");
}

const FIXTURE_NAMES = Object.keys(FIXTURES) as (keyof typeof FIXTURES)[];

/**
 * Every `--data` step the router accepts, with the options that reach a
 * distinct branch. `route_command.ts`'s unknown-step error lists the ten step
 * names; this table has to stay in step with it.
 */
const STEPS: { name: string; data: Record<string, unknown> }[] = [
	{ name: "auth", data: { step: "auth" } },
	{ name: "auth-verify", data: { step: "auth", verify: true } },
	{ name: "auth-existing", data: { step: "auth", method: "existing" } },
	{ name: "auth-new", data: { step: "auth", method: "new" } },
	{ name: "setup", data: { step: "setup" } },
	{
		name: "setup-defaults",
		data: {
			step: "setup",
			mode: "defaults",
			mcpConfigured: false,
			isVscodeIde: true,
			installExtension: false,
		},
	},
	{
		name: "setup-customize",
		data: {
			step: "setup",
			mode: "customize",
			mcpScope: "global",
			skillsScope: "project",
			installExtension: false,
		},
	},
	{ name: "mcp-status", data: { step: "mcp", status: true } },
	{
		name: "mcp-install",
		data: { step: "mcp", install: true, scope: "global" },
	},
	{ name: "skills-status", data: { step: "skills", status: true } },
	{ name: "skills-install", data: { step: "skills", install: true } },
	{ name: "skills-update", data: { step: "skills", update: true } },
];

describe("neon init --agent: every step, against every project shape", () => {
	for (const fixture of FIXTURE_NAMES) {
		describe(fixture, () => {
			for (const step of STEPS) {
				test(step.name, async () => {
					const result = await runInit(fixture, [
						"--agent",
						"--data",
						JSON.stringify(step.data),
					]);
					expect(snapshotOf(result)).toMatchSnapshot();
				});
			}
		});
	}
});

describe("neon init --agent: the orchestrator picks the next phase", () => {
	for (const fixture of FIXTURE_NAMES) {
		test(`${fixture} — no --data`, async () => {
			expect(
				snapshotOf(await runInit(fixture, ["--agent"])),
			).toMatchSnapshot();
		});
	}
});

describe("neon init --agent: the response depends on which agent is driving", () => {
	for (const agent of Object.keys(AGENTS) as (keyof typeof AGENTS)[]) {
		describe(agent, () => {
			for (const step of [
				"auth",
				"setup",
				"mcp-status",
				"skills-status",
			]) {
				const found = STEPS.find((s) => s.name === step);
				if (!found) throw new Error(`no step named ${step}`);
				test(step, async () => {
					const result = await runInit(
						"next-prisma",
						["--agent", "--data", JSON.stringify(found.data)],
						{ agent },
					);
					expect(snapshotOf(result)).toMatchSnapshot();
				});
			}

			test("orchestrator", async () => {
				expect(
					snapshotOf(
						await runInit("next-prisma", ["--agent"], { agent }),
					),
				).toMatchSnapshot();
			});
		});
	}
});

/**
 * Every case above runs with a stored credential, which makes the auth phase
 * answer `verified` and never reach the branches that matter when someone is
 * actually signed out. These run with no credentials file.
 */
describe("neon init --agent: the signed-out auth branches", () => {
	for (const step of [
		{ name: "auth", data: { step: "auth" } },
		{ name: "auth-verify", data: { step: "auth", verify: true } },
		{
			name: "auth-existing-account",
			data: { step: "auth", method: "existing" },
		},
		{ name: "auth-new-account", data: { step: "auth", method: "new" } },
	]) {
		test(step.name, async () => {
			const result = await runInit(
				"next-prisma",
				["--agent", "--data", JSON.stringify(step.data)],
				{ credentials: null },
			);
			expect(snapshotOf(result)).toMatchSnapshot();
		});
	}

	test("the orchestrator sends a signed-out caller to the auth phase", async () => {
		expect(
			snapshotOf(
				await runInit("next-prisma", ["--agent"], {
					credentials: null,
				}),
			),
		).toMatchSnapshot();
	});

	// A credentials file that exists but cannot be parsed must not read as
	// "signed out" — that would start a sign-in that overwrites it.
	test("a damaged credentials file is an error, not a fresh machine", async () => {
		expect(
			snapshotOf(
				await runInit(
					"next-prisma",
					["--agent", "--data", '{"step":"auth","verify":true}'],
					{ credentials: "{ not json" },
				),
			),
		).toMatchSnapshot();
	});
});

describe("neon init --agent: agentId in the payload overrides detection", () => {
	for (const agentId of ["cursor", "claude-code", "vscode", "windsurf"]) {
		test(agentId, async () => {
			const result = await runInit(
				"next-prisma",
				[
					"--agent",
					"--data",
					JSON.stringify({ step: "mcp", agentId, status: true }),
				],
				{ agent: "none" },
			);
			expect(snapshotOf(result)).toMatchSnapshot();
		});
	}
});

describe("neon init --agent: nested and string-encoded --data payloads", () => {
	test("nested object under a data key", async () => {
		const result = await runInit("next-prisma", [
			"--agent",
			"--data",
			JSON.stringify({
				step: "skills",
				data: { status: true },
			}),
		]);
		expect(snapshotOf(result)).toMatchSnapshot();
	});

	test("JSON-encoded string under a data key", async () => {
		const result = await runInit("next-prisma", [
			"--agent",
			"--data",
			JSON.stringify({
				step: "skills",
				data: JSON.stringify({ status: true }),
			}),
		]);
		expect(snapshotOf(result)).toMatchSnapshot();
	});
});

describe("neon init: failure output", () => {
	test("unknown step", async () => {
		const result = await runInit("next-prisma", [
			"--agent",
			"--data",
			JSON.stringify({ step: "not-a-step" }),
		]);
		expect(snapshotOf(result)).toMatchSnapshot();
	});

	test("malformed --data", async () => {
		expect(
			snapshotOf(
				await runInit("next-prisma", [
					"--agent",
					"--data",
					"{not json",
				]),
			),
		).toMatchSnapshot();
	});

	test("--data without a step falls through to the orchestrator", async () => {
		const result = await runInit("next-prisma", [
			"--agent",
			"--data",
			JSON.stringify({ framework: "next" }),
		]);
		expect(snapshotOf(result)).toMatchSnapshot();
	});

	test("--profile is refused, as JSON", async () => {
		expect(
			snapshotOf(
				await runInit("next-prisma", [
					"--agent",
					"--profile",
					"DEFAULT",
				]),
			),
		).toMatchSnapshot();
	});

	// No agent in the environment and no `--agent`, so this is the human path:
	// one line on stderr and nothing on stdout. `--profile` is the refusal that
	// fails before any prompting, so it gets there without needing a TTY.
	test("--profile is refused in plain text when no agent is detected", async () => {
		expect(
			snapshotOf(
				await runInit("next-prisma", ["--profile", "DEFAULT"], {
					agent: "none",
				}),
			),
		).toMatchSnapshot();
	});

	// The same invocation with an agent in the environment is agent mode, even
	// though `--agent` was never passed — stdin is not a TTY and detection wins.
	test("an autodetected agent gets the JSON refusal without passing --agent", async () => {
		expect(
			snapshotOf(
				await runInit("next-prisma", ["--profile", "DEFAULT"], {
					agent: "cursor",
				}),
			),
		).toMatchSnapshot();
	});

	test("an unknown profile is refused before the command runs", async () => {
		expect(
			snapshotOf(
				await runInit("next-prisma", ["--agent", "--profile", "ghost"]),
			),
		).toMatchSnapshot();
	});

	test("--help", async () => {
		expect(
			snapshotOf(await runInit("greenfield", ["--help"])),
		).toMatchSnapshot();
	});
});
