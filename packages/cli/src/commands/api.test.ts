import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const DESCRIBE_SPEC = {
	paths: {
		"/projects": {
			get: {
				operationId: "listProjects",
				summary: "List projects",
				parameters: [
					{
						name: "limit",
						in: "query",
						schema: { type: "integer" },
						description: "Page size",
					},
					{
						name: "category",
						in: "query",
						schema: {
							type: "string",
							enum: ["SECURITY", "PERFORMANCE"],
						},
						description: "Filter by category",
					},
				],
			},
			post: {
				operationId: "createProject",
				summary: "Create project",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["project"],
								properties: {
									project: {
										type: "object",
										properties: {
											name: {
												type: "string",
												description: "The project name",
											},
											endpoints: {
												type: "array",
												items: {
													type: "object",
													required: ["type"],
													properties: {
														type: {
															type: "string",
															enum: [
																"read_write",
																"read_only",
															],
														},
													},
												},
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
	},
};

const listenSpec = async (
	spec: unknown,
): Promise<{ url: string; close: () => Promise<void> }> => {
	const server: Server = createServer((_req, res) => {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(spec));
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			}),
	};
};

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

describe("api --describe", () => {
	const describeArgs = (url: string, args: string[]) => {
		const configDir = mkdtempSync(join(tmpdir(), "neon-api-describe-"));
		return [...args, "--spec-url", url, "--config-dir", configDir];
	};

	test("prints GET query fields as JSON without calling the API", async ({
		testCliCommand,
	}) => {
		const spec = await listenSpec(DESCRIBE_SPEC);
		try {
			await testCliCommand(
				describeArgs(spec.url, ["api", "/projects", "--describe"]),
				{ output: "json", unreachableHost: true },
			);
		} finally {
			await spec.close();
		}
	});

	test("prints GET query fields as a table", async ({ testCliCommand }) => {
		const spec = await listenSpec(DESCRIBE_SPEC);
		try {
			await testCliCommand(
				describeArgs(spec.url, ["api", "/projects", "--describe"]),
				{ output: "table", unreachableHost: true },
			);
		} finally {
			await spec.close();
		}
	});

	test("prints POST body fields dotted for -F", async ({
		testCliCommand,
	}) => {
		const spec = await listenSpec(DESCRIBE_SPEC);
		try {
			await testCliCommand(
				describeArgs(spec.url, [
					"api",
					"/projects",
					"-X",
					"POST",
					"--describe",
				]),
				{ output: "json", unreachableHost: true },
			);
		} finally {
			await spec.close();
		}
	});

	test("prints POST array item fields in the table type column", async ({
		testCliCommand,
	}) => {
		const spec = await listenSpec(DESCRIBE_SPEC);
		try {
			await testCliCommand(
				describeArgs(spec.url, [
					"api",
					"/projects",
					"-X",
					"POST",
					"--describe",
				]),
				{ output: "table", unreachableHost: true },
			);
		} finally {
			await spec.close();
		}
	});

	test("rejects --describe without a path", async ({ testCliCommand }) => {
		const spec = await listenSpec(DESCRIBE_SPEC);
		try {
			await testCliCommand(
				describeArgs(spec.url, ["api", "--describe"]),
				{
					code: 1,
					unreachableHost: true,
					stderr: "ERROR: Missing API path. Usage: neon api <path> --describe (e.g. neon api /projects --describe). Run `neon api --list` to see available routes.",
				},
			);
		} finally {
			await spec.close();
		}
	});

	test("rejects --list and --describe together", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["api", "--list", "--describe"], {
			code: 1,
			unreachableHost: true,
			stderr: "ERROR: Pass either --list or --describe, not both.",
		});
	});

	test("rejects api ls --describe", async ({ testCliCommand }) => {
		await testCliCommand(["api", "ls", "--describe"], {
			code: 1,
			unreachableHost: true,
			stderr: "ERROR: Pass either --list or --describe, not both.",
		});
	});

	test("rejects an unknown path", async ({ testCliCommand }) => {
		const spec = await listenSpec(DESCRIBE_SPEC);
		try {
			await testCliCommand(
				describeArgs(spec.url, ["api", "/nope", "--describe"]),
				{
					code: 1,
					unreachableHost: true,
					stderr: 'ERROR: No route matches "/nope". Run `neon api --list` to see available routes.',
				},
			);
		} finally {
			await spec.close();
		}
	});

	test("rejects request flags with --describe", async ({
		testCliCommand,
	}) => {
		const spec = await listenSpec(DESCRIBE_SPEC);
		try {
			await testCliCommand(
				describeArgs(spec.url, [
					"api",
					"/projects",
					"--describe",
					"-F",
					"project.name=x",
				]),
				{
					code: 1,
					unreachableHost: true,
					stderr: "ERROR: --describe prints the field list; it does not send a request. Drop -F, -f, -d, -Q, -H, and -i.",
				},
			);
		} finally {
			await spec.close();
		}
	});
});
