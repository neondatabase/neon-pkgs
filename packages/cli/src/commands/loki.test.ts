import { execFile } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

const EXPRESSION = '{service_name="neon-function/api"} |= "error & a+b=1"';
const ENVELOPE = {
	status: "success",
	warnings: [
		"results truncated: narrow the query or time range for complete results",
	],
	data: {
		resultType: "streams",
		result: [
			{
				stream: {
					service_name: "neon-function/api",
					severity_text: "ERROR",
				},
				values: [
					["1793491200123456000", "error & a+b=1\nsecond line\u001b"],
				],
			},
		],
	},
};

describe("logs loki through dist/cli.js", () => {
	let server: Server;
	let apiHost: string;
	let requests: { method?: string; url: URL; headers: IncomingHttpHeaders }[];
	let reply: { status: number; body: unknown };

	beforeEach(async () => {
		requests = [];
		reply = { status: 200, body: ENVELOPE };
		server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			requests.push({ method: req.method, url, headers: req.headers });
			res.setHeader("Content-Type", "application/json");
			if (url.pathname === "/api/v2/users/me/organizations") {
				res.end(
					JSON.stringify({ organizations: [{ id: "org-test" }] }),
				);
			} else if (url.pathname === "/api/v2/projects") {
				res.end(JSON.stringify({ projects: [{ id: "test-project" }] }));
			} else if (
				url.pathname === "/api/v2/projects/test-project/branches"
			) {
				res.end(
					JSON.stringify({
						branches: [
							{
								id: "br-main-123456",
								name: "main",
								default: true,
							},
						],
					}),
				);
			} else if (url.pathname.startsWith("/telemetry/v1/projects/")) {
				res.setHeader("Retry-After", "0");
				res.writeHead(reply.status);
				res.end(JSON.stringify(reply.body));
			} else {
				res.writeHead(404);
				res.end(
					JSON.stringify({
						message: `Unexpected route ${url.pathname}`,
					}),
				);
			}
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		apiHost = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2`;
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise<void>((done, reject) =>
			server.close((error) => (error ? reject(error) : done())),
		);
	});

	const run = async (
		args: string[],
		code = 0,
		{ command = ["logs", "loki"], authenticated = true } = {},
	) => {
		const result = await new Promise<{
			stdout: string;
			stderr: string;
			code: number;
		}>((done, reject) => {
			execFile(
				process.execPath,
				[
					resolve("dist/cli.js"),
					"--api-host",
					apiHost,
					...(authenticated ? ["--api-key", "test-loki-key"] : []),
					"--no-analytics",
					"--config-dir",
					resolve("../../tmp/loki-no-config"),
					"--context-file",
					resolve("../../tmp/loki-no-context"),
					...command,
					...args,
				],
				{
					env: {
						PATH: process.env.PATH,
						NO_UPDATE_NOTIFIER: "1",
						NO_COLOR: "1",
						CI: "true",
					},
				},
				(error, stdout, stderr) => {
					if (error && typeof error.code !== "number") {
						reject(error);
					} else {
						done({
							stdout,
							stderr,
							code:
								typeof error?.code === "number"
									? error.code
									: 0,
						});
					}
				},
			);
		});
		expect(result.code, result.stderr).toBe(code);
		return result;
	};

	it("resolves a project and default branch, then sends an authenticated range query", async () => {
		const { stdout, stderr } = await run([
			EXPRESSION,
			"--since",
			"30m",
			"--limit",
			"200",
			"--direction",
			"forward",
		]);
		expect(JSON.parse(stdout)).toEqual(ENVELOPE);
		expect(stderr).toBe("");
		expect(requests.map(({ url }) => url.pathname)).toEqual([
			"/api/v2/users/me/organizations",
			"/api/v2/projects",
			"/api/v2/projects/test-project/branches",
			"/telemetry/v1/projects/test-project/branches/br-main-123456/loki/api/v1/query_range",
		]);
		const request = requests.at(-1)!;
		expect(request.method).toBe("GET");
		expect(request.headers.authorization).toBe("Bearer test-loki-key");
		expect(request.headers["user-agent"]).toMatch(/^neonctl v/);
		expect(Object.fromEntries(request.url.searchParams)).toEqual({
			query: EXPRESSION,
			since: "30m",
			limit: "200",
			direction: "forward",
		});
	});

	it("accepts named bounds without losing nanosecond precision", async () => {
		await run([
			EXPRESSION,
			"--project-id",
			"test-project",
			"--branch",
			"br-other-branch-654321",
			"--since",
			"24h",
			"--start",
			"1793491200123456789",
			"--end",
			"1793494800123456789",
			"--limit",
			"200",
			"--direction",
			"forward",
		]);
		expect(requests).toHaveLength(1);
		expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({
			query: EXPRESSION,
			since: "24h",
			start: "1793491200123456789",
			end: "1793494800123456789",
			limit: "200",
			direction: "forward",
		});
	});

	it("collapses identical repeated named flags", async () => {
		await run([EXPRESSION, "--since", "30m", "--since", "30m"]);
		expect(requests.at(-1)?.url.searchParams.get("since")).toBe("30m");
	});

	it("resolves an explicit branch name and accepts parameters before the query", async () => {
		await run([
			"--project-id",
			"test-project",
			"--branch",
			"main",
			"--since",
			"1h",
			EXPRESSION,
		]);
		expect(requests.at(-1)?.url.searchParams.get("query")).toBe(EXPRESSION);
		expect(requests.at(-1)?.url.pathname).toContain(
			"/branches/br-main-123456/",
		);
	});

	it.each([
		"labels",
		"label/service_name/values",
	])("calls %s without requiring a query and preserves the YAML envelope", async (endpoint) => {
		reply.body = {
			status: "success",
			data: ["neon-function/api"],
			warnings: ["truncated"],
		};
		const { stdout } = await run([
			"--project-id",
			"test-project",
			"--endpoint",
			endpoint,
			"--output",
			"yaml",
		]);
		expect(YAML.parse(stdout)).toEqual(reply.body);
		expect(requests.at(-1)?.url.pathname).toBe(
			`/telemetry/v1/projects/test-project/branches/br-main-123456/loki/api/v1/${endpoint}`,
		);
	});

	it("passes a selector when discovering label values", async () => {
		await run([
			"--project-id",
			"test-project",
			"--endpoint",
			"label/severity_text/values",
			'{service_name="neon-function/api"}',
			"--since",
			"6h",
		]);
		expect(Object.fromEntries(requests.at(-1)!.url.searchParams)).toEqual({
			query: '{service_name="neon-function/api"}',
			since: "6h",
		});
	});

	it.each([
		"json",
		"yaml",
	])("returns the complete Loki envelope with --output %s", async (output) => {
		const { stdout } = await run([
			EXPRESSION,
			"--project-id",
			"test-project",
			"--output",
			output,
		]);
		expect(
			output === "yaml" ? YAML.parse(stdout) : JSON.parse(stdout),
		).toEqual(ENVELOPE);
	});

	it.each([
		[[], "Pass a LogQL query"],
		[[EXPRESSION, "-f", "limit=10"], "Unknown argument"],
		[
			["--endpoint", "labels", "--limit", "10"],
			"--limit applies only to --endpoint query_range",
		],
		[
			[
				"--endpoint",
				"label/service_name/values",
				"--direction",
				"forward",
			],
			"--direction applies only to --endpoint query_range",
		],
		[
			[
				EXPRESSION,
				"--project-id",
				"..",
				"--branch",
				"br-other-branch-654321",
			],
			'Path parameter project_id cannot be ".."',
		],
		[[EXPRESSION, "--endpoint", "../../projects"], "--endpoint must be"],
		[[EXPRESSION, "--endpoint", "query"], "--endpoint must be"],
		[
			[EXPRESSION, "--endpoint", "https://example.com"],
			"--endpoint must be",
		],
		[[EXPRESSION, "--bogus"], "Unknown argument: bogus"],
		[[EXPRESSION, "--limit", "0"], "--limit must be a positive integer"],
		[[EXPRESSION, "--limit", "1.5"], "--limit must be a positive integer"],
		[[EXPRESSION, "--limit", "nope"], "--limit must be a positive integer"],
		[[EXPRESSION, "--direction", "asc"], "Invalid values"],
		[[EXPRESSION, "--output", "table"], "--output must be json or yaml"],
		[
			[EXPRESSION, "--since", "30m", "--since", "1h"],
			"--since was given more than once",
		],
		[
			[EXPRESSION, "--", "--project-id", "other"],
			"takes no arguments after",
		],
	])("rejects invalid arguments %j before any request", async (args, message) => {
		const { stdout, stderr } = await run(args, 1);
		expect(stdout).toBe("");
		expect(stderr).toContain(message);
		expect(requests).toEqual([]);
	});

	it("shows the endpoint choices and supported subset in help without authentication", async () => {
		const { stdout, stderr } = await run(["--help"], 0, {
			authenticated: false,
		});
		expect(stdout).toContain("neon logs loki [query]");
		expect(stdout).toContain("label/<name>/values");
		expect(stdout).toContain("--since");
		expect(stdout).toContain("--start");
		expect(stdout).toContain("--end");
		expect(stdout).toContain("--limit");
		expect(stdout).toContain("--direction");
		expect(stdout.replace(/\s+/g, " ")).toContain('"forward", "backward"');
		expect(stdout).toContain("--output");
		expect(stdout).toContain("nanoseconds");
		expect(stdout).toContain("warnings");
		expect(stdout).toContain("no continuation cursor");
		expect(stdout).toContain(
			"metric queries, parser stages and live tailing are unsupported",
		);
		expect(stderr).toBe("");
		expect(requests).toEqual([]);
	});

	it("makes Loki discoverable from root and logs help without authentication", async () => {
		const options = { authenticated: false };
		const { stdout: root } = await run(["--help"], 0, {
			...options,
			command: [],
		});
		expect(root).toContain("neon logs");
		expect(root).toContain("Loki API");
		expect(root).not.toMatch(/^neon loki/m);
		const { stdout: parent } = await run(["--help"], 0, {
			...options,
			command: ["logs"],
		});
		expect(parent).toContain("neon logs loki [query]");
		expect(parent).toContain("neon logs query");
		const { stdout: bare } = await run([], 0, {
			...options,
			command: ["logs"],
		});
		expect(bare).toBe(parent);
		const { stdout: query } = await run(["--help"], 0, {
			...options,
			command: ["logs", "query"],
		});
		expect(query).toContain("neon logs loki");
		expect(requests).toEqual([]);
	});

	it("includes loki in logs shell completion without authentication", async () => {
		const { stdout } = await run(
			["--get-yargs-completions", "neon", "logs", ""],
			0,
			{ command: [], authenticated: false },
		);
		expect(stdout.split("\n")).toEqual(
			expect.arrayContaining(["query", "fields", "field-values", "loki"]),
		);
		expect(requests).toEqual([]);
	});

	it.each([
		[400, "logql: unsupported pipeline stage"],
		[404, "telemetry is not available for this project"],
		[429, "rate limit exceeded"],
		[502, "query backend error"],
	])("surfaces a Loki %i error and exits nonzero", async (status, error) => {
		reply = { status, body: { status: "error", error } };
		const { stdout, stderr } = await run(
			[EXPRESSION, "--project-id", "test-project"],
			1,
		);
		expect(stdout).toBe("");
		expect(stderr).toContain(`ERROR: ${error}`);
	});
});
