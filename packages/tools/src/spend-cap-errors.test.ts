import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { NeonDbError } from "@neondatabase/serverless";
import { describe, expect, test } from "vitest";
import { createNeonTools } from "./index.js";
import { registerNeonTools } from "./mcp.js";

describe("billing denials through the shared MCP adapter", () => {
	test("keeps the Postgres marker and SQLSTATE with billing guidance", async () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.get"],
		});
		const server = new McpServer({ name: "billing-test", version: "1" });
		// The adapter is under test; its external tool boundary supplies a driver error.
		registerNeonTools(server, {
			failure: {
				...tools["projects.get"],
				async execute() {
					throw Object.assign(
						new NeonDbError("Compute is restricted"),
						{ code: "57P03", detail: "SPEND_CAP_EXCEEDED" },
					);
				},
			},
		});
		const client = new Client({ name: "billing-test", version: "1" });
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		try {
			const result = await client.callTool({
				name: tools["projects.get"].id,
				arguments: { project_id: "p-1" },
			});
			expect(result.structuredContent).toMatchObject({
				error: {
					code: "57P03",
					detail: "SPEND_CAP_EXCEEDED",
					action: expect.stringContaining("Organization Billing"),
				},
			});
			expect(result.isError).toBe(true);
		} finally {
			await client.close();
			await server.close();
		}
	});
	test.each([
		"SPEND_CAP_EXCEEDED",
		"INSUFFICIENT_ORG_PERMISSIONS",
	])("preserves %s and relevant admin guidance without retry", async (code) => {
		let requests = 0;
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.get"],
			fetch: async () => {
				requests += 1;
				return new Response(
					JSON.stringify({ code, message: "Denied by policy" }),
					{
						status: 403,
						headers: { "content-type": "application/json" },
					},
				);
			},
		});
		const server = new McpServer({ name: "billing-test", version: "1" });
		registerNeonTools(server, tools);
		const client = new Client({ name: "billing-test", version: "1" });
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		try {
			const result = await client.callTool({
				name: tools["projects.get"].id,
				arguments: { project_id: "p-1" },
			});
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({
				error: {
					status: 403,
					code,
					message: "Denied by policy",
					action: expect.stringContaining("Organization Admin"),
				},
			});
			expect(JSON.stringify(result.content)).toContain(
				"Organization Admin",
			);
			if (code === "INSUFFICIENT_ORG_PERMISSIONS") {
				expect(result.structuredContent).toMatchObject({
					error: {
						action: "An Organization Admin must perform this action.",
					},
				});
				expect(JSON.stringify(result.content)).not.toContain(
					"Organization Billing",
				);
			} else {
				expect(result.structuredContent).toMatchObject({
					error: {
						action: expect.stringContaining("Organization Billing"),
					},
				});
			}
			expect(requests).toBe(1);
		} finally {
			await client.close();
			await server.close();
		}
	});
});
