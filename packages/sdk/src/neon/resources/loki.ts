import type { CallOptions, RequestContext } from "../context.js";
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";

/**
 * Time bounds shared by every Loki read. `start` and `end` take RFC 3339 or Unix
 * nanoseconds and stay strings, because a nanosecond timestamp does not fit in a
 * JavaScript number.
 */
export interface LokiWindow {
	/** Lookback as a Go duration (`30m`, `24h`), ending at `end` or now. `start` wins. */
	since?: string;
	start?: string;
	/** Defaults to now. */
	end?: string;
}

export type LokiQueryRangeParams = {
	projectId: string;
	branchId: string;
	/** LogQL: stream selectors and line filters only. */
	query: string;
	/** Maximum log lines. The server enforces its own cap. */
	limit?: number;
	/** `backward` is newest first. */
	direction?: "forward" | "backward";
} & LokiWindow;

export type LokiLabelsParams = {
	projectId: string;
	branchId: string;
	/** A stream selector without line filters, scoping which streams are read. */
	query?: string;
} & LokiWindow;

export type LokiLabelValuesParams = LokiLabelsParams & { name: string };

/** One stream: its label set, then `[timestamp, line]` pairs with nanosecond timestamps. */
export interface LokiStream {
	stream: Record<string, string>;
	values: [timestamp: string, line: string][];
}

/**
 * The `query_range` body as Loki defines it. There is no continuation cursor. A result
 * holding `limit` lines, or the server's cap (10,000 observed, reached without a
 * `warnings` entry), may be incomplete; only a narrower window or selector returns the
 * rest.
 */
export interface LokiQueryRangeResponse {
	status: "success";
	data: { resultType: "streams"; result: LokiStream[] };
	warnings?: string[];
}

/** The `labels` and `label/{name}/values` body as Loki defines it. */
export interface LokiLabelsResponse {
	status: "success";
	data: string[];
	warnings?: string[];
}

const SECURITY = [{ scheme: "bearer", type: "http" }] as const;

/**
 * The branch's Loki-compatible read API, `/telemetry/v1/.../loki/api/v1`, on the same
 * origin as the client's `baseUrl`. It reads the same records as {@link Logs.query} and
 * returns Loki's response bodies unchanged: streams grouped by label set, nanosecond
 * timestamps, and any server `warnings`.
 *
 * Not part of the Neon OpenAPI spec, so these methods are hand-written over the raw
 * client. Region-gated like the rest of `neon.logs`: outside a telemetry region the
 * server answers `404`.
 */
export class Loki<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/**
	 * Run a LogQL range query.
	 *
	 * @apiCall GET /telemetry/v1/projects/{project_id}/branches/{branch_id}/loki/api/v1/query_range
	 */
	queryRange(
		params: LokiQueryRangeParams,
	): Promise<Outcome<LokiQueryRangeResponse, DThrow>>;
	queryRange<Throw extends boolean = DThrow>(
		params: LokiQueryRangeParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<LokiQueryRangeResponse, Throw>>;
	queryRange(
		params: LokiQueryRangeParams,
		opts?: CallOptions,
	): Promise<LokiQueryRangeResponse | NeonResult<LokiQueryRangeResponse>> {
		const invalid = validateParams(params, "logs.loki.queryRange", {
			projectId: "string",
			branchId: "string",
			query: "string",
		});
		if (invalid) {
			return invalidParamsResult<LokiQueryRangeResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...query } = params;
		return this.#get<LokiQueryRangeResponse>(
			opts,
			"/query_range",
			{ project_id: projectId, branch_id: branchId },
			query,
		);
	}

	/**
	 * List the stream labels present on the branch.
	 *
	 * @apiCall GET /telemetry/v1/projects/{project_id}/branches/{branch_id}/loki/api/v1/labels
	 */
	labels(
		params: LokiLabelsParams,
	): Promise<Outcome<LokiLabelsResponse, DThrow>>;
	labels<Throw extends boolean = DThrow>(
		params: LokiLabelsParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<LokiLabelsResponse, Throw>>;
	labels(
		params: LokiLabelsParams,
		opts?: CallOptions,
	): Promise<LokiLabelsResponse | NeonResult<LokiLabelsResponse>> {
		const invalid = validateParams(params, "logs.loki.labels", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<LokiLabelsResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...query } = params;
		return this.#get<LokiLabelsResponse>(
			opts,
			"/labels",
			{ project_id: projectId, branch_id: branchId },
			query,
		);
	}

	/**
	 * List the values one stream label carries.
	 *
	 * @apiCall GET /telemetry/v1/projects/{project_id}/branches/{branch_id}/loki/api/v1/label/{name}/values
	 */
	labelValues(
		params: LokiLabelValuesParams,
	): Promise<Outcome<LokiLabelsResponse, DThrow>>;
	labelValues<Throw extends boolean = DThrow>(
		params: LokiLabelValuesParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<LokiLabelsResponse, Throw>>;
	labelValues(
		params: LokiLabelValuesParams,
		opts?: CallOptions,
	): Promise<LokiLabelsResponse | NeonResult<LokiLabelsResponse>> {
		const invalid = validateParams(params, "logs.loki.labelValues", {
			projectId: "string",
			branchId: "string",
			name: "string",
		});
		if (invalid) {
			return invalidParamsResult<LokiLabelsResponse>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, name, ...query } = params;
		return this.#get<LokiLabelsResponse>(
			opts,
			"/label/{name}/values",
			{ project_id: projectId, branch_id: branchId, name },
			query,
		);
	}

	#get<T>(
		opts: CallOptions | undefined,
		endpoint: string,
		path: Record<string, string>,
		query: Record<string, unknown>,
	): Promise<T | NeonResult<T>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				client.get<{ 200: T }, unknown, false>({
					baseUrl: new URL(
						"/telemetry/v1",
						client.getConfig().baseUrl,
					).toString(),
					url: `/projects/{project_id}/branches/{branch_id}/loki/api/v1${endpoint}`,
					security: SECURITY,
					path,
					query,
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}
}
