type DeclaredOptions = {
	key: Record<string, unknown>;
	alias: Record<string, string[]>;
	array: string[];
	boolean: string[];
	count: string[];
};

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The options yargs has declared for the command it is running. Not in `@types/yargs`. */
export const declaredOptions = (cli: object): DeclaredOptions => {
	if (!("getOptions" in cli) || typeof cli.getOptions !== "function") {
		throw new Error(
			"yargs no longer exposes getOptions(); update declaredOptions for the installed yargs",
		);
	}
	const options: unknown = cli.getOptions();
	if (
		!isRecord(options) ||
		!isRecord(options.key) ||
		!isRecord(options.alias) ||
		!Object.values(options.alias).every(isStringArray) ||
		!isStringArray(options.array) ||
		!isStringArray(options.boolean) ||
		!isStringArray(options.count)
	) {
		throw new Error(
			"yargs getOptions() changed shape; update declaredOptions for the installed yargs",
		);
	}
	return {
		key: options.key,
		alias: Object.fromEntries(
			Object.entries(options.alias).filter(
				(entry): entry is [string, string[]] => isStringArray(entry[1]),
			),
		),
		array: options.array,
		boolean: options.boolean,
		count: options.count,
	};
};

const camelCase = (name: string) =>
	name.replace(/-+([a-z0-9])/g, (_, char: string) => char.toUpperCase());

/**
 * yargs collects a repeated option into an array unless it is declared as one, so a handler
 * written for one string receives several. Identical repeats collapse to one value; different
 * values are an error, worded like `single()` in flags.ts. The values are not echoed, because
 * `--api-key` is one of these flags.
 */
export const collapseRepeatedFlags = (
	argv: Record<string, unknown>,
	options: DeclaredOptions,
): void => {
	const multiValued = new Set([
		...options.array,
		...options.boolean,
		...options.count,
	]);
	const aliases = new Set(Object.values(options.alias).flat());
	for (const name of Object.keys(options.key)) {
		if (multiValued.has(name) || aliases.has(name)) continue;
		const value = argv[name];
		if (!Array.isArray(value) || value.length < 2) continue;
		if (new Set(value).size > 1) {
			throw new Error(
				`--${name} was given more than once. Pass it at most once.`,
			);
		}
		for (const key of [name, ...(options.alias[name] ?? [])]) {
			argv[key] = value[0];
			argv[camelCase(key)] = value[0];
		}
	}
};
