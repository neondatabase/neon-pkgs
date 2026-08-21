import { describe, expect, test } from "vitest";
import { createNeonTools, NeonError } from "./index.js";

const requestFrom = (input: RequestInfo | URL, init?: RequestInit) =>
	new Request(input, init);

describe("JSON-safe transport", () => {
	test("decodes base64 tool input for multipart operations", async () => {
		let uploaded: FormData | undefined;
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["createProjectBranchFunctionDeployment"],
			fetch: async (input, init) => {
				uploaded = await requestFrom(input, init).formData();
				return new Response(
					JSON.stringify({ deployment: { id: "deployment-id" } }),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});

		await tools.createProjectBranchFunctionDeployment.execute({
			project_id: "project-id",
			branch_id: "branch-id",
			slug: "demo",
			zip: "UEsDBA==",
		});

		const zip = uploaded?.get("zip");
		expect(zip).toBeInstanceOf(Blob);
		if (!(zip instanceof Blob)) {
			throw new TypeError("Expected multipart zip field to be a Blob.");
		}
		expect(new Uint8Array(await zip.arrayBuffer())).toEqual(
			new Uint8Array([80, 75, 3, 4]),
		);
	});

	test("encodes binary responses as base64 with content metadata", async () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["getProjectBranchBucketObject"],
			fetch: async () =>
				new Response("hi", {
					headers: { "content-type": "application/octet-stream" },
				}),
		});

		const result = await tools.getProjectBranchBucketObject.execute({
			project_id: "project-id",
			branch_id: "branch-id",
			bucket_name: "assets",
			object_key: "hello.txt",
		});

		expect(result).toEqual({
			data: {
				base64: "aGk=",
				contentType: "application/octet-stream",
				size: 2,
			},
		});
	});

	test("normalizes empty responses to JSON null", async () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["revokeCredential"],
			fetch: async () => new Response(null, { status: 204 }),
		});

		await expect(
			tools.revokeCredential.execute({
				project_id: "project-id",
				branch_id: "branch-id",
				token_id: "nak_live_test",
			}),
		).resolves.toEqual({ data: null });
	});

	test("propagates typed Neon API errors outside MCP", async () => {
		const tools = createNeonTools({
			apiKey: "bad-key",
			operations: ["listProjects"],
			fetch: async () =>
				new Response(
					JSON.stringify({ message: "Authentication failed" }),
					{
						status: 401,
						headers: { "content-type": "application/json" },
					},
				),
		});

		await expect(tools.listProjects.execute({})).rejects.toBeInstanceOf(
			NeonError,
		);
	});
});
