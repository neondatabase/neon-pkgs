import type { CommonProps } from "../types.js";
import { writer } from "../writer.js";

/**
 * Write the not-found payload for a delete that returned HTTP 204.
 * Roles pass exitCode 1; throwing would log ERROR and leave stdout empty.
 */
export const reportMissingDelete = (
	props: Pick<CommonProps, "output">,
	message: string,
	exitCode: 0 | 1 = 0,
): void => {
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(
			{ deleted: false, message },
			{ fields: ["deleted", "message"] },
		);
	} else {
		writer(props).text(`${message}\n`);
	}
	if (exitCode !== 0) {
		process.exitCode = exitCode;
	}
};
