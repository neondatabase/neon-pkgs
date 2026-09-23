import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";
import { NeonAbortError } from "../errors.js";

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

function queryParams(url: string | undefined): URLSearchParams {
	if (url === undefined) {
		throw new Error("missing captured request URL");
	}
	return new URL(url).searchParams;
}

describe("snapshots.create maps the ergonomic input to the query string", () => {
	it("forwards a distinct name and slug and sends no body", async () => {
		const { neon, calls } = neonCapturing();
		await neon.snapshots.create({
			projectId: "p-1",
			branchId: "br-1",
			name: "Before migration",
			slug: "before-migration",
			expiresAt: "2030-01-01T00:00:00Z",
		});
		expect(calls[0]?.url).toContain("/projects/p-1/branches/br-1/snapshot");
		expect(calls[0]?.body).toBe("");
		const query = queryParams(calls[0]?.url);
		expect(query.get("name")).toBe("Before migration");
		expect(query.get("slug")).toBe("before-migration");
		expect(query.get("expires_at")).toBe("2030-01-01T00:00:00Z");
	});

	it("omits slug when it is not provided", async () => {
		const { neon, calls } = neonCapturing();
		await neon.snapshots.create({
			projectId: "p-1",
			branchId: "br-1",
			name: "Baseline",
		});
		expect(queryParams(calls[0]?.url).has("slug")).toBe(false);
	});

	it("omits slug when it is explicitly undefined", async () => {
		const { neon, calls } = neonCapturing();
		await neon.snapshots.create({
			projectId: "p-1",
			branchId: "br-1",
			slug: undefined,
		});
		expect(queryParams(calls[0]?.url).has("slug")).toBe(false);
	});
});

describe("snapshots.update maps the ergonomic input to the API body", () => {
	it("sends camelCase expiresAt as snake_case expires_at", async () => {
		const { neon, calls } = neonCapturing();
		await neon.snapshots.update({
			projectId: "p-1",
			snapshotId: "snap-1",
			name: "renamed",
			expiresAt: "2030-01-01T00:00:00Z",
		});
		expect(calls[0]?.body).toEqual({
			snapshot: { name: "renamed", expires_at: "2030-01-01T00:00:00Z" },
		});
	});

	it("forwards an explicit null to clear the expiration", async () => {
		const { neon, calls } = neonCapturing();
		await neon.snapshots.update({
			projectId: "p-1",
			snapshotId: "snap-1",
			expiresAt: null,
		});
		expect(calls[0]?.body).toEqual({ snapshot: { expires_at: null } });
	});

	it("omits expires_at entirely when not provided", async () => {
		const { neon, calls } = neonCapturing();
		await neon.snapshots.update({
			projectId: "p-1",
			snapshotId: "snap-1",
			name: "renamed",
		});
		expect(calls[0]?.body).toEqual({ snapshot: { name: "renamed" } });
	});
});

describe("snapshots.restore keeps the result contract around its preview callback", () => {
	/** Answers the restore, then the branch fetch, with a ready branch. */
	function neonRestoring() {
		return createNeonClient({
			apiKey: "test",
			retries: 0,
			fetch: async () =>
				new Response(
					JSON.stringify({
						branch: { id: "br-restored", name: "restored" },
						operations: [],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		});
	}

	it("reports a callback that honours its signal by throwing as aborted", async () => {
		// Cooperating with the signal is the documented thing to do, so the DOMException
		// it throws must not escape a client that promised { data, error }.
		const neon = neonRestoring();
		const controller = new AbortController();

		const { error } = await neon.snapshots.restore(
			{
				projectId: "p-1",
				snapshotId: "snap-1",
				targetBranchId: "br-1",
				preview: async (_branch, { signal }) => {
					controller.abort();
					signal?.throwIfAborted();
					return true;
				},
			},
			{ signal: controller.signal },
		);

		expect(error).toBeInstanceOf(NeonAbortError);
		expect(error?.message).toContain("un-finalized");
	});

	it("reports a callback that throws for its own reasons as a client error", async () => {
		const neon = neonRestoring();

		const { error } = await neon.snapshots.restore({
			projectId: "p-1",
			snapshotId: "snap-1",
			targetBranchId: "br-1",
			preview: async () => {
				throw new Error("my checks blew up");
			},
		});

		expect(error?.kind).toBe("client");
		expect(error?.message).toContain("my checks blew up");
	});
});

describe("snapshots.setSchedule forwards the schedule body verbatim", () => {
	it("sends the narrowed schedule as the request body", async () => {
		const { neon, calls } = neonCapturing();
		await neon.snapshots.setSchedule({
			projectId: "p-1",
			branchId: "br-1",
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
