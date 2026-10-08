import {
	chmodSync,
	existsSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	apiRequest,
	configuredBaseUrl,
	requireApiKey,
} from "@neon/e2e-harness";
import { spawn as spawnPty } from "node-pty";
import stripAnsi from "strip-ansi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProject,
	deleteProject,
	runCli,
	uniqueProjectName,
	waitForProjectReady,
} from "./helpers.js";

const CLI_ENTRY = resolve(import.meta.dirname, "..", "dist", "cli.js");

describe.sequential("e2e — neon deploy confirmations against the real API", () => {
	let projectId: string;
	let branchId: string;
	let cwd: string;

	const policyPath = () => join(cwd, "neon.ts");

	const writePolicy = (minCu?: number) =>
		writeFileSync(
			policyPath(),
			minCu === undefined
				? "export default {};\n"
				: `export default { branch: () => ({ postgres: { computeSettings: { autoscalingLimitMinCu: ${minCu} } } }) };\n`,
		);

	const remoteMinCu = async (): Promise<number> => {
		const { endpoints } = await apiRequest<{
			endpoints: {
				branch_id: string;
				type: string;
				autoscaling_limit_min_cu: number;
			}[];
		}>(`/projects/${projectId}/endpoints`);
		const endpoint = endpoints.find(
			(candidate) =>
				candidate.branch_id === branchId &&
				candidate.type === "read_write",
		);
		if (!endpoint) throw new Error("branch has no read_write endpoint");
		return endpoint.autoscaling_limit_min_cu;
	};

	const setProtected = async (value: boolean) => {
		// A compute update from the previous deploy can still be running; the API answers 423.
		await waitForProjectReady(projectId);
		await apiRequest(`/projects/${projectId}/branches/${branchId}`, {
			method: "PATCH",
			body: { branch: { protected: value } },
		});
		await waitForProjectReady(projectId);
	};

	const targetFlags = () => [
		"--project-id",
		projectId,
		"--branch",
		branchId,
		"--config",
		policyPath(),
		"--no-env-pull",
	];

	const deploy = (...flags: string[]) =>
		runCli(["deploy", ...flags, ...targetFlags()], { cwd });

	/** Run `neon deploy` in a real terminal and answer its prompt with `answer`. */
	const deployInTerminal = (
		answer: string,
		...flags: string[]
	): Promise<{ code: number; output: string }> => {
		const spawnHelper = join(
			resolve(import.meta.dirname, ".."),
			"node_modules",
			"node-pty",
			"prebuilds",
			`${process.platform}-${process.arch}`,
			"spawn-helper",
		);
		if (existsSync(spawnHelper)) chmodSync(spawnHelper, 0o755);
		const term = spawnPty(
			process.execPath,
			[
				CLI_ENTRY,
				"deploy",
				...flags,
				...targetFlags(),
				"--api-key",
				requireApiKey(),
				"--api-host",
				configuredBaseUrl(),
				"--config-dir",
				mkdtempSync(join(tmpdir(), "neon-deploy-pty-config-")),
				"--context-file",
				join(cwd, ".neon-pty"),
				"--no-analytics",
				"--no-color",
			],
			{
				name: "xterm-256color",
				cols: 200,
				rows: 40,
				cwd,
				env: {
					...process.env,
					CI: "",
					NO_COLOR: "1",
					FORCE_COLOR: "0",
				} as Record<string, string>,
			},
		);
		return new Promise((resolvePromise, reject) => {
			let output = "";
			let answered = false;
			const timer = setTimeout(() => {
				term.kill();
				reject(new Error(`neon deploy timed out. Output:\n${output}`));
			}, 120_000);
			term.onData((data) => {
				output += data;
				if (!answered && /\? .*› /.test(stripAnsi(output))) {
					answered = true;
					term.write(answer);
				}
			});
			term.onExit(({ exitCode }) => {
				clearTimeout(timer);
				resolvePromise({ code: exitCode, output: stripAnsi(output) });
			});
		});
	};

	beforeAll(async () => {
		cwd = mkdtempSync(join(tmpdir(), "neon-deploy-e2e-"));
		projectId = await createProject({
			name: uniqueProjectName("cli-deploy"),
		});
		const { branches } = await apiRequest<{
			branches: { id: string; default?: boolean }[];
		}>(`/projects/${projectId}/branches`);
		const branch = branches.find((candidate) => candidate.default);
		if (!branch) throw new Error("project has no default branch");
		branchId = branch.id;
	});

	afterAll(async () => {
		if (projectId) {
			await setProtected(false).catch(() => undefined);
			await deleteProject(projectId);
		}
		if (cwd) rmSync(cwd, { recursive: true, force: true });
	});

	it("applies a policy that changes nothing without asking", async () => {
		writePolicy();
		const result = await deploy();
		expect(result.code, result.stderr).toBe(0);
	});

	it("refuses drift without a flag and changes nothing", async () => {
		const before = await remoteMinCu();
		writePolicy(before === 0.5 ? 0.25 : 0.5);

		const result = await deploy();

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"Re-run with --update-existing (or -y) to apply the changes shown above.",
		);
		expect(await remoteMinCu()).toBe(before);
	});

	it.each([
		["-y", 0.5],
		["--yes", 0.25],
		["--update-existing", 0.5],
	])("%s applies drift", async (flag, minCu) => {
		writePolicy(minCu);
		const result = await deploy(flag);
		expect(result.code, result.stderr).toBe(0);
		expect(await remoteMinCu()).toBe(minCu);
	});

	describe("on a protected branch", () => {
		beforeAll(async () => {
			await setProtected(true);
		});

		it("refuses with no flag, naming both", async () => {
			writePolicy(0.25);
			const result = await deploy();
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				"is protected and its settings differ from the policy. Re-run with -y (or --allow-protected --update-existing)",
			);
			expect(await remoteMinCu()).toBe(0.5);
		});

		it("--update-existing alone still needs --allow-protected", async () => {
			const result = await deploy("--update-existing");
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				"is protected. Re-run with --allow-protected (or -y) to apply to it.",
			);
			expect(await remoteMinCu()).toBe(0.5);
		});

		it("--allow-protected alone still needs --update-existing", async () => {
			const result = await deploy("--allow-protected");
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				"Re-run with --update-existing (or -y) to apply the changes shown above.",
			);
			expect(await remoteMinCu()).toBe(0.5);
		});

		it.each([
			["n", "an explicit no"],
			["\r", "the default"],
		])("in a terminal, %j (%s) aborts and changes nothing", async (answer) => {
			const result = await deployInTerminal(answer);
			expect(result.code).toBe(1);
			expect(result.output).toContain("is protected, and this overrides");
			expect(result.output).toContain("Aborted: nothing was applied");
			expect(await remoteMinCu()).toBe(0.5);
		});

		it("in a terminal, y applies", async () => {
			const result = await deployInTerminal("y");
			expect(result.code, result.output).toBe(0);
			expect(await remoteMinCu()).toBe(0.25);
		});

		it("in a terminal, -o json does not prompt", async () => {
			writePolicy(0.5);
			const result = await deployInTerminal("y", "-o", "json");
			expect(result.code).toBe(1);
			expect(result.output).not.toContain("Apply anyway?");
			expect(await remoteMinCu()).toBe(0.25);
		});

		it("--allow-protected --update-existing applies", async () => {
			const result = await deploy(
				"--allow-protected",
				"--update-existing",
			);
			expect(result.code, result.stderr).toBe(0);
			expect(await remoteMinCu()).toBe(0.5);
		});

		it("config apply -y applies", async () => {
			writePolicy(0.25);
			const result = await runCli(
				["config", "apply", "-y", ...targetFlags()],
				{ cwd },
			);
			expect(result.code, result.stderr).toBe(0);
			expect(await remoteMinCu()).toBe(0.25);
		});

		it("without drift, needs only --allow-protected", async () => {
			const refused = await deploy();
			expect(refused.code).toBe(1);
			expect(refused.stderr).toContain(
				"is protected. Re-run with --allow-protected (or -y) to apply to it.",
			);

			const allowed = await deploy("--allow-protected");
			expect(allowed.code, allowed.stderr).toBe(0);
		});
	});
});
