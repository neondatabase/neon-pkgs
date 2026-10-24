import { fileURLToPath } from "node:url";

export const FIXTURE_REGISTRY_DIR = fileURLToPath(
	new URL("../../tests/function-registry", import.meta.url),
);
