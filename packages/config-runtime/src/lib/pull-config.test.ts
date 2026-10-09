import { ErrorCode, PlatformError, resolveConfig } from "@neon/config";
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

	test("omits auth/dataApi/Realtime when none is enabled", async () => {
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
		expect(pulled.config.realtime).toBeUndefined();
	});

	test("sets config.realtime when Realtime is enabled", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-realtime";
		api.seedProject({
			project: {
				id: projectId,
				name: "realtime",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{ branch: { id: "br-main", name: "main", isDefault: true } },
			],
		});
		api.seedRealtime(projectId, "br-main", {
			enabled: true,
			pending: false,
			invocationUrl: "wss://realtime.example.test/v1",
		});

		const pulled = await pullConfig({
			api,
			projectId,
			branchId: "br-main",
		});

		expect(pulled.config.realtime).toBe(true);
	});

	test("omits Realtime when its API route is not deployed", async () => {
		class MissingRealtimeRouteApi extends FakeNeonApi {
			override async getProjectBranchRealtime(): Promise<never> {
				throw new PlatformError(
					ErrorCode.NotFound,
					"getProjectBranchRealtime failed: resource not found on Neon.",
					{ details: { status: 404 } },
				);
			}
		}
		const api = new MissingRealtimeRouteApi();
		const projectId = "proj-without-realtime-route";
		api.seedProject({
			project: {
				id: projectId,
				name: "without-realtime-route",
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

		expect(pulled.config.realtime).toBeUndefined();
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

	test("includes the branch's buckets in config so the no-policy env path resolves storage", async () => {
		// Regression for the feature gap: a branch with a bucket but no local neon.ts must
		// still get its object-storage vars pulled. `pullConfig` mirrors the bucket into
		// `config.preview.buckets` (buckets round-trip: name + access), which is what makes
		// `fetchEnv`'s `wantsStorage` fire in the no-policy tier (`neon dev` / `neon env pull`).
		const api = new FakeNeonApi();
		const projectId = "proj-buckets";
		api.seedProject({
			project: {
				id: projectId,
				name: "buckets",
				regionId: "aws-us-east-2",
				pgVersion: 17,
			},
			branches: [
				{ branch: { id: "br-main", name: "main", isDefault: true } },
			],
		});
		api.seedBucket(projectId, "br-main", {
			name: "assets",
			accessLevel: "private",
		});

		const pulled = await pullConfig({
			api,
			projectId,
			branchId: "br-main",
		});

		// The bucket rides on the resolvable `config` (not just the display-only `preview`),
		// with its access level preserved …
		expect(pulled.config.preview?.buckets).toEqual({
			assets: { access: "private" },
		});
		// … and it is what a downstream `resolveConfig` reads as "storage wanted".
		const resolved = resolveConfig(pulled.config, {
			name: "main",
			exists: true,
		});
		expect(resolved.preview?.buckets.map((b) => b.name)).toEqual([
			"assets",
		]);
		// The AI Gateway has no branch-level enabled state to read back, so it is never
		// smuggled into the pulled config (only buckets are).
		expect(pulled.config.preview?.aiGateway).toBeUndefined();
		// It also stays in the display-only preview view for `config status` / inspect.
		expect(pulled.preview?.buckets).toEqual([
			{ name: "assets", access: "private" },
		]);
	});

	test("omits preview from config when the branch has no buckets", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-no-buckets";
		api.seedProject({
			project: {
				id: projectId,
				name: "no-buckets",
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

		// No buckets → no `preview` on the resolvable config, so `fetchEnv` never mints a
		// storage credential or probes the storage endpoint.
		expect(pulled.config.preview).toBeUndefined();
	});

	test("reports issued credential metadata (secret-free) under preview", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-creds";
		api.seedProject({
			project: {
				id: projectId,
				name: "creds",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{ branch: { id: "br-main", name: "main", isDefault: true } },
			],
		});
		await api.createCredential(projectId, "br-main", {
			scopes: ["storage:read", "storage:write"],
			principalType: "user",
			name: "app",
		});

		const pulled = await pullConfig({
			api,
			projectId,
			branchId: "br-main",
		});

		expect(pulled.preview?.credentials?.some((c) => c.name === "app")).toBe(
			true,
		);
		const meta = pulled.preview?.credentials?.find((c) => c.name === "app");
		expect(meta).toMatchObject({
			name: "app",
			principalType: "user",
			scopes: ["storage:read", "storage:write"],
		});
		// Never leak the one-time secrets through the list/inspect path.
		expect(meta).not.toHaveProperty("apiToken");
		expect(meta).not.toHaveProperty("s3SecretAccessKey");
	});

	test("degrades when a Preview feature is unavailable, still pulling auth/dataApi", async () => {
		// A branch whose object-storage endpoint is unavailable for the project/region.
		// pullConfig mirrors the branch for env resolution (`neon dev` / `neon env pull`) and
		// inspect, so it must not abort on an unrelated Preview capability — env comes from
		// auth/dataApi.
		class UnavailableBucketsApi extends FakeNeonApi {
			override async listBranchBuckets(): Promise<never> {
				throw new PlatformError(
					ErrorCode.FeatureUnavailable,
					"Object storage is a Preview feature that is not available for this project or region.",
				);
			}
		}
		const api = new UnavailableBucketsApi();
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

		// Auth still pulled; the unavailable buckets endpoint degrades to "none" rather than
		// throwing.
		expect(pulled.config.auth).toBe(true);
		expect(pulled.preview?.buckets ?? []).toEqual([]);
	});

	describe("request scheduling", () => {
		const READS = [
			"getProject",
			"listBranches",
			"listEndpoints",
			"listBranchDatabases",
			"listBranchBuckets",
			"listBranchFunctions",
			"listCredentials",
			"getNeonAuth",
			"getNeonDataApi",
		] as const;
		type Read = (typeof READS)[number];

		/** A fake whose reads wait until the test releases them, recording when each starts. */
		class GatedNeonApi extends FakeNeonApi {
			readonly started: Read[] = [];
			readonly failures = new Map<Read, Error>();
			private readonly gates = new Map<Read, () => void>();

			release(name: Read) {
				this.gates.get(name)?.();
			}

			private gate<T>(name: Read, read: () => Promise<T>): Promise<T> {
				this.started.push(name);
				return new Promise<void>((resolve) =>
					this.gates.set(name, resolve),
				).then(() => {
					const failure = this.failures.get(name);
					if (failure) throw failure;
					return read();
				});
			}

			override getProject(
				...args: Parameters<FakeNeonApi["getProject"]>
			) {
				return this.gate("getProject", () => super.getProject(...args));
			}
			override listBranches(
				...args: Parameters<FakeNeonApi["listBranches"]>
			) {
				return this.gate("listBranches", () =>
					super.listBranches(...args),
				);
			}
			override listEndpoints(
				...args: Parameters<FakeNeonApi["listEndpoints"]>
			) {
				return this.gate("listEndpoints", () =>
					super.listEndpoints(...args),
				);
			}
			override listBranchDatabases(
				...args: Parameters<FakeNeonApi["listBranchDatabases"]>
			) {
				return this.gate("listBranchDatabases", () =>
					super.listBranchDatabases(...args),
				);
			}
			override listBranchBuckets(
				...args: Parameters<FakeNeonApi["listBranchBuckets"]>
			) {
				return this.gate("listBranchBuckets", () =>
					super.listBranchBuckets(...args),
				);
			}
			override listBranchFunctions(
				...args: Parameters<FakeNeonApi["listBranchFunctions"]>
			) {
				return this.gate("listBranchFunctions", () =>
					super.listBranchFunctions(...args),
				);
			}
			override listCredentials(
				...args: Parameters<FakeNeonApi["listCredentials"]>
			) {
				return this.gate("listCredentials", () =>
					super.listCredentials(...args),
				);
			}
			override getNeonAuth(
				...args: Parameters<FakeNeonApi["getNeonAuth"]>
			) {
				return this.gate("getNeonAuth", () =>
					super.getNeonAuth(...args),
				);
			}
			override getNeonDataApi(
				...args: Parameters<FakeNeonApi["getNeonDataApi"]>
			) {
				return this.gate("getNeonDataApi", () =>
					super.getNeonDataApi(...args),
				);
			}
		}

		const gatedApi = () => {
			const api = new GatedNeonApi();
			api.seedProject({
				project: {
					id: "proj-gate",
					name: "gate",
					regionId: "aws-us-east-1",
					pgVersion: 17,
				},
				branches: [
					{
						branch: {
							id: "br-main",
							name: "main",
							isDefault: true,
						},
					},
				],
			});
			const flush = () =>
				new Promise((resolve) => setTimeout(resolve, 0));
			return {
				api,
				started: api.started,
				failures: api.failures,
				release: (name: Read) => api.release(name),
				flush,
			};
		};

		test("starts project, branches, endpoints, and databases together; the rest once databases resolve", async () => {
			const { api, started, release, flush } = gatedApi();
			const pulled = pullConfig({
				api,
				projectId: "proj-gate",
				branchId: "br-main",
			});
			await flush();
			expect(new Set(started)).toEqual(
				new Set([
					"getProject",
					"listBranches",
					"listEndpoints",
					"listBranchDatabases",
				]),
			);

			release("listBranchDatabases");
			await flush();
			expect(new Set(started)).toEqual(new Set(READS));

			for (const name of READS) release(name);
			await expect(pulled).resolves.toMatchObject({
				branch: { id: "br-main" },
			});
		});

		test("reports the first preview error in the order the reads fail", async () => {
			const { api, release, failures, flush } = gatedApi();
			failures.set("getNeonDataApi", new Error("data API failed"));
			failures.set("getNeonAuth", new Error("auth failed"));
			const pulled = pullConfig({
				api,
				projectId: "proj-gate",
				branchId: "br-main",
			});
			await flush();
			// Auth answers while databases are still pending; it must not get ahead of the probe.
			release("getNeonAuth");
			await flush();
			release("listBranchDatabases");
			await flush();
			release("getNeonDataApi");
			await flush();
			for (const name of READS) release(name);
			await expect(pulled).rejects.toThrow("data API failed");
		});

		test("a synchronous adapter throw leaves no unhandled rejection", async () => {
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			process.on("unhandledRejection", onUnhandled);
			try {
				const { api, release, failures, flush } = gatedApi();
				failures.set("getProject", new Error("project failed"));
				failures.set("listBranches", new Error("branches failed"));
				Object.assign(api, {
					listEndpoints: () => {
						throw new Error("endpoints threw");
					},
				});
				const pulled = pullConfig({
					api,
					projectId: "proj-gate",
					branchId: "br-main",
				});
				await flush();
				release("listBranches");
				await flush();
				release("getProject");
				await expect(pulled).rejects.toThrow("project failed");
				await flush();
				expect(unhandled).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});

		test("reports the project error even when a later read fails first", async () => {
			const { api, release, failures, flush } = gatedApi();
			failures.set("getProject", new Error("project failed"));
			failures.set("listBranches", new Error("branches failed"));
			failures.set("getNeonAuth", new Error("auth failed"));
			const pulled = pullConfig({
				api,
				projectId: "proj-gate",
				branchId: "br-main",
			});
			await flush();
			release("getNeonAuth");
			release("listBranches");
			await flush();
			release("getProject");
			await expect(pulled).rejects.toThrow("project failed");
		});

		test("reports a missing branch before any preview read error", async () => {
			const { api, release, failures, flush } = gatedApi();
			failures.set("listBranchBuckets", new Error("buckets failed"));
			const pulled = pullConfig({
				api,
				projectId: "proj-gate",
				branchId: "br-gone",
			});
			await flush();
			for (const name of READS) release(name);
			await expect(pulled).rejects.toMatchObject({
				code: ErrorCode.BranchNotFound,
			});
		});

		test("reports a databases error before the preview group's", async () => {
			const { api, release, failures, flush } = gatedApi();
			failures.set("listBranchDatabases", new Error("databases failed"));
			failures.set("getNeonAuth", new Error("auth failed"));
			const pulled = pullConfig({
				api,
				projectId: "proj-gate",
				branchId: "br-main",
			});
			await flush();
			release("getNeonAuth");
			await flush();
			for (const name of READS) release(name);
			await expect(pulled).rejects.toThrow("databases failed");
		});
	});
});
