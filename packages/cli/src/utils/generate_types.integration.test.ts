/**
 * Runs the vendored postgres-meta introspection and TypeScript template against a real
 * Postgres via testcontainers.
 *
 * Skipped by default (Docker required); run with:
 *   RUN_INTEGRATION=1 npx vitest run src/utils/generate_types.integration.test.ts
 */

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateTypes } from "./generate_types.js";

const RUN = process.env.CI === "true" || process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("generateTypes — integration", () => {
	let stop: () => Promise<unknown>;
	let url: string;
	const options = () => ({
		connectionString: url,
		schemas: ["public"],
		detectOneToOneRelationships: true,
	});

	beforeAll(async () => {
		const { PostgreSqlContainer } = await import(
			"@testcontainers/postgresql"
		);
		const container = await new PostgreSqlContainer(
			"postgres:17-alpine",
		).start();
		stop = () => container.stop();
		url = `${container.getConnectionUri()}?sslmode=disable`;
		const client = new pg.Client({ connectionString: url });
		await client.connect();
		await client.query(`
			create table authors (id serial primary key, name text not null);
			create table books (id serial primary key, author_id int references authors (id));
			create schema extra;
			create table extra.notes (body text);`);
		await client.end();
	}, 90_000);

	afterAll(async () => {
		await stop?.();
	});

	it("types the tables of the requested schemas only", async () => {
		const types = await generateTypes(options());

		expect(types).toMatch(
			/authors: \{\s+Row: \{\s+id: number\s+name: string/,
		);
		expect(types).toContain("author_id: number | null");
		expect(types).not.toContain("notes");
		expect(
			await generateTypes({ ...options(), schemas: ["public", "extra"] }),
		).toContain("notes: {");
	});

	it("omits isOneToOne when one-to-one detection is off", async () => {
		expect(await generateTypes(options())).toContain("isOneToOne");
		expect(
			await generateTypes({
				...options(),
				detectOneToOneRelationships: false,
			}),
		).not.toContain("isOneToOne");
	});

	it("reports the database error instead of a generic message", async () => {
		await expect(
			generateTypes({
				...options(),
				connectionString:
					"postgresql://u:p@127.0.0.1:1/db?sslmode=disable",
			}),
		).rejects.toThrow(/ECONNREFUSED/);
	});
});
