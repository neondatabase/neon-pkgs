import { describe, expect, it } from "vitest";
import { NeonNotFoundError } from "../src/index.js";
import {
	describeEndpoint,
	fetchOpenApiSpec,
	searchEndpoints,
} from "../src/openapi.js";
import { makeClient } from "./helpers.js";

/**
 * `neon.request` and `@neon/sdk/openapi` against what production serves: the live
 * spec on neon.com and the API's real envelopes, which the unit suite stubs.
 */
describe.sequential("e2e — neon.request and the live OpenAPI spec", () => {
	it("finds and describes the create-branch endpoint in the released spec", async () => {
		const spec = await fetchOpenApiSpec();
		const [hit] = searchEndpoints(spec, "create branch");
		expect(hit).toMatchObject({
			method: "POST",
			path: "/projects/{project_id}/branches",
		});
		const names = describeEndpoint(
			spec,
			hit?.path ?? "",
			"POST",
		).fields.map((field) => field.name);
		expect(names).toEqual(
			expect.arrayContaining(["project_id", "branch.name"]),
		);
	});

	it("reads a route and maps a missing one to NeonNotFoundError", async () => {
		const neon = makeClient();
		const listed = await neon.request({
			method: "GET",
			path: "/projects",
			query: { limit: 1 },
		});
		expect(listed.error).toBeUndefined();
		expect(listed.data).toMatchObject({ projects: expect.any(Array) });

		const missing = await neon.request({
			method: "GET",
			path: "/projects/neon-ts-e2e-does-not-exist",
		});
		expect(missing.error).toBeInstanceOf(NeonNotFoundError);
	});
});
