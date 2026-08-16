import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { log, spinner } from "@clack/prompts";
import { execa } from "execa";
import { dim } from "yoctocolors";
import {
	globalInstallCommand,
	resolveInvokingPackageManager,
} from "../utils/package_manager.js";
import {
	type AgentType,
	getSkillsAgentName as getSkillsAgentNameFromId,
} from "./agents.js";

/**
 * Ensures the `skills` CLI is globally installed so npx doesn't need
 * to download it (which can fail behind corporate proxies / sandboxes).
 */
async function ensureSkillsCli(): Promise<void> {
	try {
		await execa("skills", ["--version"], { stdio: "pipe", timeout: 5000 });
	} catch {
		// Not installed — install it globally with whatever launched us, so a
		// pnpm/bun user doesn't get a stray npm global install. Undefined means
		// nothing on this machine can install a global CLI at all.
		const install = globalInstallCommand(
			resolveInvokingPackageManager(),
			"skills",
		);
		if (!install) return;
		try {
			await execa(install.command, install.args, {
				stdio: "pipe",
				timeout: 60000,
			});
		} catch {
			// Swallowed because the caller reports per-skill failures with their
			// own errors. Nothing retries this: every `skills` call below invokes
			// the binary directly, so they all fail if this did.
		}
	}
}

/** Base skills installed for all invocations */
const BASE_SKILLS = ["neon", "neon-postgres"];

/** Additional skills installed for preview (non-bootstrap) invocations */
const PREVIEW_SKILLS = [
	"neon-object-storage",
	"neon-functions",
	"neon-ai-gateway",
];

/** Returns the skill list based on whether preview mode is active */
export function getSkillList(preview?: boolean): string[] {
	return preview ? [...BASE_SKILLS, ...PREVIEW_SKILLS] : BASE_SKILLS;
}

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

export type InstallSkillsOptions = {
	json?: boolean;
	scope?: "global" | "project";
	preview?: boolean;
};

/**
 * Installs Neon agent skills using Vercel's skills CLI.
 */
export async function installAgentSkills(
	selectedAgents: AgentType[],
	options?: InstallSkillsOptions,
): Promise<boolean> {
	const quiet = options?.json === true;

	const agentsWithSkills = selectedAgents.filter(
		(id) => getSkillsAgentNameFromId(id) !== undefined,
	);

	if (agentsWithSkills.length === 0) {
		return true;
	}

	const skillsSpinner = quiet ? null : spinner();
	skillsSpinner?.start("Installing agent skills for Neon in this project...");

	let anyFailed = false;

	await ensureSkillsCli();
	const skills = getSkillList(options?.preview);

	for (const agent of agentsWithSkills) {
		const agentName = getSkillsAgentNameFromId(agent);
		if (!agentName) continue;

		// Install one skill at a time — the skills CLI has a bug with multiple
		// --skill flags where it creates directories but doesn't copy all SKILL.md files.
		for (const skill of skills) {
			try {
				await execa(
					"skills",
					[
						"add",
						"neondatabase/agent-skills",
						"--skill",
						skill,
						"--agent",
						agentName,
						...(options?.scope === "global" ? ["-g"] : []),
						"-y",
					],
					{
						stdio: "pipe",
						timeout: 120000,
					},
				);
			} catch (error) {
				if (!quiet)
					log.error(
						`Failed to install skill ${skill} for ${agent}: ${error instanceof Error ? error.message : "Unknown error"}`,
					);
				anyFailed = true;
			}
		}
	}

	if (anyFailed) {
		skillsSpinner?.stop(
			"Agent skills installation for this project completed with errors",
		);
		if (!quiet)
			log.info(
				"You can manually install skills by running: npx skills add neondatabase/agent-skills --skill neon --skill neon-postgres",
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
	// .agents/skills is the generic directory used by multiple agents
	const agentsDir = resolve(home, ".agents", "skills");
	return {
		cursor: [resolve(home, ".cursor", "skills"), agentsDir],
		"claude-code": [resolve(home, ".claude", "skills"), agentsDir],
		"github-copilot": [resolve(home, ".vscode", "skills"), agentsDir],
		codex: [resolve(home, ".codex", "skills"), agentsDir],
		cline: [resolve(home, ".cline", "skills"), agentsDir],
	};
})();

const PROJECT_SKILLS_DIRS: Record<string, string[]> = {
	cursor: [".cursor/skills", ".agents/skills"],
	"claude-code": [".claude/skills", ".agents/skills"],
	"github-copilot": [".vscode/skills", ".agents/skills"],
	codex: [".codex/skills", ".agents/skills"],
	cline: [".cline/skills", ".agents/skills"],
};

function dirsHaveNeonSkill(dirs: string[]): boolean {
	return BASE_SKILLS.some((skill) =>
		dirs.some((dir) => existsSync(resolve(dir, skill, "SKILL.md"))),
	);
}

export function skillsInstalledForAgent(
	agent: AgentType,
	cwd = process.cwd(),
): boolean {
	const skillsId = getSkillsAgentNameFromId(agent);
	if (!skillsId) return true;
	const projectDirs = (PROJECT_SKILLS_DIRS[skillsId] ?? []).map((dir) =>
		resolve(cwd, dir),
	);
	if (dirsHaveNeonSkill(projectDirs)) return true;
	return dirsHaveNeonSkill(GLOBAL_SKILLS_DIRS[skillsId] ?? []);
}

/**
 * Checks whether skills were recently updated (within the freshness window).
 * Checks both project-level (skills-lock.json mtime) and global (skills dir mtime).
 */
function skillsAreFresh(agent: string, requiredSkills: string[]): boolean {
	const now = Date.now();
	const cwd = process.cwd();
	const projectSkillDirs = [".agents", ".cursor", ".claude"];

	// Check project-level: ALL required skills must exist on disk
	// and skills-lock.json must be recent
	const lockPath = resolve(cwd, "skills-lock.json");
	if (existsSync(lockPath)) {
		try {
			const mtime = statSync(lockPath).mtimeMs;
			if (now - mtime < SKILLS_FRESHNESS_MS) {
				const allExist = requiredSkills.every((skill) =>
					projectSkillDirs.some((dir) =>
						existsSync(
							resolve(cwd, dir, "skills", skill, "SKILL.md"),
						),
					),
				);
				if (allExist) return true;
			}
		} catch {}
	}

	// Check global: ALL required skills must exist in agent-specific dirs
	const agentName = getSkillsAgentNameFromId(agent);
	if (!agentName) return false;
	const globalDirs = GLOBAL_SKILLS_DIRS[agentName] ?? [];
	for (const dir of globalDirs) {
		const allExist = requiredSkills.every((skill) =>
			existsSync(resolve(dir, skill, "SKILL.md")),
		);
		if (allExist) {
			// Check freshness of any one skill file
			try {
				const mtime = statSync(
					resolve(dir, requiredSkills[0], "SKILL.md"),
				).mtimeMs;
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
	agent: string | undefined,
	scope?: "global" | "project",
	preview?: boolean,
): Promise<boolean> {
	const resolvedAgent = agent || "cursor";
	const agentName = getSkillsAgentNameFromId(resolvedAgent);
	if (!agentName) return true;

	const skills = getSkillList(preview);
	if (skillsAreFresh(resolvedAgent, skills)) return true;

	await ensureSkillsCli();
	let allOk = true;

	// Only install skills that don't already have SKILL.md on disk.
	// Re-installing existing skills can trigger sandbox permission prompts.
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const cwd = process.cwd();
	const checkDirs =
		scope === "global"
			? [
					resolve(home, ".cursor", "skills"),
					resolve(home, ".claude", "skills"),
					resolve(home, ".agents", "skills"),
				]
			: [
					resolve(cwd, ".cursor", "skills"),
					resolve(cwd, ".claude", "skills"),
					resolve(cwd, ".agents", "skills"),
				];

	const missingSkills = skills.filter(
		(skill) =>
			!checkDirs.some((dir) =>
				existsSync(resolve(dir, skill, "SKILL.md")),
			),
	);

	if (missingSkills.length === 0) return true;

	// Install one skill at a time — the skills CLI has a bug with multiple
	// --skill flags where it creates directories but doesn't copy all SKILL.md files.
	for (const skill of missingSkills) {
		try {
			await execa(
				"skills",
				[
					"add",
					"neondatabase/agent-skills",
					"--skill",
					skill,
					"--agent",
					agentName,
					...(scope === "global" ? ["-g"] : []),
					"-y",
				],
				{ stdio: "pipe", timeout: 120000 },
			);
		} catch {
			allOk = false;
		}
	}

	return allOk;
}
