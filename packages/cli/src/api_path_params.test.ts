import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getApiClient, isNeonApiError } from "./api.js";
import {
	deleteProjectBranchBucket,
	deleteProjectBranchBucketObject,
} from "./storage_api.js";

/**
 * A `.` or `..` path parameter is rejected before sending, because the URL would resolve it
 * to a different route: by `@neon/sdk` for SDK calls, and by `pathSegment` for the paths the
 * CLI builds itself. The CLI has to surface that message rather than treat the missing
 * response as a network failure.
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

beforeEach(() => {
	received.length = 0;
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

	it("is rejected in paths the CLI builds itself", async () => {
		const api = getApiClient({ apiKey: "test", apiHost });
		await expect(async () =>
			deleteProjectBranchBucket(api, {
				projectId: "proj-1",
				branchId: "br-1",
				bucketName: "..",
			}),
		).rejects.toThrow('Path parameter bucket_name cannot be "..".');
		await expect(async () =>
			deleteProjectBranchBucketObject(api, {
				projectId: "proj-1",
				branchId: "br-1",
				bucketName: "assets",
				objectKey: ".",
			}),
		).rejects.toThrow('Path parameter object_key cannot be ".".');
		expect(received).toEqual([]);
	});

	it("keeps dotted names in paths the CLI builds itself", async () => {
		const api = getApiClient({ apiKey: "test", apiHost });
		await deleteProjectBranchBucketObject(api, {
			projectId: "proj-1",
			branchId: "br-1",
			bucketName: "assets",
			objectKey: "a/../.env",
		});
		expect(received).toEqual([
			"DELETE /projects/proj-1/branches/br-1/buckets/assets/objects/a%2F..%2F.env",
		]);
	});
});
