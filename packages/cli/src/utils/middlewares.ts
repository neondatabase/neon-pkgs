import { recordApiKeyFlag } from "../auth_selection.js";

/**
 * Resolves `--api-key` from `NEON_API_KEY` when the flag is absent, leaving it an
 * empty string when neither is set.
 *
 * This cannot be expressed as the option's yargs `default`, because yargs prints
 * defaults in help output and would print the key itself.
 *
 * The flag's own value is recorded before the fold, because folding destroys the one
 * distinction the precedence rules need: `--api-key` outranks `--profile` and an exported
 * `NEON_API_KEY` does not, but once both live in `args.apiKey` they are indistinguishable.
 * It is recorded outside `args` deliberately — a hidden yargs option would be a second,
 * undocumented way to pass a credential, and commands that call `.strict()` reject arguments
 * the middleware invents.
 */
export const resolveApiKeyFromEnv = (args: Record<string, unknown>) => {
	const fromFlag = typeof args.apiKey === "string" ? args.apiKey : "";
	recordApiKeyFlag(fromFlag);
	if (fromFlag !== "") {
		return;
	}
	const fromEnv = process.env.NEON_API_KEY ?? "";
	args.apiKey = fromEnv;
	args["api-key"] = fromEnv;
};

/**
 * This middleware is needed to fill in the args for nested objects,
 * so that required arguments would work
 * otherwise yargs just throws an error
 */
export const fillInArgs = (
	args: Record<string, unknown>,
	currentArgs: Record<string, unknown> = args,
	acc: string[] = [],
) => {
	Object.entries(currentArgs).forEach(([k, v]) => {
		if (k === "_" || k === "--") {
			return;
		}
		// check if the value is an Object
		if (typeof v === "object" && v !== null) {
			fillInArgs(args, v as any, [...acc, k]);
		} else if (acc.length > 0) {
			// if it's not an object, and we have a path, fill it in
			args[acc.join(".") + "." + k] = v;
		}
	});
};
