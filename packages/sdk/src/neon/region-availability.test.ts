import { describe, expect, it } from "vitest";
import { createNeonClient } from "./client.js";
import { NeonNotFoundError } from "./errors.js";

type Reply = { status: number; body?: unknown };

function neonAnswering(respond: (url: URL) => Reply) {
	const calls: string[] = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		throwOnError: false,
		fetch: async (input) => {
			const url = new URL(
				input instanceof Request ? input.url : String(input),
			);
			calls.push(url.pathname);
			const { status, body } = respond(url);
			return new Response(
				body === undefined ? null : JSON.stringify(body),
				{
					status,
					headers: { "content-type": "application/json" },
				},
			);
		},
	});
	return { neon, calls };
}

const notAvailable = (message: string): Reply => ({
	status: 404,
	body: { code: "", message },
});

function projectIn(regionId: string, feature: Reply) {
	return (url: URL): Reply =>
		/^\/api\/v2\/projects\/[^/]+$/.test(url.pathname)
			? {
					status: 200,
					body: { project: { id: "p", region_id: regionId } },
				}
			: feature;
}

const target = { projectId: "proud-dew-48310209", branchId: "br-flat-bread" };

describe("feature-unavailable 404s", () => {
	it("names the project region and the supported regions", async () => {
		const { neon, calls } = neonAnswering(
			projectIn(
				"aws-us-west-2",
				notAvailable("Realtime is not available for this project"),
			),
		);

		const result = await neon.realtime.enable(target);

		expect(result.error).toBeInstanceOf(NeonNotFoundError);
		expect(result.error?.message).toBe(
			"Realtime is not available for this project: it is in aws-us-west-2. Realtime runs in aws-us-east-2, aws-us-east-1, aws-eu-central-1, and aws-ap-southeast-1. Create a project in one of those regions to use it.",
		);
		expect(calls).toEqual([
			"/api/v2/projects/proud-dew-48310209/branches/br-flat-bread/realtime",
			"/api/v2/projects/proud-dew-48310209",
		]);
	});

	type Neon = ReturnType<typeof neonAnswering>["neon"];
	it.each([
		[
			"platform branchable-storage is not available in this region",
			(n: Neon) => n.storage.get(target),
			"Object Storage is not available for this project: it is in aws-us-west-2. Object Storage runs in",
		],
		[
			"ai gateway is not available in this region",
			(n: Neon) => n.aiGateway.get(target),
			"The AI Gateway is not available for this project: it is in aws-us-west-2. The AI Gateway runs in",
		],
		[
			"function triggers not available for this project",
			(n: Neon) => n.triggers.list(target),
			"Function triggers are not available for this project: it is in aws-us-west-2. Function triggers run in",
		],
		[
			"platform functions not available for this project",
			(n: Neon) => n.functions.list(target).page(),
			"Neon Functions are not available for this project: it is in aws-us-west-2. Neon Functions run in",
		],
	])("rewrites the 404 %s", async (message, call, expected) => {
		const { neon } = neonAnswering(
			projectIn("aws-us-west-2", notAvailable(message)),
		);
		const result = await call(neon);
		expect(result.error).toBeInstanceOf(NeonNotFoundError);
		expect(result.error?.message.startsWith(expected)).toBe(true);
	});

	it("keeps the API message when the project is in a supported region", async () => {
		const { neon } = neonAnswering(
			projectIn(
				"aws-us-east-2",
				notAvailable("Realtime is not available for this project"),
			),
		);
		const result = await neon.realtime.get(target);
		expect(result.error?.message).toBe(
			"Realtime is not available for this project",
		);
	});

	it("keeps the API message when the project region cannot be read", async () => {
		const { neon } = neonAnswering((url) =>
			url.pathname.endsWith("/realtime")
				? notAvailable("Realtime is not available for this project")
				: { status: 500, body: { message: "boom" } },
		);
		const result = await neon.realtime.get(target);
		expect(result.error).toBeInstanceOf(NeonNotFoundError);
		expect(result.error?.message).toBe(
			"Realtime is not available for this project",
		);
	});

	it("does not look up the project for other 404s", async () => {
		const { neon, calls } = neonAnswering(() =>
			notAvailable("branch not found"),
		);
		const result = await neon.realtime.get(target);
		expect(result.error?.message).toBe("branch not found");
		expect(calls).toHaveLength(1);
	});
});

describe("the region lookup stays inside the request deadline", () => {
	function stallingLookup(config: { requestTimeoutMs?: number }) {
		let fetched = false;
		return createNeonClient({
			// Key reads after the first request are the region lookup's; they never
			// resolve, as a stalled credential refresh would not.
			apiKey: () => (fetched ? new Promise<string>(() => {}) : "test"),
			retries: 0,
			throwOnError: false,
			requestTimeoutMs: config.requestTimeoutMs,
			fetch: async () => {
				fetched = true;
				return new Response(
					JSON.stringify({
						message: "Realtime is not available for this project",
					}),
					{
						status: 404,
						headers: { "content-type": "application/json" },
					},
				);
			},
		});
	}

	it("answers within requestTimeoutMs when the lookup stalls", async () => {
		const neon = stallingLookup({ requestTimeoutMs: 100 });
		const started = Date.now();
		const result = await neon.realtime.get(target);
		expect(result.error?.kind).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("answers within requestTimeoutMs for a paginated list", async () => {
		const neon = stallingLookup({ requestTimeoutMs: 100 });
		const started = Date.now();
		const result = await neon.functions.list(target).page();
		expect(result.error?.kind).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("honors the caller's signal during the lookup", async () => {
		const neon = stallingLookup({});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const result = await neon.realtime.get(target, {
			signal: controller.signal,
		});
		expect(result.error?.kind).toBe("aborted");
	});
});
