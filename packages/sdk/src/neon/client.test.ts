import { expectTypeOf, it } from "vitest";
import type { Branch, Project } from "../client/types.gen.js";
import { createNeonClient } from "./client.js";
import type { Paginated } from "./paginate.js";
import type { BranchWithCompute } from "./resources/branches.js";
import type { ProjectConnection } from "./resources/projects.js";
import type { NeonResult } from "./result.js";

it("default client returns the { data, error } envelope", () => {
	const neon = createNeonClient({ apiKey: "x" });
	expectTypeOf(neon.projects.get("p")).resolves.toEqualTypeOf<
		NeonResult<Project>
	>();
	expectTypeOf(neon.projects.create()).resolves.toEqualTypeOf<
		NeonResult<Project>
	>();
});

it("throwOnError on the client narrows methods to the bare resource", () => {
	const neon = createNeonClient({ apiKey: "x", throwOnError: true });
	expectTypeOf(neon.projects.get("p")).resolves.toEqualTypeOf<Project>();
});

it("per-call throwOnError overrides the client default and narrows", () => {
	const neon = createNeonClient({ apiKey: "x" });
	expectTypeOf(
		neon.projects.get("p", { throwOnError: true }),
	).resolves.toEqualTypeOf<Project>();

	const throwing = createNeonClient({ apiKey: "x", throwOnError: true });
	expectTypeOf(
		throwing.projects.get("p", { throwOnError: false }),
	).resolves.toEqualTypeOf<NeonResult<Project>>();
});

it("branches + workflows carry the envelope and narrow under throwOnError", () => {
	const neon = createNeonClient({ apiKey: "x" });
	expectTypeOf(neon.branches.list("p")).toEqualTypeOf<Paginated<Branch>>();
	expectTypeOf(neon.branches.get("p", "br")).resolves.toEqualTypeOf<
		NeonResult<Branch>
	>();
	expectTypeOf(
		neon.branches.createWithCompute("p", { name: "x" }),
	).resolves.toEqualTypeOf<NeonResult<BranchWithCompute>>();
	expectTypeOf(
		neon.projects.createAndConnect({ name: "x" }),
	).resolves.toEqualTypeOf<NeonResult<ProjectConnection>>();

	const throwing = createNeonClient({ apiKey: "x", throwOnError: true });
	expectTypeOf(
		throwing.branches.createWithCompute("p", { name: "x" }),
	).resolves.toEqualTypeOf<BranchWithCompute>();
	expectTypeOf(
		throwing.branches.delete("p", "br"),
	).resolves.toEqualTypeOf<void>();
});
