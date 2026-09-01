import type { Options } from "yargs";

/**
 * Every Neon service a `--service` flag can name, spelled the way a user types it — one
 * vocabulary for the whole CLI.
 *
 * Kebab-case rather than the `neon.ts` field names (`aiGateway`, `buckets`) so a flag reads
 * like a flag, and the full product name rather than a shortening (`object-storage`, not
 * `storage`) so nothing is ambiguous when read on its own.
 *
 * Commands take a **subset** of this via {@link ParseServicesOptions.allowed} — `config init`
 * can only declare what a `neon.ts` has a field for, `env pull` can only pull what produces
 * env vars — but the spelling of a service never varies between them. The order here is the
 * canonical one: parsing sorts into it, so a command's output never depends on the order the
 * flags were typed in.
 *
 * Not to be confused with `NeonFeature` in `init/bootstrap.ts`, which is what a *template*
 * requires. That list comes from remote manifests (`neondatabase/examples/bootstrap.yaml`),
 * spells Postgres `database`, and is not ours to rename.
 */
export const NEON_SERVICES = [
	"postgres",
	"auth",
	"data-api",
	"functions",
	"object-storage",
	"ai-gateway",
] as const;
export type NeonService = (typeof NEON_SERVICES)[number];

/**
 * Spellings that used to be canonical, and the service they now mean. Accepted so a scripted
 * `--services storage` keeps working, warned about so it does not quietly become a second
 * vocabulary, and absent from help text, errors, and docs so nobody learns it fresh.
 */
const DEPRECATED_SERVICE_ALIASES: Readonly<Record<string, NeonService>> = {
	// `config init --services storage` shipped before the vocabulary was unified.
	storage: "object-storage",
};

/** An explicit empty selection, for commands where "declare nothing" is a real answer. */
export const NO_SERVICES = "none";

/**
 * What to tell someone still using a retired spelling. A message rather than a log call, so
 * the parser stays free of the CLI's writer and each command can surface it in its own voice.
 */
export const deprecatedServiceMessage = (
	used: string,
	canonical: NeonService,
): string =>
	`"${used}" is the old name for "${canonical}" and still works, but it will be removed. ` +
	`Use "${canonical}".`;

export type ParseServicesOptions = {
	/** The subset this command supports. In {@link NEON_SERVICES} order. */
	allowed: readonly NeonService[];
	/** The flag being parsed, for error messages. */
	flag: string;
	/**
	 * What {@link NO_SERVICES} produces here, e.g. "the bare starter policy". Present means
	 * the command accepts it; absent means `none` is not a value it knows.
	 */
	noneMeans?: string;
	/**
	 * Why a service outside {@link ParseServicesOptions.allowed} is not selectable here. The
	 * refusal is otherwise a fact with no reason attached, and the user's belief ("I have
	 * functions, give me their env") is coherent — the missing piece is knowledge only the
	 * command has. Optional per service; without one the refusal is still specific, just terse.
	 */
	whyUnavailable?: Partial<Record<NeonService, string>>;
	/** Called once per deprecated spelling used, so the command can warn in its own voice. */
	onDeprecated?: (used: string, canonical: NeonService) => void;
};

/**
 * Parse the raw values of a services flag into a canonical selection.
 *
 * Accepts the flag repeated (`-s auth -s postgres`) and comma-separated
 * (`-s auth,postgres`), since both read naturally and users will try either. The result is
 * deduplicated and sorted into {@link NEON_SERVICES} order, so what a command does never
 * depends on typing order.
 *
 * An unrecognized name is rejected rather than dropped: a typo would otherwise act on
 * everything *except* the service that was asked for, and report success. A name that is a
 * real service but not one this command supports says so specifically — "postgres is on
 * every branch" is a different problem from a typo, and has a different fix.
 */
export const parseServices = (
	raw: readonly string[],
	options: ParseServicesOptions,
): NeonService[] => {
	const {
		allowed,
		flag,
		noneMeans,
		whyUnavailable = {},
		onDeprecated,
	} = options;
	const supported = `Supported values: ${allowed.join(", ")}${
		noneMeans !== undefined ? `, ${NO_SERVICES}` : ""
	}.`;

	const names = raw
		.flatMap((value) => value.split(","))
		.map((name) => name.trim())
		.filter((name) => name !== "");

	if (names.length === 0) {
		throw new Error(`${flag} needs at least one service. ${supported}`);
	}

	if (noneMeans !== undefined && names.includes(NO_SERVICES)) {
		// Deduplicate before deciding it was combined with something: a repeated value is
		// a no-op everywhere else in this parser, so `-s none -s none` must be too.
		if (new Set(names).size > 1) {
			throw new Error(
				`${flag} ${NO_SERVICES} cannot be combined with other services.`,
			);
		}
		return [];
	}

	// Canonicalize first and unconditionally, so a retired spelling is reported against the
	// service it means rather than as a word nobody recognizes.
	const deprecated = new Map<string, NeonService>();
	const resolved = names.map((name) => {
		const canonical = DEPRECATED_SERVICE_ALIASES[name];
		if (canonical === undefined) return name;
		deprecated.set(name, canonical);
		return canonical;
	});

	const unsupported = resolved.filter(
		(name) => !allowed.some((service) => service === name),
	);
	if (unsupported.length > 0) {
		throw new Error(
			`${unsupportedMessage(unsupported, flag, whyUnavailable)} ${supported}`,
		);
	}

	// Warned only once the selection is valid: a run that fails validation should not also
	// carry a "still works" claim about a value that never took effect.
	for (const [used, canonical] of deprecated) onDeprecated?.(used, canonical);

	return NEON_SERVICES.filter(
		(service) => allowed.includes(service) && resolved.includes(service),
	);
};

/**
 * The sentences explaining why a selection was refused. A real Neon service this command
 * cannot act on is a different mistake from a typo — different cause, different fix — so the
 * two are never answered with the same word, and each service carries its reason where the
 * command supplied one.
 */
const unsupportedMessage = (
	unsupported: readonly string[],
	flag: string,
	whyUnavailable: Partial<Record<NeonService, string>>,
): string => {
	const known = unsupported.filter((name): name is NeonService =>
		NEON_SERVICES.some((service) => service === name),
	);
	const unknown = unsupported.filter(
		(name) => !known.some((service) => service === name),
	);
	return [
		unknown.length > 0
			? `Unknown service${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}.`
			: undefined,
		...known.map((service) => {
			const why = whyUnavailable[service];
			return `${service} is not something ${flag} can select${why ? `: ${why}` : ""}.`;
		}),
	]
		.filter((part): part is string => part !== undefined)
		.join(" ");
};

/** Every spelling of the services flag, so a habit picked up on one command works on another. */
const SERVICE_FLAG_NAMES = ["s", "service", "services"] as const;

/**
 * The yargs option for a services flag, so every command that has one accepts the same
 * spellings (`-s`, `--service`, `--services`) and the same value syntax. `key` is the name the
 * command reads off `argv`; the rest become aliases.
 */
export const servicesOption = (params: {
	key: "service" | "services";
	allowed: readonly NeonService[];
	/**
	 * A noun phrase for what these services are, in this command — the value list is
	 * appended to it after a colon, so it has to be something a list can attach to
	 * ("Services the scaffolded neon.ts declares"), not a clause. Put the rest in `also`.
	 */
	describe: string;
	/** What {@link NO_SERVICES} produces here. Present means the command accepts it. */
	noneMeans?: string;
	/** Anything to say after the value syntax, e.g. what happens when the flag is omitted. */
	also?: string;
}): Options => ({
	alias: SERVICE_FLAG_NAMES.filter((name) => name !== params.key),
	describe: [
		`${params.describe}: ${params.allowed.join(", ")}.`,
		params.noneMeans !== undefined
			? `Pass "${NO_SERVICES}" for ${params.noneMeans}.`
			: undefined,
		"Repeat the flag or comma-separate.",
		params.also,
	]
		.filter((part): part is string => part !== undefined)
		.join(" "),
	type: "array",
	string: true,
});

/**
 * Narrow a yargs value for a services flag to the raw strings, or `undefined` when the flag
 * was not given. `argv` is untyped at the handler, and `string: true` only guarantees the
 * element type when the flag was actually parsed as an array.
 */
export const servicesFlagValue = (value: unknown): string[] | undefined =>
	Array.isArray(value) ? value.map(String) : undefined;
