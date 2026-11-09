import type { CallOptions, RequestContext } from "../context.js";
import { createDeadline, resolveTimeoutMs, runBounded } from "../deadline.js";
import {
	describeTransportFailure,
	NeonAbortError,
	NeonClientError,
	type NeonErrorUnion,
	NeonNetworkError,
	NeonRequestTimeoutError,
} from "../errors.js";
import { validateCallOptions } from "../params.js";
import { err, finalize, type NeonResult, type Outcome, ok } from "../result.js";

const STATUS_PAGE_ID = "6878fc85709daa75be6c7e3c";

/** The public Status.io API behind neonstatus.com. Needs no credentials. */
export const NEON_STATUS_API_URL = `https://api.status.io/1.0/status/${STATUS_PAGE_ID}`;

const STATUS_PAGE_URL = "https://neonstatus.com";
const DEFAULT_TIMEOUT_MS = 10_000;

export type NeonServiceStatus =
	| "operational"
	| "maintenance"
	| "degraded_performance"
	| "partial_disruption"
	| "disruption"
	| "security_event";

export type NeonIncidentState =
	| "investigating"
	| "identified"
	| "monitoring"
	| "resolved";

// Status.io codes: https://kb.status.io/developers/status-codes/
const SERVICE_STATUS: ReadonlyMap<number, NeonServiceStatus> = new Map([
	[100, "operational"],
	[200, "maintenance"],
	[300, "degraded_performance"],
	[400, "partial_disruption"],
	[500, "disruption"],
	[600, "security_event"],
]);

const INCIDENT_STATE: ReadonlyMap<number, NeonIncidentState> = new Map([
	[100, "investigating"],
	[200, "identified"],
	[300, "monitoring"],
	[400, "resolved"],
]);

/** A component neonstatus.com reports as not operational, with the regions affected. */
export interface NeonAffectedComponent {
	name: string;
	status: NeonServiceStatus;
	/** Region names as neonstatus.com prints them, such as `AWS us-east-2` or `Global`. */
	regions: string[];
}

export interface NeonIncident {
	id: string;
	/** Often a ticket id such as `ES-2331348`; `latest_update` carries the details. */
	name: string;
	state: NeonIncidentState;
	status: NeonServiceStatus;
	started_at: string;
	updated_at: string;
	latest_update: string;
	components: string[];
	regions: string[];
	url: string;
}

export interface NeonMaintenance {
	id: string;
	name: string;
	state: "active" | "pending";
	planned_start: string;
	planned_end: string;
	latest_update: string;
	components: string[];
	regions: string[];
	url: string;
}

/** What neonstatus.com reports right now. */
export interface NeonIncidentsReport {
	status: NeonServiceStatus;
	updated_at: string;
	status_page_url: typeof STATUS_PAGE_URL;
	/** Open incidents. */
	incidents: NeonIncident[];
	/** Active maintenance first, then upcoming. */
	maintenance: NeonMaintenance[];
	affected_components: NeonAffectedComponent[];
}

export interface ListNeonIncidentsOptions {
	/** Custom `fetch` implementation (proxies, tests, non-global runtimes). */
	fetch?: typeof fetch;
	signal?: AbortSignal;
	/** Defaults to 10 seconds. `Infinity` disables the deadline. */
	requestTimeoutMs?: number;
}

/**
 * Read open incidents, maintenance, and degraded components from neonstatus.com.
 * Needs no API key. Throws a {@link NeonErrorUnion} member on failure.
 *
 * @example
 * ```ts
 * import { listNeonIncidents } from "@neon/sdk";
 *
 * const report = await listNeonIncidents();
 * if (report.status !== "operational") console.log(report.incidents);
 * ```
 */
export async function listNeonIncidents(
	options: ListNeonIncidentsOptions = {},
): Promise<NeonIncidentsReport> {
	const result = await fetchIncidents(options);
	if (result.error) throw result.error;
	return result.data;
}

/** neonstatus.com, through the client's `fetch` and `throwOnError` policy. */
export class Incidents<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/**
	 * Open incidents, maintenance, and degraded components from neonstatus.com. Reads
	 * the public Status.io API and sends no API key. `requestTimeoutMs` defaults to 10
	 * seconds regardless of the client's setting.
	 */
	list(): Promise<Outcome<NeonIncidentsReport, DThrow>>;
	list<Throw extends boolean = DThrow>(
		opts: CallOptions<Throw>,
	): Promise<Outcome<NeonIncidentsReport, Throw>>;
	async list(
		opts?: CallOptions,
	): Promise<NeonIncidentsReport | NeonResult<NeonIncidentsReport>> {
		const invalid = validateCallOptions(opts);
		const result = invalid
			? err<NeonIncidentsReport>(invalid)
			: await fetchIncidents({
					fetch: this.#ctx.client.getConfig().fetch,
					signal: opts?.signal,
					requestTimeoutMs: opts?.requestTimeoutMs,
				});
		return finalize(result, this.#ctx.shouldThrow(opts));
	}
}

async function fetchIncidents(
	options: ListNeonIncidentsOptions,
): Promise<NeonResult<NeonIncidentsReport>> {
	let timeoutMs: number;
	try {
		timeoutMs =
			options.requestTimeoutMs === undefined
				? DEFAULT_TIMEOUT_MS
				: resolveTimeoutMs(options.requestTimeoutMs);
	} catch (error) {
		if (error instanceof NeonClientError) return err(error);
		throw error;
	}
	const deadline = createDeadline(timeoutMs, options.signal);
	const stopped = (): NeonErrorUnion | undefined => {
		const source = deadline.source();
		if (source === "caller") {
			return new NeonAbortError("The request was aborted by its signal.");
		}
		if (source === "timeout") {
			return new NeonRequestTimeoutError(
				"Timed out waiting for neonstatus.com to respond (requestTimeoutMs).",
				{ timeoutMs },
			);
		}
		return undefined;
	};
	try {
		const report = await runBounded(deadline, async () => {
			const response = await (options.fetch ?? globalThis.fetch)(
				NEON_STATUS_API_URL,
				{
					headers: { accept: "application/json" },
					signal: deadline.signal,
				},
			);
			if (!response.ok) {
				throw new NeonClientError(
					`neonstatus.com returned HTTP ${response.status}.`,
				);
			}
			return parseReport(await response.text());
		});
		const cancellation = stopped();
		if (cancellation) return err(cancellation);
		if (report === undefined) {
			throw new NeonClientError(
				"Internal: the neonstatus.com request ended without a result.",
			);
		}
		return ok(report);
	} catch (error) {
		const cancellation = stopped();
		if (cancellation) return err(cancellation);
		if (error instanceof NeonClientError) return err(error);
		const reason = describeTransportFailure(error);
		return err(
			new NeonNetworkError(
				`Network error: no response received from neonstatus.com (${reason}).`,
				{ cause: error, reason },
			),
		);
	} finally {
		deadline.dispose();
	}
}

type Fields = Record<string, unknown>;

const unexpected = (detail: string) =>
	new NeonClientError(
		`neonstatus.com returned an unexpected response: ${detail}.`,
	);

function object(value: unknown, path: string): Fields {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw unexpected(`${path} is not an object`);
	}
	return Object.fromEntries(Object.entries(value));
}

function array(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) throw unexpected(`${path} is not an array`);
	return value;
}

function string(fields: Fields, key: string, path: string): string {
	const value = fields[key];
	if (typeof value !== "string") {
		throw unexpected(`${path}.${key} is not a string`);
	}
	return value;
}

function code<Name extends string>(
	codes: ReadonlyMap<number, Name>,
	value: unknown,
	path: string,
): Name {
	const name = typeof value === "number" ? codes.get(value) : undefined;
	if (name === undefined) {
		throw unexpected(`${path} has unknown code ${String(value)}`);
	}
	return name;
}

function names(value: unknown, path: string): string[] {
	return array(value, path).map((entry, index) =>
		string(object(entry, `${path}[${index}]`), "name", `${path}[${index}]`),
	);
}

interface Message {
	details: string;
	state: unknown;
	status: unknown;
	datetime: string;
}

function latestMessage(value: unknown, path: string): Message {
	const messages = array(value, `${path}.messages`).map((entry, index) => {
		const at = `${path}.messages[${index}]`;
		const fields = object(entry, at);
		return {
			details: string(fields, "details", at),
			state: fields.state,
			status: fields.status,
			datetime: string(fields, "datetime", at),
		};
	});
	const latest = messages.reduce<Message | undefined>(
		(newest, message) =>
			newest === undefined || message.datetime > newest.datetime
				? message
				: newest,
		undefined,
	);
	if (latest === undefined) throw unexpected(`${path}.messages is empty`);
	return latest;
}

function parseIncident(value: unknown, path: string): NeonIncident {
	const fields = object(value, path);
	const id = string(fields, "_id", path);
	const latest = latestMessage(fields.messages, path);
	return {
		id,
		name: string(fields, "name", path),
		state: code(
			INCIDENT_STATE,
			latest.state,
			`${path} latest message state`,
		),
		status: code(
			SERVICE_STATUS,
			latest.status,
			`${path} latest message status`,
		),
		started_at: string(fields, "datetime_open", path),
		updated_at: latest.datetime,
		latest_update: latest.details,
		components: names(
			fields.components_affected,
			`${path}.components_affected`,
		),
		regions: names(
			fields.containers_affected,
			`${path}.containers_affected`,
		),
		url: `https://status.io/pages/incident/${STATUS_PAGE_ID}/${id}`,
	};
}

function parseMaintenance(
	value: unknown,
	path: string,
	state: NeonMaintenance["state"],
): NeonMaintenance {
	const fields = object(value, path);
	const id = string(fields, "_id", path);
	return {
		id,
		name: string(fields, "name", path),
		state,
		planned_start: string(fields, "datetime_planned_start", path),
		planned_end: string(fields, "datetime_planned_end", path),
		latest_update: latestMessage(fields.messages, path).details,
		components: names(
			fields.components_affected,
			`${path}.components_affected`,
		),
		regions: names(
			fields.containers_affected,
			`${path}.containers_affected`,
		),
		url: `https://status.io/pages/maintenance/${STATUS_PAGE_ID}/${id}`,
	};
}

function parseComponent(
	value: unknown,
	path: string,
): NeonAffectedComponent | undefined {
	const fields = object(value, path);
	const status = code(
		SERVICE_STATUS,
		fields.status_code,
		`${path}.status_code`,
	);
	if (status === "operational") return undefined;
	const regions = array(fields.containers, `${path}.containers`).flatMap(
		(entry, index) => {
			const at = `${path}.containers[${index}]`;
			const container = object(entry, at);
			const regionStatus = code(
				SERVICE_STATUS,
				container.status_code,
				`${at}.status_code`,
			);
			return regionStatus === "operational"
				? []
				: [string(container, "name", at)];
		},
	);
	return { name: string(fields, "name", path), status, regions };
}

function parseReport(raw: string): NeonIncidentsReport {
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch (error) {
		throw new NeonClientError(
			"neonstatus.com returned a body that is not JSON.",
			{
				cause: error,
			},
		);
	}
	const result = object(object(body, "body").result, "result");
	const overall = object(result.status_overall, "result.status_overall");
	const maintenance = object(result.maintenance, "result.maintenance");
	return {
		status: code(
			SERVICE_STATUS,
			overall.status_code,
			"result.status_overall.status_code",
		),
		updated_at: string(overall, "updated", "result.status_overall"),
		status_page_url: STATUS_PAGE_URL,
		incidents: array(result.incidents, "result.incidents").map(
			(incident, index) =>
				parseIncident(incident, `result.incidents[${index}]`),
		),
		maintenance: [
			...array(maintenance.active, "result.maintenance.active").map(
				(entry, index) =>
					parseMaintenance(
						entry,
						`result.maintenance.active[${index}]`,
						"active",
					),
			),
			...array(maintenance.upcoming, "result.maintenance.upcoming").map(
				(entry, index) =>
					parseMaintenance(
						entry,
						`result.maintenance.upcoming[${index}]`,
						"pending",
					),
			),
		],
		affected_components: array(result.status, "result.status").flatMap(
			(component, index) => {
				const affected = parseComponent(
					component,
					`result.status[${index}]`,
				);
				return affected === undefined ? [] : [affected];
			},
		),
	};
}
