import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createNeonClient } from "./client.js";
import { NeonClientError, NeonNotFoundError } from "./errors.js";
import { parseApiPath } from "./request.js";

interface Received {
	method: string | undefined;
	url: string | undefined;
	authorization: string | undefined;
	contentType: string | undefined;
	body: string;
}

let server: Server;
let baseUrl: string;
const received: Received[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			received.push({
				method: req.method,
				url: req.url,
				authorization: req.headers.authorization,
				contentType: req.headers["content-type"],
				body,
			});
			const path = req.url?.split("?")[0];
			if (path === "/api/v2/empty") {
				res.writeHead(204).end();
			} else if (path === "/api/v2/text") {
				res.writeHead(200, { "content-type": "text/plain" }).end(
					"hello",
				);
			} else if (path === "/api/v2/missing") {
				res.writeHead(404, { "content-type": "application/json" }).end(
					'{"code":"","message":"project not found"}',
				);
			} else if (path === "/api/v2/redirect") {
				res.writeHead(302, { location: "/api/v2/elsewhere" }).end();
			} else if (path === "/api/v2/broken") {
				res.writeHead(200, { "content-type": "application/json" }).end(
					"{not json",
				);
			} else {
				res.writeHead(201, { "content-type": "application/json" }).end(
					JSON.stringify({
						branch: { id: "br-1" },
						operations: [{ id: "op-1", status: "running" }],
					}),
				);
			}
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	const { port } = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}/api/v2`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
	received.length = 0;
});

describe("neon.request", () => {
	it("sends method, query, JSON body, and the bearer key, and never polls operations", async () => {
		const neon = createNeonClient({
			apiKey: "test-key",
			baseUrl,
			retries: 0,
			waitForReadiness: true,
		});
		const res = await neon.request({
			method: "POST",
			path: "/projects/p-1/branches",
			query: { org_id: "org-1", limit: 2, dry: false },
			body: { branch: { name: "dev" } },
		});
		expect(res.error).toBeUndefined();
		expect(res.data).toEqual({
			branch: { id: "br-1" },
			operations: [{ id: "op-1", status: "running" }],
		});
		expect(received).toEqual([
			{
				method: "POST",
				url: "/api/v2/projects/p-1/branches?org_id=org-1&limit=2&dry=false",
				authorization: "Bearer test-key",
				contentType: "application/json",
				body: '{"branch":{"name":"dev"}}',
			},
		]);
	});

	it("returns null for an empty body and the text of a non-JSON one", async () => {
		const neon = createNeonClient({
			apiKey: "k",
			baseUrl,
			retries: 0,
			throwOnError: true,
		});
		await expect(
			neon.request({ method: "DELETE", path: "/empty" }),
		).resolves.toBeNull();
		await expect(
			neon.request({ method: "GET", path: "/text" }),
		).resolves.toBe("hello");
		expect(received.map((r) => r.contentType)).toEqual([
			undefined,
			undefined,
		]);
	});

	it("maps an API error to the typed SDK error", async () => {
		const neon = createNeonClient({ apiKey: "k", baseUrl, retries: 0 });
		const res = await neon.request({ method: "GET", path: "/missing" });
		expect(res.error).toBeInstanceOf(NeonNotFoundError);
		expect(res.error?.message).toBe("project not found");
	});

	it("refuses a redirect and a 2xx JSON body it cannot parse", async () => {
		const neon = createNeonClient({ apiKey: "k", baseUrl, retries: 0 });
		const redirected = await neon.request({
			method: "GET",
			path: "/redirect",
		});
		expect(redirected.error).toBeDefined();
		const broken = await neon.request({ method: "GET", path: "/broken" });
		expect(broken.error).toBeInstanceOf(NeonClientError);
		expect(broken.error?.message).toBe(
			"The Neon API answered GET /broken with a body that is not valid JSON.",
		);
		expect(received.map((r) => r.url)).toEqual([
			"/api/v2/redirect",
			"/api/v2/broken",
		]);
	});

	it("refuses an invalid path without sending a request", async () => {
		const neon = createNeonClient({ apiKey: "k", baseUrl, retries: 0 });
		const res = await neon.request({ method: "GET", path: "/../users/me" });
		expect(res.error).toBeInstanceOf(NeonClientError);
		const thrower = createNeonClient({
			apiKey: "k",
			baseUrl,
			retries: 0,
			throwOnError: true,
		});
		await expect(
			thrower.request({ method: "GET", path: "projects" }),
		).rejects.toBeInstanceOf(NeonClientError);
		expect(received).toEqual([]);
	});
});

describe("parseApiPath", () => {
	it("returns the decoded segments", () => {
		expect(
			parseApiPath("/projects/p-1/branches/br-1/roles/my%20role"),
		).toEqual(["projects", "p-1", "branches", "br-1", "roles", "my role"]);
	});

	it.each([
		["projects", 'it must start with "/"'],
		["/projects/{project_id}", "fill in every {placeholder}"],
		["/projects?limit=1", "pass query parameters in query"],
		["/projects#x", "pass query parameters in query"],
		["/projects/p\tx", "may only contain URL path characters"],
		["/projects/a\\b", "may only contain URL path characters"],
		["/projects//branches", "empty segment"],
		["/projects/", "empty segment"],
		["/projects/../users", '"." and ".." segments'],
		["/projects/%2e%2E/users", '"." and ".." segments'],
		["/projects/./x", '"." and ".." segments'],
		["/projects/a%2Fauth", "encoded slash or backslash"],
		["/projects/a%5Cb", "encoded slash or backslash"],
		["/projects/%zz", "not valid percent-encoding"],
		["//evil.example/x", "empty segment"],
	])("refuses %j", (path, reason) => {
		const result = parseApiPath(path);
		expect(result).toBeInstanceOf(NeonClientError);
		expect(result instanceof NeonClientError && result.message).toContain(
			reason,
		);
	});
});
