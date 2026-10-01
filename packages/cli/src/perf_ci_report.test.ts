import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// .github/workflows/cli-perf.yml runs scripts/perf/ci-report.ts and then profiles each line of
// its --regressed-out file with `while IFS= read -r`, which drops an unterminated last line.

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const samples = (ms: number) => Array.from({ length: 5 }, () => ms);

const report = (helpHeadMs: number) => {
	const dir = mkdtempSync(join(tmpdir(), "neon-ci-report-"));
	dirs.push(dir);
	const input = join(dir, "perf.json");
	const regressedOut = join(dir, "regressed.txt");
	writeFileSync(
		input,
		JSON.stringify({
			node: "v22.0.0",
			platform: "linux-x64",
			runs: 5,
			clis: ["/base/dist/cli.js", "/head/dist/cli.js"],
			samples: {
				"--version": [samples(740), samples(742)],
				"--help": [samples(750), samples(helpHeadMs)],
			},
		}),
	);
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"scripts/perf/ci-report.ts",
			"--input",
			input,
			"--base-sha",
			"a".repeat(40),
			"--head-sha",
			"b".repeat(40),
			"--threshold-ms",
			"15",
			"--threshold-pct",
			"1.5",
			"--regressed-out",
			regressedOut,
		],
		{ encoding: "utf8" },
	);
	const linesReadByWorkflow = spawnSync(
		"bash",
		[
			"-c",
			'n=0; while IFS= read -r scenario; do n=$((n+1)); done < "$1"; echo "$n"',
			"bash",
			regressedOut,
		],
		{ encoding: "utf8" },
	).stdout.trim();
	return {
		...result,
		regressed: readFileSync(regressedOut, "utf8"),
		linesReadByWorkflow,
	};
};

describe("ci-report", () => {
	it("passes when no scenario is slower than both thresholds", () => {
		const run = report(760);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain(
			"Result: no scenario slowed by more than +15ms and +1.5%.",
		);
		expect(run.linesReadByWorkflow).toBe("0");
	});

	it("fails on one regressed scenario and hands the workflow a line it reads", () => {
		const run = report(790);
		expect(run.status).toBe(1);
		expect(run.stdout).toContain(
			"Result: failing this PR. Slower than +15ms and +1.5%: `neon --help` +40ms.",
		);
		expect(run.stdout).toContain(`BASE=${"a".repeat(40)}`);
		expect(run.stdout).toContain("--threshold-ms 15 --threshold-pct 1.5");
		expect(run.regressed).toBe("--help\n");
		expect(run.linesReadByWorkflow).toBe("1");
	});
});
