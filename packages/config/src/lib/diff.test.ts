import { describe, expect, test } from "vitest";
import { diffConfig, type RemoteState } from "./diff.js";

describe("diffConfig", () => {
	const remote: RemoteState = {
		projectId: "proj",
		branch: {
			id: "br-main",
			name: "main",
			isDefault: true,
			protected: false,
		},
		endpoint: {
			id: "ep",
			branchId: "br-main",
			type: "read_write" as const,
			autoscalingLimitMinCu: 0.25,
			autoscalingLimitMaxCu: 1,
			suspendTimeout: "5m",
		},
		services: {
			databaseName: "neondb",
			authEnabled: false,
			dataApiEnabled: false,
		},
	};

	test("plans service enables", () => {
		const diff = diffConfig(
			{ authEnabled: true, dataApiEnabled: true },
			remote,
			{ updateExisting: false },
		);
		expect(diff.plan.map((p) => p.kind)).toEqual([
			"enable-auth",
			"enable-data-api",
		]);
	});

	test("reports compute drift unless updateExisting is set", () => {
		const diff = diffConfig(
			{
				authEnabled: false,
				dataApiEnabled: false,
				postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } },
			},
			remote,
			{ updateExisting: false },
		);
		expect(diff.conflicts[0]).toMatchObject({ field: "computeSettings" });
	});

	test("plans mutable branch updates with updateExisting", () => {
		const diff = diffConfig(
			{ authEnabled: false, dataApiEnabled: false, protected: true },
			remote,
			{ updateExisting: true },
		);
		expect(diff.plan[0]).toMatchObject({
			kind: "update-branch-protected",
			branchId: "br-main",
		});
	});

	test("plans preview deploy + bucket when nothing exists (aiGateway is never provisioned)", () => {
		const diff = diffConfig(
			{
				authEnabled: false,
				dataApiEnabled: false,
				preview: {
					functions: [
						{
							slug: "fn1",
							name: "Hello World",
							source: "./hello.ts",
							env: {},
							runtime: "nodejs24",
						},
					],
					buckets: [{ name: "uploads", access: "private" }],
					// aiGateway is always available (credential-gated), so even when the
					// policy enables it the diff emits no provisioning step for it.
					aiGatewayEnabled: true,
				},
			},
			{
				...remote,
				preview: {
					buckets: [],
					functions: [],
				},
			},
			{ updateExisting: false },
		);
		expect(diff.plan.map((p) => p.kind)).toEqual([
			"create-bucket",
			"deploy-function",
		]);
		// A brand-new function is created by its first deployment, so the single
		// deploy-function step is flagged as not-yet-existing.
		const deploy = diff.plan.find((p) => p.kind === "deploy-function");
		expect(deploy).toMatchObject({ functionExists: false });
	});

	test("re-deploys an existing function and never plans an aiGateway step", () => {
		const diff = diffConfig(
			{
				authEnabled: false,
				dataApiEnabled: false,
				preview: {
					functions: [
						{
							slug: "fn1",
							name: "Hello World",
							source: "./hello.ts",
							env: {},
							runtime: "nodejs24",
						},
					],
					buckets: [{ name: "uploads", access: "private" }],
					aiGatewayEnabled: true,
				},
			},
			{
				...remote,
				preview: {
					buckets: [{ name: "uploads", accessLevel: "private" }],
					functions: [
						{
							id: "fn-1",
							slug: "fn1",
							name: "Hello World",
							invocationUrl: "https://x/functions/fn1",
						},
					],
				},
			},
			{ updateExisting: false },
		);
		expect(diff.plan.map((p) => p.kind)).toEqual(["deploy-function"]);
		// The function already exists remotely, so its deploy is flagged as an update.
		const deploy = diff.plan.find((p) => p.kind === "deploy-function");
		expect(deploy).toMatchObject({ functionExists: true });
	});
});
