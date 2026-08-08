import { configuredOrgId } from "@neon/e2e-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProject,
	deleteProject,
	runCli,
	uniqueProjectName,
} from "./helpers.js";

/**
 * `neon init --agent` is a protocol rather than a command that does the work: each phase
 * answers with JSON describing the next shell command the agent should run and how to feed
 * the result back. The snapshot tests pin those strings exactly; what no test checks is that
 * the commands still exist and still produce output the next phase can read. That is the
 * regression this covers — init handing an agent an invocation the CLI no longer accepts.
 *
 * Scope is the database phase, driven from an explicit org. The full journey starts at the
 * auth phase, which reads a credentials file from the real config directory and inspects the
 * working directory, so covering it means seeding a credential on disk — a separate concern
 * from proving the emitted commands work.
 */

/** The exact prefix the protocol emits. Substituted for the binary under test — and asserted, because a silent change here would make every substitution below a no-op. */
const EMITTED_PREFIX = "CI= npx -y neon ";

/** A protocol that loops or stalls should fail the test, not run until Vitest gives up. */
const MAX_TRANSITIONS = 12;

type NextAction = {
	type: string;
	command?: string;
	steps?: { id: string; command?: string }[];
	onComplete?: NextAction;
	onSuccess?: NextAction;
	responseMapping?: Record<string, { command?: string }>;
	[key: string]: unknown;
};

type PhaseResponse = {
	phase: string;
	status: string;
	nextAction?: NextAction;
	[key: string]: unknown;
};

/**
 * Pull the `--data '<json>'` payload out of an emitted `neon init` invocation and parse it,
 * rather than handing the string to a shell. The payload is single-quoted JSON that itself
 * contains quotes, and the placeholder it carries gets replaced with a whole JSON document —
 * string surgery on that produces something that only looks like valid input.
 */
function parseEmittedInitData(command: string): Record<string, unknown> {
	const match = command.match(/--data\s+'(.*)'\s*$/s);
	if (!match) {
		throw new Error(`No --data payload in emitted command: ${command}`);
	}
	return JSON.parse(match[1]) as Record<string, unknown>;
}

/** Replace the protocol's `<stdout>` placeholder with what the command actually printed. */
function substituteStdout(
	data: Record<string, unknown>,
	stdout: string,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(data).map(([key, value]) => [
			key,
			value === "<stdout>" ? stdout : value,
		]),
	);
}

describe.sequential("e2e — neon init drives real commands", () => {
	let projectId: string;
	const orgId = configuredOrgId();

	beforeAll(async () => {
		projectId = await createProject({
			name: uniqueProjectName("cli-init"),
		});
	});

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
	});

	/** Run a phase and parse its JSON, failing loudly on a non-zero exit. */
	const initStep = async (
		data: Record<string, unknown>,
	): Promise<PhaseResponse> => {
		const result = await runCli([
			"init",
			"--agent",
			"--data",
			JSON.stringify(data),
		]);
		expect(result.code, result.stderr).toBe(0);
		return JSON.parse(result.stdout) as PhaseResponse;
	};

	/**
	 * Execute a command the protocol emitted, as the agent would. `CI=` in the prefix means
	 * the child runs with an empty `CI`, which the runner would otherwise set to `true`;
	 * dropping the prefix without preserving that would test a different environment.
	 */
	const runEmitted = async (command: string) => {
		expect(command.startsWith(EMITTED_PREFIX)).toBe(true);
		const args = command.slice(EMITTED_PREFIX.length).split(/\s+/);
		const result = await runCli(args, { env: { CI: "" } });
		expect(result.code, `${command}\n${result.stderr}`).toBe(0);
		return result.stdout;
	};

	/**
	 * The phase turns anything it cannot parse into an empty project list and carries on
	 * asking the user to create one, so a driver that only checked the phase's answer would
	 * read a broken command as a legitimate "you have no projects".
	 */
	const expectProjectList = (stdout: string, command: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(stdout);
		} catch {
			throw new Error(
				`${command} did not print JSON, so the next phase would see no projects:\n${stdout.slice(0, 200)}`,
			);
		}
		const projects = Array.isArray(parsed)
			? (parsed as { id?: string }[])
			: ((parsed as { projects?: { id?: string }[] }).projects ?? []);
		expect(projects.map((project) => project.id)).toContain(projectId);
	};

	it("emits a database-phase flow whose every command works against real Neon", async () => {
		if (!orgId) {
			throw new Error(
				"NEON_ORG_ID is required: the database phase routes on the org, and without one the protocol asks the user to choose.",
			);
		}

		const executed: string[] = [];
		const seen = new Set<string>();
		let response = await initStep({ step: "db", orgId });
		let reachedProjectReady = false;

		for (let step = 0; step < MAX_TRANSITIONS; step++) {
			const marker = `${response.phase}:${response.status}`;
			if (seen.has(marker)) {
				throw new Error(
					`init looped: revisited ${marker} after ${executed.length} command(s)`,
				);
			}
			seen.add(marker);

			const action = response.nextAction;
			if (!action) {
				throw new Error(
					`Phase ${marker} returned no nextAction, so the agent has nothing to do next.`,
				);
			}

			if (action.type === "complete") {
				expect(reachedProjectReady).toBe(true);
				expect(executed.length).toBeGreaterThan(0);
				return;
			}

			if (action.type === "run_command") {
				const command = action.command as string;
				const stdout = await runEmitted(command);
				executed.push(command);
				if (command.includes("projects list")) {
					expectProjectList(stdout, command);
				}
				const followUp = action.onSuccess;
				if (followUp?.type !== "run_shell_command") {
					throw new Error(
						`Expected a run_shell_command follow-up after ${marker}, got ${followUp?.type}`,
					);
				}
				response = await initStep(
					substituteStdout(
						parseEmittedInitData(followUp.command as string),
						stdout,
					),
				);
				continue;
			}

			if (action.type === "ask_user") {
				// Stand in for the human: pick the project this test created. Its presence is
				// the assertion — the phase parses the `projects list` output to build these
				// options, and silently offers none when that output is not what it expects.
				const mapping = action.responseMapping ?? {};
				expect(Object.keys(mapping)).toContain(projectId);
				response = await initStep(
					parseEmittedInitData(mapping[projectId].command as string),
				);
				continue;
			}

			if (action.type === "agent_action") {
				expect(response.status).toBe("project_ready");
				reachedProjectReady = true;
				for (const agentStep of action.steps ?? []) {
					if (!agentStep.command) continue;
					const stdout = await runEmitted(agentStep.command);
					executed.push(agentStep.command);
					if (agentStep.id === "get_connection_string") {
						expect(stdout.trim()).toMatch(/^postgresql:\/\//);
					}
				}
				const onComplete = action.onComplete;
				if (onComplete?.type === "complete") return;
				if (onComplete?.type !== "run_shell_command") {
					throw new Error(
						`Unexpected onComplete after ${marker}: ${onComplete?.type}`,
					);
				}
				// The remaining phases configure the developer's machine — MCP servers,
				// editor extensions, migrations — so the run stops at the end of the
				// database flow rather than mutating the host.
				expect(executed.length).toBeGreaterThan(1);
				return;
			}

			throw new Error(
				`Unhandled nextAction type "${action.type}" after ${marker}`,
			);
		}

		throw new Error(
			`init did not settle within ${MAX_TRANSITIONS} transitions; ran ${executed.length} command(s)`,
		);
	});

	it("reports an unknown step instead of guessing", async () => {
		const result = await runCli([
			"init",
			"--agent",
			"--data",
			JSON.stringify({ step: "not-a-real-step" }),
		]);

		expect(result.code).not.toBe(0);
		// Agent mode answers in JSON even when it fails, so an agent parsing the output gets
		// a reason rather than a stack trace on stderr.
		const failure = JSON.parse(result.stdout) as {
			success: boolean;
			error: string;
		};
		expect(failure.success).toBe(false);
		expect(failure.error).toContain('Unknown step: "not-a-real-step"');
	});
});
