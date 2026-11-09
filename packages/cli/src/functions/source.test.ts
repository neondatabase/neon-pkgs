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
import { gzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_JSON_BYTES } from "./registry";
import {
	DEFAULT_GITHUB_RAW_URL,
	DEFAULT_REGISTRY_URL,
	describeRegistrySource,
	GITHUB_REGISTRY_URL,
	githubFileUrl,
	openRegistry,
	resolveGithubRawBase,
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
						categories: ["first-party"],
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

	it("rejects a malformed index entry instead of skipping it", async () => {
		writeIndex([
			{
				id: "demo",
				title: "Demo",
				description: "d",
				path: "demo/template.json",
				categories: ["first-party"],
			},
			{
				id: "Bad",
				title: "Bad",
				description: "d",
				path: "bad/template.json",
			},
		]);
		await expect(openRegistry({ kind: "dir", dir })).rejects.toThrow(
			/templates\/1\/id/,
		);
	});

	it("rejects an index with more entries than the CLI reads", async () => {
		writeIndex(
			Array.from({ length: 501 }, (_, i) => ({
				id: `t${i}`,
				title: "T",
				description: "d",
				path: `t${i}/template.json`,
			})),
		);
		await expect(openRegistry({ kind: "dir", dir })).rejects.toThrow(
			/must NOT have more than 500 items/,
		);
	});
});

type Reply =
	| string
	| Buffer
	| {
			status: number;
			body?: string;
			location?: string;
			gate?: Promise<void>;
	  };

const serve = async (routes: Record<string, Reply>) => {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		const path = request.url ?? "/";
		requests.push(path);
		const reply = routes[path] ?? { status: 404, body: "Not found\n" };
		if (typeof reply === "string" || Buffer.isBuffer(reply)) {
			response.writeHead(200).end(reply);
			return;
		}
		void (reply.gate ?? Promise.resolve()).then(() =>
			response
				.writeHead(
					reply.status,
					reply.location ? { location: reply.location } : {},
				)
				.end(reply.body ?? ""),
		);
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
				categories: ["first-party"],
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
			/answered 404\. .* is cached and may still list a template that moved/,
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
		).rejects.toThrow(
			/redirected .*, and the CLI does not follow redirects\./,
		);
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

describe("githubFileUrl", () => {
	const raw = new URL(DEFAULT_GITHUB_RAW_URL);
	const github = { owner: "workos", repo: "neon-sync", ref: "main" };

	it("builds a raw GitHub URL under owner/repo/ref", () => {
		expect(githubFileUrl(raw, github, "template.json").href).toBe(
			"https://raw.githubusercontent.com/workos/neon-sync/main/template.json",
		);
		expect(
			githubFileUrl(
				raw,
				{ ...github, dir: "packages/fn" },
				"functions/index.ts",
			).href,
		).toBe(
			"https://raw.githubusercontent.com/workos/neon-sync/main/packages/fn/functions/index.ts",
		);
	});

	it("refuses a path that leaves the repo dir", () => {
		expect(() =>
			githubFileUrl(
				raw,
				{ ...github, dir: "packages/fn" },
				"../secret.ts",
			),
		).toThrow(/outside/);
	});

	it("refuses a dot segment the URL parser would resolve", () => {
		for (const ref of ["..", "release/../main"]) {
			expect(() =>
				githubFileUrl(raw, { ...github, ref }, "template.json"),
			).toThrow(/outside/);
		}
	});

	it("keeps a slash in the ref as a path separator", () => {
		expect(
			githubFileUrl(
				raw,
				{ ...github, ref: "release/v1" },
				"template.json",
			).href,
		).toBe(
			"https://raw.githubusercontent.com/workos/neon-sync/release/v1/template.json",
		);
	});

	it("keeps a mirror's path prefix and query", () => {
		expect(
			githubFileUrl(
				new URL("https://mirror.example.com/raw?sig=abc"),
				github,
				"template.json",
			).href,
		).toBe(
			"https://mirror.example.com/raw/workos/neon-sync/main/template.json?sig=abc",
		);
	});
});

describe("resolveGithubRawBase", () => {
	it("defaults to raw.githubusercontent.com and refuses plain HTTP except loopback", () => {
		expect(resolveGithubRawBase({}).href).toBe(
			`${DEFAULT_GITHUB_RAW_URL}/`,
		);
		expect(() =>
			resolveGithubRawBase({
				NEON_FUNCTION_REGISTRY_GITHUB: "http://example.com",
			}),
		).toThrow(/https/);
		expect(
			resolveGithubRawBase({
				NEON_FUNCTION_REGISTRY_GITHUB: "http://127.0.0.1:9",
			}).href,
		).toBe("http://127.0.0.1:9/");
	});
});

describe("openRegistry GitHub template sources", () => {
	let dir: string;
	let servers: Awaited<ReturnType<typeof serve>>[] = [];

	const start = async (routes: Record<string, Reply>) => {
		const server = await serve(routes);
		servers.push(server);
		return server;
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "neon-registry-github-"));
	});

	afterEach(async () => {
		rmSync(dir, { recursive: true, force: true });
		await Promise.all(servers.map((server) => server.close()));
		servers = [];
	});

	const writeIndex = (templates: unknown[]) =>
		writeFileSync(
			join(dir, "registry.json"),
			JSON.stringify({ templates }),
		);

	const partnerEntry = {
		id: "partner",
		title: "Partner",
		description: "A partner template.",
		path: "template.json",
		categories: ["first-party"],
		source: { github: { owner: "workos", repo: "neon-sync" } },
	};

	it("defaults ref to HEAD and loads files from GitHub, not the local tree", async () => {
		writeIndex([partnerEntry]);
		writeFileSync(
			join(dir, "template.json"),
			JSON.stringify({
				id: "partner",
				title: "Local",
				description: "Should not be read.",
				layout: "router",
			}),
		);
		const github = await start({
			"/workos/neon-sync/HEAD/template.json": JSON.stringify({
				id: "partner",
				title: "Partner",
				description: "From GitHub.",
				layout: "router",
			}),
			"/workos/neon-sync/HEAD/functions/index.ts": "export default 1;\n",
		});
		const registry = await openRegistry(
			{ kind: "dir", dir },
			{ githubRaw: github.url("/") },
		);
		const [entry] = registry.entries;
		if (!entry) throw new Error("partner entry did not parse");
		expect(entry.source).toEqual({
			github: { owner: "workos", repo: "neon-sync", ref: "HEAD" },
		});
		const loaded = await registry.load(entry);
		expect(loaded.template.description).toBe("From GitHub.");
		expect(loaded.sources.get("functions/index.ts")).toBe(
			"export default 1;\n",
		);
		expect(github.requests).toEqual([
			"/workos/neon-sync/HEAD/template.json",
			"/workos/neon-sync/HEAD/functions/index.ts",
		]);
	});

	it("reads from source.github.dir when set", async () => {
		writeIndex([
			{
				...partnerEntry,
				source: {
					github: {
						owner: "workos",
						repo: "neon-sync",
						ref: "v1.2.3",
						dir: "packages/fn",
					},
				},
			},
		]);
		const github = await start({
			"/workos/neon-sync/v1.2.3/packages/fn/template.json":
				JSON.stringify({
					id: "partner",
					title: "Partner",
					description: "Nested.",
					layout: "router",
				}),
			"/workos/neon-sync/v1.2.3/packages/fn/functions/index.ts":
				"export default 2;\n",
		});
		const registry = await openRegistry(
			{ kind: "dir", dir },
			{ githubRaw: github.url("/") },
		);
		const [entry] = registry.entries;
		if (!entry) throw new Error("partner entry did not parse");
		const loaded = await registry.load(entry);
		expect(loaded.sources.get("functions/index.ts")).toBe(
			"export default 2;\n",
		);
	});

	it("rejects a GitHub source that is not owner/repo", async () => {
		writeIndex([
			{
				...partnerEntry,
				source: {
					github: {
						owner: "https://github.com/workos",
						repo: "neon-sync",
					},
				},
			},
		]);
		await expect(openRegistry({ kind: "dir", dir })).rejects.toThrow(
			/owner/,
		);
	});

	it("does not treat a GitHub 404 as a stale neon.com index", async () => {
		writeIndex([partnerEntry]);
		const github = await start({});
		const registry = await openRegistry(
			{ kind: "dir", dir },
			{ githubRaw: github.url("/") },
		);
		const [entry] = registry.entries;
		if (!entry) throw new Error("partner entry did not parse");
		await expect(registry.load(entry)).rejects.toThrow(
			/GitHub \(workos\/neon-sync@HEAD\) answered 404\.$/,
		);
	});

	it("tells the user to set GITHUB_TOKEN when GitHub rate limits", async () => {
		writeIndex([partnerEntry]);
		const github = await start({
			"/workos/neon-sync/HEAD/template.json": { status: 429 },
		});
		const registry = await openRegistry(
			{ kind: "dir", dir },
			{ githubRaw: github.url("/") },
		);
		const [entry] = registry.entries;
		if (!entry) throw new Error("partner entry did not parse");
		await expect(registry.load(entry)).rejects.toThrow(
			/answered 429\. GitHub is rate limiting this network/,
		);
	});

	it("reads a branch name that contains a slash", async () => {
		writeIndex([
			{
				...partnerEntry,
				source: {
					github: {
						owner: "workos",
						repo: "neon-sync",
						ref: "release/v1",
					},
				},
			},
		]);
		const github = await start({
			"/workos/neon-sync/release/v1/template.json": JSON.stringify({
				id: "partner",
				title: "Partner",
				description: "Branch.",
				layout: "router",
			}),
			"/workos/neon-sync/release/v1/functions/index.ts":
				"export default 3;\n",
		});
		const registry = await openRegistry(
			{ kind: "dir", dir },
			{ githubRaw: github.url("/") },
		);
		const [entry] = registry.entries;
		if (!entry) throw new Error("partner entry did not parse");
		const loaded = await registry.load(entry);
		expect(loaded.sources.get("functions/index.ts")).toBe(
			"export default 3;\n",
		);
	});

	const manyFiles = (count: number, reply: (index: number) => Reply) => {
		const routes: Record<string, Reply> = {
			"/workos/neon-sync/HEAD/template.json": JSON.stringify({
				id: "partner",
				title: "Partner",
				description: "Many.",
				layout: "separate",
				operations: Array.from({ length: count }, (_, i) => ({
					id: `op${i}`,
					title: `Op ${i}`,
					description: "d",
					source: `functions/op${i}.ts`,
					slug: `op${i}`,
					recommended: true,
				})),
			}),
		};
		for (let i = 0; i < count; i++) {
			routes[`/workos/neon-sync/HEAD/functions/op${i}.ts`] = reply(i);
		}
		return routes;
	};

	const openPartner = async (routes: Record<string, Reply>) => {
		writeIndex([partnerEntry]);
		const github = await start(routes);
		const registry = await openRegistry(
			{ kind: "dir", dir },
			{ githubRaw: github.url("/") },
		);
		const [entry] = registry.entries;
		if (!entry) throw new Error("partner entry did not parse");
		return { github, load: () => registry.load(entry) };
	};

	it("reads six files at a time and starts none after the first failure", async () => {
		let release = () => {};
		const gate = new Promise<void>((done) => {
			release = done;
		});
		const { github, load } = await openPartner(
			manyFiles(12, (i) =>
				i === 0
					? { status: 500 }
					: { status: 200, body: `export default ${i};\n`, gate },
			),
		);
		await expect(load()).rejects.toThrow(/answered 500/);
		await vi.waitFor(() => expect(github.requests).toHaveLength(1 + 6));
		release();
		await new Promise((done) => setTimeout(done, 50));
		expect(github.requests).toHaveLength(1 + 6);
	});

	it("names the template when its files exceed the total size limit", async () => {
		const { load } = await openPartner(
			manyFiles(9, () => "x".repeat(250 * 1024)),
		);
		await expect(load()).rejects.toThrow(
			/Template "partner" source files exceed the 2097152-byte total limit\./,
		);
	});

	it("keeps a mirror's path prefix and query when loading", async () => {
		const { github } = await openPartner({});
		const registry = await openRegistry(
			{ kind: "dir", dir },
			{ githubRaw: github.url("/mirror/raw?sig=1") },
		);
		const [entry] = registry.entries;
		if (!entry) throw new Error("partner entry did not parse");
		await expect(registry.load(entry)).rejects.toThrow(/answered 404/);
		expect(github.requests).toEqual([
			"/mirror/raw/workos/neon-sync/HEAD/template.json?sig=1",
		]);
	});

	it("only fails partner templates when the GitHub mirror setting is invalid", async () => {
		writeIndex([
			{
				id: "local",
				title: "Local",
				description: "d",
				path: "local/template.json",
				categories: ["first-party"],
			},
			partnerEntry,
		]);
		mkdirSync(join(dir, "local/functions"), { recursive: true });
		writeFileSync(
			join(dir, "local/template.json"),
			JSON.stringify({
				id: "local",
				title: "Local",
				description: "d",
				layout: "router",
			}),
		);
		writeFileSync(join(dir, "local/functions/index.ts"), "export {};\n");
		const registry = await openRegistry(
			{ kind: "dir", dir },
			{ env: { NEON_FUNCTION_REGISTRY_GITHUB: "http://example.com" } },
		);
		const [local, partner] = registry.entries;
		if (!local || !partner) throw new Error("entries did not parse");
		await expect(registry.load(local)).resolves.toMatchObject({
			template: { id: "local" },
		});
		await expect(registry.load(partner)).rejects.toThrow(
			/NEON_FUNCTION_REGISTRY_GITHUB must be an https:\/\/ URL/,
		);
	});

	it("rejects a ref of . or .. or a dot segment", async () => {
		for (const ref of [".", "..", "release/../main", "release//v1"]) {
			writeIndex([
				{
					...partnerEntry,
					source: {
						github: { owner: "workos", repo: "neon-sync", ref },
					},
				},
			]);
			await expect(openRegistry({ kind: "dir", dir })).rejects.toThrow(
				/ref/,
			);
		}
	});
});

type TarEntry = string | { symlink: string };

const tarGz = (entries: Record<string, TarEntry>): Buffer => {
	const blocks: Buffer[] = [];
	for (const [name, entry] of Object.entries(entries)) {
		const body = Buffer.from(typeof entry === "string" ? entry : "");
		const header = Buffer.alloc(512);
		header.write(name, 0);
		header.write("0000644\0", 100);
		header.write("0000000\0", 108);
		header.write("0000000\0", 116);
		header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
		header.write("00000000000\0", 136);
		header.write("        ", 148);
		header.write(typeof entry === "string" ? "0" : "2", 156);
		if (typeof entry !== "string") header.write(entry.symlink, 157);
		header.write("ustar\0", 257);
		header.write("00", 263);
		let sum = 0;
		for (const byte of header) sum += byte;
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		blocks.push(
			header,
			body,
			Buffer.alloc((512 - (body.length % 512)) % 512),
		);
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.from(gzipSync(new Uint8Array(Buffer.concat(blocks))));
};

describe("openRegistry reads neondatabase/examples from one tarball", () => {
	const TARBALL = "/neondatabase/examples/tar.gz/main";
	const demoTemplate = JSON.stringify({
		id: "demo",
		title: "Demo",
		description: "A demo.",
		layout: "router",
	});
	const index = JSON.stringify({
		templates: [
			{
				id: "demo",
				title: "Demo",
				description: "A demo.",
				path: "demo/template.json",
				categories: ["first-party"],
			},
			{
				id: "partner",
				title: "Partner",
				description: "A partner template.",
				path: "template.json",
				categories: ["first-party"],
				source: { github: { owner: "workos", repo: "neon-sync" } },
			},
		],
	});
	let servers: Awaited<ReturnType<typeof serve>>[] = [];

	const start = async (routes: Record<string, Reply>) => {
		const server = await serve(routes);
		servers.push(server);
		return server;
	};

	const open = async (
		tarball: Reply,
		rawRoutes: Record<string, Reply> = {},
	) => {
		const primary = await start({ "/registry.json": index });
		const codeload = await start({ [TARBALL]: tarball });
		const raw = await start({
			"/workos/neon-sync/HEAD/template.json": JSON.stringify({
				id: "partner",
				title: "Partner",
				description: "From GitHub.",
				layout: "router",
			}),
			"/workos/neon-sync/HEAD/functions/index.ts": "export default 2;\n",
			...rawRoutes,
		});
		const registry = await openRegistry(undefined, {
			primary: primary.url("/registry.json"),
			env: { NEON_BOOTSTRAP_GITHUB_CODELOAD: codeload.url("") },
			githubRaw: raw.url("/"),
		});
		const entry = (id: string) => {
			const found = registry.entries.find(
				(candidate) => candidate.id === id,
			);
			if (!found) throw new Error(`${id} entry did not parse`);
			return found;
		};
		return { registry, entry, primary, codeload, raw };
	};

	afterEach(async () => {
		await Promise.all(servers.map((server) => server.close()));
		servers = [];
	});

	it("falls back to raw GitHub file by file when the archive download fails", async () => {
		const { registry, entry, codeload, raw } = await open(
			{ status: 500 },
			{
				"/neondatabase/examples/main/registry/demo/template.json":
					demoTemplate,
				"/neondatabase/examples/main/registry/demo/functions/index.ts":
					"export default 3;\n",
			},
		);
		const demo = await registry.load(entry("demo"));
		expect(demo.sources.get("functions/index.ts")).toBe(
			"export default 3;\n",
		);
		await registry.load(entry("demo"));
		expect(codeload.requests).toEqual([TARBALL]);
		expect(raw.requests).toHaveLength(4);
	});

	it("keeps the stale-index hint when the fallback cannot find a template", async () => {
		const { registry, entry } = await open({ status: 500 });
		await expect(registry.load(entry("demo"))).rejects.toThrow(
			/answered 404\. .* is cached/,
		);
	});

	it("downloads the archive once and leaves partner templates on raw GitHub", async () => {
		const { registry, entry, primary, codeload, raw } = await open(
			tarGz({
				"examples-main/registry/demo/template.json": demoTemplate,
				"examples-main/registry/demo/functions/index.ts":
					"export default 1;\n",
				"examples-main/with-hono/package.json": "{}",
			}),
		);
		const demo = await registry.load(entry("demo"));
		expect(demo.sources.get("functions/index.ts")).toBe(
			"export default 1;\n",
		);
		await registry.load(entry("demo"));
		const partner = await registry.load(entry("partner"));
		expect(partner.sources.get("functions/index.ts")).toBe(
			"export default 2;\n",
		);
		expect(primary.requests).toEqual(["/registry.json"]);
		expect(codeload.requests).toEqual([TARBALL]);
		expect(raw.requests).toEqual([
			"/workos/neon-sync/HEAD/template.json",
			"/workos/neon-sync/HEAD/functions/index.ts",
		]);
	});

	it("says the cached index may be stale when the archive lacks a template", async () => {
		const { registry, entry } = await open(
			tarGz({ "examples-main/with-hono/package.json": "{}" }),
		);
		await expect(registry.load(entry("demo"))).rejects.toThrow(
			/not found in neondatabase\/examples@main\. .* is cached/,
		);
	});

	it("refuses a symlink in the archive", async () => {
		const { registry, entry } = await open(
			tarGz({
				"examples-main/registry/demo/template.json": demoTemplate,
				"examples-main/registry/demo/functions/index.ts": {
					symlink: "../../secret.ts",
				},
			}),
		);
		await expect(registry.load(entry("demo"))).rejects.toThrow(
			/not a regular file/,
		);
	});
});
