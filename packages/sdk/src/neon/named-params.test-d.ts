import { expectTypeOf, it } from "vitest";
import {
	type Branch,
	createNeonClient,
	type NeonResult,
	type Paginated,
	type RemoveRoleOptions,
	type SetRoleOptions,
} from "../index.js";

it("named inputs preserve resource and pagination inference", () => {
	const client = createNeonClient({ apiKey: "unused" });
	expectTypeOf(
		client.branches.get({ branchId: "b", projectId: "p" }),
	).resolves.toEqualTypeOf<NeonResult<Branch>>();
	expectTypeOf(
		client.branches.get(
			{ projectId: "p", branchId: "b" },
			{ throwOnError: true },
		),
	).resolves.toEqualTypeOf<Branch>();
	expectTypeOf(
		client.branches.list(
			{ projectId: "p", limit: 2 },
			{ throwOnError: true },
		),
	).toEqualTypeOf<Paginated<Branch, true>>();
	expectTypeOf(
		client.branches.delete(
			{ projectId: "p", branchId: "b" },
			{ throwOnError: true },
		),
	).resolves.toEqualTypeOf<void>();
	expectTypeOf(
		client.operations.waitFor(
			{ operations: [] },
			{ timeoutMs: 100, throwOnError: true },
		),
	).resolves.toEqualTypeOf<void>();

	// @ts-expect-error positional resource identifiers were removed
	client.branches.get("p", "b");
	// @ts-expect-error a branch selector is required
	client.branches.get({ projectId: "p" });
	// @ts-expect-error numeric API key ids retain their type
	client.apiKeys.revoke({ keyId: "1" });
	// @ts-expect-error compute settings and noCompute remain mutually exclusive
	client.branches.create({
		projectId: "p",
		noCompute: true,
		compute: { minCu: 1 },
	});
	// @ts-expect-error operation arrays now belong to a named object
	client.operations.waitFor([]);
	// @ts-expect-error waitFor does not support requestTimeoutMs
	client.operations.waitFor({ operations: [] }, { requestTimeoutMs: 100 });
});

it("workflow fields belong to operation inputs, not execution options", () => {
	const client = createNeonClient({ apiKey: "unused" });
	client.projects.createAndConnect({ name: "app", pooled: false });
	client.branches.createAndConnect({ projectId: "p", pooled: false });
	client.projects.members.setRole({
		projectId: "p",
		memberId: "m",
		role: "viewer",
		confirmSelfDemotion: true,
	});
	client.projects.members.removeRole({
		projectId: "p",
		memberId: "m",
		confirmSelfLockout: true,
	});
	// @ts-expect-error pooled moved into the first argument
	client.projects.createAndConnect({}, { pooled: false });
	// @ts-expect-error pooled moved into the first argument
	client.branches.createAndConnect({ projectId: "p" }, { pooled: false });
	// @ts-expect-error confirmation moved into the operation input
	const setOptions: SetRoleOptions = { confirmSelfDemotion: true };
	// @ts-expect-error confirmation moved into the operation input
	const removeOptions: RemoveRoleOptions = { confirmSelfLockout: true };
	void setOptions;
	void removeOptions;
});
