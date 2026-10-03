import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect } from "vitest";

import { test } from "../test_utils/fixtures.js";
import {
	DEFAULT_FEEDBACK_URL,
	MAX_FEEDBACK_LENGTH,
	resolveFeedbackUrl,
} from "./feedback.js";

const FEEDBACK_ENV = { CI: "1" };

async function withFeedbackServer(
	handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void,
	run: (url: string) => Promise<void>,
): Promise<void> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			handler(req, res, raw === "" ? undefined : JSON.parse(raw));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	try {
		await run(`http://127.0.0.1:${port}/`);
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	}
}

const respond =
	(status: number, body?: unknown) =>
	(_req: IncomingMessage, res: ServerResponse) => {
		res.statusCode = status;
		if (body === undefined) {
			res.end();
			return;
		}
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify(body));
	};

describe("resolveFeedbackUrl", () => {
	test("uses the hosted feedback service by default", () => {
		expect(resolveFeedbackUrl({})).toBe(DEFAULT_FEEDBACK_URL);
		expect(DEFAULT_FEEDBACK_URL).toBe("https://feedback.neon.tech/");
	});

	test("prefers --url over NEON_FEEDBACK_URL", () => {
		expect(
			resolveFeedbackUrl({
				url: " http://127.0.0.1:9/ ",
				envUrl: "https://example.test/",
			}),
		).toBe("http://127.0.0.1:9/");
	});

	test("uses NEON_FEEDBACK_URL when --url is omitted", () => {
		expect(resolveFeedbackUrl({ envUrl: " https://example.test/ " })).toBe(
			"https://example.test/",
		);
	});
});

describe("neon feedback", () => {
	test("sends only the message and source, without logging in", async ({
		testCliCommand,
	}) => {
		const seen: unknown[] = [];
		await withFeedbackServer(
			(req, res, body) => {
				seen.push({
					method: req.method,
					contentType: req.headers["content-type"],
					authorization: req.headers.authorization,
					body,
				});
				respond(204)(req, res);
			},
			async (url) => {
				const { stdout, stderr } = await testCliCommand(
					[
						"feedback",
						"--message",
						"  The branch docs were unclear  ",
						"--url",
						url,
					],
					{
						apiKey: false,
						outputTable: true,
						snapshot: false,
						env: FEEDBACK_ENV,
					},
				);
				expect(stdout).toBe("Feedback received. Thank you!\n");
				expect(stderr).not.toMatch(/Cannot run interactive auth in CI/);
			},
		);
		expect(seen).toEqual([
			{
				method: "POST",
				contentType: "application/json",
				authorization: undefined,
				body: {
					feedback: "The branch docs were unclear",
					source: "neon_cli",
				},
			},
		]);
	});

	test("prints json as { received: true }", async ({ testCliCommand }) => {
		await withFeedbackServer(respond(204), async (url) => {
			const { stdout } = await testCliCommand(
				["feedback", "--message", "Great CLI", "--url", url],
				{
					apiKey: false,
					output: "json",
					snapshot: false,
					env: FEEDBACK_ENV,
				},
			);
			expect(JSON.parse(stdout)).toEqual({ received: true });
		});
	});

	test("uses NEON_FEEDBACK_URL when --url is omitted", async ({
		testCliCommand,
	}) => {
		let hits = 0;
		await withFeedbackServer(
			(req, res) => {
				hits += 1;
				respond(204)(req, res);
			},
			async (url) => {
				await testCliCommand(["feedback", "--message", "Great CLI"], {
					apiKey: false,
					outputTable: true,
					snapshot: false,
					env: { ...FEEDBACK_ENV, NEON_FEEDBACK_URL: url },
				});
			},
		);
		expect(hits).toBe(1);
	});

	test("prints the server error on 4xx", async ({ testCliCommand }) => {
		await withFeedbackServer(
			respond(400, { error: "feedback is required" }),
			async (url) => {
				const { stdout, stderr } = await testCliCommand(
					["feedback", "--message", "hello", "--url", url],
					{
						apiKey: false,
						outputTable: true,
						snapshot: false,
						code: 1,
						env: FEEDBACK_ENV,
					},
				);
				expect(stdout).toBe("");
				expect(stderr).toMatch(/feedback is required/);
			},
		);
	});

	test("explains a rate limit", async ({ testCliCommand }) => {
		await withFeedbackServer(
			respond(429, { error: "Too many requests" }),
			async (url) => {
				const { stderr } = await testCliCommand(
					["feedback", "--message", "hello", "--url", url],
					{
						apiKey: false,
						outputTable: true,
						snapshot: false,
						code: 1,
						env: FEEDBACK_ENV,
					},
				);
				expect(stderr).toMatch(/Wait a minute and try again/);
			},
		);
	});

	test("falls back to the status on a 5xx without a body", async ({
		testCliCommand,
	}) => {
		await withFeedbackServer(respond(503), async (url) => {
			const { stderr } = await testCliCommand(
				["feedback", "--message", "hello", "--url", url],
				{
					apiKey: false,
					outputTable: true,
					snapshot: false,
					code: 1,
					env: FEEDBACK_ENV,
				},
			);
			expect(stderr).toMatch(/feedback service returned 503/);
		});
	});

	test("explains an unreachable service", async ({ testCliCommand }) => {
		const { stderr } = await testCliCommand(
			["feedback", "--message", "hello", "--url", "http://127.0.0.1:1/"],
			{
				apiKey: false,
				outputTable: true,
				snapshot: false,
				code: 1,
				env: FEEDBACK_ENV,
			},
		);
		expect(stderr).toMatch(/Could not reach the Neon feedback service/);
	});

	test("fails without --message", async ({ testCliCommand }) => {
		const { stdout, stderr } = await testCliCommand(["feedback"], {
			apiKey: false,
			snapshot: false,
			code: 1,
			env: FEEDBACK_ENV,
		});
		expect(stdout).toBe("");
		expect(stderr).toMatch(/message/i);
	});

	test("fails on a blank --message", async ({ testCliCommand }) => {
		const { stderr } = await testCliCommand(
			["feedback", "--message", "   "],
			{ apiKey: false, snapshot: false, code: 1, env: FEEDBACK_ENV },
		);
		expect(stderr).toMatch(/--message needs a value/);
	});

	test("rejects a message over the length limit", async ({
		testCliCommand,
	}) => {
		const { stderr } = await testCliCommand(
			["feedback", "--message", "x".repeat(MAX_FEEDBACK_LENGTH + 1)],
			{ apiKey: false, snapshot: false, code: 1, env: FEEDBACK_ENV },
		);
		expect(stderr).toMatch(/10,000 characters or fewer/);
	});

	test("help lists --message and not the hidden URL", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(["feedback", "--help"], {
			apiKey: false,
			snapshot: false,
			env: FEEDBACK_ENV,
		});
		expect(stdout).toMatch(/--message/);
		expect(stdout).not.toMatch(/--url/);
	});
});
