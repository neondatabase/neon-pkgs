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
import { branchIdFromProps } from "../utils/enrichers.js";
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
	now?: () => Date;
};

type SubscribeEvent =
	| { type: "status"; state: LiveQueryState }
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
		.usage('$0 realtime subscribe "<query>" [options]')
		.positional("query", {
			describe: "SELECT query to subscribe to",
			type: "string",
		})
		.options({
			changes: {
				describe: "Show raw resets and transaction batches",
				type: "boolean",
				default: false,
			},
		})
		.example(
			'$0 realtime subscribe "SELECT * FROM items"',
			"Print the initial result followed by a readable transaction log",
		)
		.example(
			'$0 realtime subscribe --changes "SELECT * FROM items"',
			"Print raw reset and delta events",
		)
		.epilogue(
			"The subscription runs until interrupted. Terminal output is an append-only snapshot and transaction log; JSON output is newline-delimited; YAML output uses one document per event.",
		)
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
	const now = dependencies.now ?? (() => new Date());
	const branchId = await resolveBranchId(props);
	const { vars } = await resolveEnv({
		cwd: props.cwd ?? process.cwd(),
		contextFile: props.contextFile,
		projectId: props.projectId,
		branchId,
		apiKey: props.apiKey,
		apiHost: props.apiHost,
		services: ["postgres", "realtime"],
		...(props.runtimeApi ? { api: props.runtimeApi } : {}),
	});

	const url = requiredEnv(vars, "NEON_REALTIME_URL");
	const secret = requiredEnv(vars, "NEON_REALTIME_SECRET");
	const database = await databaseName(requiredEnv(vars, "DATABASE_URL"));
	const realtime = await connect({ url, secret, database });
	const render = createRenderer(
		props,
		{
			project: props.projectId,
			branch: branchDisplayName(props, branchId),
			database,
			query: props.query,
		},
		now,
	);
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
			if (props.output === "table") {
				await consumeChanges(materialized, render, props.signal);
			} else {
				await consumeSnapshots(materialized, render, props.signal);
			}
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
	key: "DATABASE_URL" | "NEON_REALTIME_URL" | "NEON_REALTIME_SECRET",
): string => {
	const value = vars[key];
	if (value) return value;
	throw new Error(`Could not resolve ${key} for the selected branch.`);
};

const databaseName = async (connectionString: string): Promise<string> => {
	const { parse } = await import("pg-connection-string");
	const database = parse(connectionString, { useLibpqCompat: true }).database;
	if (database) return database;
	throw new Error("DATABASE_URL must include a database name.");
};

type Renderer = (event: SubscribeEvent) => void;

type HumanSubscriptionContext = {
	project: string;
	branch: string;
	database: string;
	query: string;
};

const createRenderer = (
	props: Pick<SubscribeProps, "changes" | "output" | "out">,
	context: HumanSubscriptionContext,
	now: () => Date,
): Renderer => {
	const out = props.out ?? process.stdout;
	let hasBaseline = false;
	let lastStatus: string | undefined;
	const rowsById = new Map<string, QueryRow>();
	if (props.output === "table")
		renderHumanHeader(out, context, props.changes);
	return (event) => {
		if (event.type === "status") {
			if (props.output === "table") {
				const status = humanStatus(event.state);
				if (status !== lastStatus) {
					lastStatus = status;
					out.write(`${timestamp(now)} ${status}\n`);
				}
			}
			return;
		}
		if (props.output === "json") {
			out.write(`${JSON.stringify(event)}\n`);
			return;
		}
		if (props.output === "yaml") {
			out.write(`---\n${YAML.stringify(event)}`);
			return;
		}
		out.write("\n");
		if (event.type === "reset" && !props.changes) {
			const label = hasBaseline ? "Reset" : "Initial snapshot";
			hasBaseline = true;
			rowsById.clear();
			for (const { rowId, row } of event.rows) rowsById.set(rowId, row);
			renderMaterializedRows(
				out,
				event.rows.map(({ row }) => row),
				`${timestamp(now)} ${label}`,
			);
			return;
		}
		if (event.type === "batch" && !props.changes) {
			renderHumanBatch(out, event, rowsById, now);
			return;
		}
		renderTableEvent(out, event, now);
	};
};

const renderTableEvent = (
	out: NodeJS.WritableStream,
	event: Exclude<SubscribeEvent, { type: "status" }>,
	now: () => Date,
): void => {
	if (event.type === "snapshot") {
		renderMaterializedRows(out, event.rows, `${timestamp(now)} Snapshot`);
		return;
	}
	if (event.type === "reset") {
		const rows = event.rows.map(({ rowId, row }) => ({
			row_id: rowId,
			row,
		}));
		renderRows(
			out,
			rows,
			["row_id", "row"],
			`${timestamp(now)} Reset · ${rowCount(rows.length)}`,
			"Reset contains no rows.",
		);
		return;
	}
	const rows = event.changes.map((change) => ({
		type: change.type,
		row_id: change.rowId,
		row: change.type === "upsert" ? change.row : undefined,
	}));
	renderRows(
		out,
		rows,
		["type", "row_id", "row"],
		`${timestamp(now)} ${transactionLabel(event.txids)} · ${rawChangeSummary(event.changes)}`,
		"Batch contains no row changes.",
	);
};

const renderHumanHeader = (
	out: NodeJS.WritableStream,
	context: HumanSubscriptionContext,
	rawChanges: boolean,
): void => {
	const target = {
		project: context.project,
		branch: context.branch,
		database: context.database,
		mode: rawChanges ? "Raw changes" : "Materialized result",
		query: context.query,
	};
	writer({ output: "table", out }).end(target, {
		fields: ["project", "branch", "database", "mode", "query"],
		humanTitle: "Live query",
	});
};

const renderMaterializedRows = (
	out: NodeJS.WritableStream,
	rows: readonly QueryRow[],
	title: string,
): void => {
	const humanTitle = `${title} · ${rowCount(rows.length)}`;
	renderRows(
		out,
		rows,
		rowFields(rows),
		humanTitle,
		"Query returned no rows.",
	);
};

type ClassifiedChange = {
	operation: "+ insert" | "~ update" | "- delete";
	row?: QueryRow;
};

const renderHumanBatch = (
	out: NodeJS.WritableStream,
	event: Extract<SubscribeEvent, { type: "batch" }>,
	rowsById: Map<string, QueryRow>,
	now: () => Date,
): void => {
	const changes = classifyChanges(event.changes, rowsById);
	const inserted = changes.filter(
		(change) => change.operation === "+ insert",
	);
	const updated = changes.filter((change) => change.operation === "~ update");
	const deleted = changes.filter((change) => change.operation === "- delete");
	const rowFieldsInBatch = rowFields(
		changes.flatMap((change) => (change.row ? [change.row] : [])),
	);
	const operationField = uniqueOperationField(rowFieldsInBatch);
	const rows = changes.map((change) => ({
		...(change.row ?? {}),
		[operationField]: change.operation,
	}));
	renderRows(
		out,
		rows,
		[operationField, ...rowFieldsInBatch],
		`${timestamp(now)} ${transactionLabel(event.txids)} · +${inserted.length} ~${updated.length} -${deleted.length}`,
		"Transaction contains no row changes.",
	);
};

const renderRows = (
	out: NodeJS.WritableStream,
	rows: readonly Record<string, unknown>[],
	fields: readonly string[],
	title: string,
	emptyMessage: string,
): void => {
	writer({ output: "table", out }).end(rows as Record<string, unknown>[], {
		fields: fields as never,
		humanTitle: title,
	});
	if (rows.length === 0) out.write(`${emptyMessage}\n`);
};

const classifyChanges = (
	changes: readonly LiveQueryChange<QueryRow>[],
	rowsById: Map<string, QueryRow>,
): ClassifiedChange[] =>
	changes.map((change) => {
		if (change.type === "upsert") {
			const operation = rowsById.has(change.rowId)
				? "~ update"
				: "+ insert";
			rowsById.set(change.rowId, change.row);
			return { operation, row: change.row };
		}
		const row = rowsById.get(change.rowId);
		rowsById.delete(change.rowId);
		return { operation: "- delete", ...(row ? { row } : {}) };
	});

const uniqueOperationField = (fields: readonly string[]): string => {
	for (const candidate of ["change", "operation", "event"]) {
		if (!fields.includes(candidate)) return candidate;
	}
	let suffix = 1;
	while (fields.includes(`change_${suffix}`)) suffix += 1;
	return `change_${suffix}`;
};

const transactionLabel = (txids: readonly string[]): string => {
	if (txids.length === 0) return "Update (no transaction ID)";
	return `${txids.length === 1 ? "Transaction" : "Transactions"} ${txids.join(", ")}`;
};

const rawChangeSummary = (
	changes: readonly LiveQueryChange<QueryRow>[],
): string => {
	const upserts = changes.filter((change) => change.type === "upsert").length;
	const removals = changes.length - upserts;
	return `${upserts} upsert${upserts === 1 ? "" : "s"}, ${removals} removal${removals === 1 ? "" : "s"}`;
};

const rowCount = (count: number): string =>
	`${count} ${count === 1 ? "row" : "rows"}`;

const timestamp = (now: () => Date): string => `[${now().toISOString()}]`;

const humanStatus = (state: LiveQueryState): string => {
	switch (state.status) {
		case "connecting":
			return "Connecting…";
		case "live":
			return "Live — waiting for changes.";
		case "stale":
			return "Stale — showing the last known result.";
		case "closed":
			return "Subscription closed.";
		case "error":
			return `Subscription failed — ${state.error.message}`;
	}
};

const branchDisplayName = (props: SubscribeProps, branchId: string): string => {
	const branch = "branch" in props ? props.branch : props.id;
	return branch === branchId ? branchId : `${branch} (${branchId})`;
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
			subscription.onUpdate(() =>
				attempt(fail, () => {
					const rows = subscription.getSnapshot().data;
					if (rows !== undefined) render({ type: "snapshot", rows });
				}),
			),
		],
		render,
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
			subscription.onUpdate((update) => {
				if (update.type === "rows") {
					attempt(fail, () =>
						render({ type: "reset", rows: update.rows }),
					);
				} else {
					attempt(fail, () =>
						render({
							type: "batch",
							txids: update.batch.txids,
							changes: update.changes,
						}),
					);
				}
			}),
		],
		render,
		signal,
	);

const consumeSubscription = (
	subscription: RawLiveQuerySubscription<QueryRow>,
	listenForData: (fail: (error: unknown) => void) => Array<() => void>,
	render: Renderer,
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
			attempt(fail, () => render({ type: "status", state }));
			if (settled) return;
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
