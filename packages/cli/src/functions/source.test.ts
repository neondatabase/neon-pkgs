import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_JSON_BYTES, REGISTRY_CONTRACT } from "./registry";
import {
	DEFAULT_REGISTRY_URL,
	describeRegistrySource,
	GITHUB_REGISTRY_URL,
	openRegistry,
	resolveRegistrySource,
} from "./source";

describe("resolveRegistrySource", () => {
	it("prefers a local directory, then a URL, then the default", () => {
		expect(
			resolveRegistrySource(
				{ NEON_FUNCTION_REGISTRY_DIR: "reg" },
				"/work",
			),
		).toEqual({ kind: "dir", dir: "/work/reg" });
		expect(
			resolveRegistrySource({
				NEON_FUNCTION_REGISTRY_URL:
					"https://example.com/r/registry.json",
			}),
		).toMatchObject({ kind: "url" });
		const fallback = resolveRegistrySource({});
		expect(fallback.kind === "url" && fallback.url.href).toBe(
			DEFAULT_REGISTRY_URL,
		);
	});

	it("refuses plain HTTP except on loopback", () => {
		expect(() =>
			resolveRegistrySource({
				NEON_FUNCTION_REGISTRY_URL: "http://example.com/registry.json",
			}),
		).toThrow(/https/);
		expect(
			resolveRegistrySource({
				NEON_FUNCTION_REGISTRY_URL:
					"http://localhost:3000/registry.json",
			}),
		).toMatchObject({ kind: "url" });
	});
});

describe("openRegistry from a directory", () => {
	let dir: string;
	let outside: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "neon-registry-"));
		outside = mkdtempSync(join(tmpdir(), "neon-registry-outside-"));
		writeFileSync(
			join(dir, "registry.json"),
			JSON.stringify({
				templates: [
					{
						id: "demo",
						title: "Demo",
						description: "d",
						path: "demo/template.json",
					},
				],
			}),
		);
		mkdirSync(join(dir, "demo"));
		writeFileSync(
			join(dir, "demo/template.json"),
			JSON.stringify({
				id: "demo",
				title: "Demo",
				description: "d",
				layout: "router",
			}),
		);
	});

	const loadDemo = async () => {
		const registry = await openRegistry({ kind: "dir", dir });
		const [entry] = registry.entries;
		if (!entry) throw new Error("demo entry did not parse");
		return registry.load(entry);
	};

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("refuses a source symlinked outside the registry", async () => {
		writeFileSync(join(outside, "secret.ts"), "export {};\n");
		mkdirSync(join(dir, "demo/functions"));
		symlinkSync(
			join(outside, "secret.ts"),
			join(dir, "demo/functions/index.ts"),
		);
		await expect(loadDemo()).rejects.toThrow(/outside/);
	});

	it("reports a missing source", async () => {
		await expect(loadDemo()).rejects.toThrow(/not found/);
	});

	const writeIndex = (templates: unknown[]) =>
		writeFileSync(
			join(dir, "registry.json"),
			JSON.stringify({ templates }),
		);

	const writeTemplate = (fields: Record<string, unknown>) =>
		writeFileSync(
			join(dir, "demo/template.json"),
			JSON.stringify({
				id: "demo",
				title: "Demo",
				description: "d",
				layout: "router",
				...fields,
			}),
		);

	it("rejects a malformed index entry instead of skipping it", async () => {
		writeIndex([
			{
				id: "demo",
				title: "Demo",
				description: "d",
				path: "demo/template.json",
			},
			{
				id: "Bad",
				title: "Bad",
				description: "d",
				path: "bad/template.json",
			},
		]);
		await expect(openRegistry({ kind: "dir", dir })).rejects.toThrow(
			'Invalid function registry: templates[1] ("Bad") has a bad id.',
		);
	});

	it("rejects an index with more entries than the CLI reads", async () => {
		writeIndex(
			Array.from(
				{ length: REGISTRY_CONTRACT.maxIndexEntries + 1 },
				(_, i) => ({
					id: `t${i}`,
					title: "T",
					description: "d",
					path: `t${i}/template.json`,
				}),
			),
		);
		await expect(openRegistry({ kind: "dir", dir })).rejects.toThrow(
			/more than the \d+ the CLI reads/,
		);
	});

	it("rejects a multiline environment description", async () => {
		writeTemplate({
			environment: [
				{ name: "API_KEY", description: "Key\nAPI_KEY=leaked" },
			],
		});
		await expect(loadDemo()).rejects.toThrow(/one-line description/);
	});

	it("rejects an operation source that is not TypeScript", async () => {
		writeTemplate({
			operations: [
				{
					id: "send",
					title: "Send",
					description: "d",
					source: "functions/send.tsx",
					recommended: true,
					route: "/send",
				},
			],
		});
		await expect(loadDemo()).rejects.toThrow(/malformed operations/);
	});
});

type Reply = string | { status: number; body?: string; location?: string };

const serve = async (routes: Record<string, Reply>) => {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		const path = request.url ?? "/";
		requests.push(path);
		const reply = routes[path] ?? { status: 404, body: "Not found\n" };
		if (typeof reply === "string") {
			response.writeHead(200).end(reply);
			return;
		}
		response
			.writeHead(
				reply.status,
				reply.location ? { location: reply.location } : {},
			)
			.end(reply.body ?? "");
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;
	return {
		url: (path: string) => `http://127.0.0.1:${port}${path}`,
		requests,
		close: () => new Promise<void>((done) => server.close(() => done())),
	};
};

describe("openRegistry with the default sources", () => {
	const empty = JSON.stringify({ templates: [] });
	const demoIndex = JSON.stringify({
		templates: [
			{
				id: "demo",
				title: "Demo",
				description: "A demo.",
				path: "demo/template.json",
			},
		],
	});
	const demoTemplate = JSON.stringify({
		id: "demo",
		title: "Demo",
		description: "A demo.",
		layout: "router",
	});
	const env = {};
	let servers: Awaited<ReturnType<typeof serve>>[] = [];

	const start = async (routes: Record<string, Reply>) => {
		const server = await serve(routes);
		servers.push(server);
		return server;
	};

	afterEach(async () => {
		await Promise.all(servers.map((server) => server.close()));
		servers = [];
	});

	it("defaults to neon.com for the index and GitHub for files", () => {
		expect(resolveRegistrySource({})).toEqual({
			kind: "url",
			url: new URL(DEFAULT_REGISTRY_URL),
		});
		expect(new URL(GITHUB_REGISTRY_URL).hostname).toBe(
			"raw.githubusercontent.com",
		);
	});

	it("reads the index from the primary source", async () => {
		const primary = await start({ "/registry.json": empty });
		const fallback = await start({ "/registry.json": empty });
		const registry = await openRegistry(undefined, {
			primary: primary.url("/registry.json"),
			fallback: fallback.url("/registry.json"),
			env,
		});
		expect(describeRegistrySource(registry.source)).toBe(
			primary.url("/registry.json"),
		);
		expect(fallback.requests).toEqual([]);
	});

	it("falls back when the primary source fails", async () => {
		const primary = await start({ "/registry.json": { status: 503 } });
		const fallback = await start({ "/registry.json": empty });
		const registry = await openRegistry(undefined, {
			primary: primary.url("/registry.json"),
			fallback: fallback.url("/registry.json"),
			env,
		});
		expect(describeRegistrySource(registry.source)).toBe(
			fallback.url("/registry.json"),
		);
	});

	it("loads template files from the fallback, not the primary", async () => {
		const primary = await start({ "/registry.json": demoIndex });
		const fallback = await start({
			"/demo/template.json": demoTemplate,
			"/demo/functions/index.ts": "export default {};\n",
		});
		const registry = await openRegistry(undefined, {
			primary: primary.url("/registry.json"),
			fallback: fallback.url("/registry.json"),
			env,
		});
		const [entry] = registry.entries;
		if (!entry) throw new Error("demo entry did not parse");
		const { sources } = await registry.load(entry);
		expect(sources.get("functions/index.ts")).toBe("export default {};\n");
		expect(primary.requests).toEqual(["/registry.json"]);
		expect(fallback.requests).toEqual([
			"/demo/template.json",
			"/demo/functions/index.ts",
		]);
	});

	it("says the cached index may be stale when a template file is gone", async () => {
		const primary = await start({ "/registry.json": demoIndex });
		const fallback = await start({});
		const registry = await openRegistry(undefined, {
			primary: primary.url("/registry.json"),
			fallback: fallback.url("/registry.json"),
			env,
		});
		const [entry] = registry.entries;
		if (!entry) throw new Error("demo entry did not parse");
		await expect(registry.load(entry)).rejects.toThrow(
			/answered 404 .* is cached and may still list a template that moved/,
		);
	});

	it("never falls back from an explicit URL", async () => {
		const explicit = await start({ "/registry.json": { status: 503 } });
		const fallback = await start({ "/registry.json": empty });
		await expect(
			openRegistry(undefined, {
				fallback: fallback.url("/registry.json"),
				env: {
					NEON_FUNCTION_REGISTRY_URL: explicit.url("/registry.json"),
				},
			}),
		).rejects.toThrow(/503/);
		expect(fallback.requests).toEqual([]);
	});

	it("does not follow redirects", async () => {
		const target = await start({ "/registry.json": empty });
		const redirecting = await start({
			"/registry.json": {
				status: 302,
				location: target.url("/registry.json"),
			},
		});
		await expect(
			openRegistry({
				kind: "url",
				url: new URL(redirecting.url("/registry.json")),
			}),
		).rejects.toThrow(/Could not reach/);
		expect(target.requests).toEqual([]);
	});

	it("refuses an index larger than the size limit", async () => {
		const large = await start({
			"/registry.json": " ".repeat(MAX_JSON_BYTES + 1),
		});
		await expect(
			openRegistry({
				kind: "url",
				url: new URL(large.url("/registry.json")),
			}),
		).rejects.toThrow(/larger than the \d+-byte limit/);
	});
});
