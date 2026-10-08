import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { Analytics } from "@segment/analytics-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "./pkg.js";

// Drives the real Sentry client against a local collector standing in for sentry.io.

type SentryEvent = {
	release?: string;
	environment?: string;
	server_name?: string;
	tags?: Record<string, string>;
	exception?: {
		values?: {
			type?: string;
			value?: string;
			stacktrace?: {
				frames?: { filename?: string; abs_path?: string }[];
			};
		}[];
	};
};

const listen = async (
	handler: (req: IncomingMessage, res: ServerResponse) => void,
) => {
	const server: Server = createServer(handler);
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	return {
		port: (server.address() as AddressInfo).port,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
};

const readBody = (req: IncomingMessage) =>
	new Promise<string>((resolve) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => resolve(body));
	});

const eventsFromEnvelope = (body: string): SentryEvent[] => {
	const lines = body.split("\n").filter((line) => line.length > 0);
	const events: SentryEvent[] = [];
	for (let i = 1; i < lines.length; i += 2) {
		const header = JSON.parse(lines[i] ?? "{}") as { type?: string };
		if (header.type === "event") {
			events.push(JSON.parse(lines[i + 1] ?? "{}") as SentryEvent);
		}
	}
	return events;
};

let events: SentryEvent[];
let stallEnvelopes: boolean;
let collector: Awaited<ReturnType<typeof listen>>;

beforeEach(async () => {
	vi.resetModules();
	events = [];
	stallEnvelopes = false;
	collector = await listen(async (req, res) => {
		const body = await readBody(req);
		if (req.url?.startsWith("/api/1/envelope/")) {
			if (stallEnvelopes) {
				return;
			}
			events.push(...eventsFromEnvelope(body));
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	});
});

afterEach(async () => {
	await collector.close();
});

const setup = async () => {
	const analytics = await import("./analytics.js");
	const errorReporting = await import("./error_reporting.js");
	errorReporting.useErrorReportingDsnForTests(
		`http://public@127.0.0.1:${collector.port}/1`,
	);
	analytics.useAnalyticsClientForTests(
		new Analytics({
			writeKey: "test",
			host: `http://127.0.0.1:${collector.port}`,
		}),
	);
	return analytics;
};

describe("packageRelativePath", () => {
	it.each([
		[
			"/Users/someone/.npm/_npx/abc/node_modules/neon/dist/index.js",
			"neon/dist/index.js",
		],
		[
			"file:///home/someone/app/node_modules/.pnpm/yargs@18.0.0/node_modules/yargs/build/lib/yargs.js",
			"yargs/build/lib/yargs.js",
		],
		[
			"C:\\Users\\someone\\AppData\\npm\\node_modules\\neon\\dist\\cli.js",
			"neon/dist/cli.js",
		],
		["/home/someone/neon-pkgs/packages/cli/dist/index.js", "index.js"],
		[
			"node:internal/process/task_queues",
			"node:internal/process/task_queues",
		],
	])("%s -> %s", async (input, expected) => {
		const { packageRelativePath } = await import("./error_reporting.js");
		expect(packageRelativePath(input)).toBe(expected);
	});
});

describe("error reporting", () => {
	it("reports a TypeError with the release, redacted text, and no local paths", async () => {
		const analytics = await setup();

		analytics.sendError(
			new TypeError(
				"Cannot read properties of undefined (reading 'nak_live_0123abcd')",
			),
			"UNKNOWN_ERROR",
		);
		await analytics.closeAnalytics();

		expect(events).toHaveLength(1);
		const [event] = events;
		expect(event?.release).toBe(`neon@${pkg.version}`);
		expect(event?.environment).toBe("production");
		expect(event?.server_name).toBeUndefined();
		const [exception] = event?.exception?.values ?? [];
		expect(exception?.type).toBe("TypeError");
		expect(exception?.value).toBe(
			"Cannot read properties of undefined (reading 'nak_live_<redacted>')",
		);
		const frames = exception?.stacktrace?.frames ?? [];
		expect(frames.length).toBeGreaterThan(0);
		for (const frame of frames) {
			expect(frame.filename).not.toContain(homedir());
			expect(frame.abs_path ?? "").not.toContain(homedir());
		}
		expect(Object.keys(event?.tags ?? {}).sort()).toEqual(["agent", "ci"]);
	});

	it("omits a message that can carry user input", async () => {
		const analytics = await setup();
		let parseError: unknown;
		try {
			JSON.parse("private-token-123");
		} catch (err) {
			parseError = err;
		}
		if (!(parseError instanceof SyntaxError)) {
			throw new Error("JSON.parse did not throw a SyntaxError");
		}

		analytics.sendError(parseError, "UNKNOWN_ERROR");
		await analytics.closeAnalytics();

		const [exception] = events[0]?.exception?.values ?? [];
		expect(exception?.type).toBe("SyntaxError");
		expect(exception?.value).toBe("(message omitted)");
		expect(JSON.stringify(events)).not.toContain("private-token-123");
	});

	it("keeps a multiline message out of the stack frames", async () => {
		const analytics = await setup();
		let parseError: unknown;
		try {
			JSON.parse("X\nat secret123");
		} catch (err) {
			parseError = err;
		}
		if (!(parseError instanceof SyntaxError)) {
			throw new Error("JSON.parse did not throw a SyntaxError");
		}

		analytics.sendError(parseError, "UNKNOWN_ERROR");
		await analytics.closeAnalytics();

		expect(events).toHaveLength(1);
		expect(JSON.stringify(events)).not.toContain("secret123");
		const frames =
			events[0]?.exception?.values?.[0]?.stacktrace?.frames ?? [];
		expect(frames.length).toBeGreaterThan(0);
	});

	it("sends a report queued after analytics already started closing", async () => {
		const analytics = await setup();

		await analytics.closeAnalytics();
		analytics.sendError(new TypeError("after close"), "UNKNOWN_ERROR");
		await analytics.closeAnalytics();

		expect(events).toHaveLength(1);
	});

	it("keeps an unresponsive Sentry within the caller's close timeout", async () => {
		const analytics = await setup();
		stallEnvelopes = true;

		analytics.sendError(new TypeError("stalled"), "UNKNOWN_ERROR");
		const started = Date.now();
		await analytics.closeAnalytics({ timeout: 100 });

		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("keeps a late report within a later close's timeout", async () => {
		const analytics = await setup();
		stallEnvelopes = true;

		await analytics.closeAnalytics({ timeout: 100 });
		analytics.sendError(new TypeError("late"), "UNKNOWN_ERROR");
		const started = Date.now();
		await analytics.closeAnalytics({ timeout: 100 });

		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("does not report an error the CLI wrote for the user", async () => {
		const analytics = await setup();

		analytics.sendError(
			new Error("No interactive terminal. Re-run with -y."),
			"UNKNOWN_ERROR",
		);
		await analytics.closeAnalytics();

		expect(events).toEqual([]);
	});

	it("does not report a TypeError classified as a network failure", async () => {
		const analytics = await setup();

		analytics.sendError(new TypeError("fetch failed"), "NETWORK_ERROR");
		await analytics.closeAnalytics();

		expect(events).toEqual([]);
	});

	it("sends nothing when analytics is off", async () => {
		const analytics = await import("./analytics.js");
		const errorReporting = await import("./error_reporting.js");
		errorReporting.useErrorReportingDsnForTests(
			`http://public@127.0.0.1:${collector.port}/1`,
		);

		analytics.sendError(new TypeError("boom"), "UNKNOWN_ERROR");
		await analytics.closeAnalytics();

		expect(events).toEqual([]);
	});
});
