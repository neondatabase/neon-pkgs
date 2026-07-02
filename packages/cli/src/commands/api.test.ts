import { describe, expect, it } from "vitest";

import { test } from "../test_utils/fixtures";
import {
	buildBody,
	buildQuery,
	parseHeaders,
	parseKeyValue,
	parseTypedValue,
	setDeep,
} from "./api";

describe("api arg mapping", () => {
	it("types scalar and JSON values", () => {
		expect(parseTypedValue("true")).toBe(true);
		expect(parseTypedValue("false")).toBe(false);
		expect(parseTypedValue("null")).toBeNull();
		expect(parseTypedValue("42")).toBe(42);
		expect(parseTypedValue("-3.14")).toBeCloseTo(-3.14);
		expect(parseTypedValue("hello")).toBe("hello");
		expect(parseTypedValue('["a","b"]')).toEqual(["a", "b"]);
		expect(parseTypedValue('{"a":1}')).toEqual({ a: 1 });
		// Invalid JSON falls back to the literal string.
		expect(parseTypedValue("{oops")).toBe("{oops");
	});

	it("splits key=value on the first '='", () => {
		expect(parseKeyValue("a=b=c")).toEqual({ key: "a", value: "b=c" });
		expect(() => parseKeyValue("noequals")).toThrow(/key=value/);
	});

	it("assigns nested values by dot-path", () => {
		const target: Record<string, unknown> = {};
		setDeep(target, "branch.name", "dev");
		setDeep(target, "branch.protected", true);
		expect(target).toEqual({ branch: { name: "dev", protected: true } });
	});

	it("builds a typed body from -F and a raw body from -f", () => {
		expect(
			buildBody(
				["branch.name=dev", "endpoints=[]", "count=2"],
				["label=42"],
			),
		).toEqual({
			branch: { name: "dev" },
			endpoints: [],
			count: 2,
			label: "42",
		});
	});

	it("builds a query map", () => {
		expect(buildQuery(["limit=10", "search=foo"])).toEqual({
			limit: "10",
			search: "foo",
		});
	});

	it("parses headers on the first ':'", () => {
		expect(parseHeaders(["X-Trace: abc:def"])).toEqual({
			"X-Trace": "abc:def",
		});
		expect(() => parseHeaders(["bad-header"])).toThrow(/key:value/);
	});
});

describe("api command (e2e passthrough)", () => {
	// Maps -Q pairs to the query string; the mock asserts limit=100 is forwarded.
	test("GET with query params", async ({ testCliCommand }) => {
		await testCliCommand(["api", "/projects", "-Q", "limit=100"], {
			output: "json",
		});
	});

	// Path passthrough to a nested resource returns the raw JSON body.
	test("GET single resource by path", async ({ testCliCommand }) => {
		await testCliCommand(["api", "/projects/test"], { output: "json" });
	});

	// -X selects the method and -F builds the (dot-nested) JSON body; the mock
	// asserts { project: { name: "test_project" } } is received.
	test("POST with -F body fields", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"api",
				"/projects",
				"-X",
				"POST",
				"-F",
				"project.name=test_project",
			],
			{ output: "json" },
		);
	});

	test("rejects paths without a leading slash", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["api", "projects"], {
			code: 1,
			stderr: 'ERROR: Invalid path "projects". API paths must start with "/". Run `neon api --list` to see available routes.',
		});
	});
});
