import { recordCredentialInputs } from "@neon-internals/cli-core/auth_selection";

/**
 * Resolves `--api-key` from `NEON_API_KEY` when the flag is absent, leaving it an
 * empty string when neither is set.
 *
 * This cannot be expressed as the option's yargs `default`, because yargs prints
 * defaults in help output and would print the key itself.
 *
 * This is also the one place that reads the credential environment, and it records what it saw
 * before folding anything together. Folding destroys the distinction the precedence rules turn
 * on — `--api-key` outranks `--profile` and an exported `NEON_API_KEY` does not, but once both
 * live in `args.apiKey` they are indistinguishable. The snapshot lives outside `args`
 * deliberately: a hidden yargs option would be a second, undocumented way to pass a
 * credential, and commands that call `.strict()` reject arguments the middleware invents.
 */
export const resolveApiKeyFromEnv = (args: Record<string, unknown>) => {
	const fromFlag = typeof args.apiKey === "string" ? args.apiKey : "";
	const fromEnv = process.env.NEON_API_KEY ?? "";
	recordCredentialInputs({
		apiKeyFlag: fromFlag,
		apiKeyEnv: fromEnv,
		profileEnv: process.env.NEON_PROFILE ?? "",
	});
	if (fromFlag !== "") {
		return;
	}
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
