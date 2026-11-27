import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";

import {
	createDevRequestListener,
	type FetchHandler,
	portSelectionFromEnv,
	resolveFetchHandler,
	resolveUpgradeHandler,
	withErrorBoundary,
} from "./runtime.js";

describe("resolveFetchHandler", () => {
	it("picks `export default { fetch }`", async () => {
		const response = new Response("from fetch object");
		const handler = resolveFetchHandler({
			default: { fetch: () => response },
		});
		const result = await handler(new Request("http://localhost/"));
		expect(result).toBe(response);
	});

	it("picks `export default function`", async () => {
		const response = new Response("from default function");
		const handler = resolveFetchHandler({
			default: () => response,
		});
		const result = await handler(new Request("http://localhost/"));
		expect(result).toBe(response);
	});

	it("throws a helpful error when no handler is present", () => {
		expect(() => resolveFetchHandler({})).toThrow(
			/No request handler found/,
		);
	});

	it("throws when only a named `handler` export exists (named handler is not supported)", () => {
		expect(() =>
			resolveFetchHandler({ handler: () => new Response("named") }),
		).toThrow(/No request handler found/);
	});
});

describe("resolveUpgradeHandler", () => {
	// Resolution order must match the deployed runtime's: a named export first, then
	// an `upgrade` method on the default export.
	const req = {} as Parameters<
		NonNullable<ReturnType<typeof resolveUpgradeHandler>>
	>[0];
	const socket = {} as Parameters<
		NonNullable<ReturnType<typeof resolveUpgradeHandler>>
	>[1];
	const head = Buffer.alloc(0);

	it("picks a named `export function upgrade`", () => {
		let called = false;
		const handler = resolveUpgradeHandler({
			upgrade: () => {
				called = true;
			},
		});
		handler?.(req, socket, head);
		expect(called).toBe(true);
	});

	it("picks an `upgrade` method on the default export", () => {
		let called = false;
		const handler = resolveUpgradeHandler({
			default: {
				fetch: () => new Response("x"),
				upgrade: () => {
					called = true;
				},
			},
		});
		handler?.(req, socket, head);
		expect(called).toBe(true);
	});

	it("prefers the named export over the default-export method", () => {
		const calls: string[] = [];
		const handler = resolveUpgradeHandler({
			upgrade: () => calls.push("named"),
			default: { upgrade: () => calls.push("default") },
		});
		handler?.(req, socket, head);
		expect(calls).toEqual(["named"]);
	});

	it("calls the default-export method with `this` bound to the object", () => {
		// A bundle written as `export default { upgrade() { this.handle(...) } }` must
		// not lose its receiver.
		let receiver: unknown = null;
		const target = {
			marker: "the-object",
			upgrade(): void {
				receiver = this;
			},
		};
		resolveUpgradeHandler({ default: target })?.(req, socket, head);
		expect(receiver).toBe(target);
	});

	it("returns undefined when the module has no upgrade export", () => {
		expect(
			resolveUpgradeHandler({
				default: { fetch: () => new Response("x") },
			}),
		).toBeUndefined();
		expect(
			resolveUpgradeHandler({ default: () => new Response("x") }),
		).toBeUndefined();
		expect(resolveUpgradeHandler({})).toBeUndefined();
	});

	it("ignores a non-function `upgrade`", () => {
		expect(
			resolveUpgradeHandler({ upgrade: "not a function" }),
		).toBeUndefined();
		expect(
			resolveUpgradeHandler({ default: { upgrade: 42 } }),
		).toBeUndefined();
	});
});

describe("withErrorBoundary", () => {
	it("turns a thrown error into a 500 whose body contains the message", async () => {
		const boundary = withErrorBoundary(() => {
			throw new Error("boom from the user handler");
		});
		const res = await boundary(new Request("http://localhost/"));
		expect(res.status).toBe(500);
		const body = await res.text();
		expect(body).toContain("boom from the user handler");
	});

	it("passes a successful response through unchanged", async () => {
		const ok = new Response("all good", { status: 201 });
		const boundary = withErrorBoundary(() => ok);
		const res = await boundary(new Request("http://localhost/"));
		expect(res).toBe(ok);
		expect(res.status).toBe(201);
	});
});

describe("portSelectionFromEnv", () => {
	it("returns an explicit selection when NEON_DEV_PORT is set", () => {
		expect(portSelectionFromEnv({ NEON_DEV_PORT: "3000" })).toEqual({
			mode: "explicit",
			port: 3000,
		});
	});

	it("searches from the default base when NEON_DEV_PORT is empty", () => {
		expect(portSelectionFromEnv({ NEON_DEV_PORT: "" })).toEqual({
			mode: "search",
			from: 8787,
		});
	});

	it("searches from the default base when NEON_DEV_PORT is unset", () => {
		expect(portSelectionFromEnv({})).toEqual({
			mode: "search",
			from: 8787,
		});
	});

	it("respects NEON_DEV_PORT_BASE when searching", () => {
		expect(portSelectionFromEnv({ NEON_DEV_PORT_BASE: "4000" })).toEqual({
			mode: "search",
			from: 4000,
		});
	});

	it("keeps the parent's search over a PORT loaded from dotenv files", () => {
		expect(
			portSelectionFromEnv({ NEON_DEV_PORT_BASE: "8787", PORT: "0" }),
		).toEqual({ mode: "search", from: 8787 });
	});

	it("throws on an invalid NEON_DEV_PORT", () => {
		expect(() =>
			portSelectionFromEnv({ NEON_DEV_PORT: "not-a-port" }),
		).toThrow(/Invalid NEON_DEV_PORT/);
	});

	it("binds an injected PORT (e.g. PORT=3000) when NEON_DEV_PORT is unset", () => {
		expect(portSelectionFromEnv({ PORT: "4123" })).toEqual({
			mode: "explicit",
			port: 4123,
		});
	});

	it("prefers NEON_DEV_PORT over PORT", () => {
		expect(
			portSelectionFromEnv({ NEON_DEV_PORT: "3000", PORT: "4123" }),
		).toEqual({ mode: "explicit", port: 3000 });
	});

	it("throws on an invalid PORT", () => {
		expect(() => portSelectionFromEnv({ PORT: "nope" })).toThrow(
			/Invalid PORT/,
		);
	});
});

// Captured before any listener is built, the way a framework captures it when the
// user module is imported ahead of the dev server (h3 v2, through srvx).
const PlatformResponse = globalThis.Response;
const platformGlobals = {
	Request: Object.getOwnPropertyDescriptor(globalThis, "Request"),
	Response: Object.getOwnPropertyDescriptor(globalThis, "Response"),
};

describe("createDevRequestListener round-trip", () => {
	let server: Server | null = null;

	afterEach(async () => {
		if (server) {
			const toClose = server;
			server = null;
			await new Promise<void>((resolve, reject) => {
				toClose.close((err) => {
					if (err)
						reject(
							err instanceof Error ? err : new Error(String(err)),
						);
					else resolve();
				});
			});
		}
	});

	const start = async (
		handler: FetchHandler,
		createListener: (
			handler: FetchHandler,
		) => ReturnType<
			typeof createDevRequestListener
		> = createDevRequestListener,
	): Promise<number> => {
		const listener = createListener(handler);
		const created = createServer((incoming, outgoing) => {
			void listener(incoming, outgoing);
		});
		server = created;
		return new Promise<number>((resolve, reject) => {
			created.once("error", reject);
			created.listen(0, () => {
				resolve((created.address() as AddressInfo).port);
			});
		});
	};

	it("round-trips a request through the runtime helpers", async () => {
		const handler = withErrorBoundary(
			resolveFetchHandler({
				default: {
					fetch: (req: Request) =>
						new Response(
							`hello from ${new URL(req.url).pathname}`,
							{
								status: 200,
								headers: { "x-neon-dev": "runtime" },
							},
						),
				},
			}),
		);

		const port = await start(handler);
		const res = await fetch(`http://127.0.0.1:${port}/greet`);

		expect(res.status).toBe(200);
		expect(res.headers.get("x-neon-dev")).toBe("runtime");
		await expect(res.text()).resolves.toBe("hello from /greet");
	});

	// The shape of h3 v2's error path: build a Response from the class captured at
	// import time, then return it only if it is `instanceof Response` and stringify it
	// otherwise.
	const instanceofCheckingHandler = (): FetchHandler =>
		withErrorBoundary(
			resolveFetchHandler({
				default: {
					fetch: () => {
						const built = new PlatformResponse("teapot", {
							status: 418,
						});
						return built instanceof Response
							? built
							: new PlatformResponse(String(built));
					},
				},
			}),
		);

	it("keeps the platform Response global, so instanceof checks hold as when deployed", async () => {
		const port = await start(instanceofCheckingHandler());
		const res = await fetch(`http://127.0.0.1:${port}/teapot`);

		expect(globalThis.Response).toBe(PlatformResponse);
		expect(res.status).toBe(418);
		await expect(res.text()).resolves.toBe("teapot");
	});

	it("fails that check with @hono/node-server's default options, which is why createDevRequestListener opts out", async () => {
		// Control for the test above. If this starts failing, @hono/node-server no
		// longer replaces the globals by default and `overrideGlobalObjects: false`
		// can go. The default options redefine the globals for the whole worker, so
		// put the platform ones back before any other test runs.
		try {
			const port = await start(instanceofCheckingHandler(), (handler) =>
				getRequestListener(handler),
			);
			const res = await fetch(`http://127.0.0.1:${port}/teapot`);

			expect(globalThis.Response).not.toBe(PlatformResponse);
			expect(res.status).toBe(200);
			await expect(res.text()).resolves.toBe("[object Response]");
		} finally {
			for (const [name, descriptor] of Object.entries(platformGlobals)) {
				if (descriptor)
					Object.defineProperty(globalThis, name, descriptor);
			}
		}
		expect(globalThis.Response).toBe(PlatformResponse);
	});
});
