import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getApiClient, isNeonApiError } from "./api.js";

/**
 * `@neon/sdk` rejects a `.` or `..` path parameter before sending, because the URL would
 * resolve to a different route. The CLI has to surface that message rather than treat the
 * missing response as a network failure.
 */

let server: Server;
let apiHost: string;
const received: string[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		received.push(`${req.method} ${req.url}`);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end("{}");
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	const { port } = server.address() as AddressInfo;
	apiHost = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	server.closeAllConnections?.();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
});

describe("a dot-segment path parameter", () => {
	it("throws the SDK's message without sending a request", async () => {
		const api = getApiClient({ apiKey: "test", apiHost });
		const err = await api
			.deleteProjectBranchDatabase("proj-1", "br-1", "..")
			.then(
				() => undefined,
				(error: unknown) => error,
			);

		expect(isNeonApiError(err)).toBe(false);
		expect(err).toBeInstanceOf(Error);
		expect(err instanceof Error && err.message).toBe(
			'Path parameter database_name cannot be "..".',
		);
		expect(received).toEqual([]);
	});
});
