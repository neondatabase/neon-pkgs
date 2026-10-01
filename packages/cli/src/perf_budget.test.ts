import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect } from "vitest";
import {
	type Budgets,
	buildInventory,
	formatModuleFailure,
	formatRequestFailure,
	formatShrinkNote,
	growth,
	importChain,
	type ScenarioMeasurement,
	sortKeys,
	UPDATE_COMMAND,
} from "../scripts/perf/budget.js";
import {
	BUDGETS_PATH,
	createIdentifier,
	createSandbox,
	runCliWithModuleLog,
	SCENARIOS,
	scenarioArgv,
} from "../scripts/perf/scenarios.js";
import { test } from "./test_utils/fixtures.js";

// Startup cost of the CLI is dominated by how many modules it loads, and the cost of an API
// command by how many round trips it makes. Both are exact counts, so unlike wall time they
// can gate CI. See "Performance budgets" in packages/cli/AGENTS.md.

if (!("registerHooks" in nodeModule)) {
	throw new Error(
		`perf_budget.test.ts needs module.registerHooks (Node >= 22.15); this is Node ${process.versions.node}.`,
	);
}

const updating = process.env.PERF_BUDGETS_UPDATE === "1";
const identify = createIdentifier();
const budgets: Budgets | undefined = existsSync(BUDGETS_PATH)
	? JSON.parse(readFileSync(BUDGETS_PATH, "utf8"))
	: undefined;
const measured: Record<string, ScenarioMeasurement> = {};

describe("performance budgets", () => {
	for (const scenario of SCENARIOS) {
		test(`neon ${scenario.name}`, async ({ runMockServer }) => {
			const sandbox = createSandbox();
			try {
				const requests: string[] = [];
				const apiHost = scenario.api
					? `http://localhost:${
							(
								(
									await runMockServer("main", (r) =>
										requests.push(`${r.method} ${r.path}`),
									)
								).address() as AddressInfo
							).port
						}`
					: undefined;

				const { run, log } = await runCliWithModuleLog({
					argv: scenarioArgv(scenario, apiHost),
					cwd: scenario.linked ? sandbox.linked : sandbox.home,
					env: sandbox.env,
					logDir: sandbox.home,
				});

				const context = `neon ${scenario.name} must succeed before its budget means anything.\nstdout: ${run.stdout}\nstderr: ${run.stderr}`;
				expect(run.code, context).toBe(scenario.expect.code);
				if (scenario.expect.stdout) {
					expect(run.stdout, context).toMatch(scenario.expect.stdout);
				}
				if (scenario.expect.stderr) {
					expect(run.stderr, context).toMatch(scenario.expect.stderr);
				}

				const measurement: ScenarioMeasurement = {
					modules: log.loaded.length,
					requests: buildInventory(requests),
					inventory: buildInventory(log.loaded.map(identify)),
				};

				if (updating) {
					measured[scenario.name] = measurement;
					return;
				}

				const budget = budgets?.scenarios[scenario.name];
				if (!budget) {
					expect.fail(
						`No budget recorded for \`neon ${scenario.name}\`. Record one: ${UPDATE_COMMAND}`,
					);
				}

				const failures: string[] = [];
				if (measurement.modules > budget.modules) {
					failures.push(
						formatModuleFailure({
							scenario: scenario.name,
							budget: budget.modules,
							actual: measurement.modules,
							culprits: growth(
								budget.inventory,
								measurement.inventory,
							).map((culprit) => {
								const firstUrl = log.loaded.find(
									(url) => identify(url) === culprit.identity,
								);
								return {
									...culprit,
									chain: firstUrl
										? importChain(log, firstUrl, identify)
										: [culprit.identity],
								};
							}),
						}),
					);
				}

				if (growth(budget.requests, measurement.requests).length > 0) {
					failures.push(
						formatRequestFailure({
							scenario: scenario.name,
							budget: budget.requests,
							actual: measurement.requests,
						}),
					);
				}
				if (failures.length > 0) {
					expect.fail(failures.join("\n\n"));
				}

				const note = formatShrinkNote(
					scenario.name,
					budget.modules,
					measurement.modules,
				);
				if (note) {
					process.stderr.write(`${note}\n`);
				}
			} finally {
				sandbox.cleanup();
			}
		}, 30_000);
	}

	afterAll(() => {
		if (!updating) {
			return;
		}
		const missing = SCENARIOS.filter((s) => !measured[s.name]);
		if (missing.length > 0) {
			throw new Error(
				`Not writing ${BUDGETS_PATH}: ${missing.map((s) => s.name).join(", ")} did not complete.`,
			);
		}
		const next: Budgets = { scenarios: sortKeys(measured) };
		writeFileSync(BUDGETS_PATH, `${JSON.stringify(next, null, "\t")}\n`);
	});
});
