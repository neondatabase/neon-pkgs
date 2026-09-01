import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CreateCredentialInput,
	GetConnectionUriInput,
	NeonApi,
	NeonAuthSnapshot,
	NeonBranchSnapshot,
	NeonBranchStorageSnapshot,
	NeonBucketSnapshot,
	NeonCredentialMeta,
	NeonCredentialSecret,
	NeonDataApiSnapshot,
	NeonDatabaseSnapshot,
	NeonEndpointSnapshot,
	NeonFunctionDeploymentSnapshot,
	NeonFunctionSnapshot,
	NeonProjectSnapshot,
	NeonRoleSnapshot,
} from "@neon/config";
import { ErrorCode, PlatformError } from "@neon/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	DevEnvMismatchError,
	resolveDevEnv,
	resolveNeonEnvVars,
} from "./env.js";

const PROJECT_ID = "patient-art-12345";
const BRANCH_ID = "br-main-00000001";

type FakeOverrides = {
	/** Override `getNeonAuth`. Defaults to returning `null`. */
	getNeonAuth?: NeonApi["getNeonAuth"];
	/** Override `getNeonDataApi`. Defaults to returning `null`. */
	getNeonDataApi?: NeonApi["getNeonDataApi"];
	/** Override `listBranches` (e.g. to make it throw for the graceful-degrade case). */
	listBranches?: NeonApi["listBranches"];
	listBranchFunctions?: NeonApi["listBranchFunctions"];
	/**
	 * Override `listBranchBuckets` (e.g. to simulate a branch that has an object-storage
	 * bucket). Defaults to returning `[]`.
	 */
	listBranchBuckets?: NeonApi["listBranchBuckets"];
};

/**
 * A full {@link NeonApi} implementation backed by fixed in-memory state for one
 * project + one default branch. Methods that `pullConfig` and `fetchEnv` exercise
 * return real data; everything else throws `not implemented` so an unexpected call
 * fails loudly instead of silently passing.
 */
class FakeNeonApi implements NeonApi {
	constructor(private readonly overrides: FakeOverrides = {}) {}

	async listProjects(): Promise<NeonProjectSnapshot[]> {
		throw new Error("not implemented");
	}

	async getProject(projectId: string): Promise<NeonProjectSnapshot> {
		return {
			id: projectId,
			name: "dev-project",
			regionId: "aws-us-east-1",
			pgVersion: 17,
		};
	}

	async createProject(): Promise<NeonProjectSnapshot> {
		throw new Error("not implemented");
	}

	async updateProject(): Promise<NeonProjectSnapshot> {
		throw new Error("not implemented");
	}

	async listBranches(projectId: string): Promise<NeonBranchSnapshot[]> {
		if (this.overrides.listBranches) {
			return this.overrides.listBranches(projectId);
		}
		return [
			{
				id: BRANCH_ID,
				name: "main",
				isDefault: true,
				protected: false,
			},
		];
	}

	async createBranch(): Promise<{
		branch: NeonBranchSnapshot;
		endpoints: NeonEndpointSnapshot[];
	}> {
		throw new Error("not implemented");
	}

	async updateBranch(): Promise<NeonBranchSnapshot> {
		throw new Error("not implemented");
	}

	async listEndpoints(): Promise<NeonEndpointSnapshot[]> {
		return [
			{
				id: "ep-fake-1",
				branchId: BRANCH_ID,
				type: "read_write",
				autoscalingLimitMinCu: 0.25,
				autoscalingLimitMaxCu: 0.25,
				suspendTimeout: "5m",
			},
		];
	}

	async updateEndpoint(): Promise<NeonEndpointSnapshot> {
		throw new Error("not implemented");
	}

	async listBranchRoles(
		projectId: string,
		branchId: string,
	): Promise<NeonRoleSnapshot[]> {
		void projectId;
		return [{ name: "neondb_owner", branchId, protected: false }];
	}

	async listBranchDatabases(
		projectId: string,
		branchId: string,
	): Promise<NeonDatabaseSnapshot[]> {
		void projectId;
		return [{ name: "neondb", branchId, ownerName: "neondb_owner" }];
	}

	async getConnectionUri(
		projectId: string,
		input: GetConnectionUriInput,
	): Promise<{ uri: string }> {
		void projectId;
		const host = input.pooled
			? `${BRANCH_ID}-pooler.fake.neon.tech`
			: `${BRANCH_ID}.fake.neon.tech`;
		return {
			uri: `postgresql://${input.roleName}:pw@${host}/${input.databaseName}?sslmode=require`,
		};
	}

	async getNeonAuth(
		projectId: string,
		branchId: string,
	): Promise<NeonAuthSnapshot | null> {
		if (this.overrides.getNeonAuth) {
			return this.overrides.getNeonAuth(projectId, branchId);
		}
		return null;
	}

	async enableNeonAuth(): Promise<NeonAuthSnapshot> {
		throw new Error("not implemented");
	}

	async getNeonDataApi(
		projectId: string,
		branchId: string,
		databaseName: string,
	): Promise<NeonDataApiSnapshot | null> {
		if (this.overrides.getNeonDataApi) {
			return this.overrides.getNeonDataApi(
				projectId,
				branchId,
				databaseName,
			);
		}
		return null;
	}

	async enableProjectBranchDataApi(): Promise<NeonDataApiSnapshot> {
		throw new Error("not implemented");
	}

	async updateProjectBranchDataApi(): Promise<NeonDataApiSnapshot> {
		throw new Error("not implemented");
	}

	async listBranchBuckets(
		projectId: string,
		branchId: string,
	): Promise<NeonBucketSnapshot[]> {
		if (this.overrides.listBranchBuckets) {
			return this.overrides.listBranchBuckets(projectId, branchId);
		}
		return [];
	}

	async createBranchBucket(): Promise<NeonBucketSnapshot> {
		throw new Error("not implemented");
	}

	async deleteBranchBucket(): Promise<void> {
		throw new Error("not implemented");
	}

	listBranchFunctionsCalled = false;

	async listBranchFunctions(
		projectId: string,
		branchId: string,
	): Promise<NeonFunctionSnapshot[]> {
		this.listBranchFunctionsCalled = true;
		if (this.overrides.listBranchFunctions) {
			return this.overrides.listBranchFunctions(projectId, branchId);
		}
		return [];
	}

	async deleteBranchFunction(): Promise<void> {
		throw new Error("not implemented");
	}

	async deployBranchFunction(): Promise<NeonFunctionDeploymentSnapshot> {
		throw new Error("not implemented");
	}

	async getAiGatewayEnabled(): Promise<boolean> {
		return false;
	}

	async enableAiGateway(): Promise<void> {
		throw new Error("not implemented");
	}

	async disableAiGateway(): Promise<void> {
		throw new Error("not implemented");
	}

	async createCredential(
		_projectId: string,
		branchId: string,
		input: CreateCredentialInput,
	): Promise<NeonCredentialSecret> {
		return {
			tokenId: "cred-fake-0000",
			tokenIdShort: "credfake0000",
			apiToken: "nt_live_credfake0000_secret",
			s3SecretAccessKey: "s3secret".padEnd(64, "0"),
			scopes: input.scopes,
			branchId,
			createdAt: "2026-01-01T00:00:00Z",
		};
	}

	async listCredentials(): Promise<NeonCredentialMeta[]> {
		return [];
	}

	async revokeCredential(): Promise<void> {
		return;
	}

	async getProjectBranchStorage(): Promise<NeonBranchStorageSnapshot | null> {
		return {
			s3Endpoint: "https://fake.storage.neon.tech",
			region: "us-east-1",
			forcePathStyle: true,
		};
	}
}

/**
 * A project whose credentials cannot be read at all — the shape of a region where branch
 * credentials are not deployed. The implied gateway must not take the rest of the env down
 * with it, or `neon dev` starts with no `DATABASE_URL` because of a service nobody named.
 */
class UnreadableCredentialsNeonApi extends FakeNeonApi {
	override async listCredentials(): Promise<NeonCredentialMeta[]> {
		// The error the real adapter raises, so this also exercises `pullConfig` degrading
		// the same read — which is why the rest of the branch still resolves.
		throw new PlatformError(
			ErrorCode.FeatureUnavailable,
			"Branch credentials isn't available for this Neon project (HTTP 404 Not Found).",
		);
	}
}

/**
 * Credentials read fine, but issuing one fails — a quota, a 500. Distinct from the above on
 * purpose: once the endpoint has answered, a failure is a real failure and is not the
 * gateway's to absorb.
 */
class BrokenMintNeonApi extends FakeNeonApi {
	override async createCredential(): Promise<NeonCredentialSecret> {
		throw new Error("credential quota exceeded for this account");
	}
}

/**
 * A branch that keeps the credentials it issues, so reuse can be verified the way the real
 * API allows it: a persisted secret is kept only when it names a credential still live on the
 * branch. A fake with an empty credential list makes every run look like a first run.
 */
class CredentialStoreNeonApi extends FakeNeonApi {
	readonly credentials: NeonCredentialMeta[] = [];
	createCalls = 0;

	override async createCredential(
		_projectId: string,
		branchId: string,
		input: CreateCredentialInput,
	): Promise<NeonCredentialSecret> {
		this.createCalls += 1;
		const tokenIdShort = `credfake000${this.createCalls}`;
		const meta = {
			tokenId: `cred-fake-000${this.createCalls}`,
			tokenIdShort,
			...(input.name !== undefined ? { name: input.name } : {}),
			scopes: input.scopes,
			principalType: input.principalType,
			branchId,
			createdAt: "2026-01-01T00:00:00Z",
		};
		this.credentials.push(meta);
		return {
			...meta,
			apiToken: `nt_live_${tokenIdShort}_secret`,
			s3SecretAccessKey: `s3secret${this.createCalls}`.padEnd(64, "0"),
		};
	}

	override async listCredentials(): Promise<NeonCredentialMeta[]> {
		return this.credentials.filter((c) => c.revokedAt === undefined);
	}
}

describe("resolveDevEnv", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "neonctl-dev-env-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("injects the AI Gateway on a branch with no neon.ts, like the deployed runtime does", async () => {
		// `dev` exists to make local behave like deployed. A function that reads
		// NEON_AI_GATEWAY_* works in production and would fail locally without this.
		const result = await resolveDevEnv({
			cwd,
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			implyAiGateway: true,
			api: new FakeNeonApi(),
		});

		expect(result.vars.NEON_AI_GATEWAY_TOKEN).toBe(
			"nt_live_credfake0000_secret",
		);
		expect(result.vars.NEON_AI_GATEWAY_BASE_URL).toBe(
			`https://${BRANCH_ID}-api.ai.fake.neon.tech`,
		);
		expect(result.vars.DATABASE_URL).toBeDefined();
	});

	it("reuses a gateway token it is given rather than minting another", async () => {
		// `dev` writes no file, so without an env source it would mint a credential per
		// start and leave the last one live. The command layers the local dotenv file in.
		const api = new CredentialStoreNeonApi();
		const ctx = {
			cwd,
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			implyAiGateway: true,
			api,
		};
		const first = await resolveDevEnv(ctx);

		const second = await resolveDevEnv({
			...ctx,
			env: { NEON_AI_GATEWAY_TOKEN: first.vars.NEON_AI_GATEWAY_TOKEN },
		});

		expect(second.vars.NEON_AI_GATEWAY_TOKEN).toBe(
			first.vars.NEON_AI_GATEWAY_TOKEN,
		);
		expect(second.credential?.issued).toBe(false);
		expect(api.createCalls).toBe(1);
	});

	it("mints a credential on every start when it is given nothing to reuse", async () => {
		// The reason the command layers the dotenv file in: without a source of persisted
		// secrets, each start issues a credential and cannot name the last one to revoke it.
		const api = new CredentialStoreNeonApi();
		const ctx = {
			cwd,
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			implyAiGateway: true,
			api,
		};

		await resolveDevEnv(ctx);
		await resolveDevEnv(ctx);

		expect(api.createCalls).toBe(2);
		expect(api.credentials.filter((c) => c.revokedAt)).toEqual([]);
	});

	it("keeps the rest of the env when the gateway's credentials cannot be read", async () => {
		const result = await resolveDevEnv({
			cwd,
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			implyAiGateway: true,
			api: new UnreadableCredentialsNeonApi(),
		});

		expect(result.vars.DATABASE_URL).toBeDefined();
		expect(result.vars.NEON_AI_GATEWAY_TOKEN).toBeUndefined();
		expect(result.skipped).toBeUndefined();
	});

	it("surfaces a mint failure instead of absorbing it into the gateway", async () => {
		// Once the credentials endpoint has answered, a failure is a real failure. Papering
		// over it by resolving again without the gateway would swallow the error and strand
		// whatever the first attempt had already issued. A branch with object storage
		// behaves the same way, and always has.
		const result = await resolveDevEnv({
			cwd,
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			implyAiGateway: true,
			api: new BrokenMintNeonApi(),
		});

		expect(result.vars).toEqual({});
		expect(result.skipped?.reason).toMatch(/credential quota exceeded/);
	});

	it("reports a failure that was never the gateway's, without blaming it", async () => {
		const api = new FakeNeonApi({
			listBranches: async () => {
				throw new Error("boom: Neon API unreachable");
			},
		});

		const result = await resolveDevEnv({
			cwd,
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			implyAiGateway: true,
			api,
		});

		expect(result.vars).toEqual({});
		expect(result.skipped?.reason).toMatch(/Neon API unreachable/);
	});

	it('tier 3: no neon.ts and no project/branch -> empty vars + a "link a branch" note', async () => {
		const result = await resolveDevEnv({ cwd });
		expect(result.vars).toEqual({});
		expect(result.skipped?.reason).toMatch(/neon link/);
	});

	it("tier 2: no neon.ts but project + branch -> pooled + unpooled DATABASE_URL", async () => {
		const result = await resolveDevEnv({
			cwd,
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			api: new FakeNeonApi(),
		});

		expect(result.vars.DATABASE_URL).toContain("-pooler.fake.neon.tech");
		expect(result.vars.DATABASE_URL_UNPOOLED).toBeDefined();
		expect(result.vars.DATABASE_URL_UNPOOLED).not.toContain("-pooler.");
		expect(result.vars.NEON_AUTH_BASE_URL).toBeUndefined();
		expect(result.skipped).toBeUndefined();
	});

	it("tier 2 with Auth integration present: surfaces NEON_AUTH_BASE_URL too", async () => {
		const api = new FakeNeonApi({
			getNeonAuth: async () => ({
				projectId: "auth-project",
				jwksUrl: "https://auth.fake.neon.tech/.well-known/jwks.json",
				baseUrl: "https://auth.fake.neon.tech",
			}),
		});

		// Tier 2 derives its config from `pullConfig`, which now reverse-engineers the
		// branch's Auth / Data API enablement into `config.auth` / `config.dataApi`. So
		// `resolveConfig` sees `authEnabled === true`, `fetchEnv` calls `getNeonAuth`,
		// and NEON_AUTH_BASE_URL is injected from the branch's live state — without any
		// neon.ts. This mirrors what the deployed function would receive.
		const result = await resolveDevEnv({
			cwd,
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			api,
		});

		expect(Object.keys(result.vars).sort()).toEqual([
			"DATABASE_URL",
			"DATABASE_URL_UNPOOLED",
			"NEON_AUTH_BASE_URL",
			"NEON_AUTH_JWKS_URL",
			"NEON_BRANCH",
		]);
		expect(result.vars.NEON_BRANCH).toBe("main");
		expect(result.vars.NEON_AUTH_BASE_URL).toBe(
			"https://auth.fake.neon.tech",
		);
		expect(result.vars.NEON_AUTH_JWKS_URL).toBe(
			"https://auth.fake.neon.tech/.well-known/jwks.json",
		);
	});

	it("tier 2 with a bucket present: surfaces the AWS_* object-storage vars too", async () => {
		// The feature-gap fix: a branch that has an object-storage bucket but no local
		// neon.ts. pullConfig now mirrors the bucket into `config.preview.buckets`, so
		// `fetchEnv`'s `wantsStorage` fires — it mints a branch credential and injects the
		// S3-compatible AWS_* vars, exactly what a deployed function would receive. No
		// policy required.
		const api = new FakeNeonApi({
			listBranchBuckets: async () => [
				{ name: "assets", accessLevel: "private" },
			],
		});

		const result = await resolveDevEnv({
			cwd,
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			api,
		});

		// The storage gateway authenticates against the full token id, so accessKeyId is the
		// minted credential's `tokenId` (not the short id).
		expect(result.vars.AWS_ACCESS_KEY_ID).toBe("cred-fake-0000");
		expect(result.vars.AWS_SECRET_ACCESS_KEY).toBeDefined();
		expect(result.vars.AWS_ENDPOINT_URL_S3).toBe(
			"https://fake.storage.neon.tech",
		);
		expect(result.vars.AWS_REGION).toBe("us-east-1");
		// The AI Gateway has no branch-level enabled state to read back, so pullConfig never
		// declares it — its vars must not leak into the no-policy pull.
		expect(result.vars.NEON_AI_GATEWAY_TOKEN).toBeUndefined();
		expect(result.vars.NEON_AI_GATEWAY_BASE_URL).toBeUndefined();
	});

	it("tier 1: a neon.ts policy enabling auth -> DATABASE_URL and NEON_AUTH_BASE_URL", async () => {
		writeFileSync(join(cwd, "neon.ts"), "export default { auth: {} };\n");

		const api = new FakeNeonApi({
			getNeonAuth: async () => ({
				projectId: "auth-project",
				jwksUrl: "https://auth.fake.neon.tech/.well-known/jwks.json",
				baseUrl: "https://auth.fake.neon.tech",
			}),
		});

		const result = await resolveDevEnv({
			cwd,
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			api,
		});

		expect(result.vars.DATABASE_URL).toBeDefined();
		expect(result.vars.DATABASE_URL_UNPOOLED).toBeDefined();
		expect(result.vars.NEON_AUTH_BASE_URL).toBe(
			"https://auth.fake.neon.tech",
		);
	});

	it("tier 1 mismatch: neon.ts enables auth the branch lacks -> throws DevEnvMismatchError", async () => {
		writeFileSync(join(cwd, "neon.ts"), "export default { auth: {} };\n");

		// The branch has NO Auth integration (default `getNeonAuth` -> null), so
		// `plan` reports an `enable-auth` create: the policy declares a resource the
		// branch is missing. `dev` must stop and point the user at `neonctl deploy`.
		const api = new FakeNeonApi();

		await expect(
			resolveDevEnv({
				cwd,
				projectId: PROJECT_ID,
				branchId: BRANCH_ID,
				api,
			}),
		).rejects.toBeInstanceOf(DevEnvMismatchError);
	});

	it("tier 1 mismatch error: names the missing resource and points at deploy", async () => {
		writeFileSync(join(cwd, "neon.ts"), "export default { auth: {} };\n");
		const api = new FakeNeonApi();

		await expect(
			resolveDevEnv({
				cwd,
				projectId: PROJECT_ID,
				branchId: BRANCH_ID,
				api,
			}),
		).rejects.toThrow(/auth.*neon deploy/s);
	});

	it("tier 1 match: neon.ts enables auth the branch already has -> injects, no throw", async () => {
		writeFileSync(join(cwd, "neon.ts"), "export default { auth: {} };\n");

		// The branch already has the Auth integration, so `plan` reports no missing
		// resource and `dev` injects NEON_AUTH_BASE_URL.
		const api = new FakeNeonApi({
			getNeonAuth: async () => ({
				projectId: "auth-project",
				jwksUrl: "https://auth.fake.neon.tech/.well-known/jwks.json",
				baseUrl: "https://auth.fake.neon.tech",
			}),
		});

		const result = await resolveDevEnv({
			cwd,
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			api,
		});

		expect(result.vars.NEON_AUTH_BASE_URL).toBe(
			"https://auth.fake.neon.tech",
		);
	});

	it('graceful: an api whose listBranches throws -> empty vars + a "could not reach Neon" note', async () => {
		const api = new FakeNeonApi({
			listBranches: async () => {
				throw new Error("network down");
			},
		});

		const result = await resolveDevEnv({
			cwd,
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			api,
		});
		expect(result.vars).toEqual({});
		expect(result.skipped?.reason).toMatch(/network down/);
	});

	it("tier 1 functions-only: lists invocation URLs and still injects DATABASE_URL", async () => {
		writeFileSync(
			join(cwd, "neon.ts"),
			"export default { preview: { functions: { hello: " +
				"{ name: 'Hello', source: './hello.ts' } } } };\n",
		);
		const helloUrl = `https://${BRANCH_ID}-hello.compute.fake.neon.tech/`;
		const api = new FakeNeonApi({
			listBranchFunctions: async () => [
				{
					id: "fn-hello",
					slug: "hello",
					name: "Hello",
					invocationUrl: helloUrl,
				},
			],
		});

		const result = await resolveDevEnv({
			cwd,
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			api,
		});

		expect(result.vars.DATABASE_URL).toBeDefined();
		expect(result.vars.DATABASE_URL_UNPOOLED).toBeDefined();
		expect(result.vars.NEON_FUNCTION_HELLO_BASE_URL).toBe(helloUrl);
		expect(api.listBranchFunctionsCalled).toBe(true);
	});

	it("tier 1 functions-only: FeatureUnavailable hard-stops instead of dropping DATABASE_URL", async () => {
		writeFileSync(
			join(cwd, "neon.ts"),
			"export default { preview: { functions: { hello: " +
				"{ name: 'Hello', source: './hello.ts' } } } };\n",
		);
		const api = new FakeNeonApi({
			listBranchFunctions: async () => {
				throw new PlatformError(
					ErrorCode.FeatureUnavailable,
					"Functions isn't available for this Neon project",
					{ details: { status: 404 } },
				);
			},
		});

		await expect(
			resolveDevEnv({
				cwd,
				projectId: PROJECT_ID,
				branchId: BRANCH_ID,
				api,
			}),
		).rejects.toBeInstanceOf(DevEnvMismatchError);
	});

	it('neon.ts importing an uninstalled package -> a clear "did you run npm install" error', async () => {
		// A neon.ts that imports a package which isn't installed (no node_modules in
		// the temp dir) fails to load with a cryptic "Cannot find module". We expect
		// that turned into an actionable "did you run npm install" message — this is
		// exactly what `neon link`'s env pull hits in a freshly-scaffolded project.
		writeFileSync(
			join(cwd, "neon.ts"),
			"import 'neon-bootstrap-missing-dependency-xyz';\nexport default { auth: {} };\n",
		);

		await expect(
			resolveNeonEnvVars({
				cwd,
				projectId: PROJECT_ID,
				branchId: BRANCH_ID,
				api: new FakeNeonApi(),
			}),
		).rejects.toThrow(/npm install/i);
	}, 30_000);

	it("tier 1 functions + auth mismatch: a missing secret-bearing service still hard-stops", async () => {
		// Stripping functions must NOT weaken the guard for services that DO carry secrets: a
		// neon.ts enabling auth on a branch that lacks it still throws, pointing at deploy.
		writeFileSync(
			join(cwd, "neon.ts"),
			"export default { auth: {}, preview: { functions: { hello: " +
				"{ name: 'Hello', source: './hello.ts' } } } };\n",
		);
		const api = new FakeNeonApi(); // getNeonAuth -> null (branch has no auth)

		await expect(
			resolveDevEnv({
				cwd,
				projectId: PROJECT_ID,
				branchId: BRANCH_ID,
				api,
			}),
		).rejects.toBeInstanceOf(DevEnvMismatchError);
	});
});
