type TokenType = "ident" | "string" | "number" | "regex" | "punct";

type Token = {
	type: TokenType;
	value: string;
	start: number;
	end: number;
};

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const REGEX_FLAG = /[a-z]/i;

const KEYWORDS_BEFORE_REGEX = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"do",
	"else",
	"yield",
	"await",
	"case",
]);

const PUNCT_BEFORE_REGEX = new Set([
	"(",
	"[",
	"{",
	",",
	";",
	":",
	"=",
	"==",
	"===",
	"!",
	"!=",
	"!==",
	"&&",
	"||",
	"??",
	"?",
	".",
	"+",
	"-",
	"*",
	"/",
	"%",
	"^",
	"~",
	"<",
	">",
	"<=",
	">=",
	"&",
	"|",
	"=>",
	"...",
]);

const MULTI_PUNCT = [
	"...",
	"===",
	"!==",
	"=>",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"??",
	"?.",
	"**",
	"+=",
	"-=",
	"*=",
	"/=",
];

const readString = (src: string, index: number): number => {
	const quote = src[index];
	let i = index + 1;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === quote) return i + 1;
		if (c === "\n") return i;
		i++;
	}
	return i;
};

const readTemplate = (src: string, index: number): number => {
	let i = index + 1;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "`") return i + 1;
		if (c === "$" && src[i + 1] === "{") {
			i += 2;
			let depth = 1;
			while (i < src.length && depth > 0) {
				const d = src[i];
				if (d === "\\") {
					i += 2;
					continue;
				}
				if (d === '"' || d === "'") {
					i = readString(src, i);
					continue;
				}
				if (d === "`") {
					i = readTemplate(src, i);
					continue;
				}
				if (d === "{") depth++;
				else if (d === "}") depth--;
				i++;
			}
			continue;
		}
		i++;
	}
	return i;
};

const readRegex = (src: string, index: number): number => {
	let i = index + 1;
	let inClass = false;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) {
			i++;
			while (i < src.length && REGEX_FLAG.test(src[i])) i++;
			return i;
		} else if (c === "\n") return i;
		i++;
	}
	return i;
};

const regexAllowedAfter = (previous: Token | undefined): boolean => {
	if (previous === undefined) return true;
	if (previous.type === "punct")
		return PUNCT_BEFORE_REGEX.has(previous.value);
	if (previous.type === "ident")
		return KEYWORDS_BEFORE_REGEX.has(previous.value);
	return false;
};

/**
 * Tokenize a small JS/TS grammar for the constrained config editor. Trivia (whitespace and
 * comments) is dropped; every token keeps its original source offsets so edits splice the file
 * rather than re-emit it. Strings, template literals and regex literals are single opaque
 * tokens, so brackets or commas inside them never disturb the structural walk.
 */
export const tokenize = (src: string): Token[] => {
	const tokens: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\r" || c === "\n") {
			i++;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i);
			i = nl === -1 ? src.length : nl;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			i = end === -1 ? src.length : end + 2;
			continue;
		}
		if (c === '"' || c === "'") {
			const end = readString(src, i);
			tokens.push({
				type: "string",
				value: src.slice(i, end),
				start: i,
				end,
			});
			i = end;
			continue;
		}
		if (c === "`") {
			const end = readTemplate(src, i);
			tokens.push({
				type: "string",
				value: src.slice(i, end),
				start: i,
				end,
			});
			i = end;
			continue;
		}
		if (c === "/" && regexAllowedAfter(tokens[tokens.length - 1])) {
			const end = readRegex(src, i);
			tokens.push({
				type: "regex",
				value: src.slice(i, end),
				start: i,
				end,
			});
			i = end;
			continue;
		}
		if (IDENT_START.test(c)) {
			let j = i + 1;
			while (j < src.length && IDENT_PART.test(src[j])) j++;
			tokens.push({
				type: "ident",
				value: src.slice(i, j),
				start: i,
				end: j,
			});
			i = j;
			continue;
		}
		if (DIGIT.test(c) || (c === "." && DIGIT.test(src[i + 1] ?? ""))) {
			let j = i + 1;
			while (j < src.length && /[0-9a-fA-FxXoObBeE._n+-]/.test(src[j]))
				j++;
			tokens.push({
				type: "number",
				value: src.slice(i, j),
				start: i,
				end: j,
			});
			i = j;
			continue;
		}
		let matched = "";
		for (const punct of MULTI_PUNCT) {
			if (src.startsWith(punct, i)) {
				matched = punct;
				break;
			}
		}
		if (matched === "") matched = c;
		tokens.push({
			type: "punct",
			value: matched,
			start: i,
			end: i + matched.length,
		});
		i += matched.length;
	}
	return tokens;
};

const parseStringLiteral = (raw: string): string | undefined => {
	if (raw.length < 2) return undefined;
	const quote = raw[0];
	if (quote === "`") {
		if (raw.includes("${")) return undefined;
		return raw.slice(1, -1);
	}
	if (quote !== '"' && quote !== "'") return undefined;
	try {
		return JSON.parse(
			quote === '"'
				? raw
				: `"${raw.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`,
		);
	} catch {
		return undefined;
	}
};

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/** Index of the token that closes the bracket opened at `open`, or -1 if unbalanced. */
const matchBracket = (tokens: Token[], open: number): number => {
	let depth = 0;
	for (let i = open; i < tokens.length; i++) {
		const value = tokens[i].value;
		if (tokens[i].type === "punct" && OPEN.has(value)) depth++;
		else if (tokens[i].type === "punct" && CLOSE.has(value)) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
};

export type ConfigMember = {
	key: string;
	keyTokenIndex: number;
	valueStartIndex: number;
	valueEndIndex: number;
};

type ObjectShape =
	| { kind: "unsafe"; reason: string }
	| { kind: "object"; open: number; close: number; members: ConfigMember[] };

/**
 * Walk the members of the object literal whose `{` is at token `open`. Rejects anything the
 * editor cannot prove safe: spreads, computed keys, shorthand, and getters/setters/methods.
 */
const readObjectMembers = (tokens: Token[], open: number): ObjectShape => {
	const close = matchBracket(tokens, open);
	if (close === -1)
		return { kind: "unsafe", reason: "unbalanced object literal" };
	const members: ConfigMember[] = [];
	let i = open + 1;
	while (i < close) {
		const token = tokens[i];
		if (token.type === "punct" && token.value === ",") {
			i++;
			continue;
		}
		if (token.type === "punct" && token.value === "...") {
			return {
				kind: "unsafe",
				reason: "spread element in a config object",
			};
		}
		if (token.type === "punct" && token.value === "[") {
			return {
				kind: "unsafe",
				reason: "computed key in a config object",
			};
		}
		if (token.type !== "ident" && token.type !== "string") {
			return {
				kind: "unsafe",
				reason: `unexpected \`${token.value}\` in a config object`,
			};
		}
		const keyTokenIndex = i;
		const colon = tokens[i + 1];
		if (colon?.type !== "punct" || colon.value !== ":") {
			return {
				kind: "unsafe",
				reason: "shorthand, method, or accessor property in a config object",
			};
		}
		const key =
			token.type === "string"
				? parseStringLiteral(token.value)
				: token.value;
		if (key === undefined) {
			return {
				kind: "unsafe",
				reason: "non-literal key in a config object",
			};
		}
		const valueStartIndex = i + 2;
		let depth = 0;
		let j = valueStartIndex;
		while (j < close) {
			const value = tokens[j];
			if (value.type === "punct" && OPEN.has(value.value)) depth++;
			else if (value.type === "punct" && CLOSE.has(value.value)) depth--;
			else if (
				value.type === "punct" &&
				value.value === "," &&
				depth === 0
			) {
				break;
			}
			j++;
		}
		if (valueStartIndex >= j) {
			return {
				kind: "unsafe",
				reason: "empty property value in a config object",
			};
		}
		members.push({
			key,
			keyTokenIndex,
			valueStartIndex,
			valueEndIndex: j - 1,
		});
		i = j;
	}
	return { kind: "object", open, close, members };
};

export type ExistingFunction = {
	slug: string;
	/** Raw `source` string value when statically extractable; `undefined` otherwise. */
	source?: string;
	keyStartOffset: number;
	valueEndOffset: number;
};

/** Primitive value a trigger member can carry once statically extracted. */
export type TriggerFieldValue = string | number | boolean;

export type ExistingTrigger = {
	name: string;
	/**
	 * The trigger's statically-extracted primitive fields (`type`, `function`, `cron`, …), or
	 * `undefined` when the value isn't a static object of literals — in which case the caller
	 * cannot prove two declarations equal and must treat it as a conflict.
	 */
	fields?: Record<string, TriggerFieldValue>;
	keyStartOffset: number;
	valueEndOffset: number;
};

type BlockContext = {
	openOffset: number;
	closeOffset: number;
	keyIndent: string;
	memberIndent: string;
	hasMembers: boolean;
};

type EditContext = {
	source: string;
	extension: string;
	configOpenOffset: number;
	topIndent: string;
	unit: string;
	functionsBlock?: BlockContext;
	triggersBlock?: BlockContext;
};

export type ConfigAnalysis =
	| { safe: false; reason: string }
	| {
			safe: true;
			binding: string;
			functions: ExistingFunction[];
			triggers: ExistingTrigger[];
			ctx: EditContext;
	  };

const lineIndent = (source: string, offset: number): string => {
	const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
	let end = lineStart;
	while (end < offset && (source[end] === " " || source[end] === "\t")) end++;
	return source.slice(lineStart, end);
};

const NEON_CONFIG_SPECIFIERS = new Set(["@neon/config", "@neon/config/v1"]);

/**
 * Find the local binding introduced by a **non-aliased** named import of `defineConfig` from
 * `@neon/config` or `@neon/config/v1`. Aliased imports, default imports, namespace imports, and
 * re-exports are deliberately not recognized — the editor only proves the documented form.
 */
const findDefineConfigBinding = (tokens: Token[]): string | undefined => {
	for (let i = 0; i < tokens.length; i++) {
		if (!(tokens[i].type === "ident" && tokens[i].value === "import"))
			continue;
		const brace = i + 1;
		if (!(tokens[brace]?.type === "punct" && tokens[brace].value === "{")) {
			continue;
		}
		const close = matchBracket(tokens, brace);
		if (close === -1) continue;
		const from = tokens[close + 1];
		const spec = tokens[close + 2];
		if (!(from?.type === "ident" && from.value === "from")) continue;
		if (spec?.type !== "string") continue;
		const specifier = parseStringLiteral(spec.value);
		if (specifier === undefined || !NEON_CONFIG_SPECIFIERS.has(specifier)) {
			continue;
		}
		let j = brace + 1;
		while (j < close) {
			const name = tokens[j];
			if (name.type === "punct" && name.value === ",") {
				j++;
				continue;
			}
			const next = tokens[j + 1];
			const aliased = next?.type === "ident" && next.value === "as";
			if (
				name.type === "ident" &&
				name.value === "defineConfig" &&
				!aliased
			) {
				return "defineConfig";
			}
			j += aliased ? 3 : 1;
		}
	}
	return undefined;
};

const objectHasKey = (tokens: Token[], open: number, key: string): boolean => {
	const shape = readObjectMembers(tokens, open);
	return shape.kind === "object" && shape.members.some((m) => m.key === key);
};

const extractSourceValue = (
	tokens: Token[],
	valueStartIndex: number,
): string | undefined => {
	const first = tokens[valueStartIndex];
	if (!(first?.type === "punct" && first.value === "{")) return undefined;
	const shape = readObjectMembers(tokens, valueStartIndex);
	if (shape.kind !== "object") return undefined;
	const source = shape.members.find((m) => m.key === "source");
	if (!source) return undefined;
	const literal = tokens[source.valueStartIndex];
	if (source.valueEndIndex !== source.valueStartIndex) return undefined;
	if (literal.type !== "string") return undefined;
	return parseStringLiteral(literal.value);
};

/**
 * Extract a trigger object literal's members as primitive values, so two declarations can be
 * compared for equality before a conflict is reported. Returns `undefined` for anything not
 * provably static (a computed value, a spread, a nested object, a non-literal expression) — the
 * caller then treats the existing trigger as a conflict rather than silently overwriting it.
 */
const extractPrimitiveFields = (
	tokens: Token[],
	valueStartIndex: number,
): Record<string, TriggerFieldValue> | undefined => {
	const first = tokens[valueStartIndex];
	if (!(first?.type === "punct" && first.value === "{")) return undefined;
	const shape = readObjectMembers(tokens, valueStartIndex);
	if (shape.kind !== "object") return undefined;
	const fields: Record<string, TriggerFieldValue> = {};
	for (const member of shape.members) {
		if (member.valueEndIndex !== member.valueStartIndex) return undefined;
		const literal = tokens[member.valueStartIndex];
		if (literal.type === "string") {
			const value = parseStringLiteral(literal.value);
			if (value === undefined) return undefined;
			fields[member.key] = value;
		} else if (literal.type === "number") {
			const value = Number(literal.value);
			if (!Number.isFinite(value)) return undefined;
			fields[member.key] = value;
		} else if (
			literal.type === "ident" &&
			(literal.value === "true" || literal.value === "false")
		) {
			fields[member.key] = literal.value === "true";
		} else {
			return undefined;
		}
	}
	return fields;
};

type RecordBlock =
	| { kind: "unsafe"; reason: string }
	| {
			kind: "block";
			members: ConfigMember[];
			close: number;
			ctx: BlockContext;
	  };

/**
 * Resolve a top-level record member (`functions` or `triggers`) to its object-literal members and
 * the offsets/indentation an edit needs, or an `unsafe` verdict when the value isn't a static
 * object literal. Shared by the two record blocks the editor manages so their splice geometry
 * stays identical.
 */
const readTopLevelRecord = (
	tokens: Token[],
	source: string,
	member: ConfigMember,
	unit: string,
	label: string,
): RecordBlock => {
	const blockOpen = tokens[member.valueStartIndex];
	if (!(blockOpen?.type === "punct" && blockOpen.value === "{")) {
		return {
			kind: "unsafe",
			reason: `the \`${label}\` value is not a static object literal`,
		};
	}
	const block = readObjectMembers(tokens, member.valueStartIndex);
	if (block.kind === "unsafe")
		return { kind: "unsafe", reason: block.reason };
	const keyIndent = lineIndent(source, tokens[member.keyTokenIndex].start);
	return {
		kind: "block",
		members: block.members,
		close: block.close,
		ctx: {
			openOffset: blockOpen.end,
			closeOffset: tokens[block.close].start,
			keyIndent,
			memberIndent:
				block.members.length > 0
					? lineIndent(
							source,
							tokens[block.members[0].keyTokenIndex].start,
						)
					: `${keyIndent}${unit}`,
			hasMembers: block.members.length > 0,
		},
	};
};

/**
 * Statically analyze a Neon config file to decide whether the constrained editor may register a
 * function in it. Only a `export default defineConfig({ … })` static object literal — with the
 * `defineConfig` binding proven to come from `@neon/config` — is editable; every other shape
 * (dynamic config, spreads, computed keys, `preview.functions`, multiple exports, …) returns an
 * `unsafe` verdict so the caller can fall back to a pasteable fragment.
 */
export const analyzeNeonConfig = (
	source: string,
	extension: string,
): ConfigAnalysis => {
	const tokens = tokenize(source);
	const binding = findDefineConfigBinding(tokens);
	if (binding === undefined) {
		return {
			safe: false,
			reason: 'no `import { defineConfig } from "@neon/config/v1"` binding was found',
		};
	}

	let exportIndex = -1;
	for (let i = 0; i < tokens.length; i++) {
		if (
			tokens[i].type === "ident" &&
			tokens[i].value === "export" &&
			tokens[i + 1]?.type === "ident" &&
			tokens[i + 1].value === "default"
		) {
			if (exportIndex !== -1) {
				return {
					safe: false,
					reason: "multiple `export default` statements",
				};
			}
			exportIndex = i;
		}
	}
	if (exportIndex === -1) {
		return { safe: false, reason: "no `export default` was found" };
	}

	const callee = tokens[exportIndex + 2];
	const paren = tokens[exportIndex + 3];
	const configOpen = tokens[exportIndex + 4];
	if (!(callee?.type === "ident" && callee.value === binding)) {
		return {
			safe: false,
			reason: "the default export is not a direct `defineConfig(...)` call",
		};
	}
	if (!(paren?.type === "punct" && paren.value === "(")) {
		return {
			safe: false,
			reason: "the default export is not a direct `defineConfig(...)` call",
		};
	}
	if (!(configOpen?.type === "punct" && configOpen.value === "{")) {
		return {
			safe: false,
			reason: "the `defineConfig` argument is not a static object literal",
		};
	}

	const configOpenIndex = exportIndex + 4;
	const config = readObjectMembers(tokens, configOpenIndex);
	if (config.kind === "unsafe") {
		return { safe: false, reason: config.reason };
	}

	const functionsMembers = config.members.filter(
		(m) => m.key === "functions",
	);
	if (functionsMembers.length > 1) {
		return {
			safe: false,
			reason: "multiple `functions` keys in the config",
		};
	}

	const triggersMembers = config.members.filter((m) => m.key === "triggers");
	if (triggersMembers.length > 1) {
		return {
			safe: false,
			reason: "multiple `triggers` keys in the config",
		};
	}

	const preview = config.members.find((m) => m.key === "preview");
	if (preview) {
		const previewValue = tokens[preview.valueStartIndex];
		if (!(previewValue?.type === "punct" && previewValue.value === "{")) {
			return {
				safe: false,
				reason: "a non-literal `preview` block the editor cannot inspect",
			};
		}
		if (objectHasKey(tokens, preview.valueStartIndex, "functions")) {
			return {
				safe: false,
				reason: "a deprecated `preview.functions` block is present",
			};
		}
	}

	const configLineIndent = lineIndent(source, tokens[exportIndex].start);
	const topIndent =
		config.members.length > 0
			? lineIndent(source, tokens[config.members[0].keyTokenIndex].start)
			: `${configLineIndent}  `;
	let unit = topIndent.slice(configLineIndent.length);
	if (unit === "") unit = topIndent.includes("\t") ? "\t" : "  ";

	const ctx: EditContext = {
		source,
		extension,
		configOpenOffset: configOpen.end,
		topIndent,
		unit,
	};

	const functions: ExistingFunction[] = [];
	const functionsMember = functionsMembers[0];
	if (functionsMember) {
		const block = readTopLevelRecord(
			tokens,
			source,
			functionsMember,
			unit,
			"functions",
		);
		if (block.kind === "unsafe") {
			return { safe: false, reason: block.reason };
		}
		const seen = new Set<string>();
		for (const member of block.members) {
			if (seen.has(member.key)) {
				return {
					safe: false,
					reason: `duplicate function slug \`${member.key}\``,
				};
			}
			seen.add(member.key);
			functions.push({
				slug: member.key,
				source: extractSourceValue(tokens, member.valueStartIndex),
				keyStartOffset: tokens[member.keyTokenIndex].start,
				valueEndOffset: tokens[member.valueEndIndex].end,
			});
		}
		ctx.functionsBlock = block.ctx;
	}

	const triggers: ExistingTrigger[] = [];
	const triggersMember = triggersMembers[0];
	if (triggersMember) {
		const block = readTopLevelRecord(
			tokens,
			source,
			triggersMember,
			unit,
			"triggers",
		);
		if (block.kind === "unsafe") {
			return { safe: false, reason: block.reason };
		}
		const seen = new Set<string>();
		for (const member of block.members) {
			if (seen.has(member.key)) {
				return {
					safe: false,
					reason: `duplicate trigger name \`${member.key}\``,
				};
			}
			seen.add(member.key);
			triggers.push({
				name: member.key,
				fields: extractPrimitiveFields(tokens, member.valueStartIndex),
				keyStartOffset: tokens[member.keyTokenIndex].start,
				valueEndOffset: tokens[member.valueEndIndex].end,
			});
		}
		ctx.triggersBlock = block.ctx;
	}

	return { safe: true, binding, functions, triggers, ctx };
};

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const renderKey = (name: string): string =>
	IDENT_RE.test(name) ? name : JSON.stringify(name);

export type FunctionDeclaration = {
	slug: string;
	name: string;
	source: string;
	/** Env var name → source expression (e.g. `process.env.RESEND_API_KEY!`). */
	env?: Record<string, string>;
	/** Non-default bundler, e.g. `"none"` for a prebuilt directory. */
	bundler?: string;
};

/** Render `<slug>: { name: …, source: … }` as a single-line object member. */
export const buildFunctionEntry = (
	decl: FunctionDeclaration,
	options: { includeEnv: boolean },
): string => {
	const parts = [
		`name: ${JSON.stringify(decl.name)}`,
		`source: ${JSON.stringify(decl.source)}`,
	];
	if (decl.bundler !== undefined) {
		parts.push(`bundler: ${JSON.stringify(decl.bundler)}`);
	}
	const envEntries = Object.entries(decl.env ?? {});
	if (options.includeEnv && envEntries.length > 0) {
		const inner = envEntries
			.map(([key, expression]) => `${renderKey(key)}: ${expression}`)
			.join(", ");
		parts.push(`env: { ${inner} }`);
	}
	return `${renderKey(decl.slug)}: { ${parts.join(", ")} }`;
};

/**
 * A function trigger to register, keyed by its branch-unique `name`. Fields mirror the Neon
 * config `triggers` shape exactly; only the ones present are rendered, so the emitted entry is a
 * valid `FunctionTriggerDef` (`functionPath`/`enabled` fall back to their documented defaults).
 */
export type TriggerDeclaration = {
	name: string;
	type: "schedule" | "storage_object_created";
	function: string;
	cron?: string;
	bucket?: string;
	prefix?: string;
	functionPath?: string;
	enabled?: boolean;
};

/**
 * The declaration's primitive fields, in the same normalized form {@link extractPrimitiveFields}
 * produces for an existing trigger, so a re-registration of the identical trigger compares equal
 * and is treated as a no-op rather than a conflict.
 */
export const triggerFields = (
	decl: TriggerDeclaration,
): Record<string, TriggerFieldValue> => {
	const fields: Record<string, TriggerFieldValue> = {
		type: decl.type,
		function: decl.function,
	};
	if (decl.cron !== undefined) fields.cron = decl.cron;
	if (decl.bucket !== undefined) fields.bucket = decl.bucket;
	if (decl.prefix !== undefined) fields.prefix = decl.prefix;
	if (decl.functionPath !== undefined)
		fields.functionPath = decl.functionPath;
	if (decl.enabled !== undefined) fields.enabled = decl.enabled;
	return fields;
};

const canonicalFields = (fields: Record<string, TriggerFieldValue>): string =>
	JSON.stringify(
		Object.fromEntries(
			Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)),
		),
	);

/** Whether an existing trigger's provable fields match a declaration exactly. */
export const sameTriggerConfig = (
	existing: ExistingTrigger,
	decl: TriggerDeclaration,
): boolean =>
	existing.fields !== undefined &&
	canonicalFields(existing.fields) === canonicalFields(triggerFields(decl));

/** Render `<name>: { type: …, function: …, cron: … }` as a single-line object member. */
export const buildTriggerEntry = (decl: TriggerDeclaration): string => {
	const parts = [
		`type: ${JSON.stringify(decl.type)}`,
		`function: ${JSON.stringify(decl.function)}`,
	];
	if (decl.cron !== undefined)
		parts.push(`cron: ${JSON.stringify(decl.cron)}`);
	if (decl.bucket !== undefined) {
		parts.push(`bucket: ${JSON.stringify(decl.bucket)}`);
	}
	if (decl.prefix !== undefined) {
		parts.push(`prefix: ${JSON.stringify(decl.prefix)}`);
	}
	if (decl.functionPath !== undefined) {
		parts.push(`functionPath: ${JSON.stringify(decl.functionPath)}`);
	}
	if (decl.enabled !== undefined) parts.push(`enabled: ${decl.enabled}`);
	return `${renderKey(decl.name)}: { ${parts.join(", ")} }`;
};

const supportsEnvAssertion = (extension: string): boolean =>
	extension === "ts" || extension === "mts" || extension === "cts";

/**
 * Insert a new function member into a safely-analyzed config. When a `functions` block already
 * exists the entry becomes its first member; otherwise a new `functions` block is added as the
 * first member of the config object. Every edit is a splice, so all other policy text, comments,
 * and newlines are preserved verbatim.
 */
export const insertFunction = (
	analysis: Extract<ConfigAnalysis, { safe: true }>,
	decl: FunctionDeclaration,
): string => {
	const { ctx } = analysis;
	const entry = buildFunctionEntry(decl, {
		includeEnv: supportsEnvAssertion(ctx.extension),
	});
	const source = ctx.source;
	if (ctx.functionsBlock) {
		const block = ctx.functionsBlock;
		if (block.hasMembers) {
			const insertion = `\n${block.memberIndent}${entry},`;
			return (
				source.slice(0, block.openOffset) +
				insertion +
				source.slice(block.openOffset)
			);
		}
		const insertion = `\n${block.memberIndent}${entry},\n${block.keyIndent}`;
		return (
			source.slice(0, block.openOffset) +
			insertion +
			source.slice(block.closeOffset)
		);
	}
	const memberIndent = `${ctx.topIndent}${ctx.unit}`;
	const insertion = `\n${ctx.topIndent}functions: {\n${memberIndent}${entry},\n${ctx.topIndent}},`;
	return (
		source.slice(0, ctx.configOpenOffset) +
		insertion +
		source.slice(ctx.configOpenOffset)
	);
};

/** Replace an existing function member (same slug) with a fresh declaration. */
export const replaceFunction = (
	analysis: Extract<ConfigAnalysis, { safe: true }>,
	slug: string,
	decl: FunctionDeclaration,
): string => {
	const { ctx } = analysis;
	const existing = analysis.functions.find((fn) => fn.slug === slug);
	if (!existing) {
		throw new Error(
			`Function slug "${slug}" is not declared in the config.`,
		);
	}
	const entry = buildFunctionEntry(decl, {
		includeEnv: supportsEnvAssertion(ctx.extension),
	});
	return (
		ctx.source.slice(0, existing.keyStartOffset) +
		entry +
		ctx.source.slice(existing.valueEndOffset)
	);
};

/**
 * Insert a trigger member into a safely-analyzed config, mirroring {@link insertFunction}: it
 * becomes the first member of an existing `triggers` block, or a fresh `triggers` block is added
 * as the first member of the config object. Every edit is a splice, so surrounding policy text is
 * preserved verbatim.
 */
export const insertTrigger = (
	analysis: Extract<ConfigAnalysis, { safe: true }>,
	decl: TriggerDeclaration,
): string => {
	const { ctx } = analysis;
	const entry = buildTriggerEntry(decl);
	const source = ctx.source;
	if (ctx.triggersBlock) {
		const block = ctx.triggersBlock;
		if (block.hasMembers) {
			const insertion = `\n${block.memberIndent}${entry},`;
			return (
				source.slice(0, block.openOffset) +
				insertion +
				source.slice(block.openOffset)
			);
		}
		const insertion = `\n${block.memberIndent}${entry},\n${block.keyIndent}`;
		return (
			source.slice(0, block.openOffset) +
			insertion +
			source.slice(block.closeOffset)
		);
	}
	const memberIndent = `${ctx.topIndent}${ctx.unit}`;
	const insertion = `\n${ctx.topIndent}triggers: {\n${memberIndent}${entry},\n${ctx.topIndent}},`;
	return (
		source.slice(0, ctx.configOpenOffset) +
		insertion +
		source.slice(ctx.configOpenOffset)
	);
};

/** Replace an existing trigger member (same name) with a fresh declaration. */
export const replaceTrigger = (
	analysis: Extract<ConfigAnalysis, { safe: true }>,
	name: string,
	decl: TriggerDeclaration,
): string => {
	const { ctx } = analysis;
	const existing = analysis.triggers.find((trigger) => trigger.name === name);
	if (!existing) {
		throw new Error(`Trigger "${name}" is not declared in the config.`);
	}
	const entry = buildTriggerEntry(decl);
	return (
		ctx.source.slice(0, existing.keyStartOffset) +
		entry +
		ctx.source.slice(existing.valueEndOffset)
	);
};
