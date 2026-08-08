import type { NeonConfigView } from "./config_format.js";
import { NEON_SERVICES, type NeonService } from "./neon_services.js";

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
 * The services `config init` can declare in the `neon.ts` it scaffolds — the subset of
 * {@link NEON_SERVICES} a policy has a field for. {@link renderNeonConfig} owns the mapping
 * from these names to the `neon.ts` fields (`aiGateway`, `buckets`).
 *
 * Postgres is absent because every branch has it, so there is nothing to declare. `data-api`
 * is absent because enabling it with the default `authProvider: "neon"` requires `auth` — a
 * pairing the picker would have to enforce rather than offer.
 */
export const CONFIG_INIT_SERVICES = NEON_SERVICES.filter(
	(service) => service !== "postgres" && service !== "data-api",
);

/** Why the two a policy cannot declare are not selectable, for the refusal message. */
export const CONFIG_INIT_UNAVAILABLE: Partial<Record<NeonService, string>> = {
	postgres:
		"every branch has Postgres, so a policy has nothing to declare for it",
	"data-api":
		"enabling it with the default provider requires auth, so declare auth here and turn the Data API on with `neon data-api create`",
};

/** Slug, display name, and source path of the function scaffolded for `functions`. */
export const FUNCTION_SLUG = "hello";
export const FUNCTION_NAME = "Hello World";
export const FUNCTION_FILENAME = "hello.ts";

/** Name of the bucket scaffolded for `storage`. */
export const BUCKET_NAME = "assets";

/**
 * One indentation level in the emitted `neon.ts`. Two spaces, which is what every renderer
 * here produces and what `config_template.format.test.ts` holds them to.
 */
const INDENT = "  ";

/**
 * Prefix each line with `level` indentation levels. Nesting is expressed as a number at the
 * one place that knows the structure, rather than as literal spaces at every push site — a
 * miscounted space is otherwise invisible in review and only shows up in a user's file.
 */
const at = (level: number, ...lines: string[]): string[] =>
	lines.map((line) => INDENT.repeat(level) + line);

/** Wrap `body` in an object-literal block named `key`, indented from `level`. */
const block = (level: number, key: string, body: string[]): string[] => [
	...at(level, `${key}: {`),
	...body,
	...at(level, "},"),
];

/** The `preview` block for the selected services, or "" when none of them is a preview feature. */
const renderPreview = (services: readonly NeonService[]): string => {
	const lines: string[] = [];

	if (services.includes("ai-gateway")) {
		lines.push(...at(2, "aiGateway: true,"));
	}
	if (services.includes("functions")) {
		lines.push(
			...block(2, "functions", [
				...at(
					3,
					`${FUNCTION_SLUG}: { name: "${FUNCTION_NAME}", source: "./${FUNCTION_FILENAME}" },`,
				),
			]),
		);
	}
	if (services.includes("object-storage")) {
		lines.push(
			...block(2, "buckets", [
				...at(
					3,
					`// "private" is the default; use "public_read" for anonymous reads`,
					`${BUCKET_NAME}: { access: "private" },`,
				),
			]),
		);
	}

	if (lines.length === 0) {
		return "";
	}
	return `${block(1, "preview", lines).join("\n")}\n`;
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

/** Render a scalar the way it has to appear in TypeScript source. */
const renderScalar = (value: string | number | boolean): string =>
	typeof value === "string" ? `"${value}"` : String(value);

/**
 * Render an object key. Live names are not identifiers: a Neon bucket may be called
 * `smoke-uploads`, which as a bare key is a subtraction and a syntax error. Anything that
 * isn't a plain identifier gets quoted.
 */
const renderKey = (name: string): string =>
	/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);

/**
 * The `branch` closure for a policy seeded from live state, or "" when the branch carries no
 * tuning worth declaring.
 *
 * `protected` is read but never declared: it is a fact about one branch, while a policy
 * `protected` applies to every branch the policy runs against. It becomes a comment instead.
 */
const renderSeededBranch = (view: NeonConfigView): string => {
	const settings: string[] = [];
	if (view.branch?.parent !== undefined) {
		settings.push(...at(2, `parent: ${renderScalar(view.branch.parent)},`));
	}
	if (view.branch?.ttl !== undefined) {
		settings.push(...at(2, `ttl: ${renderScalar(view.branch.ttl)},`));
	}

	const compute = view.branch?.postgres?.computeSettings;
	const computeFields = Object.entries(compute ?? {}).filter(
		([, value]) => value !== undefined,
	);
	if (computeFields.length > 0) {
		settings.push(
			...block(2, "postgres", [
				...block(
					3,
					"computeSettings",
					computeFields.flatMap(([field, value]) =>
						at(4, `${field}: ${renderScalar(value)},`),
					),
				),
			]),
		);
	}

	if (settings.length === 0) {
		return "";
	}
	// An arrow returning an object literal, so the closing line is `}),` rather than `},`.
	return `${[...at(1, "branch: () => ({"), ...settings, ...at(1, "}),")].join("\n")}\n`;
};

/** The `preview` block for a policy seeded from live state. */
const renderSeededPreview = (
	view: NeonConfigView,
	branchName: string,
): string => {
	const lines: string[] = [];

	const buckets = Object.entries(view.preview?.buckets ?? {});
	if (buckets.length > 0) {
		lines.push(
			...block(
				2,
				"buckets",
				buckets.flatMap(([name, bucket]) =>
					at(
						3,
						`${renderKey(name)}: { access: "${bucket.access}" },`,
					),
				),
			),
		);
	}

	// A deployed function cannot be declared from live state: `source` is a path in the
	// user's project and the branch only knows the uploaded bundle. Listing the slugs as a
	// commented-out block is the most a read-back can honestly produce.
	const functions = Object.entries(view.preview?.functions ?? {});
	if (functions.length > 0) {
		lines.push(
			...at(
				2,
				`// ${branchName} has ${functions.length} deployed function${functions.length === 1 ? "" : "s"}.`,
				"// Declaring one needs the local source path, which the branch does not know:",
				"// functions: {",
				...functions.map(
					([slug, fn]) =>
						`//   ${renderKey(slug)}: { name: "${fn.name}", source: "./${slug}.ts" },`,
				),
				"// },",
			),
		);
	}

	if (lines.length === 0) {
		return "";
	}
	return `${block(1, "preview", lines).join("\n")}\n`;
};

/**
 * Render a `neon.ts` from a branch's live state (`config init --from-branch`).
 *
 * Only what the branch can actually report is declared. Three things are deliberately
 * absent, each for its own reason:
 *
 * - **The AI Gateway** has no branch-level enabled state to read — it is always available and
 *   credential-gated — so `pullConfig` cannot tell whether a policy would enable it.
 * - **Functions** cannot round-trip (no `source` path on the remote); they are listed as a
 *   commented-out block.
 * - **`protected`** is branch state rather than policy intent, so it is reported as a comment.
 *
 * A branch with nothing to report (no services, no tuning) renders the starter policy rather
 * than an empty `defineConfig({})`: seeding found nothing, and the caller says so.
 */
export const renderNeonConfigFromView = (
	view: NeonConfigView,
	branchName: string,
): { source: string; seeded: boolean } => {
	const services = [
		view.auth ? "  auth: true," : "",
		view.dataApi ? "  dataApi: true," : "",
	].filter((line) => line !== "");
	const preview = renderSeededPreview(view, branchName);
	const branch = renderSeededBranch(view);

	if (services.length === 0 && preview === "" && branch === "") {
		return { source: renderNeonConfig([]), seeded: false };
	}

	const protectedNote = view.branch?.protected
		? `// ${branchName} is protected on Neon. Not declared here: a policy \`protected\` would\n// apply to every branch this policy is applied to.\n`
		: "";
	const body = [
		...services,
		...(preview === "" ? [] : [preview.trimEnd()]),
		...(branch === "" ? [] : [branch.trimEnd()]),
	].join("\n");

	return {
		source: `import { defineConfig } from "${CONFIG_PACKAGE}/v1";

// Seeded by \`neon config init --from-branch\` from ${branchName}.
// The AI Gateway is not readable from a branch (always available, credential-gated), so add
// \`preview: { aiGateway: true }\` if the policy should declare it.
${protectedNote}export default defineConfig({
${body}
});
`,
		seeded: true,
	};
};

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
