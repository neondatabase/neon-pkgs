import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getRequestListener } from "@hono/node-server";

import {
	createUpgradeListener,
	installWebSocketBridge,
	type UpgradeHandler,
} from "./websocket.js";

/**
 * A WHATWG fetch-style handler: takes a Request, returns a Response. The single
 * shape the local dev server and the deployed Neon Functions runtime both speak.
 */
export type FetchHandler = (req: Request) => Response | Promise<Response>;

type UserModule = Record<string, unknown>;

const isFunction = (value: unknown): value is FetchHandler =>
	typeof value === "function";

const hasFetchMethod = (
	value: unknown,
): value is { fetch: (req: Request) => Response | Promise<Response> } =>
	typeof value === "object" &&
	value !== null &&
	"fetch" in value &&
	typeof (value as { fetch: unknown }).fetch === "function";

/**
 * Resolve the user's exported handler to a single fetch callback.
 *
 * Resolution order (first match wins):
 *   1. `export default { fetch }`      — Workers / Neon Functions style
 *   2. `export default function (req)` — bare (async) default function
 */
export const resolveFetchHandler = (mod: UserModule): FetchHandler => {
	const defaultExport = mod.default;

	if (hasFetchMethod(defaultExport)) {
		const target = defaultExport;
		return (req) => target.fetch(req);
	}

	if (isFunction(defaultExport)) {
		return defaultExport;
	}

	throw new Error(
		"No request handler found in the source module. Export one of:\n" +
			"  export default { fetch(req) { /* ... */ } }\n" +
			"  export default function (req) { /* ... */ }",
	);
};

const hasUpgradeMethod = (
	value: unknown,
): value is { upgrade: UpgradeHandler } =>
	typeof value === "object" &&
	value !== null &&
	"upgrade" in value &&
	typeof (value as { upgrade: unknown }).upgrade === "function";

/**
 * Resolve the user's optional WebSocket entrypoint: a named `export function upgrade`,
 * or an `upgrade` method on the default export. `undefined` when the module has
 * neither, which is the common case — a function without one either uses
 * `upgradeWebSocket()` inside `fetch` or serves no WebSockets at all.
 *
 * Resolution order matches the deployed runtime exactly (named export first, then the
 * default-export method), so a module that resolves one way locally cannot resolve the
 * other way once deployed.
 */
export const resolveUpgradeHandler = (
	mod: UserModule,
): UpgradeHandler | undefined => {
	if (typeof mod.upgrade === "function") return mod.upgrade as UpgradeHandler;
	const defaultExport = mod.default;
	if (hasUpgradeMethod(defaultExport)) {
		const target = defaultExport;
		return (req, socket, head) => target.upgrade(req, socket, head);
	}
	return undefined;
};

/**
 * Wrap a fetch handler so user errors become a 500 response (with the message
 * in the body during dev) instead of crashing the child process.
 */
export const withErrorBoundary = (handler: FetchHandler): FetchHandler => {
	return async (req) => {
		try {
			return await handler(req);
		} catch (err) {
			const message =
				err instanceof Error ? (err.stack ?? err.message) : String(err);
			process.stderr.write(
				`Request handler threw an error:\n${message}\n`,
			);
			return new Response(`Internal Server Error\n\n${message}`, {
				status: 500,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}
	};
};

/**
 * How the runtime picks its port:
 *   - `explicit`: bind this exact port and crash on conflict (an explicit choice
 *     — `--port` or an injected `PORT` — that is taken is an error).
 *   - `search`: walk upward from `from` until a free port is found; never crash.
 */
export type PortSelection =
	| { mode: "explicit"; port: number }
	| { mode: "search"; from: number };

export type StartRuntimeOptions = {
	source: string;
	port: PortSelection;
	hostname?: string;
};

const isAddressInUse = (err: unknown): boolean =>
	typeof err === "object" &&
	err !== null &&
	(err as { code?: unknown }).code === "EADDRINUSE";

const DEFAULT_SEARCH_BASE = 8787;
const MAX_SEARCH_STEPS = 100;

const bindPort = async (
	server: Server,
	selection: PortSelection,
	hostname: string | undefined,
): Promise<number> => {
	if (selection.mode === "explicit") {
		return listen(server, selection.port, hostname);
	}
	for (let step = 0; step < MAX_SEARCH_STEPS; step++) {
		try {
			return await listen(server, selection.from + step, hostname);
		} catch (err) {
			if (!isAddressInUse(err)) throw err;
		}
	}
	throw new Error(
		`Could not find a free port in ${selection.from}-${
			selection.from + MAX_SEARCH_STEPS - 1
		}`,
	);
};

const listen = (
	server: Server,
	port: number,
	hostname?: string,
): Promise<number> =>
	new Promise<number>((resolveListen, rejectListen) => {
		const onError = (err: Error): void => {
			server.off("listening", onListening);
			rejectListen(err);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolveListen((server.address() as AddressInfo).port);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, hostname);
	});

/**
 * Load the (already-bundled) user module, build the listener, and start an HTTP
 * server. Announces the bound port on stdout as `neon-dev:ready <port>` so the
 * parent can render the URL. Resolves with the bound port.
 */
export const startRuntime = async ({
	source,
	port,
	hostname,
}: StartRuntimeOptions): Promise<number> => {
	const absoluteSource = resolve(process.cwd(), source);
	const mod = (await import(
		pathToFileURL(absoluteSource).href
	)) as UserModule;
	const fetchHandler = resolveFetchHandler(mod);
	const handler = withErrorBoundary(fetchHandler);

	// Publish the bridge `upgradeWebSocket()` reads before the user module can serve a
	// request, so the helper resolves locally exactly as it does when deployed.
	installWebSocketBridge();

	const listener = getRequestListener(handler, { hostname });
	const server = createServer((incoming, outgoing) => {
		void listener(incoming, outgoing);
	});

	// Node emits 'upgrade' rather than 'request' for a WebSocket handshake. Without
	// this listener Node hands the handshake to the ordinary request handler, which
	// answers 200 on a connection the client expects to be a 101 — so a function's
	// WebSocket code silently never ran under `neon dev`.
	//
	// The upgrade path takes the RAW handler, not the error-boundary-wrapped one. The
	// boundary turns a throw into a 500 Response, which on this path is
	// indistinguishable from a handler that deliberately declined the upgrade — so a
	// crashing handler would answer 501 ("no WebSocket support") instead of surfacing
	// the error. The upgrade listener has its own equivalent boundary, and reports a
	// throw as the 502 the deployed runtime returns.
	server.on(
		"upgrade",
		createUpgradeListener({
			fetch: fetchHandler,
			upgrade: resolveUpgradeHandler(mod),
		}),
	);

	const boundPort = await bindPort(server, port, hostname);
	process.stdout.write(`neon-dev:ready ${boundPort}\n`);
	return boundPort;
};

/**
 * Build a {@link PortSelection} from the environment. Precedence:
 *   1. `NEON_DEV_PORT` -> explicit bind (crash if taken). Set by `neon dev` from an
 *      explicit `--port` / `dev.port`.
 *   2. `PORT`          -> explicit bind. A bare `PORT=3000 neon dev` sets this, so the
 *      runtime binds the port chosen for it.
 *   3. otherwise        -> search upward from `NEON_DEV_PORT_BASE` (or the default base).
 */
export const portSelectionFromEnv = (env: NodeJS.ProcessEnv): PortSelection => {
	const explicit = env.NEON_DEV_PORT;
	if (explicit !== undefined && explicit !== "") {
		return { mode: "explicit", port: parsePort(explicit, "NEON_DEV_PORT") };
	}
	const injected = env.PORT;
	if (injected !== undefined && injected !== "") {
		return { mode: "explicit", port: parsePort(injected, "PORT") };
	}
	const base = Number(env.NEON_DEV_PORT_BASE ?? DEFAULT_SEARCH_BASE);
	return {
		mode: "search",
		from: Number.isInteger(base) ? base : DEFAULT_SEARCH_BASE,
	};
};

const parsePort = (value: string, varName: string): number => {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`Invalid ${varName}: "${value}"`);
	}
	return port;
};

const isDirectExecution = (): boolean => {
	const entry = process.argv[1];
	if (!entry) return false;
	return import.meta.url === pathToFileURL(entry).href;
};

if (isDirectExecution()) {
	const source = process.env.NEON_DEV_SOURCE ?? process.argv[2];
	if (!source) {
		process.stderr.write("neon-dev runtime: missing source path\n");
		process.exit(1);
	}
	startRuntime({ source, port: portSelectionFromEnv(process.env) }).catch(
		(err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`neon-dev runtime failed to start: ${msg}\n`);
			process.exit(1);
		},
	);
}
