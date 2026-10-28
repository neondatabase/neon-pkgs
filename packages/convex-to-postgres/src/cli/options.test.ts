import { describe, expect, test } from "vitest";
import { CliUsageError, parseGenerateOptions } from "./options.js";

describe("parseGenerateOptions", () => {
	test("no flags leaves every option to the library defaults", () => {
		expect(parseGenerateOptions({})).toEqual({});
	});

	test("maps every flag onto GenerateOptions", () => {
		expect(
			parseGenerateOptions({
				"id-strategy": "text",
				"no-snake-case": true,
				"no-check-constraints": true,
				"search-language": "simple",
				"vector-ops": "vector_l2_ops",
				"search-k1": "1.5",
				"search-b": "0",
				"max-ann-dimensions": "2000",
			}),
		).toEqual({
			idStrategy: "text",
			snakeCase: false,
			checkConstraints: false,
			searchLanguage: "simple",
			vectorOps: "vector_l2_ops",
			searchK1: 1.5,
			searchB: 0,
			maxAnnDimensions: 2000,
		});
	});

	test("a negation flag set to false is the same as omitting it", () => {
		expect(
			parseGenerateOptions({
				"no-snake-case": false,
				"no-check-constraints": false,
			}),
		).toEqual({});
	});

	test.each([
		[{ "id-strategy": "serial" }, "--id-strategy uuid"],
		[{ "search-k1": "abc" }, "--search-k1"],
		[{ "search-k1": "" }, "--search-k1"],
		[{ "search-b": "-1" }, "--search-b"],
		[{ "max-ann-dimensions": "1.5" }, "--max-ann-dimensions"],
		[{ "max-ann-dimensions": "0" }, "--max-ann-dimensions"],
		[{ "search-language": " " }, "--search-language"],
		[{ "vector-ops": "" }, "--vector-ops"],
	])("rejects %o with a message naming the flag", (values, flag) => {
		expect(() => parseGenerateOptions(values)).toThrow(CliUsageError);
		expect(() => parseGenerateOptions(values)).toThrow(flag);
	});

	test("the error carries the command so the hint names its --help", () => {
		try {
			parseGenerateOptions({ "id-strategy": "serial" }, "seed");
			expect.unreachable();
		} catch (error) {
			expect((error as CliUsageError).command).toBe("seed");
		}
	});
});
