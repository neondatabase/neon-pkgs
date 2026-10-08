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
export type ServiceFlagValue = NeonService | "realtime";

/** How output names each service. */
export const NEON_SERVICE_LABELS: Readonly<Record<NeonService, string>> = {
	postgres: "Postgres",
	auth: "Neon Auth",
	"data-api": "Data API",
	"object-storage": "Object Storage",
	functions: "Functions",
	"ai-gateway": "AI Gateway",
};

/**
 * Spellings that used to be canonical, and the service they now mean. Accepted so a scripted
 * `--services storage` keeps working, warned about so it does not quietly become a second
 * vocabulary, and absent from help text, errors, and docs so nobody learns it fresh.
 */
const DEPRECATED_SERVICE_ALIASES: Readonly<Record<string, NeonService>> = {
	// `config init --services storage` shipped before the vocabulary was unified.
	storage: "object-storage",
};

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
	/** Values to list in errors when a caller also handles non-service selections. */
	supportedValues?: readonly ServiceFlagValue[];
	/** The flag being parsed, for error messages. */
	flag: string;
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
 * real service but not one this command supports says so, since that is a different problem
 * from a typo.
 */
export const parseServices = (
	raw: readonly string[],
	options: ParseServicesOptions,
): NeonService[] => {
	const { allowed, flag, onDeprecated, supportedValues = allowed } = options;
	const supported = `Supported values: ${supportedValues.join(", ")}.`;

	const names = raw
		.flatMap((value) => value.split(","))
		.map((name) => name.trim())
		.filter((name) => name !== "");

	if (names.length === 0) {
		throw new Error(`${flag} needs at least one service. ${supported}`);
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
			`${unsupportedMessage(unsupported, flag)} ${supported}`,
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
 * two are never answered with the same word.
 */
const unsupportedMessage = (
	unsupported: readonly string[],
	flag: string,
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
		...known.map(
			(service) => `${service} is not something ${flag} can select.`,
		),
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
	allowed: readonly ServiceFlagValue[];
	/**
	 * A noun phrase for what these services are, in this command — the value list is
	 * appended to it after a colon, so it has to be something a list can attach to
	 * ("Services the scaffolded neon.ts declares"), not a clause. Put the rest in `also`.
	 */
	describe: string;
	/** Anything to say after the value syntax, e.g. what happens when the flag is omitted. */
	also?: string;
}): Options => ({
	alias: SERVICE_FLAG_NAMES.filter((name) => name !== params.key),
	describe: [
		`${params.describe}: ${params.allowed.join(", ")}.`,
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
