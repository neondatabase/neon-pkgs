/**
 * A scanner for the shape of a `neon.ts` file, just deep enough to find the config object
 * literal and the spans of its properties, so an edit can splice text into the file and leave
 * everything else byte-for-byte alone.
 *
 * It is not a JavaScript parser. It classifies every character as code, comment, or literal
 * (string, template text, regex), matches brackets over the code characters, and splits an
 * object literal on its top-level commas. Anything it cannot place with confidence throws
 * {@link SourceScanError}; callers turn that into "edit it by hand" rather than guessing.
 */

export class SourceScanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SourceScanError";
	}
}

const CODE = 0;
const COMMENT = 1;
const LITERAL = 2;

/** Per-character classification of a source file. */
export type SourceKinds = Uint8Array;

// A `/` after one of these starts a regex literal; after anything else it divides.
const REGEX_MAY_FOLLOW = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_KEYWORDS = new Set([
	"return",
	"typeof",
	"case",
	"in",
	"of",
	"delete",
	"void",
	"throw",
	"new",
	"else",
	"do",
	"yield",
	"await",
]);

const isIdentChar = (char: string): boolean => /[\w$]/.test(char);
const isSpace = (char: string): boolean => /\s/.test(char);

const unterminated = (what: string, at: number): SourceScanError =>
	new SourceScanError(`unterminated ${what} at offset ${at}`);

/** Whether the `/` at `index` opens a regex literal rather than dividing. */
const opensRegex = (
	source: string,
	kinds: SourceKinds,
	index: number,
): boolean => {
	let prev = index - 1;
	while (prev >= 0 && (isSpace(source[prev]) || kinds[prev] === COMMENT)) {
		prev--;
	}
	if (prev < 0) return true;
	if (kinds[prev] === LITERAL) return false;
	const char = source[prev];
	if (isIdentChar(char)) {
		let start = prev;
		while (start > 0 && isIdentChar(source[start - 1])) start--;
		return REGEX_KEYWORDS.has(source.slice(start, prev + 1));
	}
	return REGEX_MAY_FOLLOW.has(char);
};

/** Classify every character of `source` as code, comment, or literal. */
export const classify = (source: string): SourceKinds => {
	const kinds = new Uint8Array(source.length);
	const length = source.length;
	// One entry per open `${`: the number of `{` opened inside it and not yet closed.
	const templateDepths: number[] = [];

	const mark = (from: number, to: number, kind: number): void => {
		kinds.fill(kind, from, to);
	};

	// Consumes template text after the opening backtick (or the `}` closing a `${`) at `from`,
	// up to and including the closing backtick or the next `${`, and returns the index after it.
	const scanTemplateText = (from: number): number => {
		let i = from + 1;
		while (i < length) {
			if (source[i] === "\\") {
				i += 2;
			} else if (source[i] === "`") {
				mark(from, i + 1, LITERAL);
				return i + 1;
			} else if (source[i] === "$" && source[i + 1] === "{") {
				mark(from, i + 2, LITERAL);
				templateDepths.push(0);
				return i + 2;
			} else {
				i++;
			}
		}
		throw unterminated("template literal", from);
	};

	let i = 0;
	while (i < length) {
		const char = source[i];
		const next = source[i + 1];

		if (char === "/" && next === "/") {
			const newline = source.indexOf("\n", i);
			const end = newline === -1 ? length : newline;
			mark(i, end, COMMENT);
			i = end;
		} else if (char === "/" && next === "*") {
			const close = source.indexOf("*/", i + 2);
			if (close === -1) throw unterminated("block comment", i);
			mark(i, close + 2, COMMENT);
			i = close + 2;
		} else if (char === '"' || char === "'") {
			let j = i + 1;
			while (j < length && source[j] !== char) {
				if (source[j] === "\n") throw unterminated("string", i);
				j += source[j] === "\\" ? 2 : 1;
			}
			if (j >= length) throw unterminated("string", i);
			mark(i, j + 1, LITERAL);
			i = j + 1;
		} else if (char === "`") {
			i = scanTemplateText(i);
		} else if (char === "/") {
			if (!opensRegex(source, kinds, i)) {
				i++;
				continue;
			}
			let j = i + 1;
			let inClass = false;
			while (j < length) {
				const c = source[j];
				if (c === "\n") throw unterminated("regular expression", i);
				if (c === "\\") {
					j += 2;
					continue;
				}
				if (c === "[") inClass = true;
				else if (c === "]") inClass = false;
				else if (c === "/" && !inClass) break;
				j++;
			}
			if (j >= length) throw unterminated("regular expression", i);
			j++;
			while (j < length && /[a-z]/i.test(source[j])) j++;
			mark(i, j, LITERAL);
			i = j;
		} else if (char === "{" && templateDepths.length > 0) {
			templateDepths[templateDepths.length - 1]++;
			i++;
		} else if (char === "}" && templateDepths.length > 0) {
			const top = templateDepths.length - 1;
			if (templateDepths[top] === 0) {
				templateDepths.pop();
				// The `}` that closes `${` belongs to the template, not to the code.
				i = scanTemplateText(i);
			} else {
				templateDepths[top]--;
				i++;
			}
		} else {
			i++;
		}
	}
	if (templateDepths.length > 0) {
		throw unterminated("template expression", length);
	}
	return kinds;
};

export type ObjectEntry = {
	/** The property name, when the entry is `name: value`, `"name": value`, `name`, or `name() {}`. */
	key: string | undefined;
	/** Whether the entry has the `key: value` form, so `valueStart`/`valueEnd` are set. */
	keyed: boolean;
	/** First character of the entry, after leading whitespace and comments. */
	start: number;
	/** One past the last character of the entry, before trailing whitespace and comments. */
	end: number;
	valueStart: number;
	valueEnd: number;
};

export type ObjectScan = {
	/** Index of `{`. */
	open: number;
	/** Index of the matching `}`. */
	close: number;
	entries: ObjectEntry[];
};

const isTrivia = (source: string, kinds: SourceKinds, index: number): boolean =>
	isSpace(source[index]) || kinds[index] === COMMENT;

const skipTrivia = (
	source: string,
	kinds: SourceKinds,
	from: number,
	to: number,
): number => {
	let i = from;
	while (i < to && isTrivia(source, kinds, i)) i++;
	return i;
};

const trimTriviaEnd = (
	source: string,
	kinds: SourceKinds,
	from: number,
	to: number,
): number => {
	let i = to;
	while (i > from && isTrivia(source, kinds, i - 1)) i--;
	return i;
};

const readEntry = (
	source: string,
	kinds: SourceKinds,
	from: number,
	to: number,
): ObjectEntry | undefined => {
	const start = skipTrivia(source, kinds, from, to);
	if (start >= to) return undefined;
	const end = trimTriviaEnd(source, kinds, start, to);
	const other = (key?: string): ObjectEntry => ({
		key,
		keyed: false,
		start,
		end,
		valueStart: end,
		valueEnd: end,
	});

	let key: string | undefined;
	let afterKey: number;
	if (
		kinds[start] === LITERAL &&
		(source[start] === '"' || source[start] === "'")
	) {
		let close = start;
		while (close < end && kinds[close] === LITERAL) close++;
		const inner = source.slice(start + 1, close - 1);
		if (inner.includes("\\")) return other();
		key = inner;
		afterKey = close;
	} else {
		const ident = /^[A-Za-z_$][\w$]*/.exec(source.slice(start, end));
		if (kinds[start] !== CODE || ident === null) return other();
		key = ident[0];
		afterKey = start + key.length;
	}

	const colon = skipTrivia(source, kinds, afterKey, end);
	if (colon >= end || source[colon] !== ":" || kinds[colon] !== CODE) {
		return other(key);
	}
	const valueStart = skipTrivia(source, kinds, colon + 1, end);
	return { key, keyed: true, start, end, valueStart, valueEnd: end };
};

/** Scan the object literal whose `{` is at `open`. */
export const scanObject = (
	source: string,
	kinds: SourceKinds,
	open: number,
): ObjectScan => {
	if (source[open] !== "{" || kinds[open] !== CODE) {
		throw new SourceScanError(
			`expected an object literal at offset ${open}`,
		);
	}
	const entries: ObjectEntry[] = [];
	let depth = 0;
	let entryStart = open + 1;
	for (let i = open + 1; i < source.length; i++) {
		if (kinds[i] !== CODE) continue;
		const char = source[i];
		if (char === "{" || char === "[" || char === "(") {
			depth++;
		} else if (char === "}" || char === "]" || char === ")") {
			if (depth > 0) {
				depth--;
				continue;
			}
			if (char !== "}") {
				throw new SourceScanError(
					`unbalanced "${char}" at offset ${i}`,
				);
			}
			const last = readEntry(source, kinds, entryStart, i);
			if (last) entries.push(last);
			return { open, close: i, entries };
		} else if (char === "," && depth === 0) {
			const entry = readEntry(source, kinds, entryStart, i);
			if (entry) entries.push(entry);
			entryStart = i + 1;
		}
	}
	throw new SourceScanError(
		`object literal at offset ${open} is never closed`,
	);
};

/** The entry named `key`, when the object has one. */
export const findEntry = (
	scan: ObjectScan,
	key: string,
): ObjectEntry | undefined => scan.entries.find((entry) => entry.key === key);

/**
 * The object literal an entry's value is, or `undefined` when the value is anything else
 * (`true`, an identifier, `{ … } as const`, a call). Only a value that is exactly one object
 * literal can be edited in place.
 */
export const entryObject = (
	source: string,
	kinds: SourceKinds,
	entry: ObjectEntry,
): ObjectScan | undefined => {
	if (!entry.keyed || source[entry.valueStart] !== "{") return undefined;
	const scan = scanObject(source, kinds, entry.valueStart);
	return scan.close + 1 === entry.valueEnd ? scan : undefined;
};

/**
 * The index of the `{` holding the policy: the argument of the first `defineConfig(` call, or
 * the object a bare `export default { … }` exports.
 */
export const findConfigObject = (
	source: string,
	kinds: SourceKinds,
): number => {
	for (const call of source.matchAll(/\bdefineConfig\s*\(/g)) {
		if (kinds[call.index] !== CODE) continue;
		const arg = skipTrivia(
			source,
			kinds,
			call.index + call[0].length,
			source.length,
		);
		if (source[arg] === "{") return arg;
		throw new SourceScanError(
			"defineConfig() is not called with an object literal",
		);
	}
	for (const exported of source.matchAll(/\bexport\s+default\s+(?=\{)/g)) {
		if (kinds[exported.index] === CODE) {
			return exported.index + exported[0].length;
		}
	}
	throw new SourceScanError("no defineConfig({ … }) call found");
};

/** Start index of the line containing `index`. */
export const lineStart = (source: string, index: number): number =>
	source.lastIndexOf("\n", index - 1) + 1;

/**
 * The whitespace that indents the line containing `index`, whatever else is on that line.
 */
export const lineIndent = (source: string, index: number): string => {
	const start = lineStart(source, index);
	const indent = /^[ \t]*/.exec(source.slice(start));
	return indent ? indent[0] : "";
};

/** Whether the character at `index` is a comment character. */
export const isCommentAt = (kinds: SourceKinds, index: number): boolean =>
	kinds[index] === COMMENT;

/** Whether the character at `index` is code (not a comment, string, or regex). */
export const isCodeAt = (kinds: SourceKinds, index: number): boolean =>
	kinds[index] === CODE;
