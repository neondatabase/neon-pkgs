import { afterEach, describe, expect, test, vi } from "vitest";

// Mock dependencies that require package.json
vi.mock("../analytics.js", () => ({
	sendError: vi.fn(),
	trackEvent: vi.fn(),
	closeAnalytics: vi.fn(),
}));

vi.mock("../init/detect_agent.js", () => ({
	detectAgent: vi.fn().mockReturnValue(null),
}));

vi.mock("../init/interactive.js", () => ({
	interactiveInit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../init/orchestrate.js", () => ({
	orchestrate: vi.fn().mockResolvedValue({ phase: "complete", status: "ok" }),
}));

vi.mock("../init/route_command.js", () => ({
	routeDataStep: vi
		.fn()
		.mockResolvedValue({ phase: "complete", status: "ok" }),
}));

// The one piece of real I/O in the handler. `src/init/auth.test.ts` covers what actually
// reaches a pipe by spawning the built binary; here it only needs to be observable.
vi.mock("../utils/write_sync.js", () => ({
	STDOUT_FD: 1,
	STDERR_FD: 2,
	writeAllSync: vi.fn(),
}));

// `enrich_output` is a pure transform and stays real, so the stdout assertions below
// exercise the payload an agent actually receives rather than a stand-in for it.

describe("init", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
	});

	test("should call interactiveInit when no --agent flag", async () => {
		const { handler } = await import("./init.js");
		const { interactiveInit } = await import("../init/interactive.js");
		const { orchestrate } = await import("../init/orchestrate.js");

		await handler({});

		expect(interactiveInit).toHaveBeenCalledTimes(1);
		expect(orchestrate).not.toHaveBeenCalled();
	});

	test("should fall through to interactiveInit when --agent is false and detectAgent returns null", async () => {
		const { handler } = await import("./init.js");
		const { interactiveInit } = await import("../init/interactive.js");
		const { orchestrate } = await import("../init/orchestrate.js");

		await handler({ agent: false });

		expect(interactiveInit).toHaveBeenCalledTimes(1);
		expect(orchestrate).not.toHaveBeenCalled();
	});

	test("should call orchestrate when --agent is true", async () => {
		const { handler } = await import("./init.js");
		const { interactiveInit } = await import("../init/interactive.js");
		const { orchestrate } = await import("../init/orchestrate.js");
		const { detectAgent } = await import("../init/detect_agent.js");
		vi.mocked(detectAgent).mockReturnValue("cursor");

		await handler({ agent: true });

		expect(orchestrate).toHaveBeenCalledWith({
			agent: "cursor",
			skipMigrations: undefined,
			preview: undefined,
		});
		expect(interactiveInit).not.toHaveBeenCalled();
	});

	test("should pass skipMigrations to orchestrate", async () => {
		const { handler } = await import("./init.js");
		const { orchestrate } = await import("../init/orchestrate.js");
		const { detectAgent } = await import("../init/detect_agent.js");
		vi.mocked(detectAgent).mockReturnValue("claude");

		await handler({
			agent: true,
			skipMigrations: true,
		});

		expect(orchestrate).toHaveBeenCalledWith({
			agent: "claude",
			skipMigrations: true,
			preview: undefined,
		});
	});

	test("should pass preview to interactiveInit", async () => {
		const { handler } = await import("./init.js");
		const { interactiveInit } = await import("../init/interactive.js");

		await handler({ preview: true });

		expect(interactiveInit).toHaveBeenCalledWith({ preview: true });
	});

	test("should pass preview to orchestrate in agent mode", async () => {
		const { handler } = await import("./init.js");
		const { orchestrate } = await import("../init/orchestrate.js");
		const { detectAgent } = await import("../init/detect_agent.js");
		vi.mocked(detectAgent).mockReturnValue("cursor");

		await handler({ agent: true, preview: true });

		expect(orchestrate).toHaveBeenCalledWith({
			agent: "cursor",
			skipMigrations: undefined,
			preview: true,
		});
	});

	test("routes a --data step and writes the enriched response as bare JSON on stdout", async () => {
		const { handler } = await import("./init.js");
		const { routeDataStep } = await import("../init/route_command.js");
		const { detectAgent } = await import("../init/detect_agent.js");
		const { writeAllSync } = await import("../utils/write_sync.js");
		vi.mocked(detectAgent).mockReturnValue("cursor");
		vi.mocked(routeDataStep).mockResolvedValue({
			phase: "auth",
			status: "needs_auth",
			nextAction: { type: "run_neon_init", args: ["auth", "--verify"] },
		});

		await handler({ agent: true, data: '{"step":"auth"}' });

		expect(routeDataStep).toHaveBeenCalledWith({ step: "auth" }, "cursor");
		expect(writeAllSync).toHaveBeenCalledTimes(1);
		const [fd, written] = vi.mocked(writeAllSync).mock.calls[0];
		expect(fd).toBe(1);
		// Parseable on its own, with `args` already rewritten into the command an agent runs.
		expect(JSON.parse(written)).toEqual({
			phase: "auth",
			status: "needs_auth",
			nextAction: {
				type: "run_shell_command",
				command:
					'neon init --agent --data \'{"step":"auth","verify":true}\'',
			},
		});
	});

	// Outside agent mode the top-level handler reports and prints, so reporting here too
	// would file one failure as two analytics events.
	test("rethrows the cause without reporting it a second time", async () => {
		const { handler } = await import("./init.js");
		const { sendError } = await import("../analytics.js");
		const { interactiveInit } = await import("../init/interactive.js");
		const failure = new Error("editor CLI not on PATH");
		vi.mocked(interactiveInit).mockRejectedValue(failure);

		await expect(handler({})).rejects.toThrow("editor CLI not on PATH");
		expect(sendError).not.toHaveBeenCalled();
	});

	test("a named profile does not stop the handler", async () => {
		const { handler } = await import("./init.js");
		const { interactiveInit } = await import("../init/interactive.js");

		await handler({ profile: "work" });

		expect(interactiveInit).toHaveBeenCalledTimes(1);
	});

	test("NEON_PROFILE does not stop the handler either", async () => {
		const { recordCredentialInputs } = await import(
			"@neon-internals/cli-core/auth_selection"
		);
		recordCredentialInputs({
			apiKeyFlag: "",
			apiKeyEnv: "",
			profileEnv: "work",
			profileFlag: "",
			configDir: "",
		});
		const { handler } = await import("./init.js");
		const { interactiveInit } = await import("../init/interactive.js");

		try {
			await handler({});
			expect(interactiveInit).toHaveBeenCalledTimes(1);
		} finally {
			recordCredentialInputs({
				apiKeyFlag: "",
				apiKeyEnv: "",
				profileEnv: "",
				profileFlag: "",
				configDir: "",
			});
		}
	});
});
