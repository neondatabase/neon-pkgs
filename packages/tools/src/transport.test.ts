import { isNeonError, NeonAuthError, NeonError } from "@neon/sdk";
import { describe, expect, test } from "vitest";
import { createNeonTools } from "./index.js";

const requestFrom = (input: RequestInfo | URL, init?: RequestInit) =>
	new Request(input, init);

describe("JSON-safe transport", () => {
	test("decodes base64 tool input for function deploys", async () => {
		let uploaded: FormData | undefined;
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["functions.deploy"],
			fetch: async (input, init) => {
				uploaded = await requestFrom(input, init).formData();
				return new Response(
					JSON.stringify({ deployment: { id: "deployment-id" } }),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});

		await tools["functions.deploy"].execute({
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

	test("normalizes empty responses to JSON null", async () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["credentials.revoke"],
			fetch: async () => new Response(null, { status: 204 }),
		});

		await expect(
			tools["credentials.revoke"].execute({
				project_id: "project-id",
				branch_id: "branch-id",
				token_id: "nak_live_test",
			}),
		).resolves.toEqual({ data: null });
	});

	test("propagates typed Neon API errors outside MCP", async () => {
		const tools = createNeonTools({
			apiKey: "bad-key",
			tools: ["projects.list"],
			fetch: async () =>
				new Response(
					JSON.stringify({ message: "Authentication failed" }),
					{
						status: 401,
						headers: { "content-type": "application/json" },
					},
				),
		});

		let thrown: unknown;
		try {
			await tools["projects.list"].execute({});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(NeonAuthError);
		expect(thrown).toBeInstanceOf(NeonError);
		expect(isNeonError(thrown)).toBe(true);
		if (thrown instanceof NeonAuthError) {
			expect(thrown.kind).toBe("auth");
			expect(thrown.status).toBe(401);
		}
	});
});

describe("auth.oauthProviders field forwarding", () => {
	const appleFields = {
		client_id: "com.example.service",
		client_secret: "-----BEGIN PRIVATE KEY-----",
		apple_team_id: "TEAM123456",
		apple_key_id: "KEY1234567",
	};
	const scope = { project_id: "project-id", branch_id: "branch-id" };

	const setup = () => {
		const bodies: unknown[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["auth.oauthProviders.add", "auth.oauthProviders.update"],
			fetch: async (request, init) => {
				bodies.push(await requestFrom(request, init).json());
				return new Response(
					JSON.stringify({ id: "apple", type: "standard" }),
					{
						headers: { "content-type": "application/json" },
					},
				);
			},
		});
		return { bodies, tools };
	};

	test("add sends the Apple fields in the request body", async () => {
		const { bodies, tools } = setup();
		await tools["auth.oauthProviders.add"].execute({
			...scope,
			id: "apple",
			...appleFields,
		});
		expect(bodies[0]).toMatchObject({ id: "apple", ...appleFields });
	});

	test("update sends the Apple fields in the request body", async () => {
		const { bodies, tools } = setup();
		await tools["auth.oauthProviders.update"].execute({
			...scope,
			oauth_provider_id: "apple",
			...appleFields,
		});
		expect(bodies[0]).toMatchObject(appleFields);
	});
});
