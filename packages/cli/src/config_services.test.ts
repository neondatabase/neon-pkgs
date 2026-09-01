import { defineConfig } from "@neon/config-runtime";
import { describe, expect, it } from "vitest";
import {
	claimableDataApiCreateBody,
	declaredNeonServices,
} from "./config_services.js";

describe("declaredNeonServices", () => {
	it("maps every static neon.ts service without adding Postgres", () => {
		const config = defineConfig({
			auth: true,
			dataApi: { enabled: true },
			preview: {
				buckets: {
					assets: { access: "private" },
				},
				functions: {
					api: { name: "API", source: "./api.ts" },
				},
				aiGateway: true,
			},
			branch: () => ({}),
		});

		expect(declaredNeonServices(config)).toEqual([
			"auth",
			"data-api",
			"object-storage",
			"functions",
			"ai-gateway",
		]);
	});

	it("omits explicitly disabled toggles and empty preview maps", () => {
		const config = defineConfig({
			auth: false,
			dataApi: { enabled: false },
			preview: {
				buckets: {},
				functions: {},
				aiGateway: { enabled: false },
			},
			branch: () => ({}),
		});

		expect(declaredNeonServices(config)).toEqual([]);
	});
});

describe("claimableDataApiCreateBody", () => {
	it("omits the body when Data API is off or absent", () => {
		expect(claimableDataApiCreateBody(defineConfig({}))).toBeUndefined();
		expect(
			claimableDataApiCreateBody(defineConfig({ dataApi: false })),
		).toBeUndefined();
	});

	it("maps neon Auth and settings to snake_case", () => {
		expect(
			claimableDataApiCreateBody(
				defineConfig({ auth: true, dataApi: true }),
			),
		).toEqual({ auth_provider: "neon_auth" });
		expect(
			claimableDataApiCreateBody(
				defineConfig({
					auth: true,
					dataApi: {
						settings: { dbMaxRows: 50, dbAnonRole: "anonymous" },
					},
				}),
			),
		).toEqual({
			auth_provider: "neon_auth",
			settings: { db_max_rows: 50, db_anon_role: "anonymous" },
		});
	});

	it("requires jwksUrl for an external provider", () => {
		expect(
			claimableDataApiCreateBody(
				defineConfig({
					dataApi: {
						authProvider: "external",
						jwksUrl: "https://idp.example.com/jwks.json",
						providerName: "Clerk",
					},
				}),
			),
		).toEqual({
			auth_provider: "external",
			jwks_url: "https://idp.example.com/jwks.json",
			provider_name: "Clerk",
		});
		expect(() =>
			claimableDataApiCreateBody(
				defineConfig({
					dataApi: { authProvider: "external" },
				}),
			),
		).toThrow(/jwksUrl/);
	});
});
