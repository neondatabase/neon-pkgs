import { getCliName } from "./utils/cli_name.js";

/** Matches `engines.node` in package.json; npm only warns when it isn't met. */
export const MIN_NODE_VERSION = [20, 19, 0] as const;

/** The error to print for an unsupported Node.js version, or `undefined` when it is supported. */
export function unsupportedNodeMessage(
	version: string,
	cliName: string,
): string | undefined {
	const parts = version.replace(/^v/, "").split(".").map(Number);
	for (let i = 0; i < MIN_NODE_VERSION.length; i += 1) {
		const actual = parts[i] ?? 0;
		const required = MIN_NODE_VERSION[i];
		if (actual > required) return undefined;
		if (actual < required) {
			return `${cliName} requires Node.js ${MIN_NODE_VERSION[0]}.${MIN_NODE_VERSION[1]} or newer (found ${version.replace(/^v/, "")}).`;
		}
	}
	return undefined;
}

const message = unsupportedNodeMessage(process.versions.node, getCliName());
if (message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
