import { describe, expect, test } from "vitest";
import { shapeHookEnv } from "./hooks.js";

describe("shapeHookEnv", () => {
	test("maps postgres, defaulting missing URLs to empty strings", () => {
		const env = shapeHookEnv({
			postgres: {
				databaseUrl: "postgres://pooled/neondb",
				databaseUrlUnpooled: "postgres://direct/neondb",
			},
		});
		expect(env.postgres.databaseUrl).toBe("postgres://pooled/neondb");
		expect(env.postgres.databaseUrlUnpooled).toBe(
			"postgres://direct/neondb",
		);
	});

	test("postgres defaults to empty strings when absent", () => {
		const env = shapeHookEnv({});
		expect(env.postgres.databaseUrl).toBe("");
		expect(env.postgres.databaseUrlUnpooled).toBe("");
	});

	test("a bare resolution yields only postgres — no service namespaces", () => {
		const env = shapeHookEnv({
			postgres: {
				databaseUrl: "postgres://pooled/neondb",
				databaseUrlUnpooled: "postgres://direct/neondb",
			},
		});
		expect(env.auth).toBeUndefined();
		expect(env.dataApi).toBeUndefined();
		expect(env.storage).toBeUndefined();
		expect(env.aiGateway).toBeUndefined();
		expect(env.functions).toBeUndefined();
		expect(env.branch).toBeUndefined();
	});

	test("populates every namespace whose fields are present", () => {
		const env = shapeHookEnv({
			postgres: {
				databaseUrl: "postgres://pooled/neondb",
				databaseUrlUnpooled: "postgres://direct/neondb",
			},
			branch: { name: "preview/feature-billing" },
			auth: {
				baseUrl: "https://auth.neon",
				jwksUrl: "https://auth.neon/jwks",
			},
			dataApi: { url: "https://dataapi.neon" },
			storage: {
				accessKeyId: "nak_live_x",
				secretAccessKey: "secret",
				endpoint: "https://s3.neon",
				region: "us-east-2",
			},
			aiGateway: {
				apiKey: "sk-neon",
				baseUrl: "https://ai.neon/openai/v1",
			},
			functions: { api: { baseUrl: "https://api.example.com" } },
		});
		expect(env.branch).toEqual({ name: "preview/feature-billing" });
		expect(env.auth).toEqual({
			baseUrl: "https://auth.neon",
			jwksUrl: "https://auth.neon/jwks",
		});
		expect(env.dataApi).toEqual({ url: "https://dataapi.neon" });
		expect(env.storage).toEqual({
			accessKeyId: "nak_live_x",
			secretAccessKey: "secret",
			endpoint: "https://s3.neon",
			region: "us-east-2",
		});
		expect(env.aiGateway).toEqual({
			apiKey: "sk-neon",
			baseUrl: "https://ai.neon/openai/v1",
		});
		expect(env.functions).toEqual({
			api: { baseUrl: "https://api.example.com" },
		});
	});

	test("omits a namespace whose fields are only partially present", () => {
		const env = shapeHookEnv({
			auth: { baseUrl: "https://auth.neon" }, // jwksUrl missing
			storage: { accessKeyId: "nak_live_x" }, // rest missing
		});
		expect(env.auth).toBeUndefined();
		expect(env.storage).toBeUndefined();
	});

	test("maps multiple function entries", () => {
		const env = shapeHookEnv({
			functions: {
				api: { baseUrl: "https://api.example.com" },
				worker: { baseUrl: "https://worker.example.com" },
			},
		});
		expect(env.functions).toEqual({
			api: { baseUrl: "https://api.example.com" },
			worker: { baseUrl: "https://worker.example.com" },
		});
	});
});
