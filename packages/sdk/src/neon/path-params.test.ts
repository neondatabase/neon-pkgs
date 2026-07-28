import { describe, expect, it } from "vitest";
import { getProject } from "../client/raw.gen.js";
import { createNeonClient } from "./client.js";
import { NeonError } from "./errors.js";
import { findUnusablePathParam } from "./path-params.js";

/**
 * A client whose `fetch` records whether it was reached at all. The point of the guard is
 * that a malformed path never leaves the process, so "was fetch called" is the assertion
 * that matters.
 */
function recordingClient() {
	const calls: string[] = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		fetch: async (input) => {
			calls.push(
				typeof input === "string" ? input : new Request(input).url,
			);
			return new Response(JSON.stringify({ project: { id: "p-1" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { neon, calls };
}

describe("findUnusablePathParam", () => {
	it("accepts populated parameters", () => {
		expect(
			findUnusablePathParam({ project_id: "p-1", branch_id: "br-1" }),
		).toBeUndefined();
	});

	it("rejects empty, whitespace-only, null and missing values", () => {
		expect(findUnusablePathParam({ project_id: "" })).toBe("project_id");
		expect(findUnusablePathParam({ project_id: "   " })).toBe("project_id");
		expect(findUnusablePathParam({ project_id: null })).toBe("project_id");
		expect(findUnusablePathParam({ project_id: undefined })).toBe(
			"project_id",
		);
	});

	it("names the offending parameter, not the first one", () => {
		expect(
			findUnusablePathParam({ project_id: "p-1", branch_id: "" }),
		).toBe("branch_id");
	});

	it("ignores non-object paths and permits numeric ids", () => {
		expect(findUnusablePathParam(undefined)).toBeUndefined();
		expect(findUnusablePathParam("nope")).toBeUndefined();
		expect(findUnusablePathParam({ endpoint_id: 0 })).toBeUndefined();
	});
});

describe("the raw surface refuses a malformed path", () => {
	it("returns a client-kind error without sending a request", async () => {
		const { neon, calls } = recordingClient();

		const res = await getProject({
			client: neon.client,
			path: { project_id: "" },
		});

		expect(res.error).toBeInstanceOf(NeonError);
		expect(res.error?.kind).toBe("client");
		expect(res.error?.message).toContain('"project_id"');
		expect(calls).toEqual([]);
	});

	it("throws under throwOnError", async () => {
		const { neon, calls } = recordingClient();

		await expect(
			getProject({
				client: neon.client,
				path: { project_id: "" },
				throwOnError: true,
			}),
		).rejects.toBeInstanceOf(NeonError);
		expect(calls).toEqual([]);
	});

	it("still sends a well-formed path", async () => {
		const { neon, calls } = recordingClient();

		const res = await getProject({
			client: neon.client,
			path: { project_id: "p-1" },
		});

		expect(res.error).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("/projects/p-1");
	});
});

describe("the ergonomic layer refuses a malformed path", () => {
	it("reports the parameter rather than an opaque network error", async () => {
		const { neon, calls } = recordingClient();

		const { data, error } = await neon.projects.get("");

		expect(data).toBeUndefined();
		expect(error).toBeInstanceOf(NeonError);
		expect(error?.kind).toBe("client");
		expect(error?.message).toContain('"project_id"');
		expect(calls).toEqual([]);
	});
});
