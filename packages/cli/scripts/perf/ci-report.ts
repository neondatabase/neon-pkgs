// Turns `pnpm --filter neon perf --cli <base> --cli <head> --json` into the CI wall-time report,
// exiting 1 when a scenario is slower than both thresholds.
// Workflow: .github/workflows/cli-perf.yml. Agent workflow: "Performance budgets" in
// packages/cli/AGENTS.md.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

type PerfRun = {
	node: string;
	platform: string;
	runs: number;
	clis: string[];
	/** Scenario name → one sample series per CLI, in `clis` order. */
	samples: Record<string, number[][]>;
};

type Row = {
	scenario: string;
	baseMs: number;
	headMs: number;
	deltaMs: number;
	deltaPct: number;
};

type Thresholds = { ms: number; pct: number };

const median = (series: number[]): number => {
	const sorted = [...series].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
};

const compare = (run: PerfRun): Row[] =>
	Object.entries(run.samples).map(([scenario, [base, head]]) => {
		const baseMs = median(base);
		const headMs = median(head);
		return {
			scenario,
			baseMs,
			headMs,
			deltaMs: headMs - baseMs,
			deltaPct: ((headMs - baseMs) / baseMs) * 100,
		};
	});

/** A regression must clear both bars: small scenarios swing by percent, large ones by ms. */
const regressions = (rows: Row[], thresholds: Thresholds): Row[] =>
	rows.filter(
		(row) => row.deltaMs > thresholds.ms && row.deltaPct > thresholds.pct,
	);

const signed = (n: number, digits = 0): string =>
	`${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;

const CLI_PAIR =
	'--cli "$BASE_ROOT/packages/cli/dist/cli.js" --cli "$HEAD_ROOT/packages/cli/dist/cli.js"';

const reproduceCommands = (baseSha: string, thresholds: Thresholds): string =>
	[
		`BASE=${baseSha}`,
		'HEAD_ROOT="$(git rev-parse --show-toplevel)"',
		'BASE_ROOT="$(mktemp -d)/neon-pkgs-base"',
		'git -C "$HEAD_ROOT" worktree add --detach "$BASE_ROOT" "$BASE" && (cd "$BASE_ROOT" && pnpm install --frozen-lockfile && pnpm --filter neon... build)',
		verifyCommand(thresholds),
	].join("\n");

const verifyCommand = (thresholds: Thresholds): string =>
	`(cd "$HEAD_ROOT" && pnpm --filter neon... build && pnpm --silent --filter neon perf --json ${CLI_PAIR} > "$BASE_ROOT/perf.json" && pnpm --silent --filter neon perf:ci-report --input "$BASE_ROOT/perf.json" --base-sha "$BASE" --head-sha "$(git rev-parse HEAD)" --threshold-ms ${thresholds.ms} --threshold-pct ${thresholds.pct})`;

const formatReport = (input: {
	run: PerfRun;
	rows: Row[];
	regressed: Row[];
	thresholds: Thresholds;
	baseSha: string;
	headSha: string;
}): string => {
	const { run, rows, regressed, thresholds } = input;
	const bar = `${signed(thresholds.ms)}ms and ${signed(thresholds.pct, 1)}%`;
	const lines = [
		`CLI wall time: base ${input.baseSha.slice(0, 10)} vs head ${input.headSha.slice(0, 10)} (Node ${run.node}, ${run.platform}, ${run.runs} interleaved runs per build)`,
		"",
		"| Scenario | Base median | Head median | Change |",
		"| --- | ---: | ---: | ---: |",
		...rows.map(
			(r) =>
				`| \`neon ${r.scenario}\` | ${r.baseMs.toFixed(0)}ms | ${r.headMs.toFixed(0)}ms | ${signed(r.deltaMs)}ms (${signed(r.deltaPct, 1)}%) |`,
		),
		"",
	];
	if (regressed.length === 0) {
		lines.push(`Result: no scenario slowed by more than ${bar}.`);
		return lines.join("\n");
	}
	lines.push(
		`Result: failing this PR. Slower than ${bar}: ${regressed
			.map((r) => `\`neon ${r.scenario}\` ${signed(r.deltaMs)}ms`)
			.join(", ")}.`,
		"",
		"What to do:",
		"1. Run `pnpm --filter neon test:perf`. A failure there names a module or API request that grew; start with it.",
		"2. Reproduce the slowdown with the same comparison and thresholds as this job, from your checkout's repo root. The last command exits 1 while a scenario is slower than the threshold:",
		"",
		"```sh",
		reproduceCommands(input.baseSha, thresholds),
		"```",
		"",
		"   If it exits 0, re-run this CI job before changing anything. Do not change the thresholds.",
		"3. Find the cause in your diff against $BASE. To see where CPU time moved between the two builds:",
		"",
		"```sh",
		`(cd "$HEAD_ROOT" && pnpm --filter neon... build && pnpm --filter neon perf ${CLI_PAIR} --profile)`,
		"```",
		"",
		'   A profile is one run per build, so its deltas, like the profile printed after this report, are leads to check against the diff. Time spent waiting (I/O, timers) shows up as "native, GC, idle".',
		"4. After the fix, rerun the last command of step 2 until it exits 0.",
	);
	return lines.join("\n");
};

const main = () => {
	const { values } = parseArgs({
		options: {
			input: { type: "string" },
			"base-sha": { type: "string" },
			"head-sha": { type: "string" },
			"threshold-ms": { type: "string" },
			"threshold-pct": { type: "string" },
			"regressed-out": { type: "string" },
		},
	});
	const required = (name: keyof typeof values): string => {
		const value = values[name];
		if (typeof value !== "string" || value === "") {
			process.stderr.write(`ci-report: --${name} is required\n`);
			process.exit(2);
		}
		return value;
	};
	const run: PerfRun = JSON.parse(readFileSync(required("input"), "utf8"));
	if (run.clis.length !== 2) {
		process.stderr.write(
			`ci-report: expected a base and a head CLI, got ${run.clis.length}\n`,
		);
		process.exit(2);
	}
	const thresholds = {
		ms: Number(required("threshold-ms")),
		pct: Number(required("threshold-pct")),
	};
	const rows = compare(run);
	const regressed = regressions(rows, thresholds);
	const report = formatReport({
		run,
		rows,
		regressed,
		thresholds,
		baseSha: required("base-sha"),
		headSha: required("head-sha"),
	});
	process.stdout.write(`${report}\n`);
	if (process.env.GITHUB_STEP_SUMMARY) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
	}
	if (values["regressed-out"]) {
		writeFileSync(
			values["regressed-out"],
			regressed.map((r) => `${r.scenario}\n`).join(""),
		);
	}
	if (regressed.length > 0) {
		process.exit(1);
	}
};

main();
