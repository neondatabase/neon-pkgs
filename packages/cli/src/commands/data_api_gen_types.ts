import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isNeonApiError } from "../api.js";
import { genTypesDbUrl } from "../context.js";
import { log } from "../log.js";
import type { BranchScopeProps } from "../types.js";
import { describeTarget, generateTypes } from "../utils/generate_types.js";
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
	const ms =
		Number.parseInt(match[1], 10) *
		UNIT_MS[(match[2] ?? "s") as keyof typeof UNIT_MS];
	// pg treats a zero timeout as "wait forever".
	if (ms <= 0) {
		throw new Error(
			`Invalid duration: ${duration}. It must be greater than 0`,
		);
	}
	return ms;
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
	let source: string;
	if (connectionString === undefined) {
		// resolveConnectionUri splits a point-in-time suffix (`main@<timestamp>`) off the
		// branch, so it receives the name as typed and returns the base branch id.
		const { connectionUri, database, branchId } =
			await resolveConnectionUri({
				...props,
				databaseName: props.database,
			});
		connectionString = connectionUri;
		schemas ??= await dataApiSchemas(props, branchId, database);
		source = `project ${props.projectId}, branch ${branchId}, database ${database}`;
	} else {
		source = `${props.dbUrl?.trim() ? "--db-url" : "DATABASE_URL"} ${describeTarget(connectionString)}`;
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
		`Generated types for schemas ${schemas.join(", ")} at ${props.outFile} from ${source}`,
	);
};
