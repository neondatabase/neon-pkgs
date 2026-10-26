import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { GlobalSetupContext } from "vitest/node";

/**
 * Boot a single Postgres container for the whole integration run and hand its
 * connection URI to the test files through Vitest's `provide`/`inject` channel.
 * One container is enough because every test applies its DDL into its own
 * `CREATE SCHEMA` namespace, so fixtures that share table names (many corpus
 * schemas declare `messages`) never collide.
 *
 * `postgres:18-alpine` is used because it is already present on the CI/dev
 * machine, which avoids a slow cold image pull. Ryuk (the testcontainers
 * resource reaper) is disabled: this setup stops the container itself in its
 * returned teardown, and Ryuk would otherwise need its own image pulled.
 */
export default async function setup({ provide }: GlobalSetupContext) {
	process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

	const image = process.env.C2P_PG_IMAGE ?? "postgres:18-alpine";
	const container = await new PostgreSqlContainer(image)
		.withDatabase("convex_to_postgres")
		.withUsername("c2p")
		.withPassword("c2p")
		.start();

	provide("pgConnectionUri", container.getConnectionUri());

	return async () => {
		await container.stop();
	};
}

declare module "vitest" {
	interface ProvidedContext {
		pgConnectionUri: string;
	}
}
