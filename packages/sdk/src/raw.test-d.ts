import { describe, expectTypeOf, test } from "vitest";
import type { ProjectResponse, ProjectsResponse } from "./client/types.gen.js";
import * as sdk from "./index.js";
import { createNeonClient } from "./neon/client.js";
import type { NeonError } from "./neon/errors.js";
import type { RawOptions, RawResult } from "./neon/raw-wrap.js";
import * as rawNs from "./raw.js";
import { getProject, listProjects } from "./raw.js";

// Type-level tests for the wrapped raw surface. Run via `pnpm --filter @neon/sdk test:types`
// and enforced by `tsc --noEmit` in the build (this file lives under `src`).

const client = createNeonClient({ apiKey: "x" }).client;

describe("raw result contract (types)", () => {
	test("default resolves to RawResult<T>", () => {
		expectTypeOf(
			getProject({ client, path: { project_id: "p" } }),
		).resolves.toEqualTypeOf<RawResult<ProjectResponse>>();
	});

	test("throwOnError: true narrows to the bare resource", () => {
		expectTypeOf(
			getProject({
				client,
				path: { project_id: "p" },
				throwOnError: true,
			}),
		).resolves.toEqualTypeOf<ProjectResponse>();
	});

	test("throwOnError: false keeps the envelope", () => {
		expectTypeOf(
			getProject({
				client,
				path: { project_id: "p" },
				throwOnError: false,
			}),
		).resolves.toEqualTypeOf<RawResult<ProjectResponse>>();
	});

	test("a list endpoint carries its intersection response type", () => {
		expectTypeOf(listProjects({ client })).resolves.toMatchTypeOf<
			RawResult<ProjectsResponse>
		>();
	});

	test("the error channel is the typed NeonError; success exposes data + response", async () => {
		const res = await getProject({ client, path: { project_id: "p" } });
		if (res.error) {
			expectTypeOf(res.error).toEqualTypeOf<NeonError>();
			expectTypeOf(res.error.kind).toBeString();
		} else {
			expectTypeOf(res.data).toEqualTypeOf<ProjectResponse>();
		}
		expectTypeOf(res.response).toEqualTypeOf<Response | undefined>();
	});
});

describe("raw result contract (negative types)", () => {
	test("responseStyle is no longer part of the public surface", () => {
		getProject({
			client,
			path: { project_id: "p" },
			// @ts-expect-error responseStyle was removed from the raw surface
			responseStyle: "data",
		});
	});

	test("throwOnError only accepts a boolean", () => {
		// @ts-expect-error throwOnError must be a boolean
		getProject({ client, path: { project_id: "p" }, throwOnError: "yes" });
	});

	test("client is required", () => {
		// @ts-expect-error raw operations require an explicit client
		getProject({ path: { project_id: "p" } });
		getProject({
			// @ts-expect-error client is Client, not undefined
			client: undefined,
			path: { project_id: "p" },
		});
	});

	test("the unauthenticated singleton is not exported", () => {
		// @ts-expect-error client is no longer exported from the raw entry
		rawNs.client;
		// @ts-expect-error raw.client is no longer public
		sdk.raw.client;
	});

	test("RawOptions requires Client and still omits hey-api switches", () => {
		type Opts = RawOptions<typeof getProject>;
		expectTypeOf<Opts["client"]>().toEqualTypeOf<typeof client>();
		expectTypeOf<Opts>().not.toHaveProperty("throwOnError");
		expectTypeOf<Opts>().not.toHaveProperty("responseStyle");
	});
});
