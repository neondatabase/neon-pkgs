import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * `neon init` writes a short Neon section into the project's agent instruction files. The
 * section is wrapped in these markers, so a re-run replaces it in place and never touches
 * the user's content outside them.
 */
export const NEON_SECTION_BEGIN = "<!-- neon:begin -->";
export const NEON_SECTION_END = "<!-- neon:end -->";

export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_FILE = "CLAUDE.md";
/** Claude Code reads CLAUDE.md, not AGENTS.md; this import is how it reads AGENTS.md. */
export const CLAUDE_AGENTS_IMPORT = "@AGENTS.md";

const SECTION_BODY = `## Neon

This project uses Neon Postgres. If the Neon agent skills are installed (\`neon\`, \`neon-postgres\`, ...), load them for Neon-specific work.

- Connection strings are in \`.env\`: \`DATABASE_URL\` (pooled; use it in the app and in serverless functions) and \`DATABASE_URL_UNPOOLED\` (direct; use it for migrations and long-running sessions).
- Use a Neon branch for risky schema changes or test data: \`neon branches create --name <name>\`.
- Computes scale to zero when idle. The first query after idle can take a moment.
- **Vector / semantic search, RAG, recommendations, agent memory:** use Neon's \`lakebase_vector\` extension with a \`lakebase_ann\` index rather than pgvector \`hnsw\`/\`ivfflat\`. Columns stay pgvector \`vector(N)\` (fixed N, any size) and queries still use \`<=>\`/\`<->\`/\`<#>\`. Create the index from the start, even on an empty or small table, because it needs no tuning:
  \`\`\`sql
  CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE;
  CREATE INDEX ON items USING lakebase_ann (embedding vector_cosine_ops);
  \`\`\`
  Details and per-framework notes (LangChain, LlamaIndex, Drizzle, Prisma, SQLAlchemy, ...): the \`neon-vector-search\` skill.`;

/** The full managed block, markers included. */
export const NEON_AGENT_SECTION = `${NEON_SECTION_BEGIN}\n${SECTION_BODY}\n${NEON_SECTION_END}`;

export type ManagedSectionAction =
	| "created"
	| "added"
	| "updated"
	| "unchanged";

export type AgentInstructionAction =
	| ManagedSectionAction
	/** CLAUDE.md was created with `@AGENTS.md` as its only content. */
	| "import-created"
	/** CLAUDE.md already imports AGENTS.md, so Claude Code reads the section from there. */
	| "imports-agents"
	| "failed";

export type AgentInstructionOutcome = {
	file: string;
	action: AgentInstructionAction;
	/** Why the write failed, for `action: "failed"`. */
	reason?: string;
};

export class NeonSectionMarkersError extends Error {}

const countOccurrences = (text: string, needle: string): number =>
	text.split(needle).length - 1;

/**
 * The content of a file after the Neon section is written into it. Pure, so the marker
 * rules can be tested without a file system.
 *
 * - No file, or an empty one: the section alone.
 * - No markers: the section appended after the user's content.
 * - One marker pair: the text between the markers is replaced; the rest is kept as is.
 * - Anything else (a lone or repeated marker): throws, because guessing which span is
 *   ours could delete the user's content.
 */
export const upsertNeonSection = (
	existing: string | undefined,
): { content: string; action: ManagedSectionAction } => {
	if (existing === undefined || existing.trim() === "") {
		return { content: `${NEON_AGENT_SECTION}\n`, action: "created" };
	}
	const begins = countOccurrences(existing, NEON_SECTION_BEGIN);
	const ends = countOccurrences(existing, NEON_SECTION_END);
	if (begins === 0 && ends === 0) {
		const separator = existing.endsWith("\n") ? "\n" : "\n\n";
		return {
			content: `${existing}${separator}${NEON_AGENT_SECTION}\n`,
			action: "added",
		};
	}
	const start = existing.indexOf(NEON_SECTION_BEGIN);
	const end = existing.indexOf(NEON_SECTION_END);
	if (begins !== 1 || ends !== 1 || end < start) {
		throw new NeonSectionMarkersError(
			`found ${begins} \`${NEON_SECTION_BEGIN}\` and ${ends} \`${NEON_SECTION_END}\` markers; keep one pair, in order, or remove the Neon section`,
		);
	}
	const content = `${existing.slice(0, start)}${NEON_AGENT_SECTION}${existing.slice(end + NEON_SECTION_END.length)}`;
	return {
		content,
		action: content === existing ? "unchanged" : "updated",
	};
};

const lexists = (path: string): boolean => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

/** The project-relative file's real path must stay inside the project. Symlinks can point out. */
const assertInsideProject = (cwd: string, path: string): void => {
	const root = realpathSync(cwd);
	const real = realpathSync(path);
	const rel = relative(root, real);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(
			`resolves outside the project directory (${real}); not written`,
		);
	}
};

const readProjectFile = (cwd: string, name: string): string | undefined => {
	const path = join(cwd, name);
	if (!lexists(path)) {
		return undefined;
	}
	assertInsideProject(cwd, path);
	return readFileSync(path, "utf8");
};

const writeProjectFile = (cwd: string, name: string, content: string): void => {
	const path = join(cwd, name);
	if (lexists(path)) {
		assertInsideProject(cwd, path);
	}
	writeFileSync(path, content);
};

const reasonOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const upsertFile = (cwd: string, name: string): AgentInstructionOutcome => {
	try {
		const { content, action } = upsertNeonSection(
			readProjectFile(cwd, name),
		);
		if (action !== "unchanged") {
			writeProjectFile(cwd, name, content);
		}
		return { file: name, action };
	} catch (error) {
		return { file: name, action: "failed", reason: reasonOf(error) };
	}
};

const claudeFile = (cwd: string): AgentInstructionOutcome => {
	try {
		const existing = readProjectFile(cwd, CLAUDE_FILE);
		if (existing === undefined) {
			writeProjectFile(cwd, CLAUDE_FILE, `${CLAUDE_AGENTS_IMPORT}\n`);
			return { file: CLAUDE_FILE, action: "import-created" };
		}
		const importsAgents = existing
			.split(/\r?\n/)
			.some((line) => line.trim() === CLAUDE_AGENTS_IMPORT);
		if (importsAgents) {
			return { file: CLAUDE_FILE, action: "imports-agents" };
		}
		return upsertFile(cwd, CLAUDE_FILE);
	} catch (error) {
		return { file: CLAUDE_FILE, action: "failed", reason: reasonOf(error) };
	}
};

/**
 * Writes the Neon section into `AGENTS.md` in `cwd`, and makes Claude Code pick it up when
 * `claudeCode` is set: `CLAUDE.md` is created as `@AGENTS.md` when missing, left alone when it
 * already imports AGENTS.md, and otherwise gets the same marker section.
 *
 * Failures are returned per file, not thrown, so one file that cannot be written does not
 * stop the other. AGENTS.md is written first: when CLAUDE.md is a symlink to it, the second
 * step then sees the section and writes nothing.
 */
export const writeAgentInstructions = (input: {
	cwd: string;
	claudeCode: boolean;
}): AgentInstructionOutcome[] => {
	const outcomes = [upsertFile(input.cwd, AGENTS_FILE)];
	if (input.claudeCode) {
		outcomes.push(claudeFile(input.cwd));
	}
	return outcomes;
};

/** The line printed for a changed file. `null` when nothing changed or no line is needed. */
export const describeAgentInstructionOutcome = (
	outcome: AgentInstructionOutcome,
): string | null => {
	switch (outcome.action) {
		case "created":
			return `Created ${outcome.file} with the Neon section.`;
		case "added":
			return `Added the Neon section to ${outcome.file}.`;
		case "updated":
			return `Updated the Neon section in ${outcome.file}.`;
		case "import-created":
			return `Created ${outcome.file} importing ${AGENTS_FILE}.`;
		case "unchanged":
		case "imports-agents":
		case "failed":
			return null;
		default: {
			const _exhaustive: never = outcome.action;
			return _exhaustive;
		}
	}
};
