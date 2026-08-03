/**
 * Strict readers for flags whose value decides how much a credential can reach.
 *
 * These live apart from any one command because both `api-keys` and `profile create` mint
 * keys, and a lenient reading of a scope flag has the same consequence in either: the flag
 * reads as falsy, the scope check falls through, and an **account** key is minted instead of
 * the narrow one that was asked for. Two copies of that check is one copy too many.
 */

/**
 * A flag is either absent, or exactly one non-empty string. Anything else is an error.
 *
 * - `--org-id ""` — an unset shell variable; empty string, which is falsy.
 * - `--no-org-id` — yargs boolean negation; `false`, which is falsy.
 * - `--org-id a --org-id b` — an array, which would reach the API as `a,b`.
 *
 * A misspelled flag never binds and cannot be seen here; `.strict()` rejects it. Anything
 * after a `--` terminator is handled by {@link noPassthrough}.
 */
export const single =
	(name: string, { required = false }: { required?: boolean } = {}) =>
	(value: unknown) => {
		if (value === undefined) return undefined;
		if (Array.isArray(value)) {
			throw new Error(
				`--${name} was given more than once. Pass it at most once.`,
			);
		}
		// `--no-x` is the negation form and yields `false`, so name it rather than telling
		// the user their value was empty when they never gave one.
		if (value === false) {
			throw new Error(
				required
					? `--no-${name} is not valid: --${name} is required.`
					: `--no-${name} is not a valid way to skip --${name}. Omit the flag entirely.`,
			);
		}
		if (typeof value !== "string" || value.trim() === "") {
			throw new Error(
				required
					? `--${name} needs a value.`
					: `--${name} needs a value. Pass one, or omit the flag entirely.`,
			);
		}
		return value;
	};

/**
 * Refuse arguments after a `--` terminator.
 *
 * The CLI sets `populate--`, so everything past `--` lands in `argv["--"]` where `.strict()`
 * never looks — `create --name x -- --project-id p` would parse cleanly and mint an account
 * key from a line that names the scope flag.
 */
export const noPassthrough =
	(command: string) =>
	(argv: Record<string, unknown>): true => {
		const rest = argv["--"];
		if (Array.isArray(rest) && rest.length > 0) {
			throw new Error(
				`${command} takes no arguments after \`--\`, and options placed there are ignored rather than applied. Remove the \`--\`.`,
			);
		}
		return true;
	};
