import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getErrorAnalyticsEventProperties } from "./analytics.js";
import { parseHeaders, parseKeyValue } from "./commands/api.js";
import { parseEnvPullKeys } from "./env_services.js";
import { matchErrorCode } from "./errors.js";
import { resolveOperationById } from "./functions/registry.js";
import { failOnUsageError } from "./help.js";
import { resolveNamedAgents } from "./init/plan.js";
import { resolveAddMcpAgentId } from "./mcp/agents.js";
import { parseMcpCategories } from "./mcp/install.js";
import { NEON_SERVICES, parseServices } from "./neon_services.js";
import { resolveSkillId } from "./skills/catalog.js";
import { test } from "./test_utils/fixtures";

// A secret pasted into the wrong flag must not reach `CLI Error` telemetry, which carries the
// error message.
const SECRETS = [
	"napi_0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijkl",
	"postgres://neondb_owner:npg_S3cr3tPassw0rd@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb",
];

const REDACTED = "<redacted invalid value>";

const telemetryMessage = (run: () => unknown): string => {
	let thrown: unknown;
	try {
		run();
	} catch (error) {
		thrown = error;
	}
	if (!(thrown instanceof Error)) {
		throw new Error("expected the parser to reject the value");
	}
	return getErrorAnalyticsEventProperties(
		thrown,
		matchErrorCode(thrown.message),
	).message;
};

const expectNoSecret = (text: string, secret: string) => {
	expect(text).not.toContain(secret);
	// Case-insensitive: `api -X` upper-cases the method before rejecting it.
	expect(text).not.toMatch(/napi_0123|npg_S3cr3t|neondb_owner/i);
};

const PARSERS: {
	flag: string;
	run: (value: string) => unknown;
	choices: string;
}[] = [
	{
		flag: "--services",
		run: (value) =>
			parseServices([value], {
				allowed: NEON_SERVICES,
				flag: "--services",
			}),
		choices: "Supported values: postgres, auth,",
	},
	{
		flag: "--category",
		run: (value) => parseMcpCategories([value]),
		choices: "Supported categories: projects, branches,",
	},
	{
		flag: "--skill",
		run: (value) => resolveSkillId(value),
		choices: "Supported skills: neon,",
	},
	{
		flag: "mcp --agent",
		run: (value) => resolveAddMcpAgentId(value),
		choices: "Supported agents: ",
	},
	{
		flag: "init --agent",
		run: (value) => resolveNamedAgents([value]),
		choices: "Supported agents: ",
	},
	{
		flag: "functions new --operation",
		run: (value) =>
			resolveOperationById(
				[
					{
						id: "send",
						title: "Send",
						description: "Send an email",
						source: "send.ts",
						recommended: true,
					},
				],
				value,
			),
		choices: "Available operations: send.",
	},
	{
		flag: "api --field",
		run: (value) => parseKeyValue(value),
		choices: 'Invalid "key=value" pair',
	},
	{
		flag: "env pull --env",
		run: (value) => parseEnvPullKeys([value], "--env"),
		choices: "Supported values: DATABASE_URL,",
	},
	{
		flag: "yargs choices",
		run: (value) =>
			failOnUsageError(
				`Invalid values:\n  Argument: output, Given: ${JSON.stringify(value)}, Choices: "json", "yaml", "table"`,
				null,
				{ help: () => "help" },
			),
		choices: 'Choices: "json", "yaml", "table"',
	},
];

describe("rejected flag values in CLI Error telemetry", () => {
	for (const { flag, run, choices } of PARSERS) {
		for (const secret of SECRETS) {
			it(`${flag} redacts ${secret.slice(0, 12)}…`, () => {
				const message = telemetryMessage(() => run(secret));
				expectNoSecret(message, secret);
				expect(message).toContain(REDACTED);
				expect(message).toContain(choices);
			});
		}
	}

	it("api --header redacts a header missing its colon", () => {
		const secret = SECRETS[0] ?? "";
		const message = telemetryMessage(() =>
			parseHeaders([`Authorization Bearer ${secret}`]),
		);
		expectNoSecret(message, secret);
		expect(message).toBe(
			`Invalid header ${REDACTED}. Expected "key:value".`,
		);
	});

	it("--services still names a real service the command cannot select", () => {
		const message = telemetryMessage(() =>
			parseServices(["realtime"], {
				allowed: ["postgres"],
				flag: "--service",
			}),
		);
		expect(message).toBe(
			"realtime is not something --service can select. Supported values: postgres.",
		);
	});

	it("names the valid choice a typo was close to", () => {
		expect(
			telemetryMessage(() =>
				parseServices(["postgress"], {
					allowed: NEON_SERVICES,
					flag: "--services",
				}),
			),
		).toContain(`Unknown service ${REDACTED}. Did you mean postgres?`);
		expect(telemetryMessage(() => parseMcpCategories(["shema"]))).toContain(
			`Unknown MCP category: ${REDACTED}. Did you mean schema?`,
		);
	});

	it("redacts a yargs choices value that hides a line break or the separator", () => {
		for (const value of [
			"napi_0123\u2028secret",
			"napi_0123, Choices: npg_S3cr3t",
		]) {
			const message = telemetryMessage(() =>
				failOnUsageError(
					`Invalid values:\n  Argument: output, Given: ${JSON.stringify(value)}, Choices: "json", "yaml", "table"`,
					null,
					{ help: () => "help" },
				),
			);
			expect(message).toBe(
				`Invalid values:\n  Argument: output, Given: ${REDACTED}, Choices: "json", "yaml", "table"`,
			);
		}
	});
});

describe("rejected flag values on the CLI", () => {
	const secret = SECRETS[1] ?? "";
	const dirs: string[] = [];
	const scratch = () => {
		const home = mkdtempSync(join(tmpdir(), "neon-rejected-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "neon-rejected-cwd-"));
		dirs.push(home, cwd);
		return { cwd, env: { HOME: home, USERPROFILE: home } };
	};

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	for (const { args, choices } of [
		{
			args: ["config", "init", "--no-install", "--services", secret],
			choices: "Supported values: postgres,",
		},
		{
			args: [
				"mcp",
				"-y",
				"--oauth",
				"--agent",
				"cursor",
				"--category",
				secret,
			],
			choices: "Supported categories: projects,",
		},
		{
			args: ["skills", "-y", "--agent", "cursor", "--skill", secret],
			choices: "Supported skills: neon,",
		},
		{
			args: ["mcp", "-y", "--oauth", "--agent", secret],
			choices: "Supported agents: ",
		},
		{
			args: ["projects", "list", "--output", secret],
			choices: 'Choices: "json", "yaml", "table"',
		},
		{
			args: ["api", "/projects", "-X", secret],
			choices: "Use one of: GET, POST, PUT, PATCH, DELETE.",
		},
	]) {
		test(`${args.slice(0, 2).join(" ")} … ${args.at(-2)} <secret>`, async ({
			testCliCommand,
		}) => {
			const { stderr } = await testCliCommand(args, {
				...scratch(),
				unreachableHost: true,
				code: 1,
				snapshot: false,
			});
			expectNoSecret(stderr, secret);
			expect(stderr).toContain(REDACTED);
			expect(stderr).toContain(choices);
		});
	}
});
