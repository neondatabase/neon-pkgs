import { describe, expect, it, vi } from "vitest";

import {
	CONFIG_INIT_SERVICES,
	parseConfigInitServices,
} from "./config_template.js";
import {
	ENV_PULL_SERVICES,
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
	flag: "--service",
};
/** A command that offers fewer services than env pull, to exercise refusals. */
const addOnsOnly = {
	allowed: CONFIG_INIT_SERVICES,
	flag: "--services",
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
		expect(ENV_PULL_SERVICES).toContain("functions");
		expect(CONFIG_INIT_SERVICES).toContain("data-api");
		// Every branch has Postgres, so a policy has nothing to declare for it.
		expect(CONFIG_INIT_SERVICES).not.toContain("postgres");
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
			/Unknown service nope\..*Supported values: postgres, auth, data-api, functions, object-storage, ai-gateway\./s,
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
		expect(() => parseServices(["postgres"], addOnsOnly)).toThrow(
			/postgres is not something --services can select\./,
		);
	});

	it("reports a typo and an unselectable service separately in one message", () => {
		expect(() => parseServices(["nope", "postgres"], addOnsOnly)).toThrow(
			/Unknown service nope\. postgres is not something --services can select\./,
		);
	});

	describe("the retired `storage` spelling", () => {
		it("still resolves to object-storage, and warns once per use", () => {
			const onDeprecated = vi.fn();
			expect(
				parseServices(["storage", "auth"], {
					...addOnsOnly,
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

		it("warns once however many times it is repeated", () => {
			const onDeprecated = vi.fn();
			parseServices(["storage", "storage,storage"], {
				...envPull,
				onDeprecated,
			});
			expect(onDeprecated).toHaveBeenCalledTimes(1);
		});

		it("is reported as the service it means where a command cannot select it", () => {
			// Not reachable through either of today's commands, since both offer object
			// storage. It is the shape that matters: an alias must never degrade into
			// "unknown word" just because this command can't act on what it resolves to.
			expect(() =>
				parseServices(["storage"], {
					allowed: ["postgres"],
					flag: "--service",
				}),
			).toThrow(/object-storage is not something --service can select\./);
		});

		it("does not claim it still works when the run fails anyway", () => {
			const onDeprecated = vi.fn();
			expect(() =>
				parseServices(["storage", "vectors"], {
					...addOnsOnly,
					onDeprecated,
				}),
			).toThrow(/Unknown service vectors/);
			expect(onDeprecated).not.toHaveBeenCalled();
		});
	});
});

describe("parseConfigInitServices", () => {
	it("reads postgres alone as the starter policy, which declares nothing", () => {
		expect(parseConfigInitServices(["postgres"])).toEqual([]);
	});

	it("accepts postgres next to add-ons, since every branch has it", () => {
		expect(parseConfigInitServices(["postgres,auth", "data-api"])).toEqual([
			"auth",
			"data-api",
		]);
	});

	it("rejects none, which is not a service", () => {
		expect(() => parseConfigInitServices(["none"])).toThrow(
			"Unknown service none. Supported values: postgres, auth, data-api, functions, object-storage, ai-gateway.",
		);
	});

	it("rejects an empty selection rather than reading it as Postgres-only", () => {
		expect(() => parseConfigInitServices([" "])).toThrow(
			/--services needs at least one service/,
		);
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

	it("documents the values it accepts", () => {
		expect(
			servicesOption({
				key: "services",
				allowed: CONFIG_INIT_SERVICES,
				describe: "Declare these",
				also: "Omitted: ask.",
			}).describe,
		).toBe(
			"Declare these: auth, data-api, functions, object-storage, ai-gateway. " +
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
