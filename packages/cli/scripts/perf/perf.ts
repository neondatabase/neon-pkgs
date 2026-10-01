// Wall-clock timing of the offline CLI scenarios, for before/after comparisons of builds.
// Usage and the agent workflow: "Performance budgets" in packages/cli/AGENTS.md.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import {
	CLI_ENTRY,
	createIdentifier,
	createSandbox,
	runCli,
	type Sandbox,
	SCENARIOS,
	type Scenario,
	scenarioArgv,
} from "./scenarios.js";

const USAGE = `Usage: pnpm --filter neon perf [--cli <absolute path to dist/cli.js>]... [--runs N] [--scenario=<name>]... [--profile] [--json]

  --cli       CLI entry to measure; repeat to compare builds (first is the baseline). Default: this checkout's dist/cli.js
  --runs      timed samples per scenario and CLI (default 20, after 2 warmup runs)
  --scenario  limit to a scenario by name; use the = form, e.g. --scenario=--help; repeatable
  --profile   instead of timing, CPU-profile one run per scenario and CLI and print self time by module
  --json      print raw samples and environment as JSON`;

const out = (text = ""): void => {
	process.stdout.write(`${text}\n`);
};
const fail = (text: string): never => {
	process.stderr.write(`${text}\n`);
	process.exit(2);
};

const { values } = parseArgs({
	options: {
		cli: { type: "string", multiple: true },
		runs: { type: "string", default: "20" },
		scenario: { type: "string", multiple: true },
		profile: { type: "boolean", default: false },
		json: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
	},
});

if (values.help) {
	out(USAGE);
	process.exit(0);
}

const clis = values.cli ?? [CLI_ENTRY];
const relativeCli = clis.find((cli) => !isAbsolute(cli));
if (relativeCli) {
	fail(
		`--cli must be an absolute path (pnpm --filter runs this script from packages/cli, so a relative path would not mean what it looks like): ${relativeCli}\n\n${USAGE}`,
	);
}

const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1) {
	fail(`--runs must be a positive integer, got ${values.runs}\n\n${USAGE}`);
}

// API scenarios are network-bound for real users; their regression signal is the request
// budget in perf_budget.test.ts, not wall time against a local mock.
const offline = SCENARIOS.filter((s) => !s.api);
const scenarios = values.scenario
	? offline.filter((s) => values.scenario?.includes(s.name))
	: offline;
const unknown = (values.scenario ?? []).filter(
	(name) => !offline.some((s) => s.name === name),
);
if (unknown.length > 0) {
	fail(
		`Unknown scenario: ${unknown.join(", ")}. Offline scenarios: ${offline.map((s) => JSON.stringify(s.name)).join(", ")}`,
	);
}

const runScenario = async (
	cli: string,
	scenario: Scenario,
	sandbox: Sandbox,
	nodeArgs: string[] = [],
): Promise<number> => {
	const start = process.hrtime.bigint();
	const run = await runCli({
		cli,
		argv: scenarioArgv(scenario, undefined),
		cwd: scenario.linked ? sandbox.linked : sandbox.home,
		env: sandbox.env,
		nodeArgs,
	});
	const ms = Number(process.hrtime.bigint() - start) / 1e6;
	if (run.code !== scenario.expect.code) {
		throw new Error(
			`${cli} ${scenario.name} exited ${run.code}, expected ${scenario.expect.code}. A failing command can look fast, so no timing is reported.\nstderr: ${run.stderr}`,
		);
	}
	return ms;
};

const quantile = (sorted: number[], q: number): number =>
	sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

const time = async (sandbox: Sandbox) => {
	// Indexed like `clis`, so comparing a build with itself (a noise check) keeps both series.
	const samples: Record<string, number[][]> = {};
	for (const scenario of scenarios) {
		samples[scenario.name] = clis.map(() => []);
		for (let i = 0; i < 2; i++) {
			for (const cli of clis) {
				await runScenario(cli, scenario, sandbox);
			}
		}
		// Alternate CLIs sample by sample so machine drift hits every build equally.
		for (let i = 0; i < runs; i++) {
			for (const [index, cli] of clis.entries()) {
				samples[scenario.name][index].push(
					await runScenario(cli, scenario, sandbox),
				);
			}
		}
	}

	if (values.json) {
		out(
			JSON.stringify(
				{
					node: process.version,
					platform: `${process.platform}-${process.arch}`,
					runs,
					clis,
					samples,
				},
				null,
				2,
			),
		);
		return;
	}

	out(
		`Node ${process.version}, ${process.platform}-${process.arch}, ${runs} runs per scenario and CLI`,
	);
	clis.forEach((cli, i) => {
		out(`  [${i}] ${cli}`);
	});
	out("");
	for (const scenario of scenarios) {
		const medians = samples[scenario.name].map((series) => {
			const sorted = [...series].sort((a, b) => a - b);
			return {
				median: quantile(sorted, 0.5),
				p90: quantile(sorted, 0.9),
			};
		});
		const cells = medians.map(
			(m, i) =>
				`[${i}] median ${m.median.toFixed(0)}ms p90 ${m.p90.toFixed(0)}ms${
					i > 0
						? ` (${signed(m.median - medians[0].median)}ms, ${signed(
								((m.median - medians[0].median) /
									medians[0].median) *
									100,
							)}%)`
						: ""
				}`,
		);
		out(`${`neon ${scenario.name}`.padEnd(32)} ${cells.join("   ")}`);
	}
};

const signed = (n: number): string =>
	`${n >= 0 ? "+" : ""}${n.toFixed(Math.abs(n) < 10 ? 1 : 0)}`;

type CpuProfile = {
	nodes: Array<{ id: number; callFrame: { url: string } }>;
	samples: number[];
	timeDeltas: number[];
};

const selfTimeByModule = (
	profile: CpuProfile,
	identify: (url: string) => string,
): Record<string, number> => {
	const urlById = new Map(profile.nodes.map((n) => [n.id, n.callFrame.url]));
	const totals: Record<string, number> = {};
	profile.samples.forEach((id, i) => {
		const url = urlById.get(id) ?? "";
		const key = url.startsWith("file:")
			? identify(url)
			: url.startsWith("node:")
				? "node internals (module loader, builtins)"
				: "native, GC, idle";
		totals[key] = (totals[key] ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000;
	});
	return totals;
};

const profile = async (sandbox: Sandbox) => {
	const identify = createIdentifier();
	const report: Record<string, Array<Record<string, number>>> = {};
	for (const scenario of scenarios) {
		report[scenario.name] = [];
		for (const cli of clis) {
			const dir = mkdtempSync(join(tmpdir(), "neon-perf-prof-"));
			await runScenario(cli, scenario, sandbox, [
				"--cpu-prof",
				`--cpu-prof-dir=${dir}`,
			]);
			const [file] = readdirSync(dir);
			const data: CpuProfile = JSON.parse(
				readFileSync(join(dir, file), "utf8"),
			);
			report[scenario.name].push(selfTimeByModule(data, identify));
			if (!values.json) {
				process.stderr.write(`profile: ${join(dir, file)}\n`);
			}
		}
	}

	if (values.json) {
		out(
			JSON.stringify(
				{ node: process.version, clis, selfTimeMs: report },
				null,
				2,
			),
		);
		return;
	}

	for (const scenario of scenarios) {
		const perCli = report[scenario.name];
		const keys = [...new Set(perCli.flatMap((r) => Object.keys(r)))];
		const delta = (key: string) =>
			(perCli[perCli.length - 1][key] ?? 0) - (perCli[0][key] ?? 0);
		const baseline = (key: string) => perCli[0][key] ?? 0;
		keys.sort(
			(a, b) =>
				(clis.length > 1
					? Math.abs(delta(b)) - Math.abs(delta(a))
					: 0) || baseline(b) - baseline(a),
		);
		out(
			`\nneon ${scenario.name}: CPU self time by module${clis.length > 1 ? `, sorted by change from [0] to [${clis.length - 1}]` : ""}`,
		);
		for (const key of keys.slice(0, 15)) {
			const cells = perCli.map(
				(r) => `${(r[key] ?? 0).toFixed(1).padStart(7)}ms`,
			);
			const change = clis.length > 1 ? `  (${signed(delta(key))}ms)` : "";
			out(`  ${cells.join(" ")}${change}  ${key}`);
		}
	}
};

const sandbox = createSandbox();
try {
	await (values.profile ? profile(sandbox) : time(sandbox));
} finally {
	sandbox.cleanup();
}
