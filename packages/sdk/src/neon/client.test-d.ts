import { expectTypeOf, it } from "vitest";
import type {
	Branch,
	ConsumptionHistoryPerProject,
	CustomDomain,
	Endpoint,
	NeonAuthIntegration,
	NeonAuthOauthProvider,
	Operation,
	Project,
	ProjectBranchLogRecord,
	ProjectListItem,
	ProjectPermission,
	Snapshot,
} from "../client/types.gen.js";
import { createNeonClient } from "./client.js";
import type { Page, Paginated } from "./paginate.js";
import type { BranchConnection } from "./resources/branches.js";
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
		neon.branches.create("p", { name: "x" }),
	).resolves.toEqualTypeOf<NeonResult<Branch>>();
	expectTypeOf(
		neon.branches.create("p", { name: "x", noCompute: true }),
	).resolves.toEqualTypeOf<NeonResult<Branch>>();
	neon.branches.create("p", {
		noCompute: true,
		// @ts-expect-error compute is invalid when noCompute is true
		compute: { minCu: 1 },
	});
	expectTypeOf(neon.branches.createAndConnect("p")).resolves.toEqualTypeOf<
		NeonResult<BranchConnection>
	>();
	expectTypeOf(
		neon.branches.createAndConnect("p", { name: "x" }),
	).resolves.toEqualTypeOf<NeonResult<BranchConnection>>();
	expectTypeOf(
		neon.projects.createAndConnect({ name: "x" }),
	).resolves.toEqualTypeOf<NeonResult<ProjectConnection>>();

	const throwing = createNeonClient({ apiKey: "x", throwOnError: true });
	expectTypeOf(
		throwing.branches.createAndConnect("p", { name: "x" }),
	).resolves.toEqualTypeOf<BranchConnection>();
	expectTypeOf(
		throwing.branches.delete("p", "br"),
	).resolves.toEqualTypeOf<void>();
	expectTypeOf(
		neon.branches.resetFromParent("p", "br"),
	).resolves.toEqualTypeOf<NeonResult<Branch>>();
	expectTypeOf(
		neon.branches.resetFromParent(
			"p",
			"br",
			{ preserveUnderName: "old" },
			{ throwOnError: true },
		),
	).resolves.toEqualTypeOf<Branch>();
	expectTypeOf(
		neon.branches.compareSchema("p", "br", { databaseName: "neondb" }),
	).resolves.toEqualTypeOf<NeonResult<{ diff?: string }>>();
});

it("cancellation and deadline options are accepted on the client and per call", () => {
	const neon = createNeonClient({ apiKey: "x", requestTimeoutMs: 30_000 });
	const controller = new AbortController();

	expectTypeOf(
		neon.projects.get("p", {
			signal: controller.signal,
			requestTimeoutMs: 5_000,
		}),
	).resolves.toEqualTypeOf<NeonResult<Project>>();

	// Paginated lists take the same per-call options as every other method, after their
	// query, and still erase the response-body type.
	expectTypeOf(
		neon.projects.list({ search: "x" }, { signal: controller.signal }),
	).toEqualTypeOf<Paginated<ProjectListItem>>();
	expectTypeOf(neon.branches.list("p", undefined, {})).toEqualTypeOf<
		Paginated<Branch>
	>();
	expectTypeOf(
		neon.operations.list("p", { requestTimeoutMs: 1_000 }),
	).toEqualTypeOf<Paginated<Operation>>();

	// A per-call throwOnError still narrows when other options ride along.
	expectTypeOf(
		neon.projects.get("p", {
			throwOnError: true,
			signal: controller.signal,
		}),
	).resolves.toEqualTypeOf<Project>();

	createNeonClient({
		apiKey: "x",
		// @ts-expect-error — a deadline is a number of milliseconds
		requestTimeoutMs: "30s",
	});
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

	// setSchedule narrows `frequency` to the API-accepted values.
	expectTypeOf(
		neon.snapshots.setSchedule("p", "br", {
			schedule: [{ frequency: "daily", hour: 3 }],
		}),
	).resolves.toEqualTypeOf<NeonResult<void>>();
	neon.snapshots.setSchedule("p", "br", {
		// @ts-expect-error — "hourly" is not an accepted SnapshotFrequency
		schedule: [{ frequency: "hourly" }],
	});
});

it("phase-1 namespaces (auth, permissions, recover, branch endpoints) are typed", () => {
	const neon = createNeonClient({ apiKey: "x" });
	expectTypeOf(neon.auth.get("p", "br")).resolves.toEqualTypeOf<
		NeonResult<NeonAuthIntegration>
	>();
	expectTypeOf(
		neon.auth.oauthProviders.list("p", "br"),
	).resolves.toEqualTypeOf<NeonResult<NeonAuthOauthProvider[]>>();
	expectTypeOf(
		neon.auth.oauthProviders.add("p", "br", { id: "google" }),
	).resolves.toEqualTypeOf<NeonResult<NeonAuthOauthProvider>>();
	expectTypeOf(neon.projects.permissions.list("p")).resolves.toEqualTypeOf<
		NeonResult<ProjectPermission[]>
	>();
	expectTypeOf(
		neon.projects.permissions.grant("p", "user@example.com"),
	).resolves.toEqualTypeOf<NeonResult<ProjectPermission>>();
	expectTypeOf(neon.projects.recover("p")).resolves.toEqualTypeOf<
		NeonResult<Project>
	>();
	expectTypeOf(
		neon.postgres.endpoints.listByBranch("p", "br"),
	).resolves.toEqualTypeOf<NeonResult<Endpoint[]>>();

	const throwing = createNeonClient({ apiKey: "x", throwOnError: true });
	expectTypeOf(
		throwing.auth.get("p", "br"),
	).resolves.toEqualTypeOf<NeonAuthIntegration>();
	expectTypeOf(
		throwing.auth.oauthProviders.delete("p", "br", "google"),
	).resolves.toEqualTypeOf<void>();
	expectTypeOf(
		throwing.projects.permissions.list("p"),
	).resolves.toEqualTypeOf<ProjectPermission[]>();
});

it("functions.customDomains is typed", () => {
	const neon = createNeonClient({ apiKey: "x" });
	expectTypeOf(neon.functions.customDomains.list("p", "br")).toEqualTypeOf<
		Paginated<CustomDomain>
	>();
	expectTypeOf(
		neon.functions.customDomains.register("p", "br", {
			domain: "docs.example.com",
			entity_type: "function",
			entity_id: "api",
		}),
	).resolves.toEqualTypeOf<NeonResult<CustomDomain>>();
	expectTypeOf(
		neon.functions.customDomains.delete("p", "br", "docs.example.com"),
	).resolves.toEqualTypeOf<NeonResult<void>>();

	const throwing = createNeonClient({ apiKey: "x", throwOnError: true });
	expectTypeOf(
		throwing.functions.customDomains.register("p", "br", {
			domain: "docs.example.com",
			entity_type: "function",
			entity_id: "api",
		}),
	).resolves.toEqualTypeOf<CustomDomain>();
	expectTypeOf(
		throwing.functions.customDomains.delete("p", "br", "docs.example.com"),
	).resolves.toEqualTypeOf<void>();
});

it("paginated lists honour throwOnError on page() and all()", async () => {
	const neon = createNeonClient({ apiKey: "x" });
	expectTypeOf(neon.projects.list().all()).resolves.toEqualTypeOf<
		NeonResult<ProjectListItem[]>
	>();
	expectTypeOf(neon.projects.list().page()).resolves.toEqualTypeOf<
		NeonResult<Page<ProjectListItem>>
	>();
	expectTypeOf(
		neon.projects.list(undefined, { throwOnError: true }),
	).toEqualTypeOf<Paginated<ProjectListItem, true>>();
	expectTypeOf(
		neon.projects.list(undefined, { throwOnError: true }).all(),
	).resolves.toEqualTypeOf<ProjectListItem[]>();

	const consumptionQuery = {
		from: "2024-03-01T00:00:00Z",
		to: "2024-03-02T00:00:00Z",
		granularity: "daily" as const,
	};
	expectTypeOf(neon.consumption.perProject(consumptionQuery)).toEqualTypeOf<
		Paginated<ConsumptionHistoryPerProject>
	>();

	const throwing = createNeonClient({ apiKey: "x", throwOnError: true });
	expectTypeOf(throwing.branches.list("p")).toEqualTypeOf<
		Paginated<Branch, true>
	>();
	expectTypeOf(throwing.branches.list("p").all()).resolves.toEqualTypeOf<
		Branch[]
	>();
	expectTypeOf(throwing.branches.list("p").page()).resolves.toEqualTypeOf<
		Page<Branch>
	>();
	expectTypeOf(
		throwing.branches.list("p", undefined, { throwOnError: false }).all(),
	).resolves.toEqualTypeOf<NeonResult<Branch[]>>();
	expectTypeOf(throwing.operations.list("p")).toEqualTypeOf<
		Paginated<Operation, true>
	>();
	expectTypeOf(throwing.logs.query("p", "br")).toEqualTypeOf<
		Paginated<ProjectBranchLogRecord, true>
	>();
	expectTypeOf(
		throwing.consumption.perProject(consumptionQuery),
	).toEqualTypeOf<Paginated<ConsumptionHistoryPerProject, true>>();

	for await (const branch of throwing.branches.list("p")) {
		expectTypeOf(branch).toEqualTypeOf<Branch>();
		break;
	}
});
