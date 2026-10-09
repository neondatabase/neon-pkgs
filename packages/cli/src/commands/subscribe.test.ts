import { Writable } from "node:stream";
import type {
	LiveQueryBatchInfo,
	LiveQueryChange,
	LiveQuerySnapshot,
	LiveQueryState,
	MaterializedLiveQuerySubscription,
	RawLiveQueryRow,
} from "@neon/realtime";
import { describe, expect, it, vi } from "vitest";
import yargs from "yargs";
import {
	builder,
	command,
	describe as commandDescription,
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
	private readonly resetListeners = new Set<
		(rows: readonly RawLiveQueryRow<Row>[]) => void
	>();
	private readonly batchListeners = new Set<
		(
			changes: readonly LiveQueryChange<Row>[],
			batch: LiveQueryBatchInfo,
		) => void
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

	onReset = (
		listener: (rows: readonly RawLiveQueryRow<Row>[]) => void,
	): (() => void) => addListener(this.resetListeners, listener);

	onBatch = (
		listener: (
			changes: readonly LiveQueryChange<Row>[],
			batch: LiveQueryBatchInfo,
		) => void,
	): (() => void) => addListener(this.batchListeners, listener);

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

	emitReset(rows: readonly RawLiveQueryRow<Row>[]): void {
		this.data = rows.map(({ row }) => row);
		for (const listener of this.resetListeners) listener(rows);
	}

	emitBatch(
		data: readonly Row[],
		changes: readonly LiveQueryChange<Row>[],
		txids: readonly string[],
	): void {
		this.data = data;
		for (const listener of this.batchListeners)
			listener(changes, { txids });
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
): SubscribeProps => ({
	apiClient: {} as never,
	apiKey: "api-key",
	apiHost: "https://console-stage.example/api/v2",
	output: "json",
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
		NEON_REALTIME_URL: "wss://realtime.example/v1",
		NEON_REALTIME_SECRET: "secret",
		NEON_DATABASE_NAME: "neondb",
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
	it("registers the top-level query and raw-change flag", () => {
		expect(command).toBe("subscribe <query>");
		expect(commandDescription).toContain("live SQL query");
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

		subscription.emitReset([
			{ rowId: "row-1", row: { id: 1, value: "first" } },
		]);
		subscription.emitBatch(
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
			services: ["realtime"],
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

	it("renders raw resets and transaction batches with --changes", async () => {
		const subscription = new FakeSubscription();
		const setupResult = setup(subscription);
		const output = capture();
		const controller = new AbortController();
		const run = subscribe(
			props(true, controller.signal, output.out),
			setupResult.dependencies,
		);
		await setupResult.ready;

		subscription.emitReset([
			{ rowId: "row-1", row: { id: 1, value: "first" } },
		]);
		subscription.emitBatch(
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
				type: "reset",
				rows: [
					{
						rowId: "row-1",
						row: { id: 1, value: "first" },
					},
				],
			},
			{
				type: "batch",
				txids: ["43"],
				changes: [{ type: "remove", rowId: "row-1" }],
			},
		]);
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
