import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const generateTypes = vi.hoisted(() => vi.fn());
const resolveConnectionUri = vi.hoisted(() => vi.fn());
const branchIdFromProps = vi.hoisted(() => vi.fn());
vi.mock("../utils/generate_types.js", () => ({ generateTypes }));
vi.mock("../utils/inspect_db.js", () => ({ resolveConnectionUri }));
vi.mock("../utils/enrichers.js", () => ({ branchIdFromProps }));

import { NeonApiError } from "../api.js";
import {
	type GenTypesProps,
	genTypes,
	parseDuration,
} from "./data_api_gen_types.js";

describe("parseDuration", () => {
	test.each([
		["30", 30_000],
		["1m", 60_000],
		["2h", 7_200_000],
	])("%s", (input, ms) => {
		expect(parseDuration(input)).toBe(ms);
	});

	test.each(["", "1d", "-5s", "1.5m", "ten"])("rejects %j", (input) => {
		expect(() => parseDuration(input)).toThrow(/Invalid duration format/);
	});
});

describe("genTypes", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "gen-types-"));
		generateTypes
			.mockReset()
			.mockResolvedValue("export type Database = {}\n");
		branchIdFromProps.mockReset().mockResolvedValue("br-1");
		resolveConnectionUri.mockReset().mockResolvedValue({
			connectionUri:
				"postgresql://role:pw@ep-1.neon.tech/db1?sslmode=require",
			database: "db1",
		});
		vi.stubEnv("DATABASE_URL", "");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	const props = (overrides: Partial<GenTypesProps> = {}): GenTypesProps =>
		({
			projectId: "proj-1",
			branch: "main",
			apiClient: {
				getProjectBranchDataApi: vi
					.fn()
					.mockResolvedValue({ data: { settings: {} } }),
			},
			outFile: path.join(dir, "nested", "db.ts"),
			postgrestV9Compat: false,
			...overrides,
		}) as GenTypesProps;

	test("uses --db-url as given and never resolves a branch", async () => {
		await genTypes(props({ dbUrl: " postgresql://u:p@h/d " }));

		expect(resolveConnectionUri).not.toHaveBeenCalled();
		expect(generateTypes).toHaveBeenCalledWith(
			expect.objectContaining({
				connectionString: "postgresql://u:p@h/d",
			}),
		);
	});

	test("falls back to the resolved branch connection, mapping --database", async () => {
		await genTypes(props({ database: "db1", roleName: "app" }));

		expect(resolveConnectionUri).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				branch: "br-1",
				databaseName: "db1",
				roleName: "app",
			}),
		);
		expect(generateTypes).toHaveBeenCalledWith(
			expect.objectContaining({
				connectionString:
					"postgresql://role:pw@ep-1.neon.tech/db1?sslmode=require",
			}),
		);
	});

	test("explicit Neon flags beat DATABASE_URL and resolve the branch", async () => {
		vi.stubEnv("DATABASE_URL", "postgresql://env:pw@h/d");
		const argv = process.argv;
		process.argv = [
			"node",
			"neon",
			"data-api",
			"gen-types",
			"--branch",
			"preview",
		];
		try {
			await genTypes(props({ branch: "preview" }));
		} finally {
			process.argv = argv;
		}
		expect(resolveConnectionUri).toHaveBeenCalled();
		expect(generateTypes).toHaveBeenCalledWith(
			expect.objectContaining({
				connectionString:
					"postgresql://role:pw@ep-1.neon.tech/db1?sslmode=require",
			}),
		);
	});

	test("uses DATABASE_URL when --db-url is absent, and --db-url wins over it", async () => {
		vi.stubEnv("DATABASE_URL", "postgresql://env:pw@h/d");
		await genTypes(props());
		expect(generateTypes).toHaveBeenLastCalledWith(
			expect.objectContaining({
				connectionString: "postgresql://env:pw@h/d",
			}),
		);

		await genTypes(props({ dbUrl: "postgresql://flag:pw@h/d" }));
		expect(generateTypes).toHaveBeenLastCalledWith(
			expect.objectContaining({
				connectionString: "postgresql://flag:pw@h/d",
			}),
		);
		expect(resolveConnectionUri).not.toHaveBeenCalled();
	});

	describe("default schemas", () => {
		const withApi = (get: ReturnType<typeof vi.fn>) =>
			props({ apiClient: { getProjectBranchDataApi: get } as never });

		test("uses the schemas the Data API exposes", async () => {
			const get = vi.fn().mockResolvedValue({
				data: { settings: { db_schemas: ["public", "api"] } },
			});
			await genTypes(withApi(get));

			expect(get).toHaveBeenCalledWith("proj-1", "br-1", "db1");
			expect(generateTypes).toHaveBeenCalledWith(
				expect.objectContaining({ schemas: ["public", "api"] }),
			);
		});

		test("an explicit --schema skips the Data API lookup", async () => {
			const get = vi.fn();
			await genTypes({ ...withApi(get), schema: ["auth"] });

			expect(get).not.toHaveBeenCalled();
			expect(generateTypes).toHaveBeenCalledWith(
				expect.objectContaining({ schemas: ["auth"] }),
			);
		});

		test("falls back to public when the Data API is not enabled", async () => {
			const get = vi
				.fn()
				.mockRejectedValue(
					new NeonApiError("not found", { status: 404 }),
				);
			await genTypes(withApi(get));

			expect(generateTypes).toHaveBeenCalledWith(
				expect.objectContaining({ schemas: ["public"] }),
			);
		});

		test("falls back to public with --db-url and never calls the API", async () => {
			const get = vi.fn();
			await genTypes({ ...withApi(get), dbUrl: "postgresql://u:p@h/d" });

			expect(get).not.toHaveBeenCalled();
			expect(generateTypes).toHaveBeenCalledWith(
				expect.objectContaining({ schemas: ["public"] }),
			);
		});

		test("surfaces other Data API errors", async () => {
			const get = vi.fn().mockRejectedValue(new Error("boom"));
			await expect(genTypes(withApi(get))).rejects.toThrow("boom");
		});
	});

	test("passes schemas, relationship detection and the timeout to the generator", async () => {
		await genTypes(
			props({
				dbUrl: "postgresql://u:p@h/d",
				schema: ["public", "auth"],
				postgrestV9Compat: true,
				queryTimeout: "1m",
			}),
		);

		expect(generateTypes).toHaveBeenCalledWith({
			connectionString: "postgresql://u:p@h/d",
			schemas: ["public", "auth"],
			detectOneToOneRelationships: false,
			queryTimeout: 60_000,
		});
	});

	test("rejects a bad --query-timeout before resolving or connecting", async () => {
		await expect(genTypes(props({ queryTimeout: "soon" }))).rejects.toThrow(
			/Invalid duration format/,
		);
		expect(resolveConnectionUri).not.toHaveBeenCalled();
		expect(generateTypes).not.toHaveBeenCalled();
	});

	test("--out-file - writes the types to stdout and creates no file", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((
			_chunk: unknown,
			cb?: () => void,
		) => {
			cb?.();
			return true;
		}) as typeof process.stdout.write);
		try {
			await genTypes(
				props({ dbUrl: "postgresql://u:p@h/d", outFile: "-" }),
			);

			expect(write).toHaveBeenCalledTimes(1);
			expect(write.mock.calls[0]?.[0]).toBe(
				"export type Database = {}\n",
			);
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			write.mockRestore();
		}
	});

	test("creates the output directory and writes the types", async () => {
		const p = props({ dbUrl: "postgresql://u:p@h/d" });
		await genTypes(p);

		expect(readFileSync(p.outFile, "utf8")).toBe(
			"export type Database = {}\n",
		);
	});
});
