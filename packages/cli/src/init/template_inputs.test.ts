import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	parseEnvAssignments,
	readTemplateInputs,
	resolveTemplateInputs,
	writeTemplateEnv,
} from "./template_inputs.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "neon-template-inputs-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("readTemplateInputs", () => {
	test("returns no inputs without a template.json", () => {
		expect(readTemplateInputs(dir)).toEqual([]);
	});

	test("reads the declared inputs and drops unknown fields", () => {
		writeFileSync(
			join(dir, "template.json"),
			JSON.stringify({
				id: "queue",
				inputs: [
					{
						name: "QUEUE_API_KEY",
						description: "Bearer token",
						secret: true,
						generate: "token",
						extra: 1,
					},
					{ name: "ROLLUP_CRON", default: "5 0 * * *" },
				],
			}),
		);
		expect(readTemplateInputs(dir)).toEqual([
			{
				name: "QUEUE_API_KEY",
				description: "Bearer token",
				secret: true,
				generate: "token",
			},
			{ name: "ROLLUP_CRON", default: "5 0 * * *" },
		]);
	});

	test.each([
		["invalid JSON", "{", /not valid JSON/],
		["inputs that aren't a list", '{"inputs": {}}', /must be a list/],
		[
			"a lower-case name",
			'{"inputs": [{"name": "api_key"}]}',
			/upper-case/,
		],
		["a missing name", '{"inputs": [{}]}', /upper-case/],
	])("refuses %s", (_label, content, error) => {
		writeFileSync(join(dir, "template.json"), content);
		expect(() => readTemplateInputs(dir)).toThrow(error);
	});
});

describe("parseEnvAssignments", () => {
	test("splits on the first =", () => {
		expect(parseEnvAssignments(["A=1", "B_2=x=y", "EMPTY="])).toEqual({
			A: "1",
			B_2: "x=y",
			EMPTY: "",
		});
	});

	test.each(["novalue", "=1", "lower=1"])("refuses %s", (assignment) => {
		expect(() => parseEnvAssignments([assignment])).toThrow(/KEY=VALUE/);
	});
});

describe("resolveTemplateInputs", () => {
	test("prefers --env, then generates, then defaults, then asks", async () => {
		const asked: string[] = [];
		const { values, generated } = await resolveTemplateInputs(
			[
				{ name: "GIVEN", generate: "token" },
				{ name: "TOKEN", generate: "token", secret: true },
				{ name: "WITH_DEFAULT", default: "5 0 * * *" },
				{ name: "ASKED" },
			],
			{
				provided: { GIVEN: "from-flag" },
				ask: async (input) => {
					asked.push(input.name);
					return "answer";
				},
			},
		);
		expect(values.GIVEN).toBe("from-flag");
		expect(values.TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(values.WITH_DEFAULT).toBe("5 0 * * *");
		expect(values.ASKED).toBe("answer");
		expect(generated).toEqual(["TOKEN"]);
		expect(asked).toEqual(["ASKED"]);
	});

	test("names the --env flag when an input has no value", async () => {
		await expect(
			resolveTemplateInputs(
				[{ name: "STRIPE_KEY", description: "Stripe secret key" }],
				{ provided: {} },
			),
		).rejects.toThrow(
			"The template needs STRIPE_KEY (Stripe secret key). Pass --env STRIPE_KEY=<value>.",
		);
	});
});

describe("writeTemplateEnv", () => {
	test("creates .env.local readable only by the owner", () => {
		const path = writeTemplateEnv(dir, { QUEUE_API_KEY: "secret" });
		expect(path).toBe(join(dir, ".env.local"));
		expect(readFileSync(path, "utf8")).toContain("QUEUE_API_KEY=secret");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("keeps the lines already in .env.local", () => {
		writeFileSync(join(dir, ".env.local"), "# mine\nOTHER=1\n");
		writeTemplateEnv(dir, { QUEUE_API_KEY: "secret" });
		const content = readFileSync(join(dir, ".env.local"), "utf8");
		expect(content).toContain("# mine");
		expect(content).toContain("OTHER=1");
		expect(content).toContain("QUEUE_API_KEY=secret");
	});
});
