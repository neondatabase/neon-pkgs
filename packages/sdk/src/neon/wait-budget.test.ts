import { describe, expect, it } from "vitest";
import { createNeonClient } from "./client.js";

function runningCreate() {
	return {
		project: { id: "p-1", name: "app" },
		operations: [
			{
				id: "op-1",
				project_id: "p-1",
				action: "create_timeline",
				status: "running",
				failures_count: 0,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T00:00:00Z",
				total_duration_ms: 0,
			},
		],
	};
}

function neonNeverFinishing(config: {
	wait?: { pollIntervalMs?: number; timeoutMs?: number };
}) {
	return createNeonClient({
		apiKey: "test",
		retries: 0,
		waitForReadiness: true,
		wait: { pollIntervalMs: 5, ...config.wait },
		fetch: async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.includes("/operations/")) {
				return new Response(
					JSON.stringify({
						operation: runningCreate().operations[0],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}
			return new Response(JSON.stringify(runningCreate()), {
				status: 201,
				headers: { "content-type": "application/json" },
			});
		},
	});
}

describe("per-call wait budget", () => {
	it("uses CallOptions.wait.timeoutMs instead of the client wait timeout", async () => {
		const neon = neonNeverFinishing({ wait: { timeoutMs: 5_000 } });
		const startedAt = Date.now();
		const { error } = await neon.projects.create(
			{ name: "app" },
			{ wait: { timeoutMs: 80 } },
		);
		expect(error?.kind).toBe("timeout");
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});

	it("keeps the client timeout when per-call timeoutMs is omitted", async () => {
		const neon = neonNeverFinishing({ wait: { timeoutMs: 80 } });
		const startedAt = Date.now();
		const { error } = await neon.projects.create(
			{ name: "app" },
			{ wait: { pollIntervalMs: 5, timeoutMs: undefined } },
		);
		expect(error?.kind).toBe("timeout");
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});

	it("aborts readiness polling from CallOptions.signal, not client wait.signal", async () => {
		const controller = new AbortController();
		const neon = neonNeverFinishing({ wait: { timeoutMs: 60_000 } });
		setTimeout(() => controller.abort(), 20);
		const { error } = await neon.projects.create(
			{ name: "app" },
			{ signal: controller.signal },
		);
		expect(error?.kind).toBe("aborted");
	});
});
