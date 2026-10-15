import { Writable } from "node:stream";
import type {
	LiveQueryChange,
	LiveQuerySnapshot,
	LiveQueryState,
	MaterializedLiveQuerySubscription,
	RawLiveQueryRow,
	RawLiveQueryUpdate,
} from "@neon/realtime";
import { describe, expect, it, vi } from "vitest";
import yargs from "yargs";
import { stripAnsi } from "../human_table.js";
import {
	builder,
	type SubscribeDependencies,
	type SubscribeProps,
	subscribe,
} from "./subscribe.js";

type Row = Record<string, unknown>;

class FakeSubscription implements MaterializedLiveQuerySubscription<Row> {
	private state: LiveQueryState = {
		status: "connecting",
		error: undefined,
	};
	private data: readonly Row[] | undefined;
	private readonly updateListeners = new Set<
		(update: RawLiveQueryUpdate<Row>) => void
	>();
	private readonly stateListeners = new Set<
		(state: LiveQueryState) => void
	>();
	private readonly changeListeners = new Set<
		(snapshot: LiveQuerySnapshot<Row>) => void
	>();
	unsubscribed = false;
	onReady?: () => void;

	getState = (): LiveQueryState => this.state;

	getSnapshot = (): LiveQuerySnapshot<Row> => ({
		...this.state,
		data: this.data,
	});

	onUpdate = (
		listener: (update: RawLiveQueryUpdate<Row>) => void,
	): (() => void) => addListener(this.updateListeners, listener);

	onStateChange = (
		listener: (state: LiveQueryState) => void,
	): (() => void) => {
		const detach = addListener(this.stateListeners, listener);
		this.onReady?.();
		return detach;
	};

	onChange = (
		listener: (snapshot: LiveQuerySnapshot<Row>) => void,
	): (() => void) => addListener(this.changeListeners, listener);

	awaitTxId = async (): Promise<void> => undefined;

	awaitRows = async (): Promise<void> => undefined;

	renew = async (): Promise<void> => undefined;

	unsubscribe = (): void => {
		this.unsubscribed = true;
	};

	emitRows(rows: readonly RawLiveQueryRow<Row>[]): void {
		this.data = rows.map(({ row }) => row);
		const update = { type: "rows", rows } as const;
		for (const listener of this.updateListeners) listener(update);
	}

	emitChanges(
		data: readonly Row[],
		changes: readonly LiveQueryChange<Row>[],
		txids: readonly string[],
	): void {
		this.data = data;
		const update = {
			type: "changes",
			changes,
			batch: { txids },
		} as const;
		for (const listener of this.updateListeners) listener(update);
	}

	emitState(state: LiveQueryState): void {
		this.state = state;
		for (const listener of this.stateListeners) listener(state);
	}
}

const addListener = <Listener>(
	listeners: Set<Listener>,
	listener: Listener,
): (() => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

const capture = () => {
	let text = "";
	const out = new Writable({
		write(chunk, _encoding, callback) {
			text += chunk.toString();
			callback();
		},
	});
	return { out, text: () => text };
};

const props = (
	changes: boolean,
	signal: AbortSignal,
	out: NodeJS.WritableStream,
	output: SubscribeProps["output"] = "json",
): SubscribeProps => ({
	apiClient: {} as never,
	apiKey: "api-key",
	apiHost: "https://console-stage.example/api/v2",
	output,
	contextFile: "/workspace/.neon",
	projectId: "project-1",
	branch: "main",
	query: "SELECT * FROM items",
	changes,
	cwd: "/workspace",
	signal,
	out,
});

const realtimeEnv = {
	vars: {
		DATABASE_URL:
			"postgresql://user:password@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require",
		NEON_REALTIME_URL: "wss://realtime.example/v1",
		NEON_REALTIME_SECRET: "secret",
	},
	credential: {
		issued: false,
		keys: [],
		fresh: [],
		revoked: [],
		superseded: [],
	},
};

const setup = (subscription: FakeSubscription) => {
	let closeCount = 0;
	let materializedQuery: string | undefined;
	let changesQuery: string | undefined;
	let connectionOptions: unknown;
	let resolveReady: () => void = () => undefined;
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	subscription.onReady = resolveReady;
	const resolveEnv = vi.fn(async () => realtimeEnv);
	const dependencies: SubscribeDependencies = {
		resolveBranchId: vi.fn(async () => "branch-1"),
		resolveEnv,
		connect: async (options) => {
			connectionOptions = options;
			return {
				subscribeMaterialized: async (query) => {
					materializedQuery = query;
					return subscription;
				},
				subscribeChanges: async (query) => {
					changesQuery = query;
					return subscription;
				},
				close: () => {
					closeCount += 1;
				},
			};
		},
	};
	return {
		dependencies,
		resolveEnv,
		ready,
		connectionOptions: () => connectionOptions,
		materializedQuery: () => materializedQuery,
		changesQuery: () => changesQuery,
		closeCount: () => closeCount,
	};
};

describe("subscribe command", () => {
	it("registers the query and raw-change flag", () => {
		const options = (builder(yargs([])) as any).getOptions();
		expect(options.boolean).toContain("changes");
		expect(options.default.changes).toBe(false);
	});

	it("resolves Realtime env and renders materialized snapshots", async () => {
		const subscription = new FakeSubscription();
		const setupResult = setup(subscription);
		const output = capture();
		const controller = new AbortController();
		const run = subscribe(
			props(false, controller.signal, output.out),
			setupResult.dependencies,
		);
		await setupResult.ready;

		subscription.emitRows([
			{ rowId: "row-1", row: { id: 1, value: "first" } },
		]);
		subscription.emitChanges(
			[
				{ id: 1, value: "first" },
				{ id: 2, value: "second" },
			],
			[
				{
					type: "upsert",
					rowId: "row-2",
					row: { id: 2, value: "second" },
				},
			],
			["42"],
		);
		controller.abort();
		await run;

		expect(setupResult.resolveEnv).toHaveBeenCalledWith({
			cwd: "/workspace",
			contextFile: "/workspace/.neon",
			projectId: "project-1",
			branchId: "branch-1",
			apiKey: "api-key",
			apiHost: "https://console-stage.example/api/v2",
			services: ["postgres", "realtime"],
		});
		expect(setupResult.connectionOptions()).toEqual({
			url: "wss://realtime.example/v1",
			secret: "secret",
			database: "neondb",
		});
		expect(setupResult.materializedQuery()).toBe("SELECT * FROM items");
		expect(
			output
				.text()
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([
			{
				type: "snapshot",
				rows: [{ id: 1, value: "first" }],
			},
			{
				type: "snapshot",
				rows: [
					{ id: 1, value: "first" },
					{ id: 2, value: "second" },
				],
			},
		]);
		expect(subscription.unsubscribed).toBe(true);
		expect(setupResult.closeCount()).toBe(1);
	});

	it("renders raw rows and changes events with --changes", async () => {
		const subscription = new FakeSubscription();
		const setupResult = setup(subscription);
		const output = capture();
		const controller = new AbortController();
		const run = subscribe(
			props(true, controller.signal, output.out),
			setupResult.dependencies,
		);
		await setupResult.ready;

		subscription.emitRows([
			{ rowId: "row-1", row: { id: 1, value: "first" } },
		]);
		subscription.emitChanges(
			[],
			[{ type: "remove", rowId: "row-1" }],
			["43"],
		);
		controller.abort();
		await run;

		expect(setupResult.changesQuery()).toBe("SELECT * FROM items");
		expect(
			output
				.text()
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual([
			{
				type: "rows",
				rows: [
					{
						rowId: "row-1",
						row: { id: 1, value: "first" },
					},
				],
			},
			{
				type: "changes",
				txids: ["43"],
				changes: [{ type: "remove", rowId: "row-1" }],
			},
		]);
	});

	it("renders one initial snapshot followed by readable transaction changes", async () => {
		const subscription = new FakeSubscription();
		const setupResult = setup(subscription);
		const output = capture();
		const controller = new AbortController();
		const run = subscribe(
			props(false, controller.signal, output.out, "table"),
			{
				...setupResult.dependencies,
				now: () => new Date("2026-10-13T12:34:56.000Z"),
			},
		);
		await setupResult.ready;

		subscription.emitRows([
			{ rowId: "row-1", row: { id: 1, value: "first" } },
			{ rowId: "row-2", row: { id: 2, value: "to delete" } },
			{ rowId: "row-4", row: { id: 4, value: "unchanged" } },
		]);
		subscription.emitState({ status: "live", error: undefined });
		subscription.emitChanges(
			[
				{ id: 1, value: "updated" },
				{ id: 3, value: "inserted" },
				{ id: 4, value: "unchanged" },
			],
			[
				{
					type: "upsert",
					rowId: "row-1",
					row: { id: 1, value: "updated" },
				},
				{
					type: "upsert",
					rowId: "row-3",
					row: { id: 3, value: "inserted" },
				},
				{ type: "remove", rowId: "row-2" },
			],
			["42"],
		);
		subscription.emitState({ status: "stale", error: undefined });
		subscription.emitRows([
			{ rowId: "new-row", row: { id: 5, value: "replacement" } },
		]);
		controller.abort();
		await run;

		const text = stripAnsi(output.text());
		expect(text).toContain("Live query");
		expect(text).toContain("Project   project-1");
		expect(text).toContain("Branch    main (branch-1)");
		expect(text).toContain("Database  neondb");
		expect(text).toContain("Mode      Materialized result");
		expect(text).toContain("Query     SELECT * FROM items");
		expect(text).toContain("[2026-10-13T12:34:56.000Z] Connecting…");
		expect(text).toContain(
			"[2026-10-13T12:34:56.000Z] Initial snapshot · 3 rows",
		);
		expect(text).toContain(
			"[2026-10-13T12:34:56.000Z] Live — waiting for changes.",
		);
		expect(text).toContain(
			"[2026-10-13T12:34:56.000Z] Transaction 42 · +1 ~1 -1",
		);
		expect(text).toContain("~ update");
		expect(text).toContain("+ insert");
		expect(text).toContain("- delete");
		expect(text).toContain(
			"[2026-10-13T12:34:56.000Z] Stale — showing the last known result.",
		);
		expect(text).toContain("[2026-10-13T12:34:56.000Z] Rows · 1 row");
		expect(text.match(/Initial snapshot/g)).toHaveLength(1);
		expect(text.match(/unchanged/g)).toHaveLength(1);
		expect(text).not.toContain("row-1");
		expect(text).not.toContain("row-2");
		expect(text).not.toContain("row-3");
	});

	it("surfaces a terminal subscription error and closes the client", async () => {
		const subscription = new FakeSubscription();
		const setupResult = setup(subscription);
		const output = capture();
		const controller = new AbortController();
		const run = subscribe(
			props(false, controller.signal, output.out),
			setupResult.dependencies,
		);
		await setupResult.ready;
		const error = Object.assign(new Error("Query was rejected"), {
			code: "query_error",
			retryable: false,
		});
		subscription.emitState({ status: "error", error });

		await expect(run).rejects.toThrow("Query was rejected");
		expect(subscription.unsubscribed).toBe(true);
		expect(setupResult.closeCount()).toBe(1);
	});
});
