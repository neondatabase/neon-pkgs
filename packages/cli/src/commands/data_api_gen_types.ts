import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isNeonApiError } from "../api.js";
import { genTypesDbUrl } from "../context.js";
import { log } from "../log.js";
import type { BranchScopeProps } from "../types.js";
import { branchIdFromProps } from "../utils/enrichers.js";
import { generateTypes } from "../utils/generate_types.js";
import { resolveConnectionUri } from "../utils/inspect_db.js";

export type GenTypesProps = BranchScopeProps & {
	branch?: string;
	database?: string;
	roleName?: string;
	dbUrl?: string;
	outFile: string;
	schema?: string[];
	postgrestV9Compat: boolean;
	queryTimeout?: string;
};

const STDOUT = "-";

const UNIT_MS = { h: 3_600_000, m: 60_000, s: 1_000 } as const;

export const parseDuration = (duration: string): number => {
	const match = duration.match(/^(\d+)([hms])?$/);
	if (!match) {
		throw new Error(
			`Invalid duration format: ${duration}. Use a format like "30s", "1m" or "90s"`,
		);
	}
	return (
		Number.parseInt(match[1], 10) *
		UNIT_MS[(match[2] ?? "s") as keyof typeof UNIT_MS]
	);
};

const FALLBACK_SCHEMAS = ["public"];

/**
 * The schemas the Data API serves for this branch and database, so the types
 * match what clients can query. Falls back to `public` when the Data API is
 * not enabled (404).
 */
const dataApiSchemas = async (
	props: GenTypesProps,
	branchId: string,
	database: string,
): Promise<string[]> => {
	try {
		const { data } = await props.apiClient.getProjectBranchDataApi(
			props.projectId,
			branchId,
			database,
		);
		const schemas = data.settings?.db_schemas;
		return schemas && schemas.length > 0 ? schemas : FALLBACK_SCHEMAS;
	} catch (error) {
		if (isNeonApiError(error) && error.status === 404) {
			return FALLBACK_SCHEMAS;
		}
		throw error;
	}
};

export const genTypes = async (props: GenTypesProps): Promise<void> => {
	// Validated before any API call so a typo doesn't cost a round trip.
	const queryTimeout = props.queryTimeout
		? parseDuration(props.queryTimeout)
		: undefined;

	let connectionString = genTypesDbUrl(props);
	let schemas = props.schema?.length ? props.schema : undefined;
	if (connectionString === undefined) {
		const branchId = await branchIdFromProps(props);
		const { connectionUri, database } = await resolveConnectionUri({
			...props,
			branch: branchId,
			databaseName: props.database,
		});
		connectionString = connectionUri;
		schemas ??= await dataApiSchemas(props, branchId, database);
	}
	schemas ??= FALLBACK_SCHEMAS;

	const types = await generateTypes({
		connectionString,
		schemas,
		detectOneToOneRelationships: !props.postgrestV9Compat,
		queryTimeout,
	});

	if (props.outFile === STDOUT) {
		await new Promise<void>((resolve, reject) =>
			process.stdout.write(types, (error) =>
				error ? reject(error) : resolve(),
			),
		);
		return;
	}

	mkdirSync(path.dirname(props.outFile), { recursive: true });
	writeFileSync(props.outFile, types);
	log.info(
		`Generated types for schemas ${schemas.join(", ")} at ${props.outFile}`,
	);
};
