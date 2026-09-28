import { readFile } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";

import {
	assertResultNamesMatchSelection,
	SUPPORTED_DRIZZLE_VERSION,
} from "./compat.js";

const accounts = pgTable("compat_accounts", {
	id: integer("id").primaryKey(),
	name: text("name").notNull(),
});

describe("Drizzle Live compatibility boundary", () => {
	it("pins the tested version and declares its optional peer range", async () => {
		const integrationPackage = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		) as {
			devDependencies: Record<string, string>;
			peerDependencies: Record<string, string>;
		};
		const installedPackage = JSON.parse(
			await readFile(
				new URL(
					"../node_modules/drizzle-orm/package.json",
					import.meta.url,
				),
				"utf8",
			),
		) as { version: string };

		expect(integrationPackage.devDependencies["drizzle-orm"]).toBe(
			SUPPORTED_DRIZZLE_VERSION,
		);
		expect(integrationPackage.peerDependencies["drizzle-orm"]).toBe(
			">=0.45.2 <0.46.0",
		);
		expect(installedPackage.version).toBe(SUPPORTED_DRIZZLE_VERSION);
	});

	it("accepts result names that match Drizzle's selected row keys", () => {
		const db = drizzle(async () => ({ rows: [] }));
		const query = db
			.select({ id: accounts.id, name: accounts.name })
			.from(accounts);

		expect(() => assertResultNamesMatchSelection(query)).not.toThrow();
	});

	it("requires explicit SQL aliases for renamed result fields", () => {
		const db = drizzle(async () => ({ rows: [] }));
		const renamed = db.select({ accountId: accounts.id }).from(accounts);
		const aliased = db
			.select({
				accountId: sql<number>`${accounts.id}`.as("accountId"),
			})
			.from(accounts);

		expect(() => assertResultNamesMatchSelection(renamed)).toThrow(
			"use an explicit SQL alias matching the selection key",
		);
		expect(() => assertResultNamesMatchSelection(aliased)).not.toThrow();
	});

	it("fails clearly when the expected private surface is absent", () => {
		expect(() =>
			assertResultNamesMatchSelection({
				toSQL: () => ({ sql: "select 1", params: [] }),
				_: { result: [] },
			}),
		).toThrow(`drizzle-orm ${SUPPORTED_DRIZZLE_VERSION}`);
	});
});
