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
	const url = pathToFileURL(schemaTsPath).href;
	const createJiti = await loadCreateJiti();
	const jiti = createJiti(url, { interopDefault: true, moduleCache: false });
	const mod: unknown = await jiti.import(schemaTsPath);

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

type CreateJiti = (
	id: string,
	options?: { interopDefault?: boolean; moduleCache?: boolean },
) => { import(id: string): Promise<unknown> };

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
