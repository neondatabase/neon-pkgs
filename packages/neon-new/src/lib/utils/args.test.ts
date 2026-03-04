import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getArgs } from "./args.js";

describe("getArgs", () => {
	const originalArgv = process.argv;
	const originalExit = process.exit;

	beforeEach(() => {
		// Mock process.exit to prevent test from exiting
		process.exit = vi.fn() as never;
		// Mock console.log to prevent output during tests
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		// Restore original values
		process.argv = originalArgv;
		process.exit = originalExit;
		vi.restoreAllMocks();
	});

	test("parses --ref flag with long form", () => {
		process.argv = ["node", "cli.js", "--ref", "custom-referrer"];

		const args = getArgs();

		expect(args.ref).toBe("custom-referrer");
	});

	test("parses -r flag with short form", () => {
		process.argv = ["node", "cli.js", "-r", "short-ref"];

		const args = getArgs();

		expect(args.ref).toBe("short-ref");
	});

	test("handles --ref flag with --yes flag", () => {
		process.argv = ["node", "cli.js", "--yes", "--ref", "ci-tool"];

		const args = getArgs();

		expect(args.yes).toBe(true);
		expect(args.ref).toBe("ci-tool");
	});

	test("handles --ref flag with other flags", () => {
		process.argv = [
			"node",
			"cli.js",
			"--env",
			".env.local",
			"--key",
			"PG_URL",
			"--ref",
			"vite-plugin",
		];

		const args = getArgs();

		expect(args.env).toBe(".env.local");
		expect(args.key).toBe("PG_URL");
		expect(args.ref).toBe("vite-plugin");
	});

	test("handles --ref flag with claim command", () => {
		process.argv = ["node", "cli.js", "claim", "--ref", "claim-tool"];

		const args = getArgs();

		expect(args.command).toBe("claim");
		expect(args.ref).toBe("claim-tool");
	});

	test("does not set ref when flag is not provided", () => {
		process.argv = ["node", "cli.js", "--yes"];

		const args = getArgs();

		expect(args.ref).toBeUndefined();
	});

	test("displays help text with --ref flag information", () => {
		process.argv = ["node", "cli.js", "--help"];

		getArgs();

		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining("-r, --ref"),
		);
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining("Referrer id"),
		);
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining("[default: npm:neon-new/cli]"),
		);
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	test("handles all flags together including --ref", () => {
		process.argv = [
			"node",
			"cli.js",
			"--yes",
			"--env",
			".env.test",
			"--key",
			"TEST_DB_URL",
			"--seed",
			"./seed.sql",
			"--prefix",
			"APP_",
			"--ref",
			"test-runner",
		];

		const args = getArgs();

		expect(args.yes).toBe(true);
		expect(args.env).toBe(".env.test");
		expect(args.key).toBe("TEST_DB_URL");
		expect(args.seed).toBe("./seed.sql");
		expect(args.prefix).toBe("APP_");
		expect(args.ref).toBe("test-runner");
	});

	test("handles empty string as ref value", () => {
		process.argv = ["node", "cli.js", "--ref", ""];

		const args = getArgs();

		expect(args.ref).toBe("");
	});

	test("handles ref value with special characters", () => {
		process.argv = ["node", "cli.js", "--ref", "npm:my-package/v1.0.0"];

		const args = getArgs();

		expect(args.ref).toBe("npm:my-package/v1.0.0");
	});

	test("returns create as default command when no command provided", () => {
		process.argv = ["node", "cli.js"];

		const args = getArgs();

		expect(args.command).toBe("create");
	});

	test("parses claim command with no flags", () => {
		process.argv = ["node", "cli.js", "claim"];

		const args = getArgs();

		expect(args.command).toBe("claim");
	});

	// Individual flag tests - Long form
	describe("individual flags (long form)", () => {
		test("parses --yes flag", () => {
			process.argv = ["node", "cli.js", "--yes"];
			const args = getArgs();
			expect(args.yes).toBe(true);
		});

		test("parses --env flag", () => {
			process.argv = ["node", "cli.js", "--env", ".env.test"];
			const args = getArgs();
			expect(args.env).toBe(".env.test");
		});

		test("parses --key flag", () => {
			process.argv = ["node", "cli.js", "--key", "DATABASE_CONNECTION"];
			const args = getArgs();
			expect(args.key).toBe("DATABASE_CONNECTION");
		});

		test("parses --seed flag", () => {
			process.argv = ["node", "cli.js", "--seed", "./schema.sql"];
			const args = getArgs();
			expect(args.seed).toBe("./schema.sql");
		});

		test("parses --prefix flag", () => {
			process.argv = ["node", "cli.js", "--prefix", "REACT_APP_"];
			const args = getArgs();
			expect(args.prefix).toBe("REACT_APP_");
		});

		test("parses --logical-replication flag (kebab-case)", () => {
			process.argv = ["node", "cli.js", "--logical-replication"];
			const args = getArgs();
			expect(args.logicalReplication).toBe(true);
		});

		test("parses --logicalReplication flag (camelCase) for backward compat", () => {
			process.argv = ["node", "cli.js", "--logicalReplication"];
			const args = getArgs();
			expect(args.logicalReplication).toBe(true);
		});
	});

	// Individual flag tests - Short form
	describe("individual flags (short form)", () => {
		test("parses -y flag", () => {
			process.argv = ["node", "cli.js", "-y"];
			const args = getArgs();
			expect(args.yes).toBe(true);
		});

		test("parses -e flag", () => {
			process.argv = ["node", "cli.js", "-e", ".env.production"];
			const args = getArgs();
			expect(args.env).toBe(".env.production");
		});

		test("parses -k flag", () => {
			process.argv = ["node", "cli.js", "-k", "DB_URL"];
			const args = getArgs();
			expect(args.key).toBe("DB_URL");
		});

		test("parses -s flag", () => {
			process.argv = ["node", "cli.js", "-s", "./init.sql"];
			const args = getArgs();
			expect(args.seed).toBe("./init.sql");
		});

		test("parses -p flag", () => {
			process.argv = ["node", "cli.js", "-p", "VITE_"];
			const args = getArgs();
			expect(args.prefix).toBe("VITE_");
		});

		test("parses -L flag (short alias)", () => {
			process.argv = ["node", "cli.js", "-L"];
			const args = getArgs();
			expect(args.logicalReplication).toBe(true);
		});
	});

	// Boolean flag defaults
	describe("boolean flag defaults", () => {
		test("--yes defaults to false when not provided", () => {
			process.argv = ["node", "cli.js"];
			const args = getArgs();
			expect(args.yes).toBe(false);
		});

		test("--logical-replication defaults to false when not provided", () => {
			process.argv = ["node", "cli.js"];
			const args = getArgs();
			expect(args.logicalReplication).toBe(false);
		});
	});

	// String flag behavior
	describe("string flag behavior", () => {
		test("handles empty string for env", () => {
			process.argv = ["node", "cli.js", "--env", ""];
			const args = getArgs();
			expect(args.env).toBe("");
		});

		test("handles undefined for env when not provided", () => {
			process.argv = ["node", "cli.js"];
			const args = getArgs();
			expect(args.env).toBeUndefined();
		});

		test("handles numeric values as strings", () => {
			process.argv = ["node", "cli.js", "--key", "12345"];
			const args = getArgs();
			expect(args.key).toBe("12345");
		});
	});

	// Command parsing with flags
	describe("command parsing with flags", () => {
		test("parses default command with flags", () => {
			process.argv = ["node", "cli.js", "--yes"];
			const args = getArgs();
			expect(args.command).toBe("create");
			expect(args.yes).toBe(true);
		});

		test("handles flags before command", () => {
			process.argv = ["node", "cli.js", "--yes", "claim"];
			const args = getArgs();
			expect(args.command).toBe("claim");
			expect(args.yes).toBe(true);
		});
	});

	// Logical replication comprehensive tests
	describe("logical replication flag variations", () => {
		test("works with other flags (kebab-case)", () => {
			process.argv = ["node", "cli.js", "--yes", "--logical-replication"];
			const args = getArgs();
			expect(args.yes).toBe(true);
			expect(args.logicalReplication).toBe(true);
		});

		test("works with other flags (camelCase)", () => {
			process.argv = ["node", "cli.js", "--yes", "--logicalReplication"];
			const args = getArgs();
			expect(args.yes).toBe(true);
			expect(args.logicalReplication).toBe(true);
		});

		test("works with other flags (short alias)", () => {
			process.argv = ["node", "cli.js", "-y", "-L"];
			const args = getArgs();
			expect(args.yes).toBe(true);
			expect(args.logicalReplication).toBe(true);
		});
	});
});
