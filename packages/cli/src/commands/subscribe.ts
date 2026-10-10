import type { NeonApi } from "@neon/config";
import type {
	LiveQueryChange,
	LiveQueryState,
	MaterializedLiveQuerySubscription,
	RawLiveQueryRow,
	RawLiveQuerySubscription,
} from "@neon/realtime";
import YAML from "yaml";
import type yargs from "yargs";
import { resolveNeonEnvVars } from "../dev/env.js";
import type { BranchScopeProps } from "../types.js";
import { branchIdFromProps, fillSingleProject } from "../utils/enrichers.js";
import { writer } from "../writer.js";

type QueryRow = Record<string, unknown>;

export type SubscribeProps = BranchScopeProps & {
	query: string;
	changes: boolean;
	cwd?: string;
	/** Injected NeonApi adapter for operation tests. */
	runtimeApi?: NeonApi;
	/** Overrides stdout for operation tests and embedding. */
	out?: NodeJS.WritableStream;
	/** Ends the otherwise long-running subscription. */
	signal?: AbortSignal;
};

type RealtimeConnectionOptions = {
	url: string;
	secret: string;
	database: string;
};

type DirectSubscriber = {
	subscribeMaterialized(
		query: string,
	): Promise<MaterializedLiveQuerySubscription<QueryRow>>;
	subscribeChanges(
		query: string,
	): Promise<RawLiveQuerySubscription<QueryRow>>;
	close(): void;
};

export type SubscribeDependencies = {
	resolveBranchId?: typeof branchIdFromProps;
	resolveEnv?: typeof resolveNeonEnvVars;
	connect?: (options: RealtimeConnectionOptions) => Promise<DirectSubscriber>;
};

type SubscribeEvent =
	| { type: "snapshot"; rows: readonly QueryRow[] }
	| { type: "reset"; rows: readonly RawLiveQueryRow<QueryRow>[] }
	| {
			type: "batch";
			txids: readonly string[];
			changes: readonly LiveQueryChange<QueryRow>[];
	  };

export const command = "subscribe <query>";
export const describe = "Subscribe to a live SQL query with Neon Realtime";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage('$0 subscribe "<query>" [options]')
		.positional("query", {
			describe: "SELECT query to subscribe to",
			type: "string",
		})
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
			branch: {
				describe: "Branch ID or name",
				type: "string",
			},
			changes: {
				describe:
					"Show raw resets and transaction batches instead of full query results",
				type: "boolean",
				default: false,
			},
		})
		.example(
			'$0 subscribe "SELECT * FROM items"',
			"Print the full result whenever it changes",
		)
		.example(
			'$0 subscribe --changes "SELECT * FROM items"',
			"Print raw reset and delta events",
		)
		.epilogue(
			"The subscription runs until interrupted. JSON output is newline-delimited; YAML output uses one document per event.",
		)
		.middleware(fillSingleProject as never)
		.strict();

export const handler = async (props: SubscribeProps): Promise<void> => {
	const controller = new AbortController();
	const stop = (exitCode: number) => {
		controller.abort();
		// Let subscribe() unsubscribe and close its WebSocket in the current
		// microtask turn, then exit even when the peer never completes the close
		// handshake and the socket would otherwise keep Node alive.
		setImmediate(() => process.exit(exitCode));
	};
	const onSigint = () => stop(130);
	const onSigterm = () => stop(143);
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	try {
		await subscribe({ ...props, signal: controller.signal });
	} finally {
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGTERM", onSigterm);
	}
};

/** Resolve Realtime credentials and stream one live SQL query until interrupted. */
export const subscribe = async (
	props: SubscribeProps,
	dependencies: SubscribeDependencies = {},
): Promise<void> => {
	const resolveBranchId = dependencies.resolveBranchId ?? branchIdFromProps;
	const resolveEnv = dependencies.resolveEnv ?? resolveNeonEnvVars;
	const connect = dependencies.connect ?? connectRealtime;
	const branchId = await resolveBranchId(props);
	const { vars } = await resolveEnv({
		cwd: props.cwd ?? process.cwd(),
		contextFile: props.contextFile,
		projectId: props.projectId,
		branchId,
		apiKey: props.apiKey,
		apiHost: props.apiHost,
		services: ["realtime"],
		...(props.runtimeApi ? { api: props.runtimeApi } : {}),
	});

	const url = requiredEnv(vars, "NEON_REALTIME_URL");
	const secret = requiredEnv(vars, "NEON_REALTIME_SECRET");
	const database = requiredEnv(vars, "NEON_DATABASE_NAME");
	const realtime = await connect({ url, secret, database });
	const render = createRenderer(props);
	let subscription: RawLiveQuerySubscription<QueryRow> | undefined;
	try {
		if (props.changes) {
			subscription = await realtime.subscribeChanges(props.query);
			await consumeChanges(subscription, render, props.signal);
		} else {
			const materialized = await realtime.subscribeMaterialized(
				props.query,
			);
			subscription = materialized;
			await consumeSnapshots(materialized, render, props.signal);
		}
	} finally {
		subscription?.unsubscribe();
		realtime.close();
	}
};

const connectRealtime = async (
	options: RealtimeConnectionOptions,
): Promise<DirectSubscriber> => {
	await ensureWebSocket();
	const { createRealtime, rawSql } = await import("@neon/realtime");
	const realtime = createRealtime({
		url: options.url,
		secret: options.secret,
		db: options.database,
	});
	return {
		subscribeMaterialized: (query) =>
			realtime.subscribe(rawSql<QueryRow>(query)),
		subscribeChanges: (query) =>
			realtime.subscribe(rawSql<QueryRow>(query), {
				materialize: false,
			}),
		close: () => realtime.close(),
	};
};

/** Node 20 does not expose WebSocket without an experimental flag. */
const ensureWebSocket = async (): Promise<void> => {
	if (typeof globalThis.WebSocket !== "undefined") return;
	const { WebSocket } = await import("undici");
	Object.defineProperty(globalThis, "WebSocket", {
		configurable: true,
		writable: true,
		value: WebSocket,
	});
};

const requiredEnv = (
	vars: Record<string, string>,
	key: "NEON_REALTIME_URL" | "NEON_REALTIME_SECRET" | "NEON_DATABASE_NAME",
): string => {
	const value = vars[key];
	if (value) return value;
	throw new Error(`Could not resolve ${key} for the selected branch.`);
};

type Renderer = (event: SubscribeEvent) => void;

const createRenderer = (
	props: Pick<SubscribeProps, "output" | "out">,
): Renderer => {
	const out = props.out ?? process.stdout;
	let renderedTableFrame = false;
	return (event) => {
		if (props.output === "json") {
			out.write(`${JSON.stringify(event)}\n`);
			return;
		}
		if (props.output === "yaml") {
			out.write(`---\n${YAML.stringify(event)}`);
			return;
		}
		if (renderedTableFrame) out.write("\n");
		renderedTableFrame = true;
		renderTableEvent(out, event);
	};
};

const renderTableEvent = (
	out: NodeJS.WritableStream,
	event: SubscribeEvent,
): void => {
	if (event.type === "snapshot") {
		const fields = rowFields(event.rows);
		writer({ output: "table", out }).end(event.rows as QueryRow[], {
			fields: fields as never,
			humanTitle: "Query result",
			emptyMessage: "Query returned no rows.",
		});
		return;
	}
	if (event.type === "reset") {
		const rows = event.rows.map(({ rowId, row }) => ({
			row_id: rowId,
			row,
		}));
		writer({ output: "table", out }).end(rows, {
			fields: ["row_id", "row"],
			humanTitle: "Reset",
			emptyMessage: "Reset contains no rows.",
		});
		return;
	}
	const rows = event.changes.map((change) => ({
		type: change.type,
		row_id: change.rowId,
		row: change.type === "upsert" ? change.row : undefined,
	}));
	writer({ output: "table", out }).end(rows, {
		fields: ["type", "row_id", "row"],
		humanTitle: `Batch (txids: ${event.txids.join(", ") || "none"})`,
		emptyMessage: "Batch contains no row changes.",
	});
};

const rowFields = (rows: readonly QueryRow[]): string[] => {
	const seen = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) seen.add(key);
	}
	return [...seen];
};

const consumeSnapshots = async (
	subscription: MaterializedLiveQuerySubscription<QueryRow>,
	render: Renderer,
	signal?: AbortSignal,
): Promise<void> =>
	consumeSubscription(
		subscription,
		(fail) => [
			subscription.onReset(() =>
				attempt(fail, () => {
					const rows = subscription.getSnapshot().data;
					if (rows !== undefined) render({ type: "snapshot", rows });
				}),
			),
			subscription.onBatch(() =>
				attempt(fail, () => {
					const rows = subscription.getSnapshot().data;
					if (rows !== undefined) render({ type: "snapshot", rows });
				}),
			),
		],
		signal,
	);

const consumeChanges = async (
	subscription: RawLiveQuerySubscription<QueryRow>,
	render: Renderer,
	signal?: AbortSignal,
): Promise<void> =>
	consumeSubscription(
		subscription,
		(fail) => [
			subscription.onReset((rows) =>
				attempt(fail, () => render({ type: "reset", rows })),
			),
			subscription.onBatch((changes, batch) =>
				attempt(fail, () =>
					render({ type: "batch", txids: batch.txids, changes }),
				),
			),
		],
		signal,
	);

const consumeSubscription = (
	subscription: RawLiveQuerySubscription<QueryRow>,
	listenForData: (fail: (error: unknown) => void) => Array<() => void>,
	signal?: AbortSignal,
): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		let settled = false;
		let detachData: Array<() => void> = [];
		let detachState: () => void = () => undefined;
		const onAbort = () => finish(resolve);
		const finish = (settle: (value?: never) => void, error?: unknown) => {
			if (settled) return;
			settled = true;
			for (const detach of detachData) detach();
			detachState();
			signal?.removeEventListener("abort", onAbort);
			settle(error as never);
		};
		const fail = (error: unknown) => finish(reject, error);
		const onState = (state: LiveQueryState) => {
			if (state.status === "error") fail(state.error);
			else if (state.status === "closed") finish(resolve);
		};

		detachData = listenForData(fail);
		detachState = subscription.onStateChange(onState);
		signal?.addEventListener("abort", onAbort, { once: true });
		onState(subscription.getState());
		if (signal?.aborted) onAbort();
	});

const attempt = (fail: (error: unknown) => void, action: () => void): void => {
	try {
		action();
	} catch (error) {
		fail(error);
	}
};
