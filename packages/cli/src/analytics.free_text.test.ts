import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect } from "vitest";

import { test } from "./test_utils/fixtures.js";

type TrackEvent = {
	type: string;
	event?: string;
	properties?: Record<string, unknown>;
};

const FREE_TEXT_WORDS = ["jane.doe@example.com", "orchid", "zephyr"];

const withLocalServices = async (
	run: (url: string, events: TrackEvent[]) => Promise<void>,
) => {
	const events: TrackEvent[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		req.on("end", () => {
			res.setHeader("Content-Type", "application/json");
			if (req.url === "/v1/batch") {
				const { batch } = JSON.parse(body) as { batch: TrackEvent[] };
				events.push(...batch);
				res.end("{}");
			} else if (req.url === "/ask") {
				res.end(JSON.stringify({ text: "An answer." }));
			} else if (req.url === "/search") {
				res.end(JSON.stringify({ hits: [] }));
			} else {
				res.statusCode = 404;
				res.end(JSON.stringify({ message: "Not Found" }));
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	try {
		await run(`http://127.0.0.1:${port}`, events);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	}
};

const tracked = (events: TrackEvent[]) =>
	events.filter((e) => e.type === "track");

const expectNoFreeText = (events: TrackEvent[]) => {
	const sent = JSON.stringify(events);
	for (const word of FREE_TEXT_WORDS) {
		expect(sent).not.toContain(word);
	}
};

describe("CLI telemetry and free text", () => {
	test("ask sends the command path, not the question", async ({
		testCliCommand,
	}) => {
		await withLocalServices(async (url, events) => {
			await testCliCommand(
				[
					"ask",
					"--prompt",
					"My email is jane.doe@example.com, why does orchid fail on zephyr?",
				],
				{
					analyticsCollector: url,
					output: "json",
					snapshot: false,
					env: { CI: "1", NEON_ASK_URL: `${url}/ask` },
				},
			);
			expect(
				tracked(events).map((e) => [e.event, e.properties?.command]),
			).toEqual([
				["CLI Started", "ask"],
				["cli_command_success", "ask"],
			]);
			expectNoFreeText(events);
		});
	});

	test("docs search sends the command path, not the query", async ({
		testCliCommand,
	}) => {
		await withLocalServices(async (url, events) => {
			await testCliCommand(["docs", "search", "orchid zephyr"], {
				analyticsCollector: url,
				output: "json",
				snapshot: false,
				env: { CI: "1", NEON_SITE_SEARCH_URL: `${url}/search` },
			});
			expect(
				tracked(events).map((e) => [e.event, e.properties?.command]),
			).toEqual([
				["CLI Started", "docs search"],
				["cli_command_success", "docs search"],
			]);
			expectNoFreeText(events);
		});
	});

	for (const { name, args, message, errCode } of [
		{
			name: "an unquoted question",
			args: ["ask", "--prompt", "why", "orchid", "zephyr"],
			message: "Unknown commands: <redacted invalid value>",
			errCode: "UNKNOWN_ERROR",
		},
		{
			name: "a word with a line break",
			args: ["ask", "--prompt", "why", "orchid\nzephyr"],
			message: "Unknown command: <redacted invalid value>",
			errCode: "UNKNOWN_ERROR",
		},
		{
			name: "an extra api path",
			args: ["api", "get", "/projects/orchid-zephyr"],
			message: "Unknown command: <redacted invalid value>",
			errCode: "UNKNOWN_COMMAND",
		},
	]) {
		test(`CLI Error leaves out the words of ${name}`, async ({
			testCliCommand,
		}) => {
			await withLocalServices(async (url, events) => {
				const { stderr } = await testCliCommand(args, {
					analyticsCollector: url,
					code: 1,
					snapshot: false,
					env: { CI: "1", NEON_ASK_URL: `${url}/ask` },
				});
				expect(stderr).toContain("orchid");
				const errors = tracked(events);
				expect(errors).toHaveLength(1);
				expect(errors[0]).toMatchObject({
					event: "CLI Error",
					properties: { message, errCode },
				});
				expect(errors[0]?.properties?.stack).toMatch(
					new RegExp(`^Error: ${message}\\n {4}at `),
				);
				expectNoFreeText(events);
			});
		});
	}

	for (const args of [
		["projects", "list"],
		["project", "list"],
	]) {
		test(`${args.join(" ")} keeps its command value`, async ({
			testCliCommand,
		}) => {
			await withLocalServices(async (url, events) => {
				await testCliCommand(args, {
					analyticsCollector: url,
					snapshot: false,
					env: { CI: "1" },
				});
				expect(
					tracked(events).map((e) => [
						e.event,
						e.properties?.command,
					]),
				).toEqual([
					["CLI Started", args.join(" ")],
					["cli_command_success", args.join(" ")],
				]);
			});
		});
	}
});
