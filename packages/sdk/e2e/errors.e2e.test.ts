import { describe, expect, it } from "vitest";
import {
	createNeonClient,
	NeonAuthError,
	NeonNotFoundError,
} from "../src/index.js";
import { listProjects } from "../src/raw.js";
import { makeClient, makeThrowingClient } from "./helpers.js";

const MISSING_PROJECT_ID = "neon-ts-e2e-does-not-exist";

/**
 * `toNeonError` classifies whatever the API actually returns. The unit suite feeds it
 * hand-written response bodies, which proves the mapping logic but not that Neon's real
 * error envelope still matches the shape it was written against.
 */
describe.sequential("e2e — @neon/sdk error mapping against the real API", () => {
	it("maps a missing project to NeonNotFoundError with the real status", async () => {
		const neon = makeClient();

		const { data, error } = await neon.projects.get(MISSING_PROJECT_ID);

		expect(data).toBeUndefined();
		expect(error).toBeInstanceOf(NeonNotFoundError);
		expect(error?.kind).toBe("not_found");
		if (!(error instanceof NeonNotFoundError))
			throw new Error("unreachable");
		expect(error.status).toBe(404);
		// Neon returns a request id on every error; it's what support asks for first.
		expect(error.requestId).toBeTruthy();
	});

	it("maps a rejected API key to NeonAuthError", async () => {
		const neon = createNeonClient({ apiKey: "napi_not_a_real_key" });

		const { data, error } = await neon.projects.list().all();

		expect(data).toBeUndefined();
		expect(error).toBeInstanceOf(NeonAuthError);
		expect(error?.kind).toBe("auth");
		if (!(error instanceof NeonAuthError)) throw new Error("unreachable");
		expect([401, 403]).toContain(error.status);
	});

	it("throws the same error class when the client is in throwOnError mode", async () => {
		const neon = makeThrowingClient();

		await expect(
			neon.projects.get(MISSING_PROJECT_ID),
		).rejects.toBeInstanceOf(NeonNotFoundError);
	});

	it("surfaces the underlying Response through the raw layer", async () => {
		const neon = makeClient();

		const result = await listProjects({
			client: neon.client,
			query: { limit: 1 },
		});

		expect(result.error).toBeUndefined();
		expect(result.response?.status).toBe(200);
		expect(Array.isArray(result.data?.projects)).toBe(true);
	});
});
