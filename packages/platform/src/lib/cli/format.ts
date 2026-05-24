import type { PulledBranchConfig } from "../pull-config.js";

/**
 * Serialise a {@link Config} as the textual body of a `neon.ts` file:
 *
 * ```ts
 * import { defineConfig } from "@neondatabase/platform/v1";
 *
 * export default defineConfig({ ... });
 * ```
 *
 * The object literal is rendered as JSON (i.e. with quoted keys) which is still valid
 * TypeScript and keeps the formatter trivial — no AST construction, no edge cases around
 * reserved words, no quoting decisions to make.
 */
export function formatInitTemplate(pulled: PulledBranchConfig): string {
	const rootName = pulled.branch.name;
	const rootConfig = JSON.stringify(pulled.config, null, 4)
		.split("\n")
		.map((line) => `      ${line}`)
		.join("\n")
		.trimStart();
	return [
		'import { defineConfig } from "@neondatabase/platform/v1";',
		"",
		"export default defineConfig((branch) => {",
		`  if (branch.name === ${JSON.stringify(rootName)}) {`,
		`    return ${rootConfig};`,
		"  }",
		"",
		"  return {",
		`    parent: ${JSON.stringify(rootName)},`,
		'    ttl: "7d",',
		"  };",
		"});",
		"",
	].join("\n");
}

/**
 * Pretty-print a {@link Config} as JSON with a trailing newline.
 */
export function formatConfigAsJson(config: PulledBranchConfig): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Output formats supported by `neon-ts pull`.
 */
export type PullOutputFormat = "ts" | "json";

export function isPullOutputFormat(value: unknown): value is PullOutputFormat {
	return value === "ts" || value === "json";
}
