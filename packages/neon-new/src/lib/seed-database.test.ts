import { describe, expect, test, vi } from "vitest";

const PASSWORD = "npg_SentinelPassword123";
const CONN = `postgresql://neondb_owner:${PASSWORD}@ep-test-123.us-east-1.aws.neon.tech/neondb?sslmode=require`;
// The driver quotes the connection string only when it cannot parse it.
const BROKEN_CONN = `postgresql://neondb_owner:${PASSWORD}@[ep-test-123/neondb`;

vi.mock("@neondatabase/serverless", () => ({
	neon: vi.fn(),
}));

vi.mock("./utils/fs.js", () => ({
	getSqlCommands: vi.fn(() => ["CREATE TABLE t (id int)"]),
}));

const { neon } = await import("@neondatabase/serverless");
const { seedDatabase } = await import("./seed-database.js");

describe("seedDatabase", () => {
	test("does not surface the password when the driver quotes the connection string", async () => {
		vi.mocked(neon).mockImplementation(() => {
			throw new Error(
				`Database connection string provided to \`neon()\` is not a valid URL. Connection string: ${BROKEN_CONN}`,
			);
		});

		const error = await seedDatabase("schema.sql", BROKEN_CONN).catch(
			(caught: unknown) => caught as Error,
		);

		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("is not a valid URL");
		expect(error?.message).toContain("neondb_owner:****@");
		expect(`${error?.stack}${String(error?.cause)}`).not.toContain(
			PASSWORD,
		);
	});

	test("rethrows errors that do not contain the password unchanged", async () => {
		const original = new Error('relation "t" already exists');
		vi.mocked(neon).mockImplementation(
			() =>
				({
					query: vi.fn(async () => {
						throw original;
					}),
				}) as never,
		);

		await expect(seedDatabase("schema.sql", CONN)).rejects.toBe(original);
	});
});
