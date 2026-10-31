import { log } from "../log.js";
import type { CommonProps } from "../types.js";
import { writer } from "../writer.js";

/**
 * Report a delete that returned HTTP 204. The API treats deleting a missing
 * name as success, so the exit code stays 0 and cleanup scripts keep working.
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
		return;
	}
	log.info(message);
};
