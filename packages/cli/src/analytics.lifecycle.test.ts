import { mkdtempSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analytics } from "@segment/analytics-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The account lookup runs alongside the command. These tests drive the real Segment client
// against a local collector and a local API whose /auth and /users/me answers are held, so
// they can check what the command waits for and what each event carries.

type SegmentEvent = {
	type: string;
	event?: string;
	userId?: string;
	properties?: Record<string, unknown>;
};

const listen = async (
	handler: (req: IncomingMessage, res: ServerResponse) => void,
) => {
	const server: Server = createServer(handler);
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
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

const json = (res: ServerResponse, body: unknown) => {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};

let events: SegmentEvent[];
let collector: Awaited<ReturnType<typeof listen>>;

beforeEach(async () => {
	vi.resetModules();
	events = [];
	collector = await listen(async (req, res) => {
		const body = JSON.parse(await readBody(req)) as {
			batch: SegmentEvent[];
		};
		events.push(...body.batch);
		json(res, {});
	});
});

afterEach(async () => {
	await collector.close();
});

/** Fresh module state per test: the analytics client, queue, and auth context are singletons. */
const setup = async (apiUrl: string) => {
	const analytics = await import("./analytics.js");
	const { setAuthContext } = await import("./auth_context.js");
	analytics.useAnalyticsClientForTests(
		new Analytics({ writeKey: "test", host: collector.url }),
	);
	const configDir = mkdtempSync(join(tmpdir(), "neon-analytics-"));
	setAuthContext({ source: "api-key", apiKeyFrom: "flag", configDir });
	const args = {
		analytics: true,
		apiKey: "test-key",
		apiHost: apiUrl,
		configDir,
		_: ["projects", "list"],
		output: "json",
	};
	return { analytics, args };
};

const sent = () => events.map((e) => (e.type === "track" ? e.event : e.type));

describe("analytics account lookup", () => {
	it("lets the command run while /auth is pending and attributes every event", async () => {
		let releaseAuth: (() => void) | undefined;
		const api = await listen((req, res) => {
			if (req.url?.startsWith("/auth")) {
				releaseAuth = () =>
					json(res, {
						account_id: "acct-1",
						auth_method: "api_key_user",
						auth_data: "key-1",
					});
			} else if (req.url?.startsWith("/users/me")) {
				json(res, { id: "user-1" });
			}
		});
		try {
			const { analytics, args } = await setup(api.url);

			expect(analytics.analyticsMiddleware(args)).toBeUndefined();
			analytics.trackEvent("command_step", { step: 1 });
			analytics.trackCommandSuccess(args);
			await vi.waitFor(() => expect(releaseAuth).toBeDefined());
			expect(events).toEqual([]);

			releaseAuth?.();
			await analytics.closeAnalytics();

			expect(sent()).toEqual([
				"identify",
				"CLI Started",
				"command_step",
				"cli_command_success",
			]);
			for (const event of events) {
				expect(event.userId).toBe("user-1");
			}
			expect(events.at(-1)?.properties).toMatchObject({
				accountId: "acct-1",
				authMethod: "api_key_user",
				authData: "key-1",
			});
		} finally {
			await api.close();
		}
	});

	it("stops waiting for a hung /auth and sends what it knows", async () => {
		let authClosed = false;
		const api = await listen((req, res) => {
			res.on("close", () => {
				authClosed = true;
			});
		});
		try {
			const { analytics, args } = await setup(api.url);

			analytics.analyticsMiddleware(args);
			analytics.trackCommandSuccess(args);
			const started = Date.now();
			await analytics.closeAnalytics();

			expect(Date.now() - started).toBeLessThan(3000);
			expect(authClosed).toBe(true);
			expect(sent()).toEqual([
				"identify",
				"CLI Started",
				"cli_command_success",
			]);
			expect(events[1]?.userId).toBe("anonymous");
		} finally {
			await api.close();
		}
	});

	it("keeps the /auth account fields when /users/me hangs", async () => {
		let usersMeClosed = false;
		const api = await listen((req, res) => {
			if (req.url?.startsWith("/auth")) {
				json(res, {
					account_id: "acct-2",
					auth_method: "api_key_user",
				});
			} else {
				res.on("close", () => {
					usersMeClosed = true;
				});
			}
		});
		try {
			const { analytics, args } = await setup(api.url);

			analytics.analyticsMiddleware(args);
			analytics.trackCommandSuccess(args);
			await analytics.closeAnalytics();

			expect(usersMeClosed).toBe(true);
			expect(events.at(-1)?.properties).toMatchObject({
				accountId: "acct-2",
				authMethod: "api_key_user",
			});
			expect(events.at(-1)?.userId).toBe("anonymous");
		} finally {
			await api.close();
		}
	});

	it("shares one close and keeps a caller's total timeout", async () => {
		const api = await listen(() => {});
		try {
			const { analytics, args } = await setup(api.url);

			analytics.analyticsMiddleware(args);
			const first = analytics.closeAnalytics({ timeout: 300 });
			const second = analytics.closeAnalytics();
			expect(second).toBe(first);
			const started = Date.now();
			await first;
			expect(Date.now() - started).toBeLessThan(500);
			// The close promise is bounded; delivery of what was flushed can finish after it.
			await vi.waitFor(() =>
				expect(sent()).toEqual(["identify", "CLI Started"]),
			);
		} finally {
			await api.close();
		}
	});

	it("keeps each retry attempt's attribution when an earlier lookup finishes last", async () => {
		let releaseFirst: (() => void) | undefined;
		let secondDone = false;
		const api = await listen((req, res) => {
			const key = req.headers.authorization?.replace("Bearer ", "");
			const answer = () =>
				req.url?.startsWith("/auth")
					? json(res, {
							account_id: `acct-${key}`,
							auth_method: "api_key_user",
							auth_data: key,
						})
					: json(res, { id: `user-${key}` });
			if (key === "a" && req.url?.startsWith("/auth")) {
				releaseFirst = answer;
			} else {
				answer();
				if (key === "b" && req.url?.startsWith("/users/me")) {
					secondDone = true;
				}
			}
		});
		try {
			const { analytics, args } = await setup(api.url);

			analytics.analyticsMiddleware({ ...args, apiKey: "a" });
			analytics.sendError(new Error("token expired"), "AUTH_FAILED");
			await vi.waitFor(() => expect(releaseFirst).toBeDefined());
			analytics.analyticsMiddleware({ ...args, apiKey: "b" });
			analytics.trackCommandSuccess(args);
			// The retry's lookup finishes first; the stale one answers last.
			await vi.waitFor(() => expect(secondDone).toBe(true));
			releaseFirst?.();
			await analytics.closeAnalytics();

			expect(events.map((e) => [e.event ?? e.type, e.userId])).toEqual([
				["identify", "user-a"],
				["CLI Started", "user-a"],
				["CLI Error", "user-a"],
				["identify", "user-b"],
				["CLI Started", "user-b"],
				["cli_command_success", "user-b"],
			]);
			expect(events.at(-1)?.properties).toMatchObject({
				accountId: "acct-b",
				authData: "b",
			});
		} finally {
			await api.close();
		}
	});
});
