import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect } from "vitest";
import YAML from "yaml";
import { stripAnsi } from "../human_table.js";
import pkg from "../pkg.js";
import { test } from "../test_utils/fixtures.js";
import {
	DEFAULT_SITE_SEARCH_URL,
	formatSearchResults,
	resolveSiteSearchUrl,
	siteSearchHeaders,
} from "./docs.js";

const DOCS_ENV = { CI: "1" };

const HIT = {
	url: "https://neon.com/docs/reference/glossary",
	title: "Glossary",
	slug: "docs/reference/glossary",
	collection: "docs",
	category: "docs",
	breadcrumb: ["Docs"],
	heading: "Glossary > LSN",
	excerpt:
		"Log Sequence Number. A byte offset to a location in the WAL stream.",
	score: 1.2,
};

type Seen = { authorization: string | undefined; body: unknown };

async function withSearchServer(
	handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void,
	run: (url: string) => Promise<void>,
): Promise<void> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			handler(req, res, raw.trim() === "" ? undefined : JSON.parse(raw));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	try {
		await run(`http://127.0.0.1:${port}/site-search`);
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	}
}

const respond =
	(status: number, body: unknown, seen?: Seen[]) =>
	(req: IncomingMessage, res: ServerResponse, requestBody: unknown) => {
		seen?.push({
			authorization: req.headers.authorization,
			body: requestBody,
		});
		res.statusCode = status;
		res.setHeader("Content-Type", "application/json");
		res.end(typeof body === "string" ? body : JSON.stringify(body));
	};

describe("resolveSiteSearchUrl", () => {
	test("uses the hosted site search by default", () => {
		expect(resolveSiteSearchUrl({})).toBe(DEFAULT_SITE_SEARCH_URL);
		expect(DEFAULT_SITE_SEARCH_URL).toMatch(/\/site-search$/);
	});

	test("prefers --url over NEON_SITE_SEARCH_URL", () => {
		expect(
			resolveSiteSearchUrl({
				url: " http://127.0.0.1:9/site-search ",
				envUrl: "https://example.test/site-search",
			}),
		).toBe("http://127.0.0.1:9/site-search");
	});
});

describe("formatSearchResults", () => {
	const hit = {
		title: "Automate branching with CircleCI",
		url: "https://neon.com/docs/guides/branching-circleci",
		category: "docs",
		breadcrumb: ["Docs"],
		heading:
			"Automate branching with CircleCI > Available commands > Example: Resetting a long-lived branch",
		excerpt: "",
	};
	const plain = (width: number | undefined) =>
		stripAnsi(
			formatSearchResults([hit, hit], { emptyMessage: "none", width }),
		);

	test("puts title and section on one line and the url under it", () => {
		expect(plain(undefined)).toBe(
			"Automate branching with CircleCI › Available commands › Example: Resetting a long-lived branch\n" +
				"  https://neon.com/docs/guides/branching-circleci\n" +
				"\n" +
				"Automate branching with CircleCI › Available commands › Example: Resetting a long-lived branch\n" +
				"  https://neon.com/docs/guides/branching-circleci\n",
		);
	});

	test("cuts the title line to the width and keeps the url whole", () => {
		const [title, url] = plain(40).split("\n");
		expect(title).toBe("Automate branching with CircleCI › Av...");
		expect(url).toBe("  https://neon.com/docs/guides/branching-circleci");
	});

	test("prints the empty message when nothing matched", () => {
		expect(
			formatSearchResults([], { emptyMessage: "No results.", width: 80 }),
		).toBe("\nNo results.\n");
	});
});

describe("neon docs search", () => {
	test("prints title, matched section, and url without logging in", async ({
		testCliCommand,
	}) => {
		const seen: Seen[] = [];
		await withSearchServer(
			respond(200, { hits: [HIT] }, seen),
			async (url) => {
				const { stdout, stderr } = await testCliCommand(
					["docs", "search", "lsn", "--url", url],
					{
						apiKey: false,
						outputTable: true,
						snapshot: false,
						env: DOCS_ENV,
					},
				);
				expect(stdout).toBe(
					"Glossary › LSN\n  https://neon.com/docs/reference/glossary\n",
				);
				expect(stderr).not.toMatch(/auth/i);
			},
		);
		expect(seen).toEqual([
			{ authorization: undefined, body: { query: "lsn", limit: 10 } },
		]);
	});

	test("ignores a broken credential and sends no Authorization header", async ({
		testCliCommand,
	}) => {
		const seen: Seen[] = [];
		await withSearchServer(
			respond(200, { hits: [HIT] }, seen),
			async (url) => {
				await testCliCommand(["docs", "search", "lsn", "--url", url], {
					apiKey: "not-a-real-key",
					output: "json",
					snapshot: false,
					env: DOCS_ENV,
				});
			},
		);
		expect(seen.map((request) => request.authorization)).toEqual([
			undefined,
		]);
	});

	test("prints json hits without internal fields", async ({
		testCliCommand,
	}) => {
		await withSearchServer(respond(200, { hits: [HIT] }), async (url) => {
			const { stdout } = await testCliCommand(
				["docs", "search", "lsn", "--url", url],
				{
					apiKey: false,
					output: "json",
					snapshot: false,
					env: DOCS_ENV,
				},
			);
			expect(JSON.parse(stdout)).toEqual([
				{
					title: "Glossary",
					url: "https://neon.com/docs/reference/glossary",
					category: "docs",
					breadcrumb: ["Docs"],
					heading: "Glossary > LSN",
					excerpt:
						"Log Sequence Number. A byte offset to a location in the WAL stream.",
				},
			]);
		});
	});

	test("prints the same shape as yaml", async ({ testCliCommand }) => {
		await withSearchServer(respond(200, { hits: [HIT] }), async (url) => {
			const { stdout } = await testCliCommand(
				["docs", "search", "lsn", "--url", url],
				{
					apiKey: false,
					output: "yaml",
					snapshot: false,
					env: DOCS_ENV,
				},
			);
			expect(YAML.parse(stdout)).toEqual([
				expect.objectContaining({
					title: "Glossary",
					category: "docs",
				}),
			]);
		});
	});

	test("sends repeated categories once each and the limit", async ({
		testCliCommand,
	}) => {
		const seen: Seen[] = [];
		await withSearchServer(
			respond(200, { hits: [] }, seen),
			async (url) => {
				await testCliCommand(
					[
						"docs",
						"search",
						"create branch",
						"--category",
						"api",
						"--category",
						"docs",
						"--category",
						"api",
						"--limit",
						"3",
						"--url",
						url,
					],
					{
						apiKey: false,
						output: "json",
						snapshot: false,
						env: DOCS_ENV,
					},
				);
			},
		);
		expect(seen.map((request) => request.body)).toEqual([
			{ query: "create branch", limit: 3, categories: ["api", "docs"] },
		]);
	});

	test("says when nothing matched", async ({ testCliCommand }) => {
		await withSearchServer(respond(200, { hits: [] }), async (url) => {
			const table = await testCliCommand(
				["docs", "search", "zzqxvbnmw", "--url", url],
				{
					apiKey: false,
					outputTable: true,
					snapshot: false,
					env: DOCS_ENV,
				},
			);
			expect(table.stdout).toContain('No results for "zzqxvbnmw".');
			const json = await testCliCommand(
				["docs", "search", "zzqxvbnmw", "--url", url],
				{
					apiKey: false,
					output: "json",
					snapshot: false,
					env: DOCS_ENV,
				},
			);
			expect(JSON.parse(json.stdout)).toEqual([]);
		});
	});

	test("uses NEON_SITE_SEARCH_URL when --url is omitted", async ({
		testCliCommand,
	}) => {
		await withSearchServer(respond(200, { hits: [HIT] }), async (url) => {
			const { stdout } = await testCliCommand(["docs", "search", "lsn"], {
				apiKey: false,
				output: "json",
				snapshot: false,
				env: { ...DOCS_ENV, NEON_SITE_SEARCH_URL: url },
			});
			expect(JSON.parse(stdout)).toHaveLength(1);
		});
	});

	test("prints the server message on a 4xx", async ({ testCliCommand }) => {
		await withSearchServer(
			respond(400, { error: "query must be 500 characters or fewer" }),
			async (url) => {
				const { stdout, stderr } = await testCliCommand(
					["docs", "search", "lsn", "--url", url],
					{
						apiKey: false,
						outputTable: true,
						snapshot: false,
						code: 1,
						env: DOCS_ENV,
					},
				);
				expect(stdout).toBe("");
				expect(stderr).toMatch(/query must be 500 characters or fewer/);
			},
		);
	});

	test("reports the status on a 5xx", async ({ testCliCommand }) => {
		await withSearchServer(
			respond(500, { error: "Site search failed." }),
			async (url) => {
				const { stderr } = await testCliCommand(
					["docs", "search", "lsn", "--url", url],
					{
						apiKey: false,
						outputTable: true,
						snapshot: false,
						code: 1,
						env: DOCS_ENV,
					},
				);
				expect(stderr).toMatch(/Neon site search failed \(HTTP 500\)/);
			},
		);
	});

	test("fails on a response that is not a hit list", async ({
		testCliCommand,
	}) => {
		for (const body of [
			"<html>",
			{ hits: [null] },
			{ hits: [{ ...HIT, breadcrumb: "Docs" }] },
		]) {
			await withSearchServer(respond(200, body), async (url) => {
				const { stderr } = await testCliCommand(
					["docs", "search", "lsn", "--url", url],
					{
						apiKey: false,
						outputTable: true,
						snapshot: false,
						code: 1,
						env: DOCS_ENV,
					},
				);
				expect(stderr).toMatch(/unexpected response/);
			});
		}
	});

	test("explains an unreachable service", async ({ testCliCommand }) => {
		const { stderr } = await testCliCommand(
			[
				"docs",
				"search",
				"lsn",
				"--url",
				"http://127.0.0.1:1/site-search",
			],
			{
				apiKey: false,
				outputTable: true,
				snapshot: false,
				code: 1,
				env: DOCS_ENV,
			},
		);
		expect(stderr).toMatch(/Could not reach Neon site search/);
	});

	test("rejects invalid input before calling the service", async ({
		testCliCommand,
	}) => {
		const cases: Array<[string[], RegExp]> = [
			[["docs", "search"], /query/i],
			[["docs", "search", "   "], /<query> needs a value/],
			[["docs", "search", "x".repeat(501)], /500 characters or fewer/],
			[["docs", "search", "lsn", "extra"], /Unknown command: extra/],
			[
				["docs", "search", "lsn", "--limit", "0"],
				/--limit must be a whole number from 1 to 40/,
			],
			[
				["docs", "search", "lsn", "--limit", "41"],
				/--limit must be a whole number from 1 to 40/,
			],
			[
				["docs", "search", "lsn", "--limit", "1.5"],
				/--limit must be a whole number from 1 to 40/,
			],
			[
				["docs", "search", "lsn", "--category", "nope"],
				/Invalid values/i,
			],
		];
		for (const [args, message] of cases) {
			const { stderr } = await testCliCommand(
				[...args, "--url", "http://127.0.0.1:1/site-search"],
				{ apiKey: false, snapshot: false, code: 1, env: DOCS_ENV },
			);
			expect(stderr).toMatch(message);
		}
	});

	test("prints help for bare neon docs", async ({ testCliCommand }) => {
		const { stdout, stderr } = await testCliCommand(["docs"], {
			apiKey: false,
			snapshot: false,
			env: DOCS_ENV,
		});
		expect(`${stdout}${stderr}`).toMatch(/docs search <query>/);
	});
});

describe("siteSearchHeaders", () => {
	test("tags the CLI with its version and the coding agent", () => {
		expect(
			siteSearchHeaders({
				analytics: true,
				agent: "claude-code",
				version: "8.10.0",
			}),
		).toEqual({
			"Content-Type": "application/json",
			"User-Agent": "neon/8.10.0",
			"x-caller-source": "cli",
			"x-caller-client": "claude-code",
		});
	});

	test("omits the client without an agent and opts out without analytics", () => {
		expect(
			siteSearchHeaders({
				analytics: false,
				agent: undefined,
				version: "8.10.0",
			}),
		).toEqual({
			"Content-Type": "application/json",
			"User-Agent": "neon/8.10.0",
			"x-caller-source": "cli",
			"x-caller-analytics": "off",
		});
	});
});

describe("neon docs search caller headers", () => {
	test("sends source, version, agent, and the analytics opt-out", async ({
		testCliCommand,
	}) => {
		const seen: Array<Record<string, string | string[] | undefined>> = [];
		await withSearchServer(
			(req, res) => {
				seen.push({ ...req.headers });
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ hits: [] }));
			},
			async (url) => {
				await testCliCommand(["docs", "search", "lsn", "--url", url], {
					apiKey: false,
					output: "json",
					snapshot: false,
					env: { ...DOCS_ENV, CLAUDE_CODE_CHILD_SESSION: "1" },
				});
				await testCliCommand(["docs", "search", "lsn", "--url", url], {
					apiKey: false,
					output: "json",
					snapshot: false,
					env: DOCS_ENV,
				});
			},
		);
		expect(seen).toHaveLength(2);
		for (const headers of seen) {
			expect(headers["x-caller-source"]).toBe("cli");
			expect(headers["user-agent"]).toBe(`neon/${pkg.version}`);
			expect(headers["x-caller-analytics"]).toBe("off");
		}
		expect(seen[0]?.["x-caller-client"]).toBe("claude-code");
		expect(seen[1]?.["x-caller-client"]).toBeUndefined();
	});
});
