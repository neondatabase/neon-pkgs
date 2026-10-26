// Public API for convex-to-postgres.
//
// The schema/data generation functions (`parseExportedSchema`, `generateDdl`,
// `generateStagingDdl`, `generateTransformSql`) are pure: they take data and
// return strings, read no files, and never print. `loadConvexSchema`,
// `generateSeedSql`, and `importConvexExport` are the I/O-bound entry points.

export type {
	ImportOptions,
	ImportResult,
	QueryableClient,
} from "./data/import.js";
export { importConvexExport } from "./data/import.js";
export type { ExportSource } from "./data/read-export.js";
export { openExportSource } from "./data/read-export.js";
export { generateSeedSql } from "./data/seed.js";
export {
	generateStagingDdl,
	generateStagingDropSql,
} from "./data/staging.js";
export { generateTransformSql } from "./data/transform.js";
export type {
	GenerateOptions,
	IdStrategy,
	ResolvedOptions,
} from "./options.js";
export { resolveOptions } from "./options.js";
export type { DdlResult } from "./schema/generate-ddl.js";
export { generateDdl, generateIndexDdl } from "./schema/generate-ddl.js";
export { loadConvexSchema } from "./schema/load.js";
export type {
	ConvexColumn,
	ConvexFieldEntry,
	ConvexIndexDef,
	ConvexSchema,
	ConvexSearchIndex,
	ConvexTable,
	ConvexValidator,
	ConvexVectorIndex,
	ExportedSchema,
	ExportedTable,
} from "./schema/model.js";
export { parseExportedSchema } from "./schema/parse.js";
export type {
	PlannedColumn,
	PlannedIndex,
	PlannedSchema,
	PlannedTable,
} from "./schema/plan.js";
export { planSchema } from "./schema/plan.js";
