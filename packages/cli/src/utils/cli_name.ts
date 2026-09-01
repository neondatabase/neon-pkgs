import { basename } from "node:path";

/** Command hints must use the invoked binary so users can run them verbatim. */
export const getCliName = (): string =>
	basename(process.argv[1] ?? "") === "neonctl" ? "neonctl" : "neon";
