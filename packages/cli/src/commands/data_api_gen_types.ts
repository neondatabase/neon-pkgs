import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import type { BranchScopeProps } from "../types.js";
import { generateTypes } from "../utils/generate_types.js";
import { resolveConnectionUri } from "../utils/inspect_db.js";

export type GenTypesProps = BranchScopeProps & {
	branch?: string;
	database?: string;
	roleName?: string;
	dbUrl?: string;
	outFile: string;
	schema: string[];
	postgrestV9Compat: boolean;
	queryTimeout?: string;
};

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

const resolveConnectionString = async (
	props: GenTypesProps,
): Promise<string> => {
	const dbUrl = props.dbUrl?.trim();
	if (dbUrl) {
		return dbUrl;
	}
	const { connectionUri } = await resolveConnectionUri({
		...props,
		databaseName: props.database,
	});
	return connectionUri;
};

export const genTypes = async (props: GenTypesProps): Promise<void> => {
	// Validated before any API call so a typo doesn't cost a round trip.
	const queryTimeout = props.queryTimeout
		? parseDuration(props.queryTimeout)
		: undefined;

	const types = await generateTypes({
		connectionString: await resolveConnectionString(props),
		schemas: props.schema,
		detectOneToOneRelationships: !props.postgrestV9Compat,
		queryTimeout,
	});

	mkdirSync(path.dirname(props.outFile), { recursive: true });
	writeFileSync(props.outFile, types);
	log.info(
		`Generated types for schemas ${props.schema.join(", ")} at ${props.outFile}`,
	);
};
