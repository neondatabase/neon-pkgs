import { randomUUID } from "node:crypto";
import { log } from "@clack/prompts";
import { seedDatabase } from "./seed-database.js";
import { messages } from "./texts.js";
import type { InstantPostgresParams } from "./types.js";
import { createClaimableDatabase } from "./utils/create-db.js";
import { getConnectionStrings } from "./utils/format.js";
import { writeToEnv } from "./utils/fs.js";
import { CLAIMABLE_POSTGRES_URLS } from "./utils/urls.js";

/**
 * Creates an instant Postgres connection string from Claimable Postgres by Neon
 * if not already set in the specified .env file.
 * Prompts the user to optionally generate a connection string,
 * saves it to the .env file, and returns the connection string.
 */
export const instantPostgres = async ({
	dotEnvFile = ".env",
	dotEnvKey = "DATABASE_URL",
	referrer,
	seed = undefined,
	envPrefix = "PUBLIC_",
	settings: { logicalReplication = false } = {},
}: InstantPostgresParams): Promise<{
	databaseUrlDirect: string;
	databaseUrl: string;
	claimUrl: string;
	claimExpiresAt: Date;
}> => {
	if (!referrer || referrer.trim() === "") {
		const { message, ...cause } = messages.errors.referrerIsRequired;

		throw new Error(message, {
			cause,
		});
	}

	const dbId = randomUUID();
	const claimExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
	const claimUrl = new URL(CLAIMABLE_POSTGRES_URLS.CLAIM_DATABASE(dbId));

	const connString = await createClaimableDatabase({
		dbId,
		referrer: `npm:get-db|${referrer}`,
		settings: { logicalReplication },
	});
	const { pooler: poolerString, direct: directString } =
		getConnectionStrings(connString);

	await writeToEnv(
		dotEnvFile,
		dotEnvKey,
		claimExpiresAt,
		claimUrl,
		directString,
		poolerString,
		envPrefix,
	);

	if (seed) {
		log.step("Pushing schema to database");
		await seedDatabase(seed.path, directString);
		log.success("Schema pushed to database");
	}

	return {
		databaseUrlDirect: directString,
		databaseUrl: poolerString,
		claimUrl: claimUrl.href,
		claimExpiresAt,
	} as const;
};

/**
 * @deprecated Use `instantPostgres` instead
 */
export const instantNeon = instantPostgres;

export type { InstantPostgresParams };

/**
 * @deprecated Use `InstantPostgresParams` instead
 */
export type InstantNeonParams = InstantPostgresParams;
