import { readFile } from "node:fs/promises";
import {
	Kysely as Kysely029,
	PostgresDialect as PostgresDialect029,
	type PostgresPool as PostgresPool029,
} from "kysely-0-29";
import { describe, expect, it } from "vitest";
import { kyselyAdapter } from "./index.js";

interface Database {
	messages: {
		id: number;
		body: string;
	};
}

describe("Kysely Realtime compatibility boundary", () => {
	it("declares the tested Kysely peer range", async () => {
		const integrationPackage = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as {
			devDependencies: Record<string, string>;
			peerDependencies: Record<string, string>;
		};
		const lowerVersion = await installedVersion("kysely");
		const upperVersion = await installedVersion("kysely-0-29");

		expect(integrationPackage.devDependencies.kysely).toBe("0.28.17");
		expect(integrationPackage.devDependencies["kysely-0-29"]).toBe(
			"npm:kysely@0.29.6",
		);
		expect(integrationPackage.peerDependencies.kysely).toBe(
			">=0.28.17 <0.30.0",
		);
		expect(lowerVersion).toBe("0.28.17");
		expect(upperVersion).toBe("0.29.6");
	});

	it("accepts a select builder from Kysely 0.29", () => {
		const pool: PostgresPool029 = {
			options: {},
			async connect() {
				throw new Error("Tests must not open a database connection");
			},
			async end() {},
		};
		const db = new Kysely029<Database>({
			dialect: new PostgresDialect029({ pool }),
		});
		const query = db
			.selectFrom("messages")
			.select(["id", "body"])
			.where("id", "=", 7);

		expect(kyselyAdapter().prepare(query)).toEqual({
			sql: 'select "id", "body" from "messages" where "id" = $1',
			parameters: [{ typeOid: 0, value: "7" }],
		});
	});
});

async function installedVersion(packageName: string): Promise<string> {
	const packageJson = JSON.parse(
		await readFile(
			new URL(
				`../node_modules/${packageName}/package.json`,
				import.meta.url,
			),
			"utf8",
		),
	) as { version: string };
	return packageJson.version;
}
