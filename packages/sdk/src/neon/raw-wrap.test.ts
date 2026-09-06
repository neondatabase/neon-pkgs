import { describe, expect, it } from "vitest";
import * as rawGen from "../client/raw.gen.js";
import { deleteProjectBranchDatabase, getProject } from "../client/raw.gen.js";
import * as gen from "../client/sdk.gen.js";
import { createNeonClient } from "./client.js";
import { NeonNotFoundError } from "./errors.js";
import { wrapRaw } from "./raw-wrap.js";

/**
 * Build a real configured client whose only stubbed boundary is the network: `fetch`
 * returns canned `Response`s. Everything under test (wrapRaw, toNeonError, the fetch
 * client) runs for real — no mocks of our own code.
 */
function clientReturning(status: number, body: unknown) {
	return createNeonClient({
		apiKey: "test",
		retries: 0,
		fetch: async () =>
			new Response(body === undefined ? null : JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
	}).client;
}

describe("wrapRaw result contract", () => {
	it("returns the { data, error } envelope on success by default", async () => {
		const client = clientReturning(200, { project: { id: "p-1" } });
		const res = await getProject({ client, path: { project_id: "p-1" } });
		expect(res.error).toBeUndefined();
		expect(res.data).toEqual({ project: { id: "p-1" } });
	});

	it("returns the bare resource under throwOnError", async () => {
		const client = clientReturning(200, { project: { id: "p-1" } });
		const data = await getProject({
			client,
			path: { project_id: "p-1" },
			throwOnError: true,
		});
		expect(data).toEqual({ project: { id: "p-1" } });
	});

	it("maps API errors to the typed NeonError on the error channel", async () => {
		const client = clientReturning(404, {
			message: "project not found",
			code: "not_found",
			request_id: "req-1",
		});
		const res = await getProject({ client, path: { project_id: "nope" } });
		expect(res.data).toBeUndefined();
		expect(res.error).toBeInstanceOf(NeonNotFoundError);
		expect(res.error?.kind).toBe("not_found");
	});

	it("throws the typed NeonError under throwOnError", async () => {
		const client = clientReturning(404, { message: "project not found" });
		await expect(
			getProject({
				client,
				path: { project_id: "nope" },
				throwOnError: true,
			}),
		).rejects.toBeInstanceOf(NeonNotFoundError);
	});

	it("treats an empty (204) success body as data, not an error", async () => {
		const client = clientReturning(204, undefined);
		const res = await deleteProjectBranchDatabase({
			client,
			path: { project_id: "p-1", branch_id: "br-1", database_name: "db" },
		});
		expect(res.error).toBeUndefined();
	});
});

describe("wrapRaw requires client", () => {
	it("throws a client NeonError and does not call the generated function", async () => {
		let calls = 0;
		const fn = async (_options: { client?: unknown }) => {
			calls += 1;
			return { data: { ok: true } };
		};
		const wrapped = wrapRaw(fn);
		await expect(
			wrapped({ path: { project_id: "p-1" } } as never),
		).rejects.toMatchObject({ kind: "client" });
		await expect(
			wrapped({
				client: undefined,
				path: { project_id: "p-1" },
			} as never),
		).rejects.toMatchObject({ kind: "client" });
		await expect(
			wrapped({ client: null, path: { project_id: "p-1" } } as never),
		).rejects.toMatchObject({ kind: "client" });
		expect(calls).toBe(0);

		const client = clientReturning(200, { project: { id: "p-1" } });
		await wrapped({ client });
		expect(calls).toBe(1);
	});
});

describe("raw barrel coverage", () => {
	it("wraps every generated operation exactly once", () => {
		const generated = Object.entries(gen)
			.filter(([, value]) => typeof value === "function")
			.map(([name]) => name)
			.sort();
		const wrapped = Object.keys(rawGen).sort();
		expect(wrapped).toStrictEqual(generated);
	});
});
