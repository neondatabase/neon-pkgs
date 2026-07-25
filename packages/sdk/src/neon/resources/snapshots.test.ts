import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";

/**
 * Build a client whose only stub is the network boundary, capturing the
 * outgoing request so we can assert the serialized body.
 */
function neonCapturing() {
	const calls: Array<{ url: string; body: unknown }> = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		fetch: async (input, init) => {
			const request = input instanceof Request ? input : undefined;
			const url = request ? request.url : String(input);
			const raw = request ? await request.clone().text() : init?.body;
			calls.push({
				url,
				body:
					typeof raw === "string" && raw.length > 0
						? JSON.parse(raw)
						: raw,
			});
			return new Response(
				JSON.stringify({ snapshot: { id: "snap-1" } }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		},
	});
	return { neon, calls };
}

describe("snapshots.update maps the ergonomic input to the API body", () => {
	it("sends camelCase expiresAt as snake_case expires_at", async () => {
		const { neon, calls } = neonCapturing();
		await neon.snapshots.update("p-1", "snap-1", {
			name: "renamed",
			expiresAt: "2030-01-01T00:00:00Z",
		});
		expect(calls[0]?.body).toEqual({
			snapshot: { name: "renamed", expires_at: "2030-01-01T00:00:00Z" },
		});
	});

	it("forwards an explicit null to clear the expiration", async () => {
		const { neon, calls } = neonCapturing();
		await neon.snapshots.update("p-1", "snap-1", { expiresAt: null });
		expect(calls[0]?.body).toEqual({ snapshot: { expires_at: null } });
	});

	it("omits expires_at entirely when not provided", async () => {
		const { neon, calls } = neonCapturing();
		await neon.snapshots.update("p-1", "snap-1", { name: "renamed" });
		expect(calls[0]?.body).toEqual({ snapshot: { name: "renamed" } });
	});
});

describe("snapshots.setSchedule forwards the schedule body verbatim", () => {
	it("sends the narrowed schedule as the request body", async () => {
		const { neon, calls } = neonCapturing();
		await neon.snapshots.setSchedule("p-1", "br-1", {
			schedule: [
				{ frequency: "weekly", day: 1, hour: 2 },
				{ frequency: "daily", hour: 3, retention_seconds: 604800 },
			],
		});
		expect(calls[0]?.url).toContain(
			"/projects/p-1/branches/br-1/backup_schedule",
		);
		expect(calls[0]?.body).toEqual({
			schedule: [
				{ frequency: "weekly", day: 1, hour: 2 },
				{ frequency: "daily", hour: 3, retention_seconds: 604800 },
			],
		});
	});
});
