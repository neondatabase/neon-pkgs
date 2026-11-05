import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConvexSchema } from "./model.js";
import { parseExportedSchema } from "./parse.js";

/**
 * Load a Convex `schema.ts`, call `SchemaDefinition.export()` on its default
 * export, and parse the result into a {@link ConvexSchema}.
 *
 * The file is evaluated with jiti so a TypeScript `schema.ts` (importing
 * `convex/server` and `convex/values`) loads directly. `export()` returns a JSON
 * **string** (verified against convex 1.47.0), so it is `JSON.parse`d before
 * parsing. `schemaTsPath` is an absolute or cwd-relative path to the file.
 */
export async function loadConvexSchema(
	schemaTsPath: string,
): Promise<ConvexSchema> {
	// Absolute before it reaches jiti, which resolves a relative id against the
	// file it was created for -- the schema itself -- rather than the cwd.
	const path = resolve(schemaTsPath);
	const createJiti = await loadCreateJiti();
	const jiti = createJiti(pathToFileURL(path).href, {
		interopDefault: true,
		moduleCache: false,
	});
	const mod: unknown = await jiti.import(path);

	const schemaDef = extractDefault(mod);
	if (!hasExport(schemaDef)) {
		throw new Error(
			`${schemaTsPath} does not default-export a Convex schema. Expected \`export default defineSchema({ ... })\`.`,
		);
	}

	const exported = schemaDef.export();
	if (typeof exported !== "string") {
		throw new Error(
			`SchemaDefinition.export() returned a ${typeof exported}; expected a JSON string.`,
		);
	}
	return parseExportedSchema(exported);
}

/** The module that exports Convex Auth's `authTables`. */
const CONVEX_AUTH_SERVER = "@convex-dev/auth/server";

/**
 * The names of the tables Convex Auth's `authTables` adds (`users` among them),
 * read from the `@convex-dev/auth` installed for the app whose `schema.ts` is
 * at `schemaTsPath`, so the list follows the app's version of Convex Auth.
 *
 * Resolution starts from the schema file, as it does for the schema's own
 * imports. Returns `undefined` when the package can't be resolved from there
 * (the app doesn't use Convex Auth, or its dependencies aren't installed) or
 * doesn't export an `authTables` object. Importing the module only defines
 * functions and validators.
 */
export async function loadConvexAuthTableNames(
	schemaTsPath: string,
): Promise<string[] | undefined> {
	const path = resolve(schemaTsPath);
	const createJiti = await loadCreateJiti();
	const jiti = createJiti(pathToFileURL(path).href, {
		interopDefault: true,
		moduleCache: false,
	});
	const resolved = jiti.esmResolve(CONVEX_AUTH_SERVER, { try: true });
	if (resolved === undefined) return undefined;
	const mod: unknown = await jiti.import(resolved);
	const authTables = isRecord(mod) ? mod.authTables : undefined;
	return isRecord(authTables) ? Object.keys(authTables) : undefined;
}

type CreateJiti = (
	id: string,
	options?: { interopDefault?: boolean; moduleCache?: boolean },
) => {
	import(id: string): Promise<unknown>;
	esmResolve(id: string, options: { try: true }): string | undefined;
};

async function loadCreateJiti(): Promise<CreateJiti> {
	const mod: unknown = await import("jiti");
	const candidate =
		(isRecord(mod) && mod.createJiti) ||
		(isRecord(mod) &&
			isRecord(mod.default) &&
			(mod.default as Record<string, unknown>).createJiti);
	if (typeof candidate !== "function") {
		throw new Error(
			"jiti is required to load a Convex schema.ts but could not be initialised. Reinstall dependencies.",
		);
	}
	return candidate as CreateJiti;
}

function extractDefault(mod: unknown): unknown {
	if (isRecord(mod) && "default" in mod && mod.default !== undefined) {
		return mod.default;
	}
	return mod;
}

function hasExport(value: unknown): value is { export(): unknown } {
	return (
		isRecord(value) &&
		typeof (value as { export?: unknown }).export === "function"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
