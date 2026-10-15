import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { apiRequest, configuredOrgId } from "@neon/e2e-harness";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readEnvFile } from "../src/env_file.js";
import type { EnvReport } from "./fixtures/env-contract/report.js";
import {
	createProject,
	deleteProject,
	runCli,
	spawnCli,
	uniqueProjectName,
} from "./helpers.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures", "env-contract");
const POLICY = join(FIXTURE, "neon.ts");
const CONTEXT_FILE = join(FIXTURE, ".neon");
const DOTENV = join(FIXTURE, ".env.local");
const READY_TIMEOUT_MS = 90_000;

/** Variables only one side can have: the function's own URL, and its declared env. */
type Runtime = "pulled" | "dev" | "deployed" | "devSource" | "devExplicit";

const FUNCTION_KEYS = new Set([
	"NEON_FUNCTION_PROBE_BASE_URL",
	"PROBE_SETTING",
	"PROBE_EXTRA",
]);

function withoutFunctionKeys(keys: string[]): string[] {
	return keys.filter((key) => !FUNCTION_KEYS.has(key));
}

function withoutFunctions(namespaces: string[]): string[] {
	return namespaces.filter((namespace) => namespace !== "functions");
}

function namespaces(report: EnvReport, form: "external" | "scoped"): string[] {
	const outcome = report[form];
	if (!outcome.ok) {
		throw new Error(`parseEnv (${form}) threw:\n${outcome.error}`);
	}
	return outcome.namespaces;
}

/** The URL `neon dev` prints once its server is listening, matched by `pattern`. */
async function devUrl(output: () => string, pattern: RegExp): Promise<string> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const match = pattern.exec(output());
		if (match?.[1]) return match[1];
		if (output().includes("ERROR:"))
			throw new Error("neon dev failed to start");
		await new Promise((wait) => setTimeout(wait, 500));
	}
	throw new Error("neon dev never printed the probe URL");
}

/** Start `neon dev` with `args` in the fixture, read the probe's report, and stop it. */
async function devReport(args: string[], pattern: RegExp): Promise<EnvReport> {
	const dev = spawnCli(["dev", ...args], {
		cwd: FIXTURE,
		contextFile: CONTEXT_FILE,
		json: false,
	});
	let output = "";
	dev.stdout.on("data", (chunk) => {
		output += String(chunk);
	});
	dev.stderr.on("data", (chunk) => {
		output += String(chunk);
	});
	const closed = once(dev, "close");
	try {
		return await fetchReport(await devUrl(() => output, pattern));
	} catch (error) {
		throw new Error(
			`neon dev ${args.join(" ")}: ${String(error)}\noutput:\n${output}`,
		);
	} finally {
		dev.kill("SIGTERM");
		await closed;
	}
}

/** GET `url` until it answers 200, for cold starts and dev-server startup. */
async function fetchReport(url: string): Promise<EnvReport> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	let last = "no response";
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
			});
			if (response.ok) return (await response.json()) as EnvReport;
			last = `HTTP ${response.status}: ${await response.text()}`;
		} catch (error) {
			last = error instanceof Error ? error.message : String(error);
		}
		await new Promise((wait) => setTimeout(wait, 2_000));
	}
	throw new Error(`${url} never answered 200. Last: ${last}`);
}

/**
 * `parseEnv` reads `process.env` and nothing else, so it is only correct if the variables
 * it requires are the ones each runtime actually provides. This deploys one Function with
 * every production service enabled and asks `parseEnv` the same questions in all three
 * places a Neon app runs: the app's own process after `neon env pull`, the Function under
 * `neon dev`, and the deployed Function.
 */
describe.sequential("e2e — parseEnv matches the env each runtime provides", () => {
	let projectId: string;
	let tmp: string;
	const collected: Partial<Record<Runtime, EnvReport>> = {};
	const report = (where: Runtime): EnvReport => {
		const found = collected[where];
		if (!found) throw new Error(`no env report from ${where}`);
		return found;
	};

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "neon-env-contract-e2e-"));
		writeFileSync(
			DOTENV,
			"PROBE_SETTING=probe-value\nPROBE_EXTRA=undeclared\n",
		);
		projectId = await createProject({
			name: uniqueProjectName("cli-env-contract"),
		});
		const { branches } = await apiRequest<{
			branches: { id: string; name: string; default?: boolean }[];
		}>(`/projects/${projectId}/branches`);
		const branch = branches.find((candidate) => candidate.default);
		if (!branch) throw new Error("project has no default branch");
		const target = ["--project-id", projectId, "--branch", branch.id];

		const deployed = await runCli(
			[
				"deploy",
				"-y",
				...target,
				"--config",
				POLICY,
				"--env",
				DOTENV,
				"--no-env-pull",
			],
			{ cwd: FIXTURE },
		);
		if (deployed.code !== 0) {
			throw new Error(
				`neon deploy exited ${deployed.code}:\n${deployed.stderr}`,
			);
		}

		const fn = await runCli(["functions", "get", "probe", ...target], {
			cwd: FIXTURE,
		});
		if (fn.code !== 0) {
			throw new Error(
				`neon functions get exited ${fn.code}:\n${fn.stderr}`,
			);
		}
		const { invocation_url } = JSON.parse(fn.stdout) as {
			invocation_url: string;
		};
		collected.deployed = await fetchReport(invocation_url);

		const envFile = join(tmp, ".env.pulled");
		const pulled = await runCli(
			["env", "pull", ...target, "--config", POLICY, "--file", envFile],
			{ cwd: FIXTURE, json: false },
		);
		if (pulled.code !== 0) {
			throw new Error(
				`neon env pull exited ${pulled.code}:\n${pulled.stderr}`,
			);
		}
		for (const key of Object.keys(process.env)) {
			if (
				/^(DATABASE_URL|NEON_|AWS_)/.test(key) &&
				key !== "NEON_API_KEY"
			) {
				vi.stubEnv(key, undefined);
			}
		}
		for (const [key, value] of Object.entries(readEnvFile(envFile))) {
			vi.stubEnv(key, value);
		}
		// The runner imports neon.ts itself, so it needs PROBE_SETTING to evaluate it. The
		// value is removed before reporting and before any `neon dev` inherits this env.
		vi.stubEnv("PROBE_SETTING", "probe-value");
		const { envReport } = await import("./fixtures/env-contract/report.js");
		vi.stubEnv("PROBE_SETTING", undefined);
		collected.pulled = envReport();
		vi.unstubAllEnvs();

		// `neon dev` finds neon.ts next to the context file, not in its cwd.
		writeFileSync(
			CONTEXT_FILE,
			JSON.stringify({
				...(configuredOrgId() ? { orgId: configuredOrgId() } : {}),
				projectId,
				branch: branch.name,
			}),
		);
		const slugUrl = /probe\s+(http:\/\/localhost:\d+)/;
		collected.dev = await devReport([], slugUrl);
		collected.devSource = await devReport(
			["--source", "./probe.ts"],
			/(http:\/\/localhost:\d+)/,
		);
		const explicit = join(tmp, "explicit.env");
		writeFileSync(explicit, "PROBE_SETTING=from-explicit\n");
		collected.devExplicit = await devReport(["--env", explicit], slugUrl);
	}, 600_000);

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
		if (tmp) rmSync(tmp, { recursive: true, force: true });
		rmSync(CONTEXT_FILE, { force: true });
		rmSync(DOTENV, { force: true });
	});

	it.each([
		"pulled",
		"dev",
		"deployed",
	] as const)("parseEnv(config) succeeds (%s)", (where) => {
		expect(namespaces(report(where), "external")).toContain("postgres");
	});

	it.each([
		"dev",
		"deployed",
	] as const)('parseEnv(config, "probe") succeeds inside the function (%s)', (where) => {
		expect(namespaces(report(where), "scoped")).toContain("function");
		expect(report(where).values.PROBE_SETTING).toBe("probe-value");
	});

	it("neon dev passes undeclared .env.local keys to the function", () => {
		expect(report("dev").values.PROBE_EXTRA).toBe("undeclared");
		expect(report("devSource").values.PROBE_SETTING).toBe("probe-value");
		expect(report("devSource").values.PROBE_EXTRA).toBe("undeclared");
		expect(report("deployed").values.PROBE_EXTRA).toBeUndefined();
	});

	it("neon dev --env loads that file instead of .env.local", () => {
		expect(namespaces(report("devExplicit"), "scoped")).toContain(
			"function",
		);
		expect(report("devExplicit").values.PROBE_SETTING).toBe(
			"from-explicit",
		);
		expect(report("devExplicit").values.PROBE_EXTRA).toBeUndefined();
	});

	it("the deployed runtime provides the variables neon env pull writes", () => {
		expect(withoutFunctionKeys(report("deployed").keys)).toEqual(
			withoutFunctionKeys(report("pulled").keys),
		);
		expect(withoutFunctionKeys(report("dev").keys)).toEqual(
			withoutFunctionKeys(report("pulled").keys),
		);
	});

	it("parseEnv returns the same namespaces everywhere", () => {
		const pulled = namespaces(report("pulled"), "external");
		expect(pulled).toContain("functions");
		expect(namespaces(report("dev"), "external")).toEqual(pulled);
		expect(
			withoutFunctions(namespaces(report("deployed"), "external")),
		).toEqual(withoutFunctions(pulled));
	});

	it("non-secret values agree everywhere", () => {
		const { NEON_FUNCTION_PROBE_BASE_URL: pulledUrl, ...pulled } =
			report("pulled").values;
		const {
			NEON_FUNCTION_PROBE_BASE_URL: devUrl,
			PROBE_SETTING: _dev,
			PROBE_EXTRA: _devExtra,
			...dev
		} = report("dev").values;
		const {
			NEON_FUNCTION_PROBE_BASE_URL: deployedUrl,
			PROBE_SETTING: _deployed,
			...deployed
		} = report("deployed").values;

		expect(dev).toEqual(pulled);
		expect(deployed).toEqual(pulled);
		expect(report("dev").databaseHost).toBe(report("pulled").databaseHost);
		expect(report("deployed").databaseHost).toBe(
			report("pulled").databaseHost,
		);

		expect(pulledUrl).toMatch(/^https:\/\//);
		expect(devUrl).toMatch(/^http:\/\/localhost:\d+$/);
		// Not injected by the runtime yet; when it is, it must be the URL env pull writes.
		if (deployedUrl !== undefined) expect(deployedUrl).toBe(pulledUrl);
	});
});
