import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describeOperation, type OpenApiSpec } from "./openapi";

const miniSpec = {
	paths: {
		"/projects": {
			parameters: [
				{
					name: "org_id",
					in: "query",
					schema: { type: "string" },
					description: "path-item org_id",
				},
			],
			get: {
				operationId: "listProjects",
				summary: "List projects",
				parameters: [
					{
						name: "limit",
						in: "query",
						schema: { type: "integer" },
						description: "Page size",
					},
					{
						name: "org_id",
						in: "query",
						schema: { type: "string" },
						description: "operation org_id",
					},
					{ $ref: "#/components/parameters/TimeoutParam" },
					{
						name: "category",
						in: "query",
						schema: {
							$ref: "#/components/schemas/AdvisorCategory",
						},
						description: "Filter by category",
					},
				],
			},
			post: {
				operationId: "createProject",
				summary: "Create project",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								$ref: "#/components/schemas/ProjectCreateRequest",
							},
						},
					},
				},
			},
		},
		"/projects/{project_id}/branches": {
			post: {
				operationId: "createProjectBranch",
				summary: "Create branch",
				requestBody: {
					required: false,
					content: {
						"application/json": {
							schema: {
								allOf: [
									{
										$ref: "#/components/schemas/BranchCreateRequest",
									},
								],
							},
						},
					},
				},
			},
		},
		"/only-post": {
			post: {
				operationId: "onlyPost",
				summary: "POST only",
			},
		},
	},
	components: {
		parameters: {
			TimeoutParam: {
				name: "timeout",
				in: "query",
				description: "Timeout in milliseconds",
				schema: { type: "integer" },
			},
		},
		schemas: {
			AdvisorCategory: {
				type: "string",
				enum: ["SECURITY", "PERFORMANCE"],
			},
			Provisioner: {
				type: "string",
				enum: ["k8s-neonvm", "k8s-pod"],
			},
			EndpointType: {
				type: "string",
				enum: ["read_write", "read_only"],
			},
			ProjectCreateRequest: {
				type: "object",
				required: ["project"],
				properties: {
					project: {
						type: "object",
						description: "New project",
						properties: {
							name: {
								type: "string",
								description: "The project name",
							},
							provisioner: {
								$ref: "#/components/schemas/Provisioner",
								description:
									"Compute provisioner. k8s-neonvm supports Autoscaling.",
							},
							settings: {
								type: "object",
								properties: {
									quota: {
										type: "object",
										properties: {
											logical_size_bytes: {
												type: "integer",
												description:
													"Per-branch size cap",
											},
										},
									},
									maintenance_window: {
										type: "object",
										required: [
											"weekdays",
											"start_time",
											"end_time",
										],
										properties: {
											weekdays: { type: "array" },
											start_time: { type: "string" },
											end_time: { type: "string" },
										},
									},
								},
							},
							annotations: {
								type: "object",
								additionalProperties: { type: "string" },
								description: "Free-form metadata",
							},
						},
					},
				},
			},
			BranchCreateRequest: {
				type: "object",
				properties: {
					branch: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: "The branch name",
							},
							parent_id: { type: "string" },
						},
					},
					endpoints: {
						type: "array",
						description: "Computes to create with the branch",
						items: {
							$ref: "#/components/schemas/BranchCreateRequestEndpointOptions",
						},
					},
				},
			},
			BranchCreateRequestEndpointOptions: {
				type: "object",
				required: ["type"],
				properties: {
					type: { $ref: "#/components/schemas/EndpointType" },
					settings: { type: "object" },
				},
			},
		},
	},
} satisfies OpenApiSpec;

const spec: OpenApiSpec = miniSpec;

describe("describeOperation", () => {
	it("lists query params, resolving parameter and schema $refs", () => {
		const result = describeOperation(spec, "/projects", "GET");
		expect(result).toMatchObject({
			method: "GET",
			path: "/projects",
			summary: "List projects",
			operationId: "listProjects",
			bodyRequired: false,
		});
		expect(result.fields).toEqual([
			{
				in: "query",
				name: "org_id",
				required: false,
				type: "string",
				description: "operation org_id",
			},
			{
				in: "query",
				name: "limit",
				required: false,
				type: "integer",
				description: "Page size",
			},
			{
				in: "query",
				name: "timeout",
				required: false,
				type: "integer",
				description: "Timeout in milliseconds",
			},
			{
				in: "query",
				name: "category",
				required: false,
				type: "string",
				description: "Filter by category",
				enum: ["SECURITY", "PERFORMANCE"],
			},
		]);
	});

	it("overrides path-item parameters with the same name and in", () => {
		const orgId = describeOperation(spec, "/projects", "GET").fields.find(
			(field) => field.name === "org_id",
		);
		expect(orgId?.description).toBe("operation org_id");
	});

	it("flattens nested body keys and keeps $ref sibling descriptions", () => {
		const result = describeOperation(spec, "/projects", "POST");
		expect(result.bodyRequired).toBe(true);
		expect(result.fields.map((field) => field.name)).toEqual([
			"org_id",
			"project.name",
			"project.provisioner",
			"project.settings.quota.logical_size_bytes",
			"project.settings.maintenance_window.weekdays",
			"project.settings.maintenance_window.start_time",
			"project.settings.maintenance_window.end_time",
			"project.annotations",
		]);
		expect(
			result.fields.find((field) => field.name === "project"),
		).toBeUndefined();
		expect(
			result.fields.find((field) => field.name === "project.name"),
		).toMatchObject({
			in: "body",
			required: false,
			type: "string",
			description: "The project name",
		});
		expect(
			result.fields.find((field) => field.name === "project.provisioner"),
		).toMatchObject({
			type: "string",
			description:
				"Compute provisioner. k8s-neonvm supports Autoscaling.",
			enum: ["k8s-neonvm", "k8s-pod"],
		});
		expect(
			result.fields.find(
				(field) =>
					field.name ===
					"project.settings.maintenance_window.weekdays",
			),
		).toMatchObject({ required: true, type: "array" });
		expect(
			result.fields.find((field) => field.name === "project.annotations"),
		).toMatchObject({
			required: false,
			type: "object",
			description: "Free-form metadata",
		});
	});

	it("keeps arrays as -F leaves and exposes item properties", () => {
		const result = describeOperation(
			spec,
			"/projects/{project_id}/branches",
			"POST",
		);
		expect(result.bodyRequired).toBe(false);
		expect(
			result.fields.find((field) => field.name === "project_id"),
		).toMatchObject({
			in: "path",
			required: true,
			type: "string",
		});
		expect(
			result.fields.find((field) => field.name === "branch.name"),
		).toMatchObject({
			in: "body",
			type: "string",
			description: "The branch name",
		});
		expect(
			result.fields.find((field) => field.name === "endpoints"),
		).toMatchObject({
			in: "body",
			required: false,
			type: "array",
			description: "Computes to create with the branch",
			items: {
				type: "object",
				properties: [
					{
						name: "type",
						type: "string",
						required: true,
						description: "",
						enum: ["read_write", "read_only"],
					},
					{
						name: "settings",
						type: "object",
						required: false,
						description: "",
					},
				],
			},
		});
	});

	it("matches a concrete id against a path template", () => {
		const result = describeOperation(
			spec,
			"/projects/foo-bar-123/branches",
			"POST",
		);
		expect(result.path).toBe("/projects/{project_id}/branches");
		expect(result.operationId).toBe("createProjectBranch");
	});

	it("errors when GET is missing and names the methods that exist", () => {
		expect(() => describeOperation(spec, "/only-post", "GET")).toThrow(
			"No GET /only-post in the spec. Available: POST. Pass -X POST.",
		);
	});

	it("errors for an unknown path", () => {
		expect(() => describeOperation(spec, "/nope", "GET")).toThrow(
			'No route matches "/nope". Run `neon api --list` to see available routes.',
		);
	});
});

describe("describeOperation against the vendored Neon spec", () => {
	const neonSpec = JSON.parse(
		readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"../../../sdk/spec/neon-openapi.json",
			),
			"utf8",
		),
	) as OpenApiSpec;

	it("describes GET /projects query params including TimeoutParam", () => {
		const result = describeOperation(neonSpec, "/projects", "GET");
		const names = result.fields.map((field) => field.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"cursor",
				"limit",
				"search",
				"org_id",
				"timeout",
			]),
		);
		expect(result.fields.every((field) => field.in === "query")).toBe(true);
	});

	it("describes POST /projects as a required body of dotted project fields", () => {
		const result = describeOperation(neonSpec, "/projects", "POST");
		expect(result.bodyRequired).toBe(true);
		expect(result.operationId).toBe("createProject");
		const names = result.fields.map((field) => field.name);
		expect(names).toContain("project.name");
		expect(names).toContain("project.region_id");
		expect(names).not.toContain("project");
		expect(
			result.fields.find((field) => field.name === "project.provisioner")
				?.description,
		).toMatch(/provisioner/i);
	});

	it("describes POST .../branches array items for -F endpoints=", () => {
		const result = describeOperation(
			neonSpec,
			"/projects/proj-1/branches",
			"POST",
		);
		expect(result.path).toBe("/projects/{project_id}/branches");
		const endpoints = result.fields.find(
			(field) => field.name === "endpoints",
		);
		expect(endpoints?.type).toBe("array");
		expect(
			endpoints?.items?.properties?.some(
				(p) => p.name === "type" && p.required,
			),
		).toBe(true);
		expect(
			result.fields.find((field) => field.name === "branch.name"),
		).toMatchObject({ in: "body", type: "string" });
	});

	it("resolves query enum $refs", () => {
		const result = describeOperation(
			neonSpec,
			"/projects/{project_id}/advisors",
			"GET",
		);
		expect(
			result.fields.find((field) => field.name === "category"),
		).toMatchObject({
			in: "query",
			type: "string",
			enum: ["SECURITY", "PERFORMANCE"],
		});
	});
});
