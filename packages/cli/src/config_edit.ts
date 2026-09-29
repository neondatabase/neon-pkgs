import {
	classify,
	entryObject,
	findConfigObject,
	findEntry,
	isCodeAt,
	isCommentAt,
	lineIndent,
	lineStart,
	type ObjectEntry,
	type ObjectScan,
	type SourceKinds,
	SourceScanError,
	scanObject,
} from "./config_source.js";
import { renderKey } from "./config_template.js";

/**
 * Edits to an existing `neon.ts`, applied as text splices so comments, formatting, and every
 * property the edit does not name survive untouched. The file is never regenerated.
 *
 * Each edit either declares something new, flips a disabled toggle on, or reports that the
 * file already declares it (`changes` is empty). A file whose layout the scanner cannot
 * place an edit into is refused with the exact lines to add by hand.
 */

export class ConfigEditError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigEditError";
	}
}

export type ConfigEdit =
	| { kind: "service"; service: "auth" | "data-api" | "ai-gateway" }
	| { kind: "function"; slug: string; name: string; source: string }
	| { kind: "bucket"; name: string; access: "private" | "public_read" };

export type ConfigEditResult = {
	source: string;
	/** What changed, one line each. Empty when the file already declared the request. */
	changes: string[];
};

type Parsed = {
	source: string;
	kinds: SourceKinds;
	root: ObjectScan;
	eol: string;
	/** One level of indentation, read from the file. */
	unit: string;
};

type Step = { source: string; change?: string };

/** Top-level keys in the order the starter policy writes them. New keys land in this order. */
const KEY_ORDER: readonly string[] = [
	"auth",
	"dataApi",
	"aiGateway",
	"functions",
	"buckets",
	"triggers",
	"preview",
	"branch",
	"experimental",
];

const keyRank = (key: string | undefined): number =>
	key === undefined ? -1 : KEY_ORDER.indexOf(key);

const unsupported = (reason: string, snippet: readonly string[]): never => {
	throw new ConfigEditError(
		`Cannot edit this neon.ts automatically: ${reason}\nDeclare it by hand:\n\n${snippet
			.map((line) => `  ${line}`)
			.join("\n")}`,
	);
};

const parse = (source: string): Parsed => {
	try {
		const kinds = classify(source);
		const root = assertPlain(
			scanObject(source, kinds, findConfigObject(source, kinds)),
		);
		const first = root.entries[0];
		const base = lineIndent(source, root.open);
		const firstIndent = first ? lineIndent(source, first.start) : base;
		const unit =
			firstIndent.startsWith(base) && firstIndent.length > base.length
				? firstIndent.slice(base.length)
				: "  ";
		return {
			source,
			kinds,
			root,
			eol: source.includes("\r\n") ? "\r\n" : "\n",
			unit,
		};
	} catch (error) {
		if (error instanceof SourceScanError) {
			throw new ConfigEditError(
				`Cannot edit this neon.ts automatically: ${error.message}.`,
			);
		}
		throw error;
	}
};

/**
 * A spread, a computed key, or a repeated key can override the property an edit just wrote,
 * so the effective value cannot be read from the text.
 */
const assertPlain = (scan: ObjectScan): ObjectScan => {
	const seen = new Set<string>();
	for (const entry of scan.entries) {
		if (entry.key === undefined || seen.has(entry.key)) {
			throw new ConfigEditError(
				"Cannot edit this neon.ts automatically: an object it edits has a spread, computed, or repeated property that could override the edit.",
			);
		}
		seen.add(entry.key);
	}
	return scan;
};

/** The object literal `entry` holds, or `undefined` when its value is anything else. */
const objectOf = (
	parsed: Parsed,
	entry: ObjectEntry,
): ObjectScan | undefined => {
	const scan = entry.keyed
		? entryObject(parsed.source, parsed.kinds, entry)
		: undefined;
	return scan && assertPlain(scan);
};

const startsLine = (source: string, index: number): boolean =>
	source.slice(lineStart(source, index), index).trim() === "";

/**
 * Where a new entry goes, as a splice into `parsed.source`. `before` places it above that
 * entry (and above the comment lines that describe it); without it the entry is appended.
 */
const insertEntry = (
	parsed: Parsed,
	scan: ObjectScan,
	lines: readonly string[],
	snippet: readonly string[],
	before?: ObjectEntry,
): string => {
	const { source, kinds, eol, unit } = parsed;
	const baseIndent = lineIndent(source, scan.open);
	const first = scan.entries[0];

	if (!first) {
		if (source.slice(scan.open + 1, scan.close).trim() !== "") {
			return unsupported(
				"the object it goes in holds only comments.",
				snippet,
			);
		}
		const indent = baseIndent + unit;
		return (
			source.slice(0, scan.open + 1) +
			eol +
			lines.map((line) => indent + line).join(eol) +
			eol +
			baseIndent +
			source.slice(scan.close)
		);
	}

	const last = scan.entries[scan.entries.length - 1];
	if (
		!startsLine(source, first.start) ||
		!source.slice(last.end, scan.close).includes("\n")
	) {
		return unsupported(
			"the object it goes in is not laid out one property per line.",
			snippet,
		);
	}
	const indent = lineIndent(source, first.start);

	if (before) {
		if (!startsLine(source, before.start)) {
			return unsupported(
				"a property sharing its line with another one.",
				snippet,
			);
		}
		let at = lineStart(source, before.start);
		// Keep a `// heading` glued to the property it describes.
		while (at > 0) {
			const previous = lineStart(source, at - 1);
			const text = source.slice(previous, at);
			const marker = previous + text.search(/\S|$/);
			if (
				previous <= scan.open ||
				!text.trim().startsWith("//") ||
				!isCommentAt(kinds, marker)
			) {
				break;
			}
			at = previous;
		}
		return (
			source.slice(0, at) +
			lines.map((line) => indent + line + eol).join("") +
			source.slice(at)
		);
	}

	let lineEnd = source.indexOf("\n", last.end);
	if (source[lineEnd - 1] === "\r") lineEnd--;
	let hasComma = false;
	for (let i = last.end; i < scan.close; i++) {
		if (!isCodeAt(kinds, i) || source[i] !== ",") continue;
		// A separator on a later line would end up after the entry appended before it.
		if (i >= lineEnd) {
			return unsupported(
				"a trailing comma on a line of its own.",
				snippet,
			);
		}
		hasComma = true;
	}
	return (
		source.slice(0, last.end) +
		(hasComma ? "" : ",") +
		source.slice(last.end, lineEnd) +
		eol +
		lines.map((line) => indent + line).join(eol) +
		source.slice(lineEnd)
	);
};

/** The first top-level entry that belongs after `key` in the starter policy's order. */
const entryAfter = (parsed: Parsed, key: string): ObjectEntry | undefined =>
	parsed.root.entries.find((entry) => keyRank(entry.key) > keyRank(key));

/**
 * `preview` still accepts `aiGateway`, `functions`, and `buckets`, and declaring the same key
 * in both places fails validation. Adding to the other home would break the file.
 */
const assertNotUnderPreview = (
	parsed: Parsed,
	key: string,
	snippet: readonly string[],
): void => {
	const preview = findEntry(parsed.root, "preview");
	if (!preview) return;
	const scan = objectOf(parsed, preview);
	if (!scan) {
		unsupported(
			`preview is not an object literal, so it may already declare ${key}.`,
			snippet,
		);
		return;
	}
	if (findEntry(scan, key)) {
		unsupported(
			`${key} is declared under the deprecated \`preview\` block. Lift it to the top level first.`,
			snippet,
		);
	}
};

type Toggle =
	| { on: true }
	| { on: false; span: [number, number]; path: string };

const readToggle = (
	parsed: Parsed,
	entry: ObjectEntry,
	key: string,
	snippet: readonly string[],
): Toggle => {
	const { source } = parsed;
	const value = source.slice(entry.valueStart, entry.valueEnd);
	if (entry.keyed && value === "true") return { on: true };
	if (entry.keyed && value === "false") {
		return {
			on: false,
			span: [entry.valueStart, entry.valueEnd],
			path: key,
		};
	}
	const object = objectOf(parsed, entry);
	if (!object) {
		return unsupported(
			`${key} is set to an expression, not true or false.`,
			snippet,
		);
	}
	const enabled = findEntry(object, "enabled");
	if (!enabled) return { on: true };
	const flag = source.slice(enabled.valueStart, enabled.valueEnd);
	if (enabled.keyed && flag === "true") return { on: true };
	if (enabled.keyed && flag === "false") {
		return {
			on: false,
			span: [enabled.valueStart, enabled.valueEnd],
			path: `${key}.enabled`,
		};
	}
	return unsupported(
		`${key}.enabled is set to an expression, not true or false.`,
		snippet,
	);
};

const setToggle = (
	parsed: Parsed,
	key: "auth" | "dataApi" | "aiGateway",
): Step => {
	const snippet = [`${key}: true,`];
	if (key === "aiGateway") assertNotUnderPreview(parsed, key, snippet);
	const entry = findEntry(parsed.root, key);
	if (!entry) {
		return {
			source: insertEntry(
				parsed,
				parsed.root,
				snippet,
				snippet,
				entryAfter(parsed, key),
			),
			change: `added ${key}: true`,
		};
	}
	const toggle = readToggle(parsed, entry, key, snippet);
	if (toggle.on) return { source: parsed.source };
	const [from, to] = toggle.span;
	return {
		source: parsed.source.slice(0, from) + "true" + parsed.source.slice(to),
		change: `set ${toggle.path}: false → true`,
	};
};

/** Whether `dataApi` verifies a third-party IdP, in which case it does not need Neon Auth. */
const dataApiIsExternal = (parsed: Parsed): boolean => {
	const entry = findEntry(parsed.root, "dataApi");
	const object = entry ? objectOf(parsed, entry) : undefined;
	const provider = object ? findEntry(object, "authProvider") : undefined;
	return (
		provider !== undefined &&
		/^["']external["']$/.test(
			parsed.source.slice(provider.valueStart, provider.valueEnd),
		)
	);
};

/** A named entry (a function or a bucket) inside `functions` / `buckets`. */
const addNamed = (
	parsed: Parsed,
	container: "functions" | "buckets",
	name: string,
	entryLines: readonly string[],
): Step => {
	const block = [
		`${container}: {`,
		...entryLines.map((line) => parsed.unit + line),
		"},",
	];
	assertNotUnderPreview(parsed, container, block);
	const entry = findEntry(parsed.root, container);
	if (!entry) {
		return {
			source: insertEntry(
				parsed,
				parsed.root,
				block,
				block,
				entryAfter(parsed, container),
			),
			change: `added ${container}.${name}`,
		};
	}
	const object = objectOf(parsed, entry);
	if (!object) {
		return unsupported(`${container} is not an object literal.`, block);
	}
	if (findEntry(object, name)) return { source: parsed.source };
	return {
		source: insertEntry(parsed, object, entryLines, block),
		change: `added ${container}.${name}`,
	};
};

const apply = (source: string, edit: ConfigEdit): ConfigEditResult => {
	const steps: Step[] = [];
	let current = source;
	const run = (build: (parsed: Parsed) => Step): void => {
		const step = build(parse(current));
		current = step.source;
		steps.push(step);
	};

	switch (edit.kind) {
		case "service":
			if (edit.service === "auth") {
				run((parsed) => setToggle(parsed, "auth"));
			} else if (edit.service === "ai-gateway") {
				run((parsed) => setToggle(parsed, "aiGateway"));
			} else {
				// The default Data API provider verifies Neon Auth tokens, and `defineConfig`
				// rejects `dataApi` without `auth`.
				if (!dataApiIsExternal(parse(current))) {
					run((parsed) => setToggle(parsed, "auth"));
				}
				run((parsed) => setToggle(parsed, "dataApi"));
			}
			break;
		case "function":
			run((parsed) =>
				addNamed(parsed, "functions", edit.slug, [
					`${renderKey(edit.slug)}: { name: ${JSON.stringify(edit.name)}, source: ${JSON.stringify(edit.source)} },`,
				]),
			);
			break;
		case "bucket":
			run((parsed) =>
				addNamed(parsed, "buckets", edit.name, [
					`${renderKey(edit.name)}: { access: ${JSON.stringify(edit.access)} },`,
				]),
			);
			break;
	}

	return {
		source: current,
		changes: steps.flatMap((step) => (step.change ? [step.change] : [])),
	};
};

/**
 * Apply `edit` to the text of a `neon.ts`. The result is re-read before it is returned: a
 * splice the scanner cannot find its own edit in is a bug in the splice, and it throws
 * instead of handing back a file that does not declare what was asked for.
 */
export const editNeonConfig = (
	source: string,
	edit: ConfigEdit,
): ConfigEditResult => {
	const result = apply(source, edit);
	if (
		result.changes.length > 0 &&
		apply(result.source, edit).changes.length > 0
	) {
		throw new ConfigEditError(
			"Editing neon.ts would not produce a file that declares the requested change. Nothing was written.",
		);
	}
	return result;
};
