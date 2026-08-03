import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getApiClient, isNeonApiError } from "./api.js";
import { isNetworkError } from "./errors.js";

/**
 * What the user sees when the Neon API accepts a connection and then never answers.
 *
 * The CLI installs its own request timeout inside a custom `fetch`, so the failure comes
 * back through `@neon/sdk`'s wrapper rather than as a bare `DOMException`. That is the
 * detail the classification has to survive: a timeout must stay a timeout, and must not be
 * reported as a connectivity problem the user is told to go and check.
 */

let server: Server;
let apiHost: string;

beforeAll(async () => {
	// Accept the connection, then never respond.
	server = createServer(() => {});
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

describe("a request that times out", () => {
	async function timeoutError() {
		const api = getApiClient({
			apiKey: "test",
			apiHost,
			requestTimeoutMs: 150,
		});
		try {
			await api.listProjects({});
			throw new Error("expected the request to time out");
		} catch (err) {
			return err;
		}
	}

	it("is reported as a timeout, not as a connectivity failure", async () => {
		const err = await timeoutError();

		expect(isNeonApiError(err)).toBe(true);
		if (!isNeonApiError(err)) return;

		// ECONNABORTED is the CLI's timeout code, deliberately kept out of
		// NETWORK_ERROR_CODES so a timeout is not reported as "check your connection".
		expect(err.code).toBe("ECONNABORTED");
		expect(err.message).toBe("Request timed out");
	});

	it("is not classified as a network error, so the connectivity advice is not shown", async () => {
		// The regression: the SDK wraps a transport failure with a message beginning
		// "Network error: ...", which `isNetworkError`'s message pattern matches. A 60s
		// timeout was therefore reported as "Could not reach the Neon API. Please check
		// your internet connection", which is wrong and unactionable — the connection is
		// fine and the request did reach the server.
		expect(isNetworkError(await timeoutError())).toBe(false);
	});

	it("does not carry a status, since no response arrived", async () => {
		const err = await timeoutError();
		if (!isNeonApiError(err)) throw new Error("expected a NeonApiError");
		expect(err.status).toBeUndefined();
	});
});
