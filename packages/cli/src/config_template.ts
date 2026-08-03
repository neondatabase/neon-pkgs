/**
 * The published npm packages a `neon.ts` project needs — the `@neon/*` org names.
 *
 * ⚠️ These ship to users the next time `neonctl` is released, so do NOT release
 * neonctl until `@neon/config` and `@neon/env` are published to npm — otherwise
 * `config init` would install packages that don't exist yet. (The libraries are
 * mid-migration from `@neondatabase/*`; track their publish before cutting a CLI
 * release.)
 */
export const CONFIG_PACKAGE = "@neon/config";
export const ENV_PACKAGE = "@neon/env";
export const REQUIRED_PACKAGES = [CONFIG_PACKAGE, ENV_PACKAGE] as const;

/**
 * A Neon service `config init` can declare in the `neon.ts` it scaffolds, spelled the way a
 * user types it in `--services`. Kebab-case rather than the `neon.ts` field names (`aiGateway`,
 * `buckets`) so the flag reads like a flag; {@link renderNeonConfig} owns the mapping.
 *
 * Postgres is absent because every branch has it, and `dataApi` is absent because enabling it
 * with the default `authProvider: "neon"` requires `auth` — a pairing the picker would have to
 * enforce rather than offer.
 */
export const NEON_SERVICES = [
	"auth",
	"ai-gateway",
	"functions",
	"storage",
] as const;
export type NeonService = (typeof NEON_SERVICES)[number];

/** `--services none`: declare nothing, i.e. scaffold the bare starter policy. */
export const NO_SERVICES = "none";

/** Slug, display name, and source path of the function scaffolded for `functions`. */
export const FUNCTION_SLUG = "hello";
export const FUNCTION_NAME = "Hello World";
export const FUNCTION_FILENAME = "hello.ts";

/** Name of the bucket scaffolded for `storage`. */
export const BUCKET_NAME = "assets";

/**
 * Parse a `--services` value into a canonical service list: comma-separated
 * {@link NEON_SERVICES} names, or {@link NO_SERVICES} on its own for none.
 *
 * Unknown names are rejected here rather than silently dropped — a typo'd service would
 * otherwise scaffold a policy missing exactly the service the user asked for. The result is
 * deduplicated and ordered by {@link NEON_SERVICES} so the rendered file doesn't depend on the
 * order they were typed in.
 */
export const parseServices = (raw: string): NeonService[] => {
	const names = raw
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name !== "");

	if (names.includes(NO_SERVICES)) {
		if (names.length > 1) {
			throw new Error(
				`--services ${NO_SERVICES} cannot be combined with other services.`,
			);
		}
		return [];
	}

	const unknown = names.filter(
		(name) => !NEON_SERVICES.includes(name as NeonService),
	);
	if (unknown.length > 0) {
		throw new Error(
			`Unknown service${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}. ` +
				`Supported values: ${NEON_SERVICES.join(", ")}, ${NO_SERVICES}.`,
		);
	}

	return NEON_SERVICES.filter((service) => names.includes(service));
};

/** The `preview` block for the selected services, or "" when none of them is a preview feature. */
const renderPreview = (services: readonly NeonService[]): string => {
	const lines: string[] = [];

	if (services.includes("ai-gateway")) {
		lines.push("    aiGateway: true,");
	}
	if (services.includes("functions")) {
		lines.push(
			"    functions: {",
			`      ${FUNCTION_SLUG}: { name: "${FUNCTION_NAME}", source: "./${FUNCTION_FILENAME}" },`,
			"    },",
		);
	}
	if (services.includes("storage")) {
		lines.push(
			"    buckets: {",
			`      // "private" is the default; use "public_read" for anonymous reads`,
			`      ${BUCKET_NAME}: { access: "private" },`,
			"    },",
		);
	}

	if (lines.length === 0) {
		return "";
	}
	return `${["  preview: {", ...lines, "  },"].join("\n")}\n`;
};

/**
 * Render the `neon.ts` policy `config init` writes. With no services this is the starter
 * policy — an explicit `auth: false`, no `preview` block, and a `branch` closure that gives
 * new non-default branches a 7-day TTL — so the picker's "skip everything" answer and a
 * non-interactive run produce the identical file.
 */
export const renderNeonConfig = (services: readonly NeonService[]): string =>
	`import { defineConfig } from "${CONFIG_PACKAGE}/v1";

export default defineConfig({
  // Declare your Neon services here
  auth: ${services.includes("auth")},
${renderPreview(services)}  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run \`neon checkout <name>\` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});
`;

/**
 * The handler written alongside `neon.ts` when `functions` is selected. It has to exist:
 * `FunctionDef.source` is only resolved when `config apply` / `deploy` bundles it, so a
 * declared function with no file on disk fails at deploy time rather than at authoring time.
 *
 * A default-exported function rather than `export default { fetch }`: both are resolved (see
 * `resolveFetchHandler`), and the bare function is less to read and less to get wrong. It is
 * named rather than anonymous so a project's linter has nothing to say about it, and takes no
 * parameter because a scaffold shipping an unused `req` fails a `noUnusedParameters` project.
 */
export const FUNCTION_TEMPLATE = `export default async function hello(): Promise<Response> {
  return new Response("Hello from Neon Functions");
}
`;
