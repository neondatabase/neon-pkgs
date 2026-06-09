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

	test("plans preview create + deploy + bucket + ai-gateway when nothing exists", () => {
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
					buckets: [],
					functions: [],
					aiGatewayEnabled: false,
				},
			},
			{ updateExisting: false },
		);
		expect(diff.plan.map((p) => p.kind)).toEqual([
			"create-bucket",
			"create-function",
			"deploy-function",
			"enable-ai-gateway",
		]);
	});

	test("skips create-function and skips enable-ai-gateway when already present, but still re-deploys", () => {
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
					aiGatewayEnabled: true,
				},
			},
			{ updateExisting: false },
		);
		expect(diff.plan.map((p) => p.kind)).toEqual(["deploy-function"]);
	});
});
