import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getApiClient, isNeonApiError } from "./api.js";
import { isUnexpectedError } from "./errors.js";

/**
 * A 2xx JSON response whose body cannot be parsed. The generated client reports that on its
 * error channel alongside an `ok` response, so the CLI has to read the error channel on
 * success too, or every caller receives `data: undefined` and crashes destructuring it.
 */

let server: Server;
let apiHost: string;

beforeAll(async () => {
	server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end('{"databases": [');
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

describe("a 2xx JSON response with an unparseable body", () => {
	it("throws a NeonApiError naming the status, path, and parse failure", async () => {
		const api = getApiClient({ apiKey: "test", apiHost });
		const err = await api.listProjectBranchDatabases("proj-1", "br-1").then(
			(result) => {
				throw new Error(
					`expected a rejection, got data: ${JSON.stringify(result.data)}`,
				);
			},
			(error: unknown) => error,
		);

		if (!isNeonApiError(err)) throw err;
		expect(err.status).toBe(200);
		expect(err.requestPath).toBe(
			"/projects/proj-1/branches/br-1/databases",
		);
		expect(err.message).toMatch(
			/^Could not read the Neon API response \(200 OK\) to \/projects\/proj-1\/branches\/br-1\/databases: .*JSON/,
		);
		expect(isUnexpectedError(err)).toBe(false);
	});
});
