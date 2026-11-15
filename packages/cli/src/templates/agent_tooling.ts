/**
 * The `agent` block a bootstrap or Function Registry template uses to suggest skills, MCP
 * servers, and CLIs for coding agents. Nothing in it is trusted: every string reaches a
 * terminal prompt, a child process argv, or an agent's MCP config, so the parser rejects
 * anything a shell, a terminal, or an agent would interpret.
 */

export const MAX_TOOLING_ENTRIES = 10;
const MAX_SKILLS_PER_SOURCE = 20;
const MAX_MAP_ENTRIES = 20;
const MAX_VALUE_LENGTH = 2048;
const MAX_COMMAND_PARTS = 32;
const MAX_COMMAND_PART_LENGTH = 1024;
const MAX_DESCRIPTION_LENGTH = 200;

export type TemplateSkills = {
	source: string;
	skills: string[];
	recommended: boolean;
};

type NamedEntry = {
	name: string;
	description?: string;
	recommended: boolean;
};

export type TemplateRemoteMcp = NamedEntry & {
	kind: "remote";
	url: string;
	transport: "http" | "sse";
	headers: Record<string, string>;
};

export type TemplateStdioMcp = NamedEntry & {
	kind: "stdio";
	command: string[];
	env: Record<string, string>;
};

export type TemplateMcpServer = TemplateRemoteMcp | TemplateStdioMcp;

export type TemplateNpmCli = NamedEntry & {
	kind: "npm";
	package: string;
};

export type TemplateCliInstallHints = {
	brew?: string;
	winget?: string;
	url?: string;
};

export type TemplateSystemCli = NamedEntry & {
	kind: "system";
	minVersion?: string;
	install: TemplateCliInstallHints;
};

export type TemplateCli = TemplateNpmCli | TemplateSystemCli;

export type TemplateAgentTooling = {
	skills: TemplateSkills[];
	mcp: TemplateMcpServer[];
	cli: TemplateCli[];
};

export class TemplateToolingError extends Error {
	constructor(path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "TemplateToolingError";
	}
}

const GITHUB_SHORTHAND =
	/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const SKILL_SOURCE_URL =
	/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)+\/?$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const EXECUTABLE = /^[a-z][a-z0-9._-]{0,63}$/;
const CLI_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NPM_PIN =
	/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const BREW_FORMULA = /^[a-z0-9][a-z0-9@._/+-]{0,127}$/;
const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HINT_URL =
	/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%/#-]*)?$/;
const PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * C0/C1 controls, zero-width characters, and bidi overrides. Each one can make a consent
 * prompt or a printed command read differently from what runs.
 */
const isUnsafeCodePoint = (code: number): boolean =>
	code < 0x20 ||
	(code >= 0x7f && code <= 0x9f) ||
	(code >= 0x200b && code <= 0x200f) ||
	(code >= 0x202a && code <= 0x202e) ||
	(code >= 0x2066 && code <= 0x2069) ||
	code === 0xfeff;

export const isSafeText = (value: string): boolean => {
	for (const char of value) {
		if (isUnsafeCodePoint(char.codePointAt(0) ?? 0)) return false;
	}
	return true;
};

/** The `${NAME}` placeholders a header or env value reads, in order of appearance. */
export const placeholderNames = (value: string): string[] =>
	[...value.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");

/**
 * A literal, or literals mixed with `${NAME}` placeholders. Any other `$` is refused, so
 * nothing reaches an agent config that the agent would expand itself (`${env:HOME}`,
 * `${VAR:-default}`, `$VAR`).
 */
const isTemplateValue = (value: string): boolean =>
	value.length <= MAX_VALUE_LENGTH &&
	isSafeText(value) &&
	!value.replace(PLACEHOLDER, "").includes("$");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const assertKeys = (
	value: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
): void => {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			throw new TemplateToolingError(path, `unknown field "${key}"`);
		}
	}
};

const list = (
	value: unknown,
	path: string,
	max = MAX_TOOLING_ENTRIES,
): unknown[] => {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length === 0 || value.length > max) {
		throw new TemplateToolingError(
			path,
			`must be a list of 1 to ${max} entries`,
		);
	}
	return value;
};

const matching = (value: unknown, pattern: RegExp, path: string): string => {
	if (typeof value !== "string" || !pattern.test(value)) {
		throw new TemplateToolingError(path, "is missing or malformed");
	}
	return value;
};

const optionalDescription = (
	value: unknown,
	path: string,
): string | undefined => {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		value.length > MAX_DESCRIPTION_LENGTH ||
		!isSafeText(value)
	) {
		throw new TemplateToolingError(
			path,
			`must be 1 to ${MAX_DESCRIPTION_LENGTH} printable characters`,
		);
	}
	return value;
};

const recommended = (value: unknown, path: string): boolean => {
	if (value === undefined) return true;
	if (typeof value !== "boolean") {
		throw new TemplateToolingError(path, "must be true or false");
	}
	return value;
};

const httpsUrl = (value: unknown, path: string): string => {
	if (
		typeof value !== "string" ||
		value.length > MAX_VALUE_LENGTH ||
		!isSafeText(value) ||
		/[\s$]/.test(value)
	) {
		throw new TemplateToolingError(path, "must be an https URL");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TemplateToolingError(path, "must be an https URL");
	}
	if (url.protocol !== "https:" || url.hostname === "") {
		throw new TemplateToolingError(path, "must be an https URL");
	}
	if (url.username !== "" || url.password !== "") {
		throw new TemplateToolingError(path, "must not carry credentials");
	}
	return value;
};

const valueMap = (
	value: unknown,
	keyPattern: RegExp,
	path: string,
): Record<string, string> => {
	if (value === undefined) return {};
	if (!isRecord(value)) {
		throw new TemplateToolingError(path, "must be a map of strings");
	}
	const entries = Object.entries(value);
	if (entries.length > MAX_MAP_ENTRIES) {
		throw new TemplateToolingError(
			path,
			`must have at most ${MAX_MAP_ENTRIES} entries`,
		);
	}
	const out: Record<string, string> = Object.create(null);
	const seen = new Set<string>();
	for (const [key, item] of entries) {
		if (!keyPattern.test(key) || seen.has(key.toLowerCase())) {
			throw new TemplateToolingError(
				`${path}.${key}`,
				"has a malformed or repeated name",
			);
		}
		seen.add(key.toLowerCase());
		if (typeof item !== "string" || !isTemplateValue(item)) {
			throw new TemplateToolingError(
				`${path}.${key}`,
				`must be a literal or \${NAME} placeholders, with no other $`,
			);
		}
		out[key] = item;
	}
	return out;
};

const parseSkills = (value: unknown, path: string): TemplateSkills => {
	if (!isRecord(value)) {
		throw new TemplateToolingError(path, "must be an object");
	}
	assertKeys(value, ["source", "skills", "recommended"], path);
	const { source } = value;
	if (
		typeof source !== "string" ||
		source.length > 255 ||
		!(GITHUB_SHORTHAND.test(source) || SKILL_SOURCE_URL.test(source))
	) {
		throw new TemplateToolingError(
			`${path}.source`,
			"must be owner/repo or an https git URL",
		);
	}
	const skills = list(
		value.skills,
		`${path}.skills`,
		MAX_SKILLS_PER_SOURCE,
	).map((skill, index) =>
		matching(skill, SKILL_NAME, `${path}.skills[${index}]`),
	);
	if (new Set(skills).size !== skills.length) {
		throw new TemplateToolingError(`${path}.skills`, "repeats a skill");
	}
	if (skills.length === 0) {
		throw new TemplateToolingError(`${path}.skills`, "is required");
	}
	return {
		source,
		skills,
		recommended: recommended(value.recommended, `${path}.recommended`),
	};
};

const parseCommand = (value: unknown, path: string): string[] => {
	if (
		!Array.isArray(value) ||
		value.length < 2 ||
		value.length > MAX_COMMAND_PARTS
	) {
		throw new TemplateToolingError(
			path,
			`must list an executable and 1 to ${MAX_COMMAND_PARTS - 1} arguments`,
		);
	}
	return value.map((part, index) => {
		const at = `${path}[${index}]`;
		if (
			typeof part !== "string" ||
			part === "" ||
			part.length > MAX_COMMAND_PART_LENGTH ||
			!isSafeText(part) ||
			part.includes("$")
		) {
			throw new TemplateToolingError(
				at,
				"must be a printable string with no $",
			);
		}
		if (index === 0 && !EXECUTABLE.test(part)) {
			throw new TemplateToolingError(
				at,
				"must be a bare executable name such as npx or uvx",
			);
		}
		if (index === 1 && /\s/.test(part)) {
			throw new TemplateToolingError(at, "must not contain whitespace");
		}
		return part;
	});
};

const parseMcp = (value: unknown, path: string): TemplateMcpServer => {
	if (!isRecord(value)) {
		throw new TemplateToolingError(path, "must be an object");
	}
	assertKeys(
		value,
		[
			"name",
			"description",
			"recommended",
			"url",
			"transport",
			"headers",
			"command",
			"env",
		],
		path,
	);
	const name = matching(value.name, MCP_NAME, `${path}.name`);
	if (name.toLowerCase() === "neon") {
		throw new TemplateToolingError(
			`${path}.name`,
			"is reserved: neon init and neon mcp own that entry",
		);
	}
	const common = {
		name,
		...(value.description !== undefined
			? {
					description: optionalDescription(
						value.description,
						`${path}.description`,
					),
				}
			: {}),
		recommended: recommended(value.recommended, `${path}.recommended`),
	} as NamedEntry;
	const remote = value.url !== undefined;
	const stdio = value.command !== undefined;
	if (remote === stdio) {
		throw new TemplateToolingError(
			path,
			"needs exactly one of url or command",
		);
	}
	if (remote) {
		if (value.env !== undefined) {
			throw new TemplateToolingError(
				`${path}.env`,
				"is for command servers; use headers",
			);
		}
		const { transport = "http" } = value;
		if (transport !== "http" && transport !== "sse") {
			throw new TemplateToolingError(
				`${path}.transport`,
				'must be "http" or "sse"',
			);
		}
		return {
			...common,
			kind: "remote",
			url: httpsUrl(value.url, `${path}.url`),
			transport,
			headers: valueMap(value.headers, HEADER_NAME, `${path}.headers`),
		};
	}
	if (value.transport !== undefined || value.headers !== undefined) {
		throw new TemplateToolingError(
			path,
			"transport and headers are for url servers",
		);
	}
	return {
		...common,
		kind: "stdio",
		command: parseCommand(value.command, `${path}.command`),
		env: valueMap(value.env, ENV_NAME, `${path}.env`),
	};
};

const parseInstallHints = (
	value: unknown,
	path: string,
): TemplateCliInstallHints => {
	if (!isRecord(value) || Object.keys(value).length === 0) {
		throw new TemplateToolingError(
			path,
			"must name at least one of brew, winget, or url",
		);
	}
	assertKeys(value, ["brew", "winget", "url"], path);
	return {
		...(value.brew !== undefined
			? { brew: matching(value.brew, BREW_FORMULA, `${path}.brew`) }
			: {}),
		...(value.winget !== undefined
			? { winget: matching(value.winget, WINGET_ID, `${path}.winget`) }
			: {}),
		...(value.url !== undefined
			? {
					url: matching(
						httpsUrl(value.url, `${path}.url`),
						HINT_URL,
						`${path}.url`,
					),
				}
			: {}),
	};
};

const parseCli = (value: unknown, path: string): TemplateCli => {
	if (!isRecord(value)) {
		throw new TemplateToolingError(path, "must be an object");
	}
	assertKeys(
		value,
		["name", "description", "recommended", "npm", "minVersion", "install"],
		path,
	);
	const common = {
		name: matching(value.name, CLI_NAME, `${path}.name`),
		...(value.description !== undefined
			? {
					description: optionalDescription(
						value.description,
						`${path}.description`,
					),
				}
			: {}),
		recommended: recommended(value.recommended, `${path}.recommended`),
	} as NamedEntry;
	if (value.npm !== undefined) {
		if (value.install !== undefined || value.minVersion !== undefined) {
			throw new TemplateToolingError(
				path,
				"npm pins an exact version, so install and minVersion do not apply",
			);
		}
		return {
			...common,
			kind: "npm",
			package: matching(value.npm, NPM_PIN, `${path}.npm`),
		};
	}
	return {
		...common,
		kind: "system",
		...(value.minVersion !== undefined
			? {
					minVersion: matching(
						value.minVersion,
						SEMVER,
						`${path}.minVersion`,
					),
				}
			: {}),
		install: parseInstallHints(value.install, `${path}.install`),
	};
};

const assertUnique = (
	names: readonly string[],
	path: string,
	what: string,
): void => {
	const seen = new Set<string>();
	for (const name of names) {
		const key = name.toLowerCase();
		if (seen.has(key)) {
			throw new TemplateToolingError(
				path,
				`repeats the ${what} "${name}"`,
			);
		}
		seen.add(key);
	}
};

/**
 * Validates a template's `agent` block. Throws {@link TemplateToolingError} naming the
 * first offending field; callers decide whether that sinks the template or only the block.
 */
export const parseTemplateAgentTooling = (
	value: unknown,
	path = "agent",
): TemplateAgentTooling => {
	if (!isRecord(value)) {
		throw new TemplateToolingError(path, "must be an object");
	}
	assertKeys(value, ["skills", "mcp", "cli"], path);
	const tooling: TemplateAgentTooling = {
		skills: list(value.skills, `${path}.skills`).map((item, index) =>
			parseSkills(item, `${path}.skills[${index}]`),
		),
		mcp: list(value.mcp, `${path}.mcp`).map((item, index) =>
			parseMcp(item, `${path}.mcp[${index}]`),
		),
		cli: list(value.cli, `${path}.cli`).map((item, index) =>
			parseCli(item, `${path}.cli[${index}]`),
		),
	};
	if (tooling.skills.length + tooling.mcp.length + tooling.cli.length === 0) {
		throw new TemplateToolingError(path, "needs skills, mcp, or cli");
	}
	assertUnique(
		tooling.skills.map(({ source }) => source),
		`${path}.skills`,
		"source",
	);
	assertUnique(
		tooling.mcp.map(({ name }) => name),
		`${path}.mcp`,
		"server",
	);
	assertUnique(
		tooling.cli.map(({ name }) => name),
		`${path}.cli`,
		"CLI",
	);
	return tooling;
};

/** Every `${NAME}` an MCP server's headers or env read, without repeats. */
export const mcpPlaceholders = (server: TemplateMcpServer): string[] => [
	...new Set(
		Object.values(
			server.kind === "remote" ? server.headers : server.env,
		).flatMap(placeholderNames),
	),
];

/** Replaces each `${NAME}` with its value. Every name must be present in `values`. */
export const substitutePlaceholders = (
	value: string,
	values: Readonly<Record<string, string>>,
): string =>
	value.replace(PLACEHOLDER, (_match, name: string) => {
		const resolved = values[name];
		if (resolved === undefined) {
			throw new Error(`No value for ${name}.`);
		}
		return resolved;
	});

/**
 * A POSIX shell word for `value`, with each `${NAME}` left for the user's shell to expand
 * from its environment, so a printed command never carries a secret.
 */
export const shellWordWithPlaceholders = (value: string): string => {
	const parts: string[] = [];
	let last = 0;
	for (const match of value.matchAll(PLACEHOLDER)) {
		const index = match.index ?? 0;
		if (index > last) parts.push(shellQuote(value.slice(last, index)));
		parts.push(`"$${match[1]}"`);
		last = index + match[0].length;
	}
	if (last < value.length || parts.length === 0) {
		parts.push(shellQuote(value.slice(last)));
	}
	return parts.join("");
};

export const shellQuote = (value: string): string =>
	/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
		? value
		: `'${value.replace(/'/g, "'\\''")}'`;
