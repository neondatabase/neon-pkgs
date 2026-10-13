import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getErrorAnalyticsEventProperties } from "./analytics.js";
import {
	getApiClient,
	isNeonApiError,
	UnreadableResponseError,
} from "./api.js";

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
		// V8's JSON.parse error quotes input like this back in its message.
		res.end('{"password": FAKESECRET}');
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

async function rejection() {
	const api = getApiClient({ apiKey: "test", apiHost });
	return api
		.getProjectBranchRolePassword("proj-1", "br-1", "neondb_owner")
		.then(
			(result) => {
				throw new Error(
					`expected a rejection, got data: ${JSON.stringify(result.data)}`,
				);
			},
			(error: unknown) => error,
		);
}

describe("a 2xx JSON response with an unparseable body", () => {
	it("throws a NeonApiError naming the status and path", async () => {
		const err = await rejection();

		if (!isNeonApiError(err)) throw err;
		expect(err.status).toBe(200);
		expect(err.requestPath).toBe(
			"/projects/proj-1/branches/br-1/roles/neondb_owner/reveal_password",
		);
		expect(err.message).toBe(
			"Could not read the Neon API response (200 OK) to /projects/proj-1/branches/br-1/roles/neondb_owner/reveal_password: the body is not valid JSON",
		);
		expect(err).toBeInstanceOf(UnreadableResponseError);
	});

	it("keeps the body out of the message and the analytics event", async () => {
		const err = await rejection();
		if (!isNeonApiError(err)) throw err;

		const properties = getErrorAnalyticsEventProperties(err, "API_ERROR");
		expect(JSON.stringify(properties)).not.toContain("FAKESECRET");
	});
});
