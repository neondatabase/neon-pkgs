import { beforeEach, describe, expect, test, vi } from "vitest";

const PASSWORD = "npg_SentinelPassword123";
const POOLED = `postgresql://neondb_owner:${PASSWORD}@ep-test-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`;

const mocks = vi.hoisted(() => {
	const spinner = { start: vi.fn(), stop: vi.fn() };
	return {
		spinner,
		prompts: {
			intro: vi.fn(),
			outro: vi.fn(),
			text: vi.fn(),
			isCancel: vi.fn(() => false),
			spinner: vi.fn(() => spinner),
			log: {
				info: vi.fn(),
				step: vi.fn(),
				success: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
		},
		getArgs: vi.fn(),
		prepEnv: vi.fn(),
		instantPostgres: vi.fn(),
	};
});

vi.mock("@clack/prompts", () => mocks.prompts);

vi.mock("./lib/utils/args.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./lib/utils/args.js")>()),
	getArgs: mocks.getArgs,
}));

vi.mock("./lib/utils/fs.js", () => ({ prepEnv: mocks.prepEnv }));

vi.mock("./lib/instant-postgres.js", () => ({
	instantPostgres: mocks.instantPostgres,
}));

function everythingPrinted(consoleLog: { mock: { calls: unknown[][] } }) {
	const { log, ...rest } = mocks.prompts;
	const fns = [
		...Object.values(rest),
		...Object.values(log),
		mocks.spinner.start,
		mocks.spinner.stop,
		consoleLog,
	];
	return fns.flatMap((fn) => fn.mock.calls.map((call) => call.join(" ")));
}

async function runCli() {
	const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
	await import("./cli.js");
	return consoleLog;
}

describe("neon-new CLI output", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.instantPostgres.mockResolvedValue({ databaseUrl: POOLED });
	});

	test("--yes does not print the connection password", async () => {
		mocks.getArgs.mockReturnValue({ yes: true, command: "create" });

		const consoleLog = await runCli();

		expect(mocks.prompts.outro).toHaveBeenCalledTimes(1);
		const [summary] = mocks.prompts.outro.mock.calls[0] as [string];
		expect(summary).toContain(
			"postgresql://neondb_owner:****@ep-test-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require",
		);
		expect(summary).toContain(
			"Saved to ./.env as DATABASE_URL (pooled) and DATABASE_URL_DIRECT (direct).",
		);
		for (const line of everythingPrinted(consoleLog)) {
			expect(line).not.toContain(PASSWORD);
		}
	});

	test("the interactive flow does not print the connection password", async () => {
		mocks.getArgs.mockReturnValue({ yes: false, command: "create" });
		mocks.prompts.text
			.mockResolvedValueOnce(".env.local")
			.mockResolvedValueOnce("PG_URL")
			.mockResolvedValueOnce("")
			.mockResolvedValueOnce("VITE_");

		const consoleLog = await runCli();

		expect(mocks.instantPostgres).toHaveBeenCalledWith(
			expect.objectContaining({
				dotEnvFile: ".env.local",
				dotEnvKey: "PG_URL",
			}),
		);
		expect(mocks.prompts.outro).toHaveBeenCalledTimes(1);
		const [summary] = mocks.prompts.outro.mock.calls[0] as [string];
		expect(summary).toContain("neondb_owner:****@");
		expect(summary).toContain(
			"Saved to .env.local as PG_URL (pooled) and PG_URL_DIRECT (direct).",
		);
		for (const line of everythingPrinted(consoleLog)) {
			expect(line).not.toContain(PASSWORD);
		}
	});
});
