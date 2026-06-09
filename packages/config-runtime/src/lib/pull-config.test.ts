import { ErrorCode, PlatformError, resolveConfig } from "@neondatabase/config";
import { describe, expect, test } from "vitest";
import { FakeNeonApi } from "./fake-neon-api.js";
import { pullConfig } from "./pull-config.js";

describe("pullConfig", () => {
	test("returns selected branch state as JSON-friendly branch config", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-pull";
		api.seedProject({
			project: {
				id: projectId,
				name: "pull-test",
				regionId: "aws-us-east-1",
				pgVersion: 17,
				orgId: "org-pull",
			},
			branches: [
				{ branch: { id: "br-main", name: "main", isDefault: true } },
				{
					branch: {
						id: "br-dev",
						name: "dev-a",
						isDefault: false,
						parentId: "br-main",
						protected: true,
					},
					endpoint: { autoscalingLimitMaxCu: 2 },
				},
			],
		});

		const pulled = await pullConfig({ api, projectId, branchId: "br-dev" });

		expect(pulled.project).toMatchObject({
			id: projectId,
			name: "pull-test",
			orgId: "org-pull",
		});
		expect(pulled.branch).toMatchObject({
			id: "br-dev",
			name: "dev-a",
			parent: "main",
			protected: true,
		});
		// Branch lifecycle/compute is carried by the `branch` tuning closure now.
		expect(
			pulled.config.branch?.({ name: "dev-a", exists: true }),
		).toMatchObject({
			parent: "main",
			protected: true,
			postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } },
		});
	});

	test("pulled config from a branch with an expiry resolves without a ttl parse crash", async () => {
		// Regression: `pullConfig` must not emit the branch's `expiresAt` (an ISO timestamp)
		// as the policy `ttl` — `ttl` is a creation-time duration, and feeding a timestamp
		// to `parseDuration` would make `resolveConfig` (and therefore `fetchEnv` /
		// `neon dev` / `neon env pull` in the no-policy tier) throw on any branch that has a
		// TTL. The expiry is reported on `branch.expiresAt` instead.
		const api = new FakeNeonApi();
		const projectId = "proj-ttl";
		api.seedProject({
			project: {
				id: projectId,
				name: "ttl",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{ branch: { id: "br-main", name: "main", isDefault: true } },
				{
					branch: {
						id: "br-ttl",
						name: "preview",
						isDefault: false,
						parentId: "br-main",
						expiresAt: "2099-01-01T00:00:00.000Z",
					},
				},
			],
		});

		const pulled = await pullConfig({ api, projectId, branchId: "br-ttl" });

		expect(pulled.branch.expiresAt).toBe("2099-01-01T00:00:00.000Z");
		expect(() =>
			resolveConfig(pulled.config, { name: "preview", exists: true }),
		).not.toThrow();
		// expiry is not smuggled into the policy as a (bogus) ttl duration.
		expect(
			resolveConfig(pulled.config, { name: "preview", exists: true })
				.ttlSeconds,
		).toBeUndefined();
	});

	test("omits auth/dataApi when neither integration is enabled", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-none";
		api.seedProject({
			project: {
				id: projectId,
				name: "none",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{ branch: { id: "br-main", name: "main", isDefault: true } },
			],
		});

		const pulled = await pullConfig({
			api,
			projectId,
			branchId: "br-main",
		});

		expect(pulled.config.auth).toBeUndefined();
		expect(pulled.config.dataApi).toBeUndefined();
	});

	test("sets config.auth when a Neon Auth integration is enabled", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-auth";
		api.seedProject({
			project: {
				id: projectId,
				name: "auth",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{ branch: { id: "br-main", name: "main", isDefault: true } },
			],
		});
		api.seedNeonAuth(projectId, "br-main", {
			projectId: "auth-proj",
			jwksUrl: "https://example.test/jwks",
			baseUrl: "https://example.test/auth",
		});

		const pulled = await pullConfig({
			api,
			projectId,
			branchId: "br-main",
		});

		expect(pulled.config.auth).toBe(true);
		expect(pulled.config.dataApi).toBeUndefined();
	});

	test("sets config.dataApi when a Data API integration is enabled", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-dataapi";
		api.seedProject({
			project: {
				id: projectId,
				name: "dataapi",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{ branch: { id: "br-main", name: "main", isDefault: true } },
			],
		});
		// The branch is seeded with a default `neondb` database, which pullConfig probes.
		api.seedNeonDataApi(projectId, "br-main", "neondb", {
			url: "https://example.test/data-api/neondb",
		});

		const pulled = await pullConfig({
			api,
			projectId,
			branchId: "br-main",
		});

		expect(pulled.config.dataApi).toBe(true);
		expect(pulled.config.auth).toBeUndefined();
	});

	test("sets both auth and dataApi when both are enabled", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-both";
		api.seedProject({
			project: {
				id: projectId,
				name: "both",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{ branch: { id: "br-main", name: "main", isDefault: true } },
			],
		});
		api.seedNeonAuth(projectId, "br-main", {
			projectId: "auth-proj",
			jwksUrl: "https://example.test/jwks",
			baseUrl: "https://example.test/auth",
		});
		api.seedNeonDataApi(projectId, "br-main", "neondb", {
			url: "https://example.test/data-api/neondb",
		});

		const pulled = await pullConfig({
			api,
			projectId,
			branchId: "br-main",
		});

		expect(pulled.config.auth).toBe(true);
		expect(pulled.config.dataApi).toBe(true);
	});

	test("degrades when a Preview feature is unavailable, still pulling auth/dataApi", async () => {
		// A branch whose AI Gateway endpoint is unavailable for the project/region. pullConfig
		// mirrors the branch for env resolution (`neon dev` / `neon env pull`) and inspect, so
		// it must not abort on an unrelated Preview capability — env comes from auth/dataApi.
		class UnavailableAiGatewayApi extends FakeNeonApi {
			override async getAiGatewayEnabled(): Promise<boolean> {
				throw new PlatformError(
					ErrorCode.FeatureUnavailable,
					"AI Gateway is a Preview feature that is not available for this project or region.",
				);
			}
		}
		const api = new UnavailableAiGatewayApi();
		const projectId = "proj-degrade";
		api.seedProject({
			project: {
				id: projectId,
				name: "degrade",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{ branch: { id: "br-main", name: "main", isDefault: true } },
			],
		});
		api.seedNeonAuth(projectId, "br-main", {
			projectId: "auth-proj",
			jwksUrl: "https://example.test/jwks",
			baseUrl: "https://example.test/auth",
		});

		const pulled = await pullConfig({
			api,
			projectId,
			branchId: "br-main",
		});

		// Auth still pulled; the unavailable AI Gateway degrades to "off" rather than throwing.
		expect(pulled.config.auth).toBe(true);
		expect(pulled.preview?.aiGatewayEnabled ?? false).toBe(false);
	});
});
