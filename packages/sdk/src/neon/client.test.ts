import { expectTypeOf, it } from "vitest";
import type {
	Branch,
	Endpoint,
	Project,
	Snapshot,
} from "../client/types.gen.js";
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

it("postgres namespace + tier-2/3 resources are reachable and typed", () => {
	const neon = createNeonClient({ apiKey: "x" });
	expectTypeOf(neon.postgres.endpoints.list("p")).resolves.toEqualTypeOf<
		NeonResult<Endpoint[]>
	>();
	expectTypeOf(
		neon.postgres.roles.password("p", "br", "neondb_owner"),
	).resolves.toEqualTypeOf<NeonResult<string>>();
	expectTypeOf(
		neon.postgres.connectionString({ projectId: "p" }),
	).resolves.toEqualTypeOf<NeonResult<string>>();
	expectTypeOf(neon.snapshots.list("p")).resolves.toEqualTypeOf<
		NeonResult<Snapshot[]>
	>();

	const throwing = createNeonClient({ apiKey: "x", throwOnError: true });
	expectTypeOf(
		throwing.postgres.connectionString({ projectId: "p" }),
	).resolves.toEqualTypeOf<string>();
	expectTypeOf(
		throwing.postgres.dataApi.delete("p", "br", "neondb"),
	).resolves.toEqualTypeOf<void>();
});

it("agent-platform helpers (default org, default branch, transfer, finalize) are typed", () => {
	const neon = createNeonClient({ apiKey: "x", orgId: "org-123" });
	expectTypeOf(neon.branches.getDefault("p")).resolves.toEqualTypeOf<
		NeonResult<Branch>
	>();
	expectTypeOf(neon.branches.setDefault("p", "br")).resolves.toEqualTypeOf<
		NeonResult<Branch>
	>();
	expectTypeOf(
		neon.branches.finalizeRestore("p", "br"),
	).resolves.toEqualTypeOf<NeonResult<void>>();
	expectTypeOf(
		neon.projects.transfer({ toOrgId: "org-paid", projectIds: ["p"] }),
	).resolves.toEqualTypeOf<NeonResult<void>>();
	expectTypeOf(
		neon.snapshots.create("p", "br", {
			name: "baseline",
			timestamp: "2026-01-01T00:00:00Z",
		}),
	).resolves.toEqualTypeOf<NeonResult<Snapshot>>();
	expectTypeOf(
		neon.snapshots.restore("p", "snap", {
			targetBranchId: "br",
			preview: (restored) => {
				expectTypeOf(restored).toEqualTypeOf<Branch>();
				return true;
			},
		}),
	).resolves.toEqualTypeOf<NeonResult<Branch>>();
});
