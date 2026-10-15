/**
 * Runs the vendored postgres-meta introspection and TypeScript template against a real
 * Postgres via testcontainers.
 *
 * Skipped by default (Docker required); run with:
 *   RUN_INTEGRATION=1 npx vitest run src/utils/generate_types.integration.test.ts
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateTypes } from "./generate_types.js";

const RUN = process.env.CI === "true" || process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("generateTypes — integration", () => {
	let stop: () => Promise<unknown>;
	let url: string;
	let tlsUrl: string;
	let certDir: string;
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

		// Self-signed server certificate that no default trust store knows.
		certDir = mkdtempSync(path.join(tmpdir(), "gen-types-tls-"));
		execFileSync("openssl", [
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost,IP:127.0.0.1",
			"-keyout",
			path.join(certDir, "server.key"),
			"-out",
			path.join(certDir, "server.crt"),
		]);
		await container.copyContentToContainer([
			{
				content: readFileSync(path.join(certDir, "server.crt")),
				target: "/tmp/server.crt",
			},
			{
				content: readFileSync(path.join(certDir, "server.key")),
				target: "/tmp/server.key",
			},
		]);
		await container.exec([
			"sh",
			"-c",
			"chown postgres:postgres /tmp/server.crt /tmp/server.key && chmod 600 /tmp/server.key",
		]);
		await client.query(
			"alter system set ssl_cert_file = '/tmp/server.crt'",
		);
		await client.query("alter system set ssl_key_file = '/tmp/server.key'");
		await client.query("alter system set ssl = on");
		await client.query("select pg_reload_conf()");
		tlsUrl = container.getConnectionUri();
		await client.end();
	}, 90_000);

	afterAll(async () => {
		await stop?.();
		if (certDir) {
			rmSync(certDir, { recursive: true, force: true });
		}
	});

	it("types the tables of the requested schemas only", async () => {
		const types = await generateTypes(options());

		expect(types).toMatch(
			/authors: \{\s+Row: \{\s+id: number\s+name: string/,
		);
		expect(types).toContain("author_id: number | null");
		expect(types).not.toContain("notes: {");
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

	describe("TLS", () => {
		const tls = (query: string) => ({
			...options(),
			connectionString: `${tlsUrl}?${query}`,
		});

		it.each([
			"require",
			"verify-ca",
			"verify-full",
		])("sslmode=%s rejects an untrusted self-signed certificate", async (sslmode) => {
			await expect(
				generateTypes(tls(`sslmode=${sslmode}`)),
			).rejects.toThrow(/self[- ]signed|certificate/i);
		});

		it("sslmode=no-verify accepts the untrusted certificate", async () => {
			expect(await generateTypes(tls("sslmode=no-verify"))).toContain(
				"authors: {",
			);
		});

		it.each([
			"require",
			"verify-full",
		])("sslmode=%s trusts the certificate named by sslrootcert", async (sslmode) => {
			const root = encodeURIComponent(path.join(certDir, "server.crt"));
			expect(
				await generateTypes(
					tls(`sslmode=${sslmode}&sslrootcert=${root}`),
				),
			).toContain("authors: {");
		});
	});
});
