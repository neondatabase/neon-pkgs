import { getGeneratorMetadata } from "../vendor/postgres-meta/lib/generators.js";
import PostgresMeta from "../vendor/postgres-meta/lib/PostgresMeta.js";
import { apply as applyTypescriptTemplate } from "../vendor/postgres-meta/templates/typescript.js";

export type GenerateTypesOptions = {
	connectionString: string;
	schemas: string[];
	detectOneToOneRelationships: boolean;
	/** Milliseconds. Bounds both the client wait and the server-side statement. */
	queryTimeout?: number;
};

export const generateTypes = async (
	options: GenerateTypesOptions,
): Promise<string> => {
	const pgMeta = new PostgresMeta({
		connectionString: options.connectionString,
		...(options.queryTimeout !== undefined && {
			query_timeout: options.queryTimeout,
			statement_timeout: options.queryTimeout,
		}),
	});
	try {
		const { data: metadata, error } = await getGeneratorMetadata(pgMeta, {
			includedSchemas: options.schemas,
		});
		if (error) {
			throw new Error(error.message);
		}
		return await applyTypescriptTemplate({
			...metadata,
			detectOneToOneRelationships: options.detectOneToOneRelationships,
		});
	} finally {
		await pgMeta.end();
	}
};
