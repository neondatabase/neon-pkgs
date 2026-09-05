import { describe, expect, it } from "vitest";
import { createNeonClient } from "./client.js";
import { createDeadline } from "./deadline.js";
import { NeonApiError, NeonError } from "./errors.js";
import { paginate } from "./paginate.js";

function unboundedDeadline() {
	return createDeadline(Number.POSITIVE_INFINITY);
}

describe("paginate throwOnError", () => {
	it("returns the envelope when shouldThrow is false", async () => {
		const error = new NeonError("classified", "client");
		const list = paginate<string, { items: string[]; cursor?: string }>(
			async () => ({ error }),
			() => ({ items: [] }),
			unboundedDeadline,
			false,
		);

		const page = await list.page();
		expect("error" in page).toBe(true);
		if (!("error" in page)) throw new Error("expected envelope");
		expect(page.data).toBeUndefined();
		expect(page.error).toBe(error);

		const all = await list.all();
		expect("error" in all).toBe(true);
		if (!("error" in all)) throw new Error("expected envelope");
		expect(all.data).toBeUndefined();
		expect(all.error).toBe(error);

		await expect(async () => {
			for await (const _item of list) {
				void _item;
			}
		}).rejects.toBe(error);
	});

	it("resolves the bare page and concatenated array when shouldThrow is true", async () => {
		const pages = new Map([
			[undefined, { items: ["a", "b"], cursor: "c1" }],
			["c1", { items: ["c"], cursor: undefined }],
		]);
		const list = paginate<string, { items: string[]; cursor?: string }>(
			async (cursor) => ({ data: pages.get(cursor) ?? { items: [] } }),
			(data) => data,
			unboundedDeadline,
			true,
		);

		const page = await list.page();
		expect(page).toEqual({ items: ["a", "b"], cursor: "c1" });
		expect(await list.all()).toEqual(["a", "b", "c"]);
	});

	it("rejects with the fetcher's NeonError when shouldThrow is true", async () => {
		const error = new NeonError("classified", "client");
		let calls = 0;
		const list = paginate<string, { items: string[]; cursor?: string }>(
			async (cursor) => {
				calls += 1;
				if (cursor === "c1") return { error };
				return { data: { items: ["a"], cursor: "c1" } };
			},
			(data) => data,
			unboundedDeadline,
			true,
		);

		await expect(list.page("c1")).rejects.toBe(error);
		calls = 0;
		await expect(list.all()).rejects.toBe(error);
		expect(calls).toBe(2);
	});
});

describe("client paginated throwOnError", () => {
	it("returns a bare array from a throwing client and the envelope when opted out", async () => {
		const project = { id: "p-1", name: "one" };
		const throwing = createNeonClient({
			apiKey: "test",
			retries: 0,
			throwOnError: true,
			fetch: async () =>
				new Response(
					JSON.stringify({
						projects: [project],
						pagination: {},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		});

		const projects = await throwing.projects.list().all();
		expect(projects).toEqual([project]);
		const page = await throwing.projects.list().page();
		expect(page.items).toEqual([project]);

		const envelope = await throwing.projects
			.list(undefined, { throwOnError: false })
			.all();
		expect(envelope.error).toBeUndefined();
		expect(envelope.data).toEqual([project]);
	});

	it("throws a classified API error from a default client with per-call throwOnError", async () => {
		const neon = createNeonClient({
			apiKey: "test",
			retries: 0,
			fetch: async () =>
				new Response(JSON.stringify({ message: "boom" }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
		});

		await expect(
			neon.projects.list(undefined, { throwOnError: true }).all(),
		).rejects.toBeInstanceOf(NeonApiError);
	});
});
