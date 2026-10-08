import { format } from "node:util";
import { isDebug } from "./env.js";

export const log = {
	debug: (...args: unknown[]) => {
		if (isDebug()) {
			process.stderr.write(`DEBUG: ${format(...args)}\n`);
		}
	},
	warning: (...args: unknown[]) => {
		process.stderr.write(`WARNING: ${format(...args)}\n`);
	},
	// No prefix: a label marks lines that need attention (WARNING, ERROR). See CONTRIBUTING.md.
	info: (...args: unknown[]) => {
		process.stderr.write(`${format(...args)}\n`);
	},
	error: (...args: unknown[]) => {
		process.stderr.write(`ERROR: ${format(...args)}\n`);
	},
};
