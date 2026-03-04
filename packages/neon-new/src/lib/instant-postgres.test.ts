import { beforeEach, describe, expect, test, vi } from "vitest";
import { instantPostgres } from "./instant-postgres.js";
import type { InstantPostgresParams } from "./types.js";

// Mock all dependencies
vi.mock("@clack/prompts", () => ({
	log: {
		step: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("./seed-database.js", () => ({
	seedDatabase: vi.fn(),
}));

vi.mock("./utils/create-db.js", () => ({
	createClaimableDatabase: vi.fn(),
}));

vi.mock("./utils/format.js", () => ({
	getConnectionStrings: vi.fn(),
}));

vi.mock("./utils/fs.js", () => ({
	writeToEnv: vi.fn(),
}));

// Import mocked modules
const { log } = await import("@clack/prompts");
const { seedDatabase } = await import("./seed-database.js");
const { createClaimableDatabase } = await import("./utils/create-db.js");
const { getConnectionStrings } = await import("./utils/format.js");
const { writeToEnv } = await import("./utils/fs.js");

describe("instantPostgres", () => {
	const mockConnectionString =
		"postgres://user:pass@ep-test-123.us-east-1.aws.neon.tech/main";
	const mockPoolerString =
		"postgres://user:pass@ep-test-123-pooler.us-east-1.aws.neon.tech/main";

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(createClaimableDatabase).mockResolvedValue(
			mockConnectionString,
		);
		vi.mocked(getConnectionStrings).mockReturnValue({
			pooler: mockPoolerString,
			direct: mockConnectionString,
		});
		vi.mocked(writeToEnv).mockResolvedValue();
		vi.mocked(seedDatabase).mockResolvedValue();
	});

	test("returns database connection info with all required properties", async () => {
		const result = await instantPostgres({ referrer: "test-referrer" });

		expect(result).toBeDefined();
		expect(result).toHaveProperty("databaseUrl");
		expect(result).toHaveProperty("databaseUrlDirect");
		expect(result).toHaveProperty("claimUrl");
		expect(result).toHaveProperty("claimExpiresAt");
	});

	test("returns correct connection strings", async () => {
		const result = await instantPostgres({ referrer: "test-referrer" });

		expect(result.databaseUrl).toBe(mockPoolerString);
		expect(result.databaseUrlDirect).toBe(mockConnectionString);
	});

	test("generates valid claim URL with UUID", async () => {
		const result = await instantPostgres({ referrer: "test-referrer" });

		expect(result.claimUrl).toMatch(/^https:\/\/pg\.new\/database\//);
		// Check that URL contains a valid UUID pattern
		expect(result.claimUrl).toMatch(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
		);
	});

	test("sets claim expiration to 3 days from now", async () => {
		const beforeCall = Date.now();
		const result = await instantPostgres({ referrer: "test-referrer" });
		const afterCall = Date.now();

		const threeDaysInMs = 3 * 24 * 60 * 60 * 1000;
		const expectedMinTime = beforeCall + threeDaysInMs;
		const expectedMaxTime = afterCall + threeDaysInMs;

		expect(result.claimExpiresAt.getTime()).toBeGreaterThanOrEqual(
			expectedMinTime,
		);
		expect(result.claimExpiresAt.getTime()).toBeLessThanOrEqual(
			expectedMaxTime,
		);
	});

	test("uses default parameters when only referrer provided", async () => {
		await instantPostgres({ referrer: "test-referrer", settings: {} });

		expect(createClaimableDatabase).toHaveBeenCalledWith({
			dbId: expect.any(String),
			referrer: "npm:neon-new|test-referrer",
			settings: { logicalReplication: false },
		});
		expect(writeToEnv).toHaveBeenCalledWith(
			".env",
			"DATABASE_URL",
			expect.any(Date),
			expect.any(URL),
			mockConnectionString,
			mockPoolerString,
			"PUBLIC_",
		);
	});

	test("accepts custom dotEnvFile parameter", async () => {
		const customEnvFile = ".env.local";

		await instantPostgres({
			referrer: "test-referrer",
			dotEnvFile: customEnvFile,
		});

		expect(writeToEnv).toHaveBeenCalledWith(
			customEnvFile,
			expect.any(String),
			expect.any(Date),
			expect.any(URL),
			expect.any(String),
			expect.any(String),
			expect.any(String),
		);
	});

	test("accepts custom dotEnvKey parameter", async () => {
		const customEnvKey = "POSTGRES_URL";

		await instantPostgres({
			referrer: "test-referrer",
			dotEnvKey: customEnvKey,
		});

		expect(writeToEnv).toHaveBeenCalledWith(
			expect.any(String),
			customEnvKey,
			expect.any(Date),
			expect.any(URL),
			expect.any(String),
			expect.any(String),
			expect.any(String),
		);
	});

	test("accepts custom referrer parameter", async () => {
		const customReferrer = "vite-plugin";

		await instantPostgres({ referrer: customReferrer, settings: {} });

		expect(createClaimableDatabase).toHaveBeenCalledWith({
			dbId: expect.any(String),
			referrer: `npm:neon-new|${customReferrer}`,
			settings: { logicalReplication: false },
		});
	});

	test("accepts custom envPrefix parameter", async () => {
		const customPrefix = "VITE_";

		await instantPostgres({
			referrer: "test-referrer",
			envPrefix: customPrefix,
		});

		expect(writeToEnv).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			expect.any(Date),
			expect.any(URL),
			expect.any(String),
			expect.any(String),
			customPrefix,
		);
	});

	test("accepts all custom parameters together", async () => {
		const params: InstantPostgresParams = {
			dotEnvFile: ".env.production",
			dotEnvKey: "PG_URL",
			referrer: "custom-tool",
			envPrefix: "APP_",
			settings: {},
		};

		await instantPostgres(params);

		expect(writeToEnv).toHaveBeenCalledWith(
			".env.production",
			"PG_URL",
			expect.any(Date),
			expect.any(URL),
			mockConnectionString,
			mockPoolerString,
			"APP_",
		);
		expect(createClaimableDatabase).toHaveBeenCalledWith({
			dbId: expect.any(String),
			referrer: "npm:neon-new|custom-tool",
			settings: { logicalReplication: false },
		});
	});

	test("does not call seedDatabase when seed is not provided", async () => {
		await instantPostgres({ referrer: "test-referrer" });

		expect(seedDatabase).not.toHaveBeenCalled();
	});

	test("calls seedDatabase when seed parameter is provided", async () => {
		const seedPath = "./schema.sql";
		const seed = { type: "sql-script" as const, path: seedPath };

		await instantPostgres({ referrer: "test-referrer", seed });

		expect(seedDatabase).toHaveBeenCalledWith(
			seedPath,
			mockConnectionString,
		);
	});

	test("logs seeding progress when seed is provided", async () => {
		const seed = { type: "sql-script" as const, path: "./schema.sql" };

		await instantPostgres({ referrer: "test-referrer", seed });

		expect(log.step).toHaveBeenCalledWith("Pushing schema to database");
		expect(log.success).toHaveBeenCalledWith("Schema pushed to database");
	});

	test("calls createClaimableDatabase with unique UUID each time", async () => {
		await instantPostgres({ referrer: "test-referrer" });
		await instantPostgres({ referrer: "test-referrer" });

		const calls = vi.mocked(createClaimableDatabase).mock.calls;
		const firstUuid = calls[0][0];
		const secondUuid = calls[1][0];

		expect(firstUuid).not.toBe(secondUuid);
	});

	test("generates pooler string from connection string", async () => {
		await instantPostgres({ referrer: "test-referrer" });

		expect(getConnectionStrings).toHaveBeenCalledWith(mockConnectionString);
	});

	test("propagates errors from createClaimableDatabase", async () => {
		const error = new Error("Failed to create database");
		vi.mocked(createClaimableDatabase).mockRejectedValue(error);

		await expect(
			instantPostgres({ referrer: "test-referrer" }),
		).rejects.toThrow("Failed to create database");
	});

	test("propagates errors from writeToEnv", async () => {
		const error = new Error("Failed to write to env");
		vi.mocked(writeToEnv).mockRejectedValue(error);

		await expect(
			instantPostgres({ referrer: "test-referrer" }),
		).rejects.toThrow("Failed to write to env");
	});

	test("propagates errors from seedDatabase", async () => {
		const error = new Error("Failed to seed database");
		vi.mocked(seedDatabase).mockRejectedValue(error);
		const seed = { type: "sql-script" as const, path: "./schema.sql" };

		await expect(
			instantPostgres({ referrer: "test-referrer", seed }),
		).rejects.toThrow("Failed to seed database");
	});

	test("maintains correct execution order", async () => {
		const callOrder: string[] = [];

		vi.mocked(createClaimableDatabase).mockImplementation(async () => {
			callOrder.push("createDatabase");
			return mockConnectionString;
		});

		vi.mocked(getConnectionStrings).mockImplementation(() => {
			callOrder.push("getPooler");
			return {
				pooler: mockPoolerString,
				direct: mockConnectionString,
			};
		});

		vi.mocked(writeToEnv).mockImplementation(async () => {
			callOrder.push("writeEnv");
		});

		vi.mocked(seedDatabase).mockImplementation(async () => {
			callOrder.push("seed");
		});

		await instantPostgres({
			referrer: "test-referrer",
			seed: { type: "sql-script", path: "./schema.sql" },
		});

		expect(callOrder).toEqual([
			"createDatabase",
			"getPooler",
			"writeEnv",
			"seed",
		]);
	});

	test("throws error when referrer is missing", async () => {
		await expect(
			instantPostgres({
				dotEnvFile: ".env",
			} as InstantPostgresParams),
		).rejects.toThrow("referrer parameter is required");
	});

	test("throws error when referrer is empty string", async () => {
		await expect(
			instantPostgres({
				dotEnvFile: ".env",
				referrer: "",
			}),
		).rejects.toThrow("referrer parameter is required");
	});

	test("throws error when referrer is whitespace only", async () => {
		await expect(
			instantPostgres({
				dotEnvFile: ".env",
				referrer: "   ",
			}),
		).rejects.toThrow("referrer parameter is required");
	});

	test("passes logicalReplication setting as false by default", async () => {
		await instantPostgres({ referrer: "test-referrer", settings: {} });

		expect(createClaimableDatabase).toHaveBeenCalledWith({
			dbId: expect.any(String),
			referrer: "npm:neon-new|test-referrer",
			settings: { logicalReplication: false },
		});
	});

	test("passes logicalReplication setting when set to true", async () => {
		await instantPostgres({
			referrer: "test-referrer",
			settings: { logicalReplication: true },
		});

		expect(createClaimableDatabase).toHaveBeenCalledWith({
			dbId: expect.any(String),
			referrer: "npm:neon-new|test-referrer",
			settings: { logicalReplication: true },
		});
	});

	test("passes logicalReplication setting when explicitly set to false", async () => {
		await instantPostgres({
			referrer: "test-referrer",
			settings: { logicalReplication: false },
		});

		expect(createClaimableDatabase).toHaveBeenCalledWith({
			dbId: expect.any(String),
			referrer: "npm:neon-new|test-referrer",
			settings: { logicalReplication: false },
		});
	});

	test("accepts logicalReplication with other custom parameters", async () => {
		const params: InstantPostgresParams = {
			dotEnvFile: ".env.production",
			dotEnvKey: "PG_URL",
			referrer: "custom-tool",
			envPrefix: "APP_",
			settings: { logicalReplication: true },
		};

		await instantPostgres(params);

		expect(createClaimableDatabase).toHaveBeenCalledWith({
			dbId: expect.any(String),
			referrer: "npm:neon-new|custom-tool",
			settings: { logicalReplication: true },
		});
		expect(writeToEnv).toHaveBeenCalledWith(
			".env.production",
			"PG_URL",
			expect.any(Date),
			expect.any(URL),
			mockConnectionString,
			mockPoolerString,
			"APP_",
		);
	});
});
