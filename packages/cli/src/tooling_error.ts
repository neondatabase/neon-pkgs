import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import { isNetworkError } from "./errors.js";

/** Where in `neon init` / `neon skills` / `neon mcp` an error came from. */
export type ToolingErrorStep =
	| "plugins"
	| "skills"
	| "mcp"
	| "config"
	| "env_pull";

export type ToolingErrorKind =
	| "node_unsupported"
	| "node_missing"
	| "timeout"
	| "permission_denied"
	| "registry_blocked"
	| "network"
	| "invalid_config"
	| "cannot_mint_key"
	| "child_failed"
	| "unknown";

export type ToolingErrorContext = {
	step?: ToolingErrorStep;
	agents?: readonly string[];
	skills?: readonly string[];
	scope?: "project" | "global";
	/** Exit status, timeout and signal of the `skills` CLI child process. */
	exitCode?: number;
	timedOut?: boolean;
	signal?: string;
	/** Extra text to classify and report, for failures whose message doesn't carry the cause. */
	detail?: string;
	/** The reason of every failure behind an error that stands for several (`errorKind` is the first). */
	errorKinds?: readonly ToolingErrorKind[];
	/** Joins the error to the `cli_init_start` / `cli_init_end` events of the same run. */
	initRunId?: string;
};

/**
 * What we know about an error beyond its message, kept beside the error instead of on it so
 * the error classes and the text shown to the user stay exactly as they are.
 */
const contexts = new WeakMap<object, ToolingErrorContext>();

export const toolingContextOf = (
	error: unknown,
): ToolingErrorContext | undefined =>
	typeof error === "object" && error !== null
		? contexts.get(error)
		: undefined;

/** Adds `context` to what is known about `error`; a value given here replaces an earlier one. */
export const attachToolingContext = (
	error: unknown,
	context: ToolingErrorContext,
): void => {
	if (typeof error !== "object" || error === null) {
		return;
	}
	const defined = Object.fromEntries(
		Object.entries(context).filter(([, value]) => value !== undefined),
	);
	contexts.set(error, { ...contexts.get(error), ...defined });
};

/** Records the step an error came from, unless something closer to the failure already did. */
export const tagToolingStep = (
	error: unknown,
	step: ToolingErrorStep,
): void => {
	if (toolingContextOf(error)?.step === undefined) {
		attachToolingContext(error, { step });
	}
};

/** Runs `run`, tagging whatever it throws with `step`. */
export const withToolingStep = async <T>(
	step: ToolingErrorStep,
	run: () => Promise<T>,
): Promise<T> => {
	try {
		return await run();
	} catch (error) {
		tagToolingStep(error, step);
		throw error;
	}
};

/**
 * One context for an error that stands for several failures: for each field the first failure
 * that has it wins, except that the error timed out if any of them did.
 */
export const mergeToolingContexts = (
	contexts: readonly (ToolingErrorContext | undefined)[],
): ToolingErrorContext => {
	const merged: ToolingErrorContext = Object.assign(
		{},
		...[...contexts].reverse(),
	);
	if (contexts.some((context) => context?.timedOut === true)) {
		merged.timedOut = true;
	}
	return merged;
};

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * A coarse reason for the failure, so errors can be counted instead of read one by one.
 * Anything that matches no reason is `unknown`, which is itself worth watching.
 */
export const classifyToolingError = (
	error: unknown,
	context: ToolingErrorContext | undefined = toolingContextOf(error),
): ToolingErrorKind => {
	if (error instanceof Error && error.name === "CannotMintApiKeyError") {
		return "cannot_mint_key";
	}
	const text = `${messageOf(error)}\n${context?.detail ?? ""}`;
	if (/needs Node\.js \S+ or newer/i.test(text)) {
		return "node_unsupported";
	}
	if (/needs npx|npx: command not found/i.test(text)) {
		return "node_missing";
	}
	if (
		context?.timedOut === true ||
		/\bETIMEDOUT\b|\btimed out after\b/i.test(text)
	) {
		return "timeout";
	}
	if (/EACCES|EPERM|permission denied|operation not permitted/i.test(text)) {
		return "permission_denied";
	}
	if (/\bE403\b|\b403\s+Forbidden\b|\bHTTP\s*403\b/i.test(text)) {
		return "registry_blocked";
	}
	if (
		isNetworkError(error) ||
		/ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|socket hang up/i.test(text)
	) {
		return "network";
	}
	if (
		/invalid json|unexpected token|JSON\.parse|could not parse/i.test(text)
	) {
		return "invalid_config";
	}
	// A child killed by a signal has no exit code.
	if (context?.exitCode !== undefined || context?.signal !== undefined) {
		return "child_failed";
	}
	return "unknown";
};

const DETAIL_MAX = 500;
const STACK_MAX = 2000;
const MAX_FRAMES = 40;
/** How much is read before redacting, so the cost doesn't grow with the size of a child's output. */
const INPUT_MAX = DETAIL_MAX * 8;
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

const escapeRegExp = (text: string): string =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The last `max` characters, starting at a word so a secret isn't cut into a fragment. */
const tailOf = (text: string, max: number): string => {
	if (text.length <= max) {
		return text;
	}
	const tail = text.slice(-max);
	const word = tail.search(/\s/);
	return word > 0 ? tail.slice(word) : tail;
};

/** The ways `path` can show up in text: as given, with either slash, and fully resolved. */
const pathForms = (path: string): string[] => {
	const forms = new Set([
		path,
		path.replace(/\\/g, "/"),
		path.replace(/\//g, "\\"),
	]);
	try {
		forms.add(realpathSync(path));
	} catch {
		// Gone or unreadable: the other forms still apply.
	}
	return [...forms].filter((form) => form.length > 1);
};

let scrubTargets: { key: string; targets: [RegExp, string][] } | undefined;

/** What to replace, built once per working and home directory instead of on every error. */
const getScrubTargets = (): [RegExp, string][] => {
	const cwd = process.cwd();
	const home = homedir();
	const key = `${cwd}\0${home}`;
	if (scrubTargets?.key !== key) {
		const targets: [RegExp, string][] = [];
		for (const [path, replacement] of [
			[cwd, "."],
			[home, "~"],
		] as const) {
			for (const form of pathForms(path).sort(
				(a, b) => b.length - a.length,
			)) {
				// Not followed by a name character, so `/work/app` leaves `/work/app-old` alone.
				targets.push([
					new RegExp(
						`${escapeRegExp(form)}(?![\\w-])`,
						process.platform === "win32" ? "gi" : "g",
					),
					replacement,
				]);
			}
		}
		scrubTargets = { key, targets };
	}
	return scrubTargets.targets;
};

/** Replaces the working directory with `.` and the home directory with `~`. */
const scrubPaths = (text: string): string => {
	let out = text;
	for (const [pattern, replacement] of getScrubTargets()) {
		out = out.replace(pattern, replacement);
	}
	return out;
};

// Each pattern starts at its keyword rather than at a run of name characters before it, so
// the cost of a long unbroken run stays linear.
const SECRET_WORD = "(?:token|secret|passw(?:or)?d|api[_-]?key)";
const VALUE = `"[^"]*"|'[^']*'|`;
/** A password or secret is taken to the end of the line: it may well contain spaces. */
const LINE_SECRET = new RegExp(
	`((?:secret|passw(?:or)?d)[\\w.-]*["']?\\s*[=:]\\s*)(${VALUE}[^\\n"']+)`,
	"gi",
);
const WORD_SECRET = new RegExp(
	`(${SECRET_WORD}[\\w.-]*["']?\\s*[=:]\\s*)(${VALUE}[^\\s"',;]+)`,
	"gi",
);
/** `--token abc`, `--password=abc`: the secret is the argument that follows. */
const FLAG_SECRET = new RegExp(
	`(--[\\w-]*${SECRET_WORD}[\\w-]*(?:\\s+|=))(${VALUE}\\S+)`,
	"gi",
);

const redactSecrets = (text: string): string =>
	text
		.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//<redacted>@")
		.replace(/\bnapi_[A-Za-z0-9_-]+/g, "napi_<redacted>")
		.replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, "<redacted>")
		.replace(/\bnpm_[A-Za-z0-9]{20,}/g, "<redacted>")
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>")
		.replace(FLAG_SECRET, "$1<redacted>")
		.replace(LINE_SECRET, "$1<redacted>")
		.replace(WORD_SECRET, "$1<redacted>");

/**
 * Makes error text safe and small enough to send: no colour codes, no home directory or
 * working directory, no credentials, and at most the last {@link DETAIL_MAX} characters, which
 * is where a failed child process puts the cause (the start is progress output). Only the end
 * of the text is looked at, so a very large child output costs no more than a small one.
 *
 * Exported for tests.
 */
export const sanitizeErrorDetail = (text: string): string => {
	const out = redactSecrets(
		scrubPaths(tailOf(text, INPUT_MAX).replace(ANSI, "")),
	).trim();
	return out.length > DETAIL_MAX ? `…${out.slice(-DETAIL_MAX)}` : out;
};

/**
 * A stack made of the error's name, its sanitized message and its first stack frames, with the
 * same scrubbing applied to the frames (whose paths carry the user's directories) and a bound.
 * It is built rather than edited, so no part of the original message can survive in it.
 */
const sanitizeStack = (
	name: string,
	stack: string,
	sanitizedMessage: string,
): string => {
	const frames = stack
		.split("\n")
		.filter((line) => /^\s+at /.test(line))
		.slice(0, MAX_FRAMES)
		.join("\n");
	const head = `${name}: ${sanitizedMessage}`;
	const full =
		frames.length === 0
			? head
			: `${head}\n${redactSecrets(scrubPaths(frames.replace(ANSI, "")))}`;
	return full.length > STACK_MAX ? `${full.slice(0, STACK_MAX)}…` : full;
};

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_IDS = 20;

/** Agent and skill names come from a fixed set, but `--agent` and `--skill` take any text. */
const safeIds = (ids: readonly string[] | undefined): string[] | undefined =>
	ids === undefined
		? undefined
		: ids.filter((id) => SAFE_ID.test(id)).slice(0, MAX_IDS);

/**
 * The fields to add to the `CLI Error` event for an error from one of these commands, or
 * `undefined` for any other error. `message` and `stack` replace the originals with the
 * sanitized, bounded text.
 */
export const toolingErrorProperties = (
	error: Error,
	command: string | undefined,
): Record<string, unknown> | undefined => {
	const context = toolingContextOf(error);
	if (context === undefined) {
		return undefined;
	}
	// The retry command isn't the cause, and a long one would push the cause out of the bound.
	const message = sanitizeErrorDetail(
		error.message.replace(/\n?Retry with: [\s\S]*$/, ""),
	);
	return {
		message,
		stack:
			error.stack === undefined
				? undefined
				: sanitizeStack(error.name, error.stack, message),
		command,
		step: context.step,
		errorKind: classifyToolingError(error, context),
		errorKinds: context.errorKinds,
		agents: safeIds(context.agents),
		skills: safeIds(context.skills),
		scope: context.scope,
		exitCode: context.exitCode,
		timedOut: context.timedOut,
		signal: context.signal,
		detail:
			context.detail === undefined
				? undefined
				: sanitizeErrorDetail(context.detail),
		initRunId: context.initRunId,
	};
};
