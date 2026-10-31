import type { CommonProps } from "../types.js";
import { writer } from "../writer.js";

/**
 * Report a delete that returned HTTP 204. Table mode throws so the CLI
 * prints ERROR on stderr; JSON/YAML keep the payload on stdout, so we
 * set exitCode instead of throwing.
 */
export const reportMissingDelete = (
	props: Pick<CommonProps, "output">,
	message: string,
): void => {
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(
			{ deleted: false, message },
			{ fields: ["deleted", "message"] },
		);
		process.exitCode = 1;
		return;
	}
	throw new Error(message);
};
