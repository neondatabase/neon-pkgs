import { describe, expect, it } from "vitest";
import * as rawGen from "../client/raw.gen.js";
import {
	deleteProjectBranchDatabase,
	getProject,
	listProjects,
} from "../client/raw.gen.js";
import * as gen from "../client/sdk.gen.js";
import { createNeonClient } from "./client.js";
import { NeonApiError, NeonClientError, NeonNotFoundError } from "./errors.js";

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

describe("a host that answers with an HTML page", () => {
	const PAGE = "<!DOCTYPE html><html><body>Neon Console</body></html>";

	function neonServingHtml(status: number) {
		return createNeonClient({
			apiKey: "test",
			baseUrl: "https://console.neon.tech/app",
			retries: 0,
			fetch: async () =>
				new Response(PAGE, {
					status,
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		});
	}

	it("fails a raw call instead of returning the page as data", async () => {
		const res = await listProjects({
			client: neonServingHtml(200).client,
			query: { limit: 100 },
		});
		expect(res.data).toBeUndefined();
		expect(res.error).toBeInstanceOf(NeonClientError);
		expect(res.error?.message).toBe(
			"https://console.neon.tech answered GET /app/projects with an HTML page (HTTP 200) instead of a Neon API response. Check that the API base URL points at the Neon API, https://console.neon.tech/api/v2, and that no proxy is answering in its place.",
		);
	});

	it("fails a list instead of returning no items", async () => {
		const res = await neonServingHtml(200).projects.list().all();
		expect(res.data).toBeUndefined();
		expect(res.error).toBeInstanceOf(NeonClientError);
	});

	it("keeps an HTML error page an API error with its status", async () => {
		const res = await listProjects({ client: neonServingHtml(502).client });
		expect(res.error).toBeInstanceOf(NeonApiError);
		expect(res.error).toMatchObject({ status: 502 });
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
