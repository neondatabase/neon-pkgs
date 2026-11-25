import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NeonClientError, NeonNetworkError } from "@neon/sdk";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createNeonTools } from "../../index.js";
import { NeonToolCallerError } from "../caller-error.js";

// fetch refuses this port, so a call that gets past the policy fails with
// NeonNetworkError and a refused one fails before any request.
const NO_NEON_API = "http://127.0.0.1:1/api/v2";

const vendoredSpecText = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		"../../../../sdk/spec/neon-openapi.json",
	),
	"utf8",
);

const errorName = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return "resolved";
	} catch (error) {
		if (error instanceof NeonToolCallerError) return "NeonToolCallerError";
		if (error instanceof NeonNetworkError) return "NeonNetworkError";
		if (error instanceof NeonClientError) return "NeonClientError";
		return String(error);
	}
};

describe("api.call policy", () => {
	const tools = createNeonTools({
		apiKey: "test-key",
		baseUrl: NO_NEON_API,
		tools: ["api.call"],
	});
	const call = (
		path: string,
		context: Parameters<(typeof tools)["api.call"]["execute"]>[1],
	) => errorName(tools["api.call"].execute({ method: "GET", path }, context));

	test("reaches every route when every secret is allowed", async () => {
		expect(await call("/projects", {})).toBe("NeonNetworkError");
		expect(
			await call("/projects/p/branches/b/auth/oauth_providers", {}),
		).toBe("NeonNetworkError");
	});

	test("refuses Neon Auth routes under secrets setup, however the path is encoded", async () => {
		for (const path of [
			"/projects/p/branches/b/auth/oauth_providers",
			"/projects/p/auth/email_server",
			"/projects/p/branches/b/%61uth/plugins",
			"/projects/p/branches/b/AUTH/plugins",
		]) {
			expect(await call(path, { secrets: "setup" }), path).toBe(
				"NeonToolCallerError",
			);
		}
		expect(await call("/projects/p/branches", { secrets: "setup" })).toBe(
			"NeonNetworkError",
		);
	});

	test("uses the secrets default from createNeonTools", async () => {
		const setup = createNeonTools({
			apiKey: "test-key",
			baseUrl: NO_NEON_API,
			secrets: "setup",
			tools: ["api.call"],
		});
		expect(
			await errorName(
				setup["api.call"].execute({
					method: "GET",
					path: "/projects/p/auth/oauth_providers",
				}),
			),
		).toBe("NeonToolCallerError");
	});

	test("is unavailable read-only or with no secrets", async () => {
		expect(await call("/projects", { readOnly: true })).toBe(
			"NeonToolCallerError",
		);
		expect(await call("/projects", { secrets: "none" })).toBe(
			"NeonToolCallerError",
		);
	});

	test("refuses an invalid path before sending", async () => {
		expect(await call("/projects/../users/me", {})).toBe("NeonClientError");
		expect(await call("projects", {})).toBe("NeonClientError");
	});
});

describe("api.search", () => {
	let server: Server;
	let specUrl: string;
	let hits = 0;
	let failNext = false;
	let delayMs = 0;

	beforeAll(async () => {
		server = createServer((_req, res) => {
			hits += 1;
			if (failNext) {
				failNext = false;
				res.writeHead(503).end();
				return;
			}
			setTimeout(() => {
				res.writeHead(200, { "content-type": "application/json" }).end(
					vendoredSpecText,
				);
			}, delayMs);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		specUrl = `http://127.0.0.1:${port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	const searchTool = (path: string) =>
		createNeonTools({
			apiSpecUrl: `${specUrl}${path}`,
			tools: ["api.search"],
		})["api.search"];

	test("returns ranked endpoints with the fields api.call takes", async () => {
		const { data } = await searchTool("/ranked").execute({
			query: "create branch",
			limit: 1,
		});
		expect(data.endpoints).toHaveLength(1);
		expect(data.endpoints[0]).toMatchObject({
			method: "POST",
			path: "/projects/{project_id}/branches",
			operation_id: "createProjectBranch",
			body_required: false,
		});
		expect(data.endpoints[0]?.fields.map((field) => field.name)).toEqual(
			expect.arrayContaining(["project_id", "branch.name"]),
		);
	});

	test("one caller cancelling leaves the shared fetch to the others, and the spec is cached", async () => {
		hits = 0;
		delayMs = 50;
		const tool = searchTool("/shared");
		const cancelled = new AbortController();
		const first = tool.execute(
			{ query: "list projects" },
			{ signal: cancelled.signal },
		);
		const second = tool.execute({ query: "list projects" });
		cancelled.abort(new Error("caller went away"));
		await expect(first).rejects.toThrow("caller went away");
		await expect(second).resolves.toMatchObject({
			data: { endpoints: expect.any(Array) },
		});
		await tool.execute({ query: "delete project" });
		expect(hits).toBe(1);
		delayMs = 0;
	});

	test("a failed fetch is reported and not cached", async () => {
		hits = 0;
		failNext = true;
		const tool = searchTool("/flaky");
		await expect(tool.execute({ query: "projects" })).rejects.toThrow(
			`Failed to fetch the Neon OpenAPI spec from ${specUrl}/flaky (503`,
		);
		await expect(
			tool.execute({ query: "projects" }),
		).resolves.toBeDefined();
		expect(hits).toBe(2);
	});
});

describe("the secrets: setup rule for api.call", () => {
	type Node = Record<string, unknown>;
	const spec: Node = JSON.parse(vendoredSpecText);
	const isNode = (value: unknown): value is Node =>
		typeof value === "object" && value !== null && !Array.isArray(value);
	const resolve = (ref: string): unknown =>
		ref
			.slice(2)
			.split("/")
			.reduce<unknown>(
				(node, key) => (isNode(node) ? node[key] : undefined),
				spec,
			);

	/** Every property name a 2xx response can carry, with the schema that declares it. */
	const responseProperties = (operation: Node) => {
		const found = new Set<string>();
		const seen = new Set<string>();
		const walk = (node: unknown, owner: string) => {
			if (Array.isArray(node)) {
				for (const item of node) walk(item, owner);
				return;
			}
			if (!isNode(node)) return;
			if (typeof node.$ref === "string") {
				if (seen.has(node.$ref)) return;
				seen.add(node.$ref);
				walk(resolve(node.$ref), node.$ref.split("/").pop() ?? owner);
			}
			if (isNode(node.properties)) {
				for (const name of Object.keys(node.properties)) {
					found.add(`${owner}.${name}`);
				}
			}
			for (const value of Object.values(node)) walk(value, owner);
		};
		const responses = isNode(operation.responses)
			? operation.responses
			: {};
		for (const [status, response] of Object.entries(responses)) {
			if (status.startsWith("2")) walk(response, "response");
		}
		return found;
	};

	// Secrets Neon issues for setup, which secrets: "setup" keeps. Any other
	// secret-looking response field is unclassified and fails the test below.
	const SETUP_SECRETS = new Set([
		"ApiKeyCreateResponse.key",
		"ConnectionDetails.connection_uri",
		"ConnectionParameters.password",
		"Role.password",
		"RolePasswordResponse.password",
		"NeonAuthOAuthClientCreated.client_secret",
		"NeonAuthOAuthClientSecret.client_secret",
		"CreateCredentialResponse.api_token",
		"CreateCredentialResponse.s3_secret_access_key",
		"CredentialSecret.api_token",
		"CredentialSecret.s3_secret_access_key",
		"RotateCredentialResponse.api_token",
		"RotateCredentialResponse.s3_secret_access_key",
		"PresignedUrlResponse.url",
		"RealtimeSecretResponse.secret",
		"NeonAuthCreateIntegrationResponse.secret_server_key",
		"NeonAuthSDKKeys.secret_server_key",
		"ConnectionURIsResponse.connection_uris",
		"ConnectionURIsOptionalResponse.connection_uris",
		"RealtimeSecret.secret",
	]);
	const NOT_SECRETS = new Set([
		"Project.store_passwords",
		"ProjectListItem.store_passwords",
		"Endpoint.passwordless_access",
	]);
	const SECRET_NAME = /password|secret|private_key|api_token|connection_uri/i;

	test("every stored secret a response can return is under an auth path segment", () => {
		const unclassified: string[] = [];
		const paths = isNode(spec.paths) ? spec.paths : {};
		for (const [path, item] of Object.entries(paths)) {
			if (!isNode(item)) continue;
			const underAuth = path.split("/").includes("auth");
			for (const [method, operation] of Object.entries(item)) {
				if (!isNode(operation) || !isNode(operation.responses))
					continue;
				for (const property of responseProperties(operation)) {
					const name = property.split(".").pop() ?? "";
					if (
						!SECRET_NAME.test(name) ||
						SETUP_SECRETS.has(property) ||
						NOT_SECRETS.has(property)
					) {
						continue;
					}
					if (!underAuth) {
						unclassified.push(
							`${method.toUpperCase()} ${path}: ${property}`,
						);
					}
				}
			}
		}
		expect(unclassified).toEqual([]);
	});
});
