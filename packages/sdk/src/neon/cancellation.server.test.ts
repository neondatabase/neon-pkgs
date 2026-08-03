import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNeonClient } from "./client.js";

/**
 * Cancellation against a real HTTP server, over the runtime's own `fetch`.
 *
 * The fetch-stub tests in `cancellation.test.ts` cover mapping, but a stub that honours
 * `signal` promptly hides two things a real socket does not: work that happens before
 * `fetch` is reached, and a request that hangs with no response. Both bugs this file
 * covers were invisible to the stubbed suite.
 */

interface Behaviour {
	/** Never respond, leaving the socket open until the client gives up. */
	hang: boolean;
	/** Operations still reported as running when polled. */
	operationRunning: boolean;
	/** Leave the operation poll itself in flight, so cancellation lands mid-request. */
	hangOperations: boolean;
	operationPolls: number;
	/** Resolves the first time an operation poll is received. */
	onOperationPoll?: () => void;
}

let server: Server;
let baseUrl: string;
const behaviour: Behaviour = {
	hang: false,
	operationRunning: true,
	hangOperations: false,
	operationPolls: 0,
};

/** Reset between tests so one test's server behaviour cannot leak into the next. */
function resetBehaviour(overrides: Partial<Behaviour> = {}) {
	behaviour.hang = false;
	behaviour.operationRunning = true;
	behaviour.hangOperations = false;
	behaviour.operationPolls = 0;
	behaviour.onOperationPoll = undefined;
	Object.assign(behaviour, overrides);
}

function json(body: unknown) {
	return JSON.stringify(body);
}

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");

		if (behaviour.hang) return; // socket stays open, no response ever

		if (url.pathname.includes("/operations/")) {
			behaviour.operationPolls += 1;
			behaviour.onOperationPoll?.();
			// Leaves the poll in flight, so an abort or a deadline lands during the
			// request rather than in the gap between polls.
			if (behaviour.hangOperations) return;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				json({
					operation: {
						id: "op-1",
						project_id: "p-1",
						action: "create_timeline",
						status: behaviour.operationRunning
							? "running"
							: "finished",
					},
				}),
			);
			return;
		}

		if (req.method === "POST" && url.pathname.endsWith("/projects")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				json({
					project: { id: "p-1", name: "test" },
					operations: [
						{
							id: "op-1",
							project_id: "p-1",
							action: "create_timeline",
							status: "running",
						},
					],
					connection_uris: [
						{
							connection_uri: "postgresql://u:p@host/db",
							connection_parameters: {
								host: "host",
								pooler_host: "host-pooler",
							},
						},
					],
				}),
			);
			return;
		}

		res.writeHead(200, { "content-type": "application/json" });
		res.end(json({ projects: [{ id: "p-1" }], pagination: {} }));
	});

	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	const { port } = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	server.closeAllConnections?.();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
});

describe("against a real socket that never responds", () => {
	it("times out a request", async () => {
		behaviour.hang = true;
		const neon = createNeonClient({
			apiKey: "k",
			baseUrl,
			retries: 0,
			requestTimeoutMs: 60,
		});

		const { error } = await neon.projects.get("p-1");
		behaviour.hang = false;
		expect(error?.kind).toBe("timeout");
	});

	it("reports a caller abort as aborted, not as a network failure", async () => {
		behaviour.hang = true;
		const neon = createNeonClient({ apiKey: "k", baseUrl, retries: 0 });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 40);

		const { error } = await neon.projects.get("p-1", {
			signal: controller.signal,
		});
		behaviour.hang = false;
		expect(error?.kind).toBe("aborted");
	});

	it("bounds a paginated walk, whose page fetches sit outside the execution core", async () => {
		behaviour.hang = true;
		const neon = createNeonClient({
			apiKey: "k",
			baseUrl,
			retries: 0,
			requestTimeoutMs: 60,
		});

		const { error } = await neon.projects.list().all();
		behaviour.hang = false;
		expect(error?.kind).toBe("timeout");
	});
});

describe("work that happens before fetch is reached", () => {
	/** Resolving the API key is awaited before the request is built. */
	const slowApiKey = () =>
		new Promise<string>((resolve) => setTimeout(() => resolve("k"), 2_000));

	it("bounds a single call", async () => {
		const neon = createNeonClient({
			apiKey: slowApiKey,
			baseUrl,
			retries: 0,
			requestTimeoutMs: 50,
		});

		const startedAt = Date.now();
		const { error } = await neon.projects.get("p-1");
		expect(error?.kind).toBe("timeout");
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});

	it("bounds a paginated walk", async () => {
		// A signal cannot reach this phase, so pagination has to be raced against its
		// deadline the same way the execution core races a request. It was not.
		const neon = createNeonClient({
			apiKey: slowApiKey,
			baseUrl,
			retries: 0,
			requestTimeoutMs: 50,
		});

		const startedAt = Date.now();
		const { error } = await neon.projects.list().all();
		expect(error?.kind).toBe("timeout");
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});

	it("bounds one page and one iteration too", async () => {
		const neon = createNeonClient({
			apiKey: slowApiKey,
			baseUrl,
			retries: 0,
			requestTimeoutMs: 50,
		});

		const page = await neon.projects.list().page();
		expect(page.error?.kind).toBe("timeout");

		await expect(async () => {
			for await (const _project of neon.projects.list()) {
				// unreachable: the first page never arrives
			}
		}).rejects.toMatchObject({ kind: "timeout" });
	});
});

describe("readiness polling", () => {
	it("reports an abort during an in-flight poll as aborted, not as a network failure", async () => {
		// The abort is triggered only once the server confirms it is holding a poll, so
		// this cannot pass on a between-polls check: the request is definitely in flight.
		const controller = new AbortController();
		resetBehaviour({
			hangOperations: true,
			onOperationPoll: () => setTimeout(() => controller.abort(), 20),
		});
		const neon = createNeonClient({
			apiKey: "k",
			baseUrl,
			retries: 0,
			waitForReadiness: true,
			wait: { pollIntervalMs: 5, timeoutMs: 60_000 },
		});

		const { error } = await neon.projects.create(
			{ name: "test" },
			{ signal: controller.signal },
		);
		expect(behaviour.operationPolls).toBeGreaterThan(0);
		expect(error?.kind).toBe("aborted");
		resetBehaviour();
	});

	it("enforces its timeout while a poll is in flight", async () => {
		// Previously the budget was only consulted between polls, so a poll that never
		// returned could outlast it indefinitely.
		resetBehaviour({ hangOperations: true });
		const neon = createNeonClient({
			apiKey: "k",
			baseUrl,
			retries: 0,
			waitForReadiness: true,
			wait: { pollIntervalMs: 5, timeoutMs: 80 },
		});

		const startedAt = Date.now();
		const { error } = await neon.projects.create({ name: "test" });
		expect(behaviour.operationPolls).toBeGreaterThan(0);
		expect(error?.kind).toBe("timeout");
		expect(Date.now() - startedAt).toBeLessThan(2_000);
		resetBehaviour();
	});

	it("enforces its timeout while operations stay pending between polls", async () => {
		resetBehaviour({ operationRunning: true });
		const neon = createNeonClient({
			apiKey: "k",
			baseUrl,
			retries: 0,
			waitForReadiness: true,
			wait: { pollIntervalMs: 10, timeoutMs: 80 },
		});

		const { error } = await neon.projects.create({ name: "test" });
		expect(error?.kind).toBe("timeout");
	});

	it("resolves once the operations finish", async () => {
		resetBehaviour({ operationRunning: false });
		const neon = createNeonClient({
			apiKey: "k",
			baseUrl,
			retries: 0,
			waitForReadiness: true,
			wait: { pollIntervalMs: 10, timeoutMs: 5_000 },
		});

		const { data, error } = await neon.projects.create({ name: "test" });
		expect(error).toBeUndefined();
		expect(data?.id).toBe("p-1");
	});

	it("survives a readiness budget larger than setTimeout can represent", async () => {
		// A single timer above 2^31-1 collapses to 1ms in Node, which would have turned
		// a very generous budget into an instant timeout.
		resetBehaviour({ operationRunning: false });
		const neon = createNeonClient({
			apiKey: "k",
			baseUrl,
			retries: 0,
			waitForReadiness: true,
			wait: { pollIntervalMs: 5, timeoutMs: 2 ** 31 + 1_000 },
		});

		const { data, error } = await neon.projects.create({ name: "test" });
		expect(error).toBeUndefined();
		expect(data?.id).toBe("p-1");
	});
});

describe("per-call timeout validation", () => {
	it("refuses a per-call value setTimeout would mistreat", async () => {
		const neon = createNeonClient({ apiKey: "k", baseUrl, retries: 0 });

		// Not validating per-call left NaN silently meaning "unbounded" and a value past
		// setTimeout's range silently meaning 1ms.
		await expect(
			neon.projects.get("p-1", { requestTimeoutMs: Number.NaN }),
		).rejects.toMatchObject({ kind: "client" });
		await expect(
			neon.projects.get("p-1", { requestTimeoutMs: 2 ** 31 }),
		).rejects.toMatchObject({ kind: "client" });
		await expect(
			neon.projects.get("p-1", { requestTimeoutMs: -1 }),
		).rejects.toMatchObject({ kind: "client" });
	});

	it("accepts Infinity as the documented opt-out", async () => {
		const neon = createNeonClient({
			apiKey: "k",
			baseUrl,
			retries: 0,
			requestTimeoutMs: 50,
		});

		const { error } = await neon.projects.get("p-1", {
			requestTimeoutMs: Number.POSITIVE_INFINITY,
		});
		expect(error).toBeUndefined();
	});
});
