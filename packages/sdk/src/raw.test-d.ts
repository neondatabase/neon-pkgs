import { describe, expectTypeOf, test } from "vitest";
import type { ProjectResponse, ProjectsResponse } from "./client/types.gen.js";
import { createNeonClient } from "./neon/client.js";
import type { NeonError } from "./neon/errors.js";
import type { NeonResult } from "./neon/result.js";
import { getProject, listProjects } from "./raw.js";

// Type-level tests for the wrapped raw surface. Run via `pnpm --filter @neon/sdk test:types`
// and enforced by `tsc --noEmit` in the build (this file lives under `src`).

const client = createNeonClient({ apiKey: "x" }).client;

describe("raw result contract (types)", () => {
	test("default resolves to NeonResult<T>", () => {
		expectTypeOf(
			getProject({ client, path: { project_id: "p" } }),
		).resolves.toEqualTypeOf<NeonResult<ProjectResponse>>();
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
		).resolves.toEqualTypeOf<NeonResult<ProjectResponse>>();
	});

	test("a list endpoint carries its intersection response type", () => {
		expectTypeOf(listProjects({ client })).resolves.toMatchTypeOf<
			NeonResult<ProjectsResponse>
		>();
	});

	test("the error channel is the typed NeonError union", async () => {
		const res = await getProject({ client, path: { project_id: "p" } });
		if (res.error) {
			expectTypeOf(res.error).toEqualTypeOf<NeonError>();
			expectTypeOf(res.error.kind).toBeString();
		} else {
			expectTypeOf(res.data).toEqualTypeOf<ProjectResponse>();
		}
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
});
