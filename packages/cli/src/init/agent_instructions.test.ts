import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
	describeAgentInstructionOutcome,
	NEON_AGENT_SECTION,
	NEON_SECTION_BEGIN,
	NEON_SECTION_END,
	NeonSectionMarkersError,
	upsertNeonSection,
	writeAgentInstructions,
} from "./agent_instructions.js";

const read = (dir: string, name: string): string =>
	readFileSync(join(dir, name), "utf8");

describe("upsertNeonSection", () => {
	test("a missing or empty file becomes the section alone", () => {
		expect(upsertNeonSection(undefined)).toEqual({
			content: `${NEON_AGENT_SECTION}\n`,
			action: "created",
		});
		expect(upsertNeonSection("  \n")).toEqual({
			content: `${NEON_AGENT_SECTION}\n`,
			action: "created",
		});
	});

	test("a file without markers keeps its content and gets the section appended", () => {
		const existing = "# My project\n\nUse pnpm.\n";
		expect(upsertNeonSection(existing)).toEqual({
			content: `${existing}\n${NEON_AGENT_SECTION}\n`,
			action: "added",
		});
	});

	test("appending adds the blank line when the file lacks a final newline", () => {
		expect(upsertNeonSection("# Notes").content).toBe(
			`# Notes\n\n${NEON_AGENT_SECTION}\n`,
		);
	});

	test("an existing section is replaced in place, keeping content on both sides", () => {
		const before = "# My project\n\nUse pnpm.\n\n";
		const after = "\n## Deploys\n\nRun deploy.sh.\n";
		const stale = `${NEON_SECTION_BEGIN}\nold text\n${NEON_SECTION_END}`;
		const result = upsertNeonSection(`${before}${stale}${after}`);
		expect(result.action).toBe("updated");
		expect(result.content).toBe(`${before}${NEON_AGENT_SECTION}${after}`);
	});

	test("re-running on an up-to-date file changes nothing", () => {
		const once = upsertNeonSection("# Notes\n").content;
		expect(upsertNeonSection(once)).toEqual({
			content: once,
			action: "unchanged",
		});
	});

	test("a lone marker is refused rather than guessed at", () => {
		expect(() =>
			upsertNeonSection(`intro\n${NEON_SECTION_BEGIN}\nno end\n`),
		).toThrow(NeonSectionMarkersError);
		expect(() => upsertNeonSection(`intro\n${NEON_SECTION_END}\n`)).toThrow(
			NeonSectionMarkersError,
		);
	});

	test("repeated or reversed markers are refused", () => {
		const pair = `${NEON_SECTION_BEGIN}\nx\n${NEON_SECTION_END}`;
		expect(() => upsertNeonSection(`${pair}\n${pair}\n`)).toThrow(
			NeonSectionMarkersError,
		);
		expect(() =>
			upsertNeonSection(`${NEON_SECTION_END}\n${NEON_SECTION_BEGIN}\n`),
		).toThrow(NeonSectionMarkersError);
	});
});

describe("writeAgentInstructions", () => {
	let cwd: string;
	let outside: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "neon-agent-instructions-"));
		outside = mkdtempSync(join(tmpdir(), "neon-agent-outside-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	test("creates AGENTS.md and no CLAUDE.md when Claude Code is not involved", () => {
		const outcomes = writeAgentInstructions({ cwd, claudeCode: false });

		expect(outcomes).toEqual([{ file: "AGENTS.md", action: "created" }]);
		expect(read(cwd, "AGENTS.md")).toBe(`${NEON_AGENT_SECTION}\n`);
		expect(() => read(cwd, "CLAUDE.md")).toThrow();
	});

	test("creates a CLAUDE.md that imports AGENTS.md when Claude Code is involved", () => {
		const outcomes = writeAgentInstructions({ cwd, claudeCode: true });

		expect(outcomes).toEqual([
			{ file: "AGENTS.md", action: "created" },
			{ file: "CLAUDE.md", action: "import-created" },
		]);
		expect(read(cwd, "CLAUDE.md")).toBe("@AGENTS.md\n");
	});

	test("leaves a CLAUDE.md that already imports AGENTS.md alone", () => {
		writeFileSync(join(cwd, "CLAUDE.md"), "# Claude\n\n@AGENTS.md\n");

		const outcomes = writeAgentInstructions({ cwd, claudeCode: true });

		expect(outcomes[1]).toEqual({
			file: "CLAUDE.md",
			action: "imports-agents",
		});
		expect(read(cwd, "CLAUDE.md")).toBe("# Claude\n\n@AGENTS.md\n");
	});

	test("adds the marker section to an existing CLAUDE.md without the import", () => {
		writeFileSync(
			join(cwd, "CLAUDE.md"),
			"# Claude notes\n\nUse vitest.\n",
		);

		const outcomes = writeAgentInstructions({ cwd, claudeCode: true });

		expect(outcomes[1]).toEqual({ file: "CLAUDE.md", action: "added" });
		expect(read(cwd, "CLAUDE.md")).toBe(
			`# Claude notes\n\nUse vitest.\n\n${NEON_AGENT_SECTION}\n`,
		);
	});

	test("updates an existing AGENTS.md in place and keeps the user's content", () => {
		const userBefore = "# Team rules\n\nNo force pushes.\n\n";
		const userAfter = "\n## Release\n\nTag from main.\n";
		writeFileSync(
			join(cwd, "AGENTS.md"),
			`${userBefore}${NEON_SECTION_BEGIN}\nstale\n${NEON_SECTION_END}${userAfter}`,
		);

		const outcomes = writeAgentInstructions({ cwd, claudeCode: false });

		expect(outcomes).toEqual([{ file: "AGENTS.md", action: "updated" }]);
		expect(read(cwd, "AGENTS.md")).toBe(
			`${userBefore}${NEON_AGENT_SECTION}${userAfter}`,
		);
	});

	test("a second run is a no-op for both files", () => {
		writeAgentInstructions({ cwd, claudeCode: true });
		const agents = read(cwd, "AGENTS.md");
		const claude = read(cwd, "CLAUDE.md");

		const outcomes = writeAgentInstructions({ cwd, claudeCode: true });

		expect(outcomes).toEqual([
			{ file: "AGENTS.md", action: "unchanged" },
			{ file: "CLAUDE.md", action: "imports-agents" },
		]);
		expect(read(cwd, "AGENTS.md")).toBe(agents);
		expect(read(cwd, "CLAUDE.md")).toBe(claude);
	});

	test("a CLAUDE.md symlinked to AGENTS.md gets the section once", () => {
		symlinkSync("AGENTS.md", join(cwd, "CLAUDE.md"));

		const outcomes = writeAgentInstructions({ cwd, claudeCode: true });

		expect(outcomes).toEqual([
			{ file: "AGENTS.md", action: "created" },
			{ file: "CLAUDE.md", action: "unchanged" },
		]);
		expect(read(cwd, "AGENTS.md").split(NEON_SECTION_BEGIN)).toHaveLength(
			2,
		);
	});

	test("a symlink that points outside the project is not written through", () => {
		const target = join(outside, "shared-rules.md");
		writeFileSync(target, "shared\n");
		symlinkSync(target, join(cwd, "AGENTS.md"));

		const outcomes = writeAgentInstructions({ cwd, claudeCode: false });

		expect(outcomes[0]).toMatchObject({
			file: "AGENTS.md",
			action: "failed",
		});
		expect(outcomes[0]?.reason).toContain("outside the project directory");
		expect(readFileSync(target, "utf8")).toBe("shared\n");
	});

	test("malformed markers fail that file without stopping CLAUDE.md", () => {
		writeFileSync(
			join(cwd, "AGENTS.md"),
			`${NEON_SECTION_BEGIN}\nno end\n`,
		);
		const original = read(cwd, "AGENTS.md");

		const outcomes = writeAgentInstructions({ cwd, claudeCode: true });

		expect(outcomes[0]).toMatchObject({
			file: "AGENTS.md",
			action: "failed",
		});
		expect(read(cwd, "AGENTS.md")).toBe(original);
		expect(outcomes[1]).toEqual({
			file: "CLAUDE.md",
			action: "import-created",
		});
	});
});

describe("describeAgentInstructionOutcome", () => {
	test("names only the changes a user should see", () => {
		expect(
			describeAgentInstructionOutcome({
				file: "AGENTS.md",
				action: "created",
			}),
		).toBe("Created AGENTS.md with the Neon section.");
		expect(
			describeAgentInstructionOutcome({
				file: "AGENTS.md",
				action: "updated",
			}),
		).toBe("Updated the Neon section in AGENTS.md.");
		expect(
			describeAgentInstructionOutcome({
				file: "CLAUDE.md",
				action: "import-created",
			}),
		).toBe("Created CLAUDE.md importing AGENTS.md.");
		expect(
			describeAgentInstructionOutcome({
				file: "AGENTS.md",
				action: "unchanged",
			}),
		).toBeNull();
		expect(
			describeAgentInstructionOutcome({
				file: "CLAUDE.md",
				action: "imports-agents",
			}),
		).toBeNull();
	});
});
