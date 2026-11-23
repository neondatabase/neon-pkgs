import { randomBytes } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * `neon init` writes a short Neon section into the project's agent instruction files. The
 * section is wrapped in these markers, so a re-run replaces it in place and never touches
 * the user's content outside them. A marker counts only as a whole line of its own outside
 * fenced code blocks, so a file that quotes one in an example is not mistaken for ours.
 */
export const NEON_SECTION_BEGIN = "<!-- neon:begin -->";
export const NEON_SECTION_END = "<!-- neon:end -->";

export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_FILE = "CLAUDE.md";
/** Claude Code reads CLAUDE.md, not AGENTS.md; this import is how it reads AGENTS.md. */
export const CLAUDE_AGENTS_IMPORT = "@AGENTS.md";
/** Project-level Claude Code settings, skills and commands live here. */
export const CLAUDE_PROJECT_DIR = ".claude";

const SECTION_BODY = `## Neon

This project uses Neon Postgres. If the Neon agent skills are installed (\`neon\`, \`neon-postgres\`, ...), load them for Neon-specific work.

- Connection strings are in \`.env\`: \`DATABASE_URL\` (pooled; use it in the app and in serverless functions) and \`DATABASE_URL_UNPOOLED\` (direct; use it for migrations and long-running sessions).
- Use a Neon branch for risky schema changes or test data: \`neon branches create --name <name>\`.
- Computes scale to zero when idle. The first query after idle can take a moment.
- **Vector / semantic search, RAG, recommendations, agent memory:** use Neon's \`lakebase_vector\` extension with a \`lakebase_ann\` index rather than pgvector \`hnsw\`/\`ivfflat\`, unless the user asks for pgvector/\`hnsw\` or needs portability to non-Neon Postgres. Columns stay pgvector \`vector(N)\` (fixed N) and queries still use \`<=>\`/\`<->\`/\`<#>\`. Create the index from the start, even on an empty table:
  \`\`\`sql
  CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE;
  CREATE INDEX ON items USING lakebase_ann (embedding vector_cosine_ops);
  \`\`\`
  \`lists=auto\` sizes the index's partitions from the table's row count at build time (none below ~65k rows) and inserts do not repartition, so after a bulk load, or once the table has grown a lot, rebuild it with \`REINDEX INDEX CONCURRENTLY\`.
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

/** The file changed between init reading it and writing it; nothing was written. */
export class ConcurrentChangeError extends Error {}

type Line = {
	/** The line without its line ending. */
	text: string;
	/** Offset of the line's first character. */
	start: number;
	/** Offset just past the line's text, before its line ending. */
	end: number;
	/** Whether the line is inside a fenced code block, or is one of its fence lines. */
	fenced: boolean;
};

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Splits markdown into lines and marks the ones inside fenced code blocks (CommonMark: a
 * fence of 3+ backticks or tildes, closed by a fence of the same character at least as
 * long). An unclosed fence runs to the end of the file.
 */
const markdownLines = (text: string): Line[] => {
	const lines: Line[] = [];
	let fence: { char: string; length: number } | null = null;
	let start = 0;
	while (start <= text.length) {
		const newline = text.indexOf("\n", start);
		const next = newline === -1 ? text.length : newline;
		const end = next > start && text[next - 1] === "\r" ? next - 1 : next;
		const line = text.slice(start, end);
		const match = FENCE.exec(line);
		if (fence === null) {
			const opener = match?.[1];
			// A backtick fence's info string cannot contain a backtick.
			if (
				opener !== undefined &&
				!(opener.startsWith("`") && match?.[2]?.includes("`"))
			) {
				fence = { char: opener[0] ?? "`", length: opener.length };
			}
			lines.push({ text: line, start, end, fenced: fence !== null });
		} else {
			const closer = match?.[1];
			if (
				closer !== undefined &&
				closer[0] === fence.char &&
				closer.length >= fence.length &&
				match?.[2]?.trim() === ""
			) {
				fence = null;
			}
			lines.push({ text: line, start, end, fenced: true });
		}
		if (newline === -1) {
			break;
		}
		start = newline + 1;
	}
	return lines;
};

/** The lines that are exactly `needle` (surrounding whitespace aside), outside code fences. */
const ownLines = (lines: readonly Line[], needle: string): Line[] =>
	lines.filter((line) => !line.fenced && line.text.trim() === needle);

/** Whether CLAUDE.md imports AGENTS.md: `@AGENTS.md` on its own line, outside code fences. */
export const importsAgentsFile = (claudeMd: string): boolean =>
	ownLines(markdownLines(claudeMd), CLAUDE_AGENTS_IMPORT).length > 0;

/**
 * The content of a file after the Neon section is written into it. Pure, so the marker
 * rules can be tested without a file system.
 *
 * - No file, or an empty one: the section alone.
 * - No markers: the section appended after the user's content.
 * - One marker pair: the lines from the begin marker to the end marker are replaced; the
 *   rest is kept as is.
 * - Anything else (a lone or repeated marker): throws, because guessing which span is
 *   ours could delete the user's content.
 *
 * Markers count only as whole lines outside fenced code blocks; a quoted marker is content.
 */
export const upsertNeonSection = (
	existing: string | undefined,
): { content: string; action: ManagedSectionAction } => {
	if (existing === undefined || existing.trim() === "") {
		return { content: `${NEON_AGENT_SECTION}\n`, action: "created" };
	}
	const lines = markdownLines(existing);
	const begins = ownLines(lines, NEON_SECTION_BEGIN);
	const ends = ownLines(lines, NEON_SECTION_END);
	if (begins.length === 0 && ends.length === 0) {
		const separator = existing.endsWith("\n") ? "\n" : "\n\n";
		return {
			content: `${existing}${separator}${NEON_AGENT_SECTION}\n`,
			action: "added",
		};
	}
	const begin = begins[0];
	const end = ends[0];
	if (
		begins.length !== 1 ||
		ends.length !== 1 ||
		begin === undefined ||
		end === undefined ||
		end.start < begin.start
	) {
		throw new NeonSectionMarkersError(
			`found ${begins.length} \`${NEON_SECTION_BEGIN}\` and ${ends.length} \`${NEON_SECTION_END}\` marker lines; keep one pair, in order, or remove the Neon section`,
		);
	}
	const content = `${existing.slice(0, begin.start)}${NEON_AGENT_SECTION}${existing.slice(end.end)}`;
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

const isDirectory = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/**
 * Project-level evidence that Claude Code is used here: a `.claude/` directory or a
 * `CLAUDE.md`. Claude Code being installed on the machine is not evidence about a project.
 */
export const hasClaudeCodeProjectFiles = (cwd: string): boolean =>
	isDirectory(join(cwd, CLAUDE_PROJECT_DIR)) ||
	lexists(join(cwd, CLAUDE_FILE));

/**
 * The real path a project file is read from and written to. Symlinks are followed, so a
 * write replaces the target and keeps the link, but the target must stay inside the project.
 */
const resolveInsideProject = (cwd: string, path: string): string => {
	const root = realpathSync(cwd);
	const real = realpathSync(path);
	const rel = relative(root, real);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(
			`resolves outside the project directory (${real}); not written`,
		);
	}
	return real;
};

/** A project file as read: where it lives and what it held, `undefined` when missing. */
export type ReadFile = { path: string; content: string | undefined };

const readProjectFile = (cwd: string, name: string): ReadFile => {
	const path = join(cwd, name);
	if (!lexists(path)) {
		return { path, content: undefined };
	}
	const real = resolveInsideProject(cwd, path);
	return { path: real, content: readFileSync(real, "utf8") };
};

const currentContent = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
};

/**
 * Replaces `read.path` with `content` without ever leaving a partial file: the content goes
 * to a temporary file in the same directory, which is flushed and then renamed over the
 * target. Right before the rename the target is read again, and if it no longer holds what
 * was read (or now exists when it did not), nothing is written, so a concurrent edit is
 * not lost. An existing file keeps its permission bits.
 */
export const writeFileIfUnchanged = (read: ReadFile, content: string): void => {
	const dir = dirname(read.path);
	const temp = join(
		dir,
		`.${basename(read.path)}.neon-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
	);
	const mode =
		read.content === undefined
			? undefined
			: statSync(read.path).mode & 0o7777;
	const fd = openSync(temp, "wx", 0o666);
	let renamed = false;
	try {
		try {
			if (mode !== undefined) {
				fchmodSync(fd, mode);
			}
			writeFileSync(fd, content);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (currentContent(read.path) !== read.content) {
			throw new ConcurrentChangeError(
				"changed while init was running; not written. Run init again to add the Neon section",
			);
		}
		renameSync(temp, read.path);
		renamed = true;
	} finally {
		if (!renamed) {
			try {
				unlinkSync(temp);
			} catch {
				// Already gone.
			}
		}
	}
};

const reasonOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const upsertFile = (name: string, read: ReadFile): AgentInstructionOutcome => {
	const { content, action } = upsertNeonSection(read.content);
	if (action !== "unchanged") {
		writeFileIfUnchanged(read, content);
	}
	return { file: name, action };
};

const agentsFile = (cwd: string): AgentInstructionOutcome => {
	try {
		return upsertFile(AGENTS_FILE, readProjectFile(cwd, AGENTS_FILE));
	} catch (error) {
		return { file: AGENTS_FILE, action: "failed", reason: reasonOf(error) };
	}
};

const claudeFile = (cwd: string): AgentInstructionOutcome => {
	try {
		const read = readProjectFile(cwd, CLAUDE_FILE);
		if (read.content === undefined) {
			writeFileIfUnchanged(read, `${CLAUDE_AGENTS_IMPORT}\n`);
			return { file: CLAUDE_FILE, action: "import-created" };
		}
		if (importsAgentsFile(read.content)) {
			return { file: CLAUDE_FILE, action: "imports-agents" };
		}
		return upsertFile(CLAUDE_FILE, read);
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
	const outcomes = [agentsFile(input.cwd)];
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
