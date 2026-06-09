import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { log, spinner } from "@clack/prompts";
import { execa } from "execa";
import { dim } from "yoctocolors";
import { getSkillsAgentName as getSkillsAgentNameFromId } from "./agents.js";
import type { Editor } from "./types.js";

const SKILL_BASE_URL =
	"https://neon.com/docs/ai/skills/neon-postgres/references";

export const SKILL_REFERENCE_URLS: Record<string, string> = {
	gettingStarted: `${SKILL_BASE_URL}/getting-started.md`,
	connectionMethods: `${SKILL_BASE_URL}/connection-methods.md`,
	neonAuth: `${SKILL_BASE_URL}/neon-auth.md`,
	serverlessDriver: `${SKILL_BASE_URL}/neon-serverless.md`,
	neonCli: `${SKILL_BASE_URL}/neon-cli.md`,
	devtools: `${SKILL_BASE_URL}/devtools.md`,
	branching: `${SKILL_BASE_URL}/branching.md`,
	neonJs: `${SKILL_BASE_URL}/neon-js.md`,
};

/**
 * Fetches the "Getting Started with Neon" skill content from the public URL.
 * Returns the markdown content, or null if the fetch fails.
 */
export async function fetchSkillContent(): Promise<string | null> {
	try {
		const response = await fetch(SKILL_REFERENCE_URLS.gettingStarted, {
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) return null;
		return await response.text();
	} catch {
		return null;
	}
}

/**
 * Maps Editor display names to the skills CLI agent name.
 * Used only by the v1 installAgentSkills function.
 */
function editorToSkillsAgent(editor: Editor): string {
	switch (editor) {
		case "Cursor":
			return "cursor";
		case "VS Code":
		case "GitHub Copilot CLI":
			return "github-copilot";
		case "Claude CLI":
			return "claude-code";
		case "Codex":
			return "codex";
		case "OpenCode":
			return "opencode";
		case "Antigravity":
			return "antigravity";
		case "Cline":
		case "Cline CLI":
			return "cline";
		case "Gemini CLI":
			return "gemini-cli";
		case "Goose":
			return "goose";
		case "Claude Desktop":
			return "claude-code";
		case "MCPorter":
			return "mcporter";
		case "Zed":
			return "zed";
		default:
			return "";
	}
}

export interface InstallSkillsOptions {
	json?: boolean;
	scope?: "global" | "project";
}

/**
 * Installs Neon agent skills using Vercel's skills CLI.
 */
export async function installAgentSkills(
	selectedEditors: Editor[],
	options?: InstallSkillsOptions,
): Promise<boolean> {
	const quiet = options?.json === true;

	const editorsWithSkills = selectedEditors.filter(
		(e) => editorToSkillsAgent(e) !== "",
	);

	if (editorsWithSkills.length === 0) {
		return true;
	}

	const skillsSpinner = quiet ? null : spinner();
	skillsSpinner?.start("Installing agent skills for Neon in this project...");

	let anyFailed = false;

	for (const editor of editorsWithSkills) {
		const agentName = editorToSkillsAgent(editor);

		try {
			await execa(
				"npx",
				[
					"skills",
					"add",
					"neondatabase/agent-skills",
					"--skill",
					"neon-postgres",
					"--agent",
					agentName,
					...(options?.scope === "global" ? ["-g"] : []),
					"-y",
				],
				{
					stdio: "pipe",
					timeout: 10000,
				},
			);
		} catch (error) {
			if (!quiet)
				log.error(
					`Failed to install agent skills for ${editor}: ${error instanceof Error ? error.message : "Unknown error"}`,
				);
			anyFailed = true;
		}
	}

	if (anyFailed) {
		skillsSpinner?.stop(
			"Agent skills installation for this project completed with errors",
		);
		if (!quiet)
			log.info(
				"You can manually install skills by running: npx skills add neondatabase/agent-skills --skill neon-postgres",
			);
		return false;
	}

	skillsSpinner?.stop(dim("Agent skills installed ✓"));
	return true;
}

// ---------------------------------------------------------------------------
// Evergreen skills: ensure skills are up to date (at most once per 12 hours)
// ---------------------------------------------------------------------------

const SKILLS_FRESHNESS_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Agent skills directory paths by agent, keyed by scope.
 * These are the directories that `skills add` writes to.
 */
const GLOBAL_SKILLS_DIRS: Record<string, string[]> = (() => {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return {
		cursor: [resolve(home, ".cursor", "skills")],
		"claude-code": [resolve(home, ".claude", "skills")],
		"github-copilot": [resolve(home, ".vscode", "skills")],
		codex: [resolve(home, ".codex", "skills")],
		cline: [resolve(home, ".cline", "skills")],
	};
})();

/**
 * Checks whether skills were recently updated (within the freshness window).
 * Checks both project-level (skills-lock.json mtime) and global (skills dir mtime).
 */
function skillsAreFresh(agent: string): boolean {
	const now = Date.now();
	const cwd = process.cwd();

	// Check project-level: skills-lock.json must reference neon-postgres
	// AND the skill file must actually exist on disk
	const lockPath = resolve(cwd, "skills-lock.json");
	if (existsSync(lockPath)) {
		try {
			const content = readFileSync(lockPath, "utf-8");
			if (content.includes("neon-postgres")) {
				// Verify the actual skill file exists (lock file can be stale)
				const skillExists =
					existsSync(
						resolve(
							cwd,
							".agents",
							"skills",
							"neon-postgres",
							"SKILL.md",
						),
					) ||
					existsSync(
						resolve(
							cwd,
							".cursor",
							"skills",
							"neon-postgres",
							"SKILL.md",
						),
					) ||
					existsSync(
						resolve(
							cwd,
							".claude",
							"skills",
							"neon-postgres",
							"SKILL.md",
						),
					);
				if (skillExists) {
					const mtime = statSync(lockPath).mtimeMs;
					if (now - mtime < SKILLS_FRESHNESS_MS) return true;
				}
			}
		} catch {}
	}

	// Check global: neon-postgres SKILL.md inside agent-specific skills directories
	const agentName = getSkillsAgentNameFromId(agent);
	const globalDirs = GLOBAL_SKILLS_DIRS[agentName] ?? [];
	for (const dir of globalDirs) {
		const neonSkillMd = resolve(dir, "neon-postgres", "SKILL.md");
		if (existsSync(neonSkillMd)) {
			try {
				const mtime = statSync(neonSkillMd).mtimeMs;
				if (now - mtime < SKILLS_FRESHNESS_MS) return true;
			} catch {}
		}
	}

	return false;
}

/**
 * Ensures Neon agent skills are up to date. Runs `skills add` if the skills
 * haven't been updated within the freshness window (12 hours).
 *
 * Designed to be called from any phase handler — cheap to call repeatedly
 * since it's a no-op when skills are fresh.
 */
export async function ensureSkillsUpToDate(
	agent: string,
	scope?: "global" | "project",
): Promise<boolean> {
	if (skillsAreFresh(agent)) return true;

	const agentName = getSkillsAgentNameFromId(agent);
	try {
		await execa(
			"npx",
			[
				"-y",
				"skills",
				"add",
				"neondatabase/agent-skills",
				"--skill",
				"neon-postgres",
				"--agent",
				agentName,
				...(scope === "global" ? ["-g"] : []),
				"-y",
			],
			{ stdio: "pipe", timeout: 60000 },
		);
		return true;
	} catch {
		return false;
	}
}
