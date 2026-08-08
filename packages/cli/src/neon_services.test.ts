import { describe, expect, it, vi } from "vitest";

import {
	CONFIG_INIT_SERVICES,
	CONFIG_INIT_UNAVAILABLE,
} from "./config_template.js";
import {
	ENV_PULL_SERVICES,
	ENV_PULL_UNAVAILABLE,
	envServiceKeys,
	ownedEnvServiceKeys,
} from "./env_services.js";
import {
	NEON_SERVICES,
	parseServices,
	servicesFlagValue,
	servicesOption,
} from "./neon_services.js";

/** The env-pull selection, which is the larger of the two allowed subsets. */
const envPull = {
	allowed: ENV_PULL_SERVICES,
	whyUnavailable: ENV_PULL_UNAVAILABLE,
	flag: "--service",
};
/** The config-init selection, which is the one that accepts `none`. */
const configInit = {
	allowed: CONFIG_INIT_SERVICES,
	whyUnavailable: CONFIG_INIT_UNAVAILABLE,
	flag: "--services",
	noneMeans: "the bare starter policy",
};

describe("the service vocabulary", () => {
	it("is one list, and every command's subset is drawn from it", () => {
		for (const service of [...ENV_PULL_SERVICES, ...CONFIG_INIT_SERVICES]) {
			expect(NEON_SERVICES).toContain(service);
		}
	});

	it("spells object storage the same way everywhere it is offered", () => {
		expect(ENV_PULL_SERVICES).toContain("object-storage");
		expect(CONFIG_INIT_SERVICES).toContain("object-storage");
		expect(NEON_SERVICES).not.toContain("storage");
	});

	it("offers each command only what it can act on", () => {
		// A function's env comes from the local neon.ts, so there is nothing to pull.
		expect(ENV_PULL_SERVICES).not.toContain("functions");
		// Every branch has Postgres, and the Data API needs auth — neither is declarable.
		expect(CONFIG_INIT_SERVICES).not.toContain("postgres");
		expect(CONFIG_INIT_SERVICES).not.toContain("data-api");
	});
});

describe("parseServices", () => {
	it("accepts the flag repeated", () => {
		expect(parseServices(["ai-gateway", "postgres"], envPull)).toEqual([
			"postgres",
			"ai-gateway",
		]);
	});

	it("accepts comma-separated values, and a mix of both", () => {
		expect(parseServices(["auth,data-api", "postgres"], envPull)).toEqual([
			"postgres",
			"auth",
			"data-api",
		]);
	});

	it("orders canonically and deduplicates, so typing order never changes the result", () => {
		expect(
			parseServices(
				["ai-gateway", "auth", "ai-gateway", "postgres"],
				envPull,
			),
		).toEqual(["postgres", "auth", "ai-gateway"]);
	});

	it("tolerates surrounding whitespace and empty segments", () => {
		expect(parseServices([" auth , ", "postgres"], envPull)).toEqual([
			"postgres",
			"auth",
		]);
	});

	it("rejects an unknown service rather than acting on everything but it", () => {
		expect(() => parseServices(["postgres", "nope"], envPull)).toThrow(
			/Unknown service nope\..*Supported values: postgres, auth, data-api, object-storage, ai-gateway\./s,
		);
	});

	it("rejects a numeric-looking value, which yargs can hand over as a string", () => {
		expect(() => parseServices(["5"], envPull)).toThrow(
			/Unknown service 5\./,
		);
	});

	it("rejects an empty selection", () => {
		expect(() => parseServices([" "], envPull)).toThrow(
			/--service needs at least one service/,
		);
	});

	it("says a real service is not selectable here, rather than calling it unknown", () => {
		// `functions` is a Neon service; it just has no branch env. That is a different
		// mistake from a typo, and pointing at the supported list alone would not say so.
		expect(() => parseServices(["functions"], envPull)).toThrow(
			/functions is not something --service can select: a function's env comes from your neon\.ts/,
		);
		expect(() => parseServices(["postgres"], configInit)).toThrow(
			/postgres is not something --services can select: every branch has Postgres/,
		);
	});

	it("reports a typo and an unselectable service separately in one message", () => {
		expect(() => parseServices(["nope", "functions"], envPull)).toThrow(
			/Unknown service nope\. functions is not something --service can select:/,
		);
	});

	describe("the retired `storage` spelling", () => {
		it("still resolves to object-storage, and warns once per use", () => {
			const onDeprecated = vi.fn();
			expect(
				parseServices(["storage", "auth"], {
					...configInit,
					onDeprecated,
				}),
			).toEqual(["auth", "object-storage"]);
			expect(onDeprecated).toHaveBeenCalledWith(
				"storage",
				"object-storage",
			);
		});

		it("works on every command that offers object storage, not just the one it came from", () => {
			expect(parseServices(["storage"], envPull)).toEqual([
				"object-storage",
			]);
		});

		it("collapses with the canonical spelling instead of duplicating", () => {
			expect(
				parseServices(["storage", "object-storage"], envPull),
			).toEqual(["object-storage"]);
		});

		it("does not claim it still works when the run fails anyway", () => {
			const onDeprecated = vi.fn();
			expect(() =>
				parseServices(["storage", "vectors"], {
					...configInit,
					onDeprecated,
				}),
			).toThrow(/Unknown service vectors/);
			expect(onDeprecated).not.toHaveBeenCalled();
		});
	});

	describe("none", () => {
		it("reads as an explicit empty selection where it is offered", () => {
			expect(parseServices(["none"], configInit)).toEqual([]);
		});

		it("cannot be combined with a real service", () => {
			expect(() => parseServices(["none", "auth"], configInit)).toThrow(
				/cannot be combined with other services/,
			);
		});

		it("deduplicates like any other value, so repeating it is still none", () => {
			expect(parseServices(["none", "none"], configInit)).toEqual([]);
			expect(parseServices(["none,none"], configInit)).toEqual([]);
		});

		it("is not a service where it is not offered", () => {
			// Pulling nothing is not a thing to ask for, so `env pull` does not accept it.
			expect(() => parseServices(["none"], envPull)).toThrow(
				/Unknown service none\./,
			);
		});
	});
});

describe("servicesOption", () => {
	it("gives every command the same three spellings", () => {
		expect(
			servicesOption({
				key: "service",
				allowed: ENV_PULL_SERVICES,
				describe: "Pull these",
			}).alias,
		).toEqual(["s", "services"]);
		expect(
			servicesOption({
				key: "services",
				allowed: CONFIG_INIT_SERVICES,
				describe: "Declare these",
			}).alias,
		).toEqual(["s", "service"]);
	});

	it("parses values as strings, so a numeric-looking service is not coerced", () => {
		const option = servicesOption({
			key: "service",
			allowed: ENV_PULL_SERVICES,
			describe: "Pull these",
		});
		expect(option.type).toBe("array");
		expect(option.string).toBe(true);
	});

	it("documents the values it accepts, and only mentions none where it is accepted", () => {
		expect(
			servicesOption({
				key: "service",
				allowed: ENV_PULL_SERVICES,
				describe: "Pull these",
			}).describe,
		).toBe(
			"Pull these: postgres, auth, data-api, object-storage, ai-gateway. " +
				"Repeat the flag or comma-separate.",
		);
		expect(
			servicesOption({
				key: "services",
				allowed: CONFIG_INIT_SERVICES,
				noneMeans: "the bare starter policy",
				describe: "Declare these",
				also: "Omitted: ask.",
			}).describe,
		).toBe(
			"Declare these: auth, functions, object-storage, ai-gateway. " +
				'Pass "none" for the bare starter policy. ' +
				"Repeat the flag or comma-separate. Omitted: ask.",
		);
	});
});

describe("servicesFlagValue", () => {
	it("is undefined when the flag was not given, so a command can tell that apart from empty", () => {
		expect(servicesFlagValue(undefined)).toBeUndefined();
	});

	it("stringifies whatever yargs produced, leaving validation to the parser", () => {
		expect(servicesFlagValue([5])).toEqual(["5"]);
	});
});

describe("envServiceKeys", () => {
	it("always includes branch identity, which is not a service", () => {
		expect([...envServiceKeys(["ai-gateway"])].sort()).toEqual([
			"NEON_AI_GATEWAY_BASE_URL",
			"NEON_AI_GATEWAY_TOKEN",
			"NEON_BRANCH",
		]);
	});

	it("unions the selected services", () => {
		expect([...envServiceKeys(["postgres", "data-api"])].sort()).toEqual([
			"DATABASE_URL",
			"DATABASE_URL_UNPOOLED",
			"NEON_BRANCH",
			"NEON_DATA_API_URL",
		]);
	});
});

describe("ownedEnvServiceKeys", () => {
	it("never claims the AWS_* storage vars, which collide with user-set credentials", () => {
		expect(ownedEnvServiceKeys(["object-storage"])).toEqual([]);
	});

	it("claims the unambiguously Neon-named vars of the selected services", () => {
		expect(ownedEnvServiceKeys(["auth", "ai-gateway"])).toEqual([
			"NEON_AUTH_BASE_URL",
			"NEON_AUTH_JWKS_URL",
			"NEON_AI_GATEWAY_TOKEN",
			"NEON_AI_GATEWAY_BASE_URL",
		]);
	});
});
