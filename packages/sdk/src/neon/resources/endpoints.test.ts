import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";
import { NeonNotFoundError, NeonOperationError } from "../errors.js";

type Step = () => Response;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

function endpointsClient<Throw extends boolean = false>(
	steps: Record<string, Step>,
	config: { throwOnError?: Throw; waitForReadiness?: boolean } = {},
) {
	const calls: string[] = [];
	const neon = createNeonClient<Throw>({
		apiKey: "test",
		retries: 0,
		wait: { pollIntervalMs: 1, timeoutMs: 5_000 },
		...config,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const key = `${request.method} ${new URL(request.url).pathname}`;
			calls.push(key);
			const step = steps[key];
			if (!step) throw new Error(`unexpected request ${key}`);
			return step();
		},
	});
	return { neon, calls };
}

const ENDPOINT = "/api/v2/projects/p/endpoints/ep-1";
const OPERATION = "/api/v2/projects/p/operations/op-1";

const operation = (status: "running" | "finished" | "failed") => ({
	id: "op-1",
	project_id: "p",
	action: "restart_compute",
	status,
	failures_count: 0,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
	total_duration_ms: 0,
});

const accepted = {
	id: "ep-1",
	current_state: "active",
	pending_state: "active",
	started_at: "2026-01-01T00:00:00Z",
};
const settled = {
	id: "ep-1",
	current_state: "active",
	started_at: "2026-01-01T00:00:05Z",
};

const restartSteps: Record<string, Step> = {
	[`POST ${ENDPOINT}/restart`]: () =>
		json({ endpoint: accepted, operations: [operation("running")] }),
	[`GET ${OPERATION}`]: () => json({ operation: operation("finished") }),
	[`GET ${ENDPOINT}`]: () => json({ endpoint: settled }),
};

describe("endpoint mutations with readiness polling", () => {
	it("restart returns the endpoint read after its operations finish", async () => {
		const { neon, calls } = endpointsClient(restartSteps);
		const { data, error } = await neon.postgres.endpoints.restart(
			{ projectId: "p", endpointId: "ep-1" },
			{ waitForReadiness: true },
		);
		expect(error).toBeUndefined();
		expect(data).toEqual(settled);
		expect(calls).toEqual([
			`POST ${ENDPOINT}/restart`,
			`GET ${OPERATION}`,
			`GET ${ENDPOINT}`,
		]);
	});

	it("update, start and suspend read the endpoint again under a client-wide waitForReadiness", async () => {
		const { neon, calls } = endpointsClient(
			{
				[`PATCH ${ENDPOINT}`]: () =>
					json({
						endpoint: accepted,
						operations: [operation("running")],
					}),
				[`POST ${ENDPOINT}/start`]: () =>
					json({
						endpoint: accepted,
						operations: [operation("running")],
					}),
				[`POST ${ENDPOINT}/suspend`]: () =>
					json({
						endpoint: accepted,
						operations: [operation("running")],
					}),
				[`GET ${OPERATION}`]: () =>
					json({ operation: operation("finished") }),
				[`GET ${ENDPOINT}`]: () => json({ endpoint: settled }),
			},
			{ throwOnError: true, waitForReadiness: true },
		);
		const params = { projectId: "p", endpointId: "ep-1" };
		expect(
			await neon.postgres.endpoints.update({
				...params,
				autoscaling_limit_min_cu: 0.25,
				autoscaling_limit_max_cu: 1,
			}),
		).toEqual(settled);
		expect(await neon.postgres.endpoints.start(params)).toEqual(settled);
		expect(await neon.postgres.endpoints.suspend(params)).toEqual(settled);
		expect(calls.filter((call) => call === `GET ${ENDPOINT}`)).toHaveLength(
			3,
		);
	});

	it("create reads back the endpoint id the create returned", async () => {
		const { neon, calls } = endpointsClient({
			"POST /api/v2/projects/p/endpoints": () =>
				json(
					{
						endpoint: { id: "ep-1", current_state: "init" },
						operations: [operation("running")],
					},
					201,
				),
			[`GET ${OPERATION}`]: () =>
				json({ operation: operation("finished") }),
			[`GET ${ENDPOINT}`]: () => json({ endpoint: settled }),
		});
		const { data } = await neon.postgres.endpoints.create(
			{ projectId: "p", branch_id: "br-1", type: "read_only" },
			{ waitForReadiness: true },
		);
		expect(data).toEqual(settled);
		expect(calls.at(-1)).toBe(`GET ${ENDPOINT}`);
	});

	it("returns the accepted endpoint without a read when readiness polling is off", async () => {
		const { neon, calls } = endpointsClient(restartSteps);
		const { data } = await neon.postgres.endpoints.restart({
			projectId: "p",
			endpointId: "ep-1",
		});
		expect(data).toEqual(accepted);
		expect(calls).toEqual([`POST ${ENDPOINT}/restart`]);
	});

	it("a per-call waitForReadiness: false skips the read under a waiting client", async () => {
		const { neon, calls } = endpointsClient(restartSteps, {
			waitForReadiness: true,
		});
		const { data } = await neon.postgres.endpoints.restart(
			{ projectId: "p", endpointId: "ep-1" },
			{ waitForReadiness: false },
		);
		expect(data).toEqual(accepted);
		expect(calls).toEqual([`POST ${ENDPOINT}/restart`]);
	});

	it("skips the read when an operation fails", async () => {
		const { neon, calls } = endpointsClient({
			...restartSteps,
			[`GET ${OPERATION}`]: () =>
				json({ operation: operation("failed") }),
		});
		const { error } = await neon.postgres.endpoints.restart(
			{ projectId: "p", endpointId: "ep-1" },
			{ waitForReadiness: true },
		);
		expect(error).toBeInstanceOf(NeonOperationError);
		expect(calls).not.toContain(`GET ${ENDPOINT}`);
	});

	it("reports a failed read instead of the accepted endpoint", async () => {
		const steps = {
			...restartSteps,
			[`GET ${ENDPOINT}`]: () => json({ message: "not found" }, 404),
		};
		const { neon } = endpointsClient(steps);
		const { data, error } = await neon.postgres.endpoints.restart(
			{ projectId: "p", endpointId: "ep-1" },
			{ waitForReadiness: true },
		);
		expect(data).toBeUndefined();
		expect(error).toBeInstanceOf(NeonNotFoundError);

		await expect(
			endpointsClient(steps, {
				throwOnError: true,
				waitForReadiness: true,
			}).neon.postgres.endpoints.restart({
				projectId: "p",
				endpointId: "ep-1",
			}),
		).rejects.toBeInstanceOf(NeonNotFoundError);
	});
});
