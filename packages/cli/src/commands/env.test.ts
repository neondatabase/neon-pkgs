import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readEnvFile } from "../env_file.js";
import {
	autoPullEnvAfterPin,
	type EnvPullProps,
	type PullOutcome,
	pull,
} from "./env.js";

const PROJECT_ID = "patient-art-12345";
const BRANCH_ID = "br-snowy-frost-12345";
const BRANCH_NAME = "main";

type FakeOverrides = {
	getNeonAuth?: NeonApi["getNeonAuth"];
};

/**
 * Minimal {@link NeonApi} for one project + default branch, with the methods `pullConfig`
 * and `fetchEnv` exercise (env-pull's tier-2 path). Auth defaults to off; override to test
 * the NEON_AUTH_BASE_URL pull.
 */
class FakeNeonApi implements NeonApi {
	constructor(private readonly overrides: FakeOverrides = {}) {}

	async listProjects(): Promise<NeonProjectSnapshot[]> {
		throw new Error("not implemented");
	}
	async getProject(projectId: string): Promise<NeonProjectSnapshot> {
		return {
			id: projectId,
			name: "p",
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
	async listBranches(): Promise<NeonBranchSnapshot[]> {
		return [
			{
				id: BRANCH_ID,
				name: BRANCH_NAME,
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
				id: "ep-1",
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
	async getNeonDataApi(): Promise<NeonDataApiSnapshot | null> {
		return null;
	}
	async enableProjectBranchDataApi(): Promise<NeonDataApiSnapshot> {
		throw new Error("not implemented");
	}
	async updateProjectBranchDataApi(): Promise<NeonDataApiSnapshot> {
		throw new Error("not implemented");
	}
	async listBranchBuckets(): Promise<NeonBucketSnapshot[]> {
		return [];
	}
	async createBranchBucket(): Promise<NeonBucketSnapshot> {
		throw new Error("not implemented");
	}
	async deleteBranchBucket(): Promise<void> {
		throw new Error("not implemented");
	}
	async listBranchFunctions(): Promise<NeonFunctionSnapshot[]> {
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
	async revokeCredential(
		_projectId: string,
		_branchId: string,
		_tokenId: string,
	): Promise<void> {
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
 * A branch with object storage enabled (one bucket), so env-pull's tier-2 path (`pullConfig`
 * -> `fetchEnv`) resolves the branch credential and emits the `AWS_*` storage vars. Keeps a
 * real credential store, because `env pull` verifies persisted secrets against the branch's
 * live credentials — a stubbed-out empty list would make every pull look like a first pull.
 */
class StorageNeonApi extends FakeNeonApi {
	readonly credentials: NeonCredentialMeta[] = [];
	createCalls = 0;

	override async listBranchBuckets(): Promise<NeonBucketSnapshot[]> {
		return [{ name: "assets", accessLevel: "private" }];
	}
	override async createCredential(
		_projectId: string,
		branchId: string,
		input: CreateCredentialInput,
	): Promise<NeonCredentialSecret> {
		this.createCalls += 1;
		const tokenIdShort = `credfake000${this.createCalls}`;
		const named = input.name !== undefined ? { name: input.name } : {};
		this.credentials.push({
			tokenId: `cred-fake-000${this.createCalls}`,
			tokenIdShort,
			...named,
			scopes: input.scopes,
			principalType: input.principalType,
			branchId,
			createdAt: "2026-01-01T00:00:00Z",
		});
		return {
			tokenId: `cred-fake-000${this.createCalls}`,
			tokenIdShort,
			...named,
			apiToken: `nt_live_${tokenIdShort}_secret`,
			s3SecretAccessKey: `s3secret${this.createCalls}`.padEnd(64, "0"),
			scopes: input.scopes,
			branchId,
			createdAt: "2026-01-01T00:00:00Z",
		};
	}
	override async listCredentials(): Promise<NeonCredentialMeta[]> {
		return this.credentials.filter((c) => c.revokedAt === undefined);
	}
	override async revokeCredential(
		_projectId: string,
		_branchId: string,
		tokenId: string,
	): Promise<void> {
		for (const cred of this.credentials) {
			if (cred.tokenId === tokenId)
				cred.revokedAt = "2026-01-02T00:00:00Z";
		}
	}
}

/** Capture what the command wrote to stderr for the duration of `run`. */
const captureLog = async (run: () => Promise<void>): Promise<string> => {
	const chunks: string[] = [];
	const stderr = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((chunk: string | Uint8Array) => {
			chunks.push(String(chunk));
			return true;
		});
	try {
		await run();
	} finally {
		stderr.mockRestore();
	}
	return chunks.join("");
};

/** Stand-in for the neonctl Api client; only branch resolution is exercised. */
const fakeApiClient = {
	listProjectBranches: async () => ({
		data: {
			branches: [{ id: BRANCH_ID, name: BRANCH_NAME, default: true }],
		},
	}),
};

const baseProps = (api: FakeNeonApi, cwd: string): EnvPullProps => ({
	apiClient: fakeApiClient as never,
	apiKey: "",
	apiHost: "https://console.neon.tech/api/v2",
	contextFile: "",
	output: "table",
	projectId: PROJECT_ID,
	branch: BRANCH_NAME,
	cwd,
	runtimeApi: api,
});

describe("env pull", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "neonctl-env-pull-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("writes Neon vars into .env.local when no .env exists", async () => {
		await pull(baseProps(new FakeNeonApi(), cwd));

		const content = readFileSync(join(cwd, ".env.local"), "utf8");
		expect(content).toMatch(/^DATABASE_URL=/m);
		expect(content).toMatch(/^DATABASE_URL_UNPOOLED=/m);
		expect(content).toContain("-pooler.fake.neon.tech");
		// Auth is off by default, so NEON_AUTH_BASE_URL is not written.
		expect(content).not.toContain("NEON_AUTH_BASE_URL");
	});

	it("includes NEON_AUTH_BASE_URL when the branch has Auth enabled", async () => {
		// A neon.ts that enables auth, plus a branch that actually has the integration.
		writeFileSync(join(cwd, "neon.ts"), "export default { auth: {} };\n");
		const api = new FakeNeonApi({
			getNeonAuth: async () => ({
				projectId: "auth-project",
				jwksUrl: "https://auth.fake.neon.tech/.well-known/jwks.json",
				baseUrl: "https://auth.fake.neon.tech",
			}),
		});

		await pull(baseProps(api, cwd));

		const content = readFileSync(join(cwd, ".env.local"), "utf8");
		expect(content).toMatch(
			/^NEON_AUTH_BASE_URL=https:\/\/auth\.fake\.neon\.tech$/m,
		);
	});

	it("updates an existing .env in place, preserving other keys", async () => {
		writeFileSync(
			join(cwd, ".env"),
			"# app\nAPP_NAME=demo\nDATABASE_URL=postgres://stale\n",
		);

		await pull(baseProps(new FakeNeonApi(), cwd));

		// Existing .env is used (not .env.local) and unrelated keys survive.
		const content = readFileSync(join(cwd, ".env"), "utf8");
		expect(content).toContain("# app");
		expect(content).toContain("APP_NAME=demo");
		expect(content).toContain("-pooler.fake.neon.tech");
		expect(content).not.toContain("postgres://stale");
	});

	it("writes to an explicit --file", async () => {
		await pull({
			...baseProps(new FakeNeonApi(), cwd),
			file: ".env.preview",
		});
		const content = readFileSync(join(cwd, ".env.preview"), "utf8");
		expect(content).toMatch(/^DATABASE_URL=/m);
	});

	it("prunes stale NEON_AUTH_* / NEON_DATA_API_* left from a prior project (Auth/Data API off)", async () => {
		// A .env.local carried over from a project/branch that *had* Auth + the Data API
		// enabled. The current branch (FakeNeonApi default) has neither, so a pull must drop the
		// now-stale vars instead of leaving credentials for features that aren't enabled.
		writeFileSync(
			join(cwd, ".env.local"),
			[
				"APP_NAME=demo",
				"DATABASE_URL=postgres://stale",
				"NEON_AUTH_BASE_URL=https://stale.neonauth.example/db/auth",
				"NEON_AUTH_JWKS_URL=https://stale.neonauth.example/db/auth/.well-known/jwks.json",
				"NEON_DATA_API_URL=https://stale.apirest.example/db/rest/v1",
				"",
			].join("\n"),
		);

		const result = await pull(baseProps(new FakeNeonApi(), cwd));

		const content = readFileSync(join(cwd, ".env.local"), "utf8");
		// The user's own line and the (refreshed) Postgres URLs survive…
		expect(content).toContain("APP_NAME=demo");
		expect(content).toMatch(/^DATABASE_URL=/m);
		expect(content).not.toContain("postgres://stale");
		// …but the stale Auth / Data API vars are gone.
		expect(content).not.toContain("NEON_AUTH_BASE_URL");
		expect(content).not.toContain("NEON_AUTH_JWKS_URL");
		expect(content).not.toContain("NEON_DATA_API_URL");
		expect(result.status).toBe("written");
		if (result.status === "written") {
			expect(result.written).toContain("DATABASE_URL");
		}
	});

	it("gitignores a dotenv file it creates (it holds live branch credentials)", async () => {
		await pull(baseProps(new FakeNeonApi(), cwd));

		expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(
			".env.local\n",
		);
	});

	it("gitignores an explicit --file target too", async () => {
		await pull({
			...baseProps(new FakeNeonApi(), cwd),
			file: ".env.preview",
		});

		expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(
			".env.preview\n",
		);
	});

	it("does not add a redundant entry when a glob already covers the file", async () => {
		writeFileSync(join(cwd, ".gitignore"), "node_modules\n.env*\n");

		await pull(baseProps(new FakeNeonApi(), cwd));

		expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(
			"node_modules\n.env*\n",
		);
	});

	it("leaves .gitignore alone when the dotenv file already existed", async () => {
		// Only a file *we* create is scaffolded: re-adding the entry on every pull would fight a
		// user who deliberately un-ignored a dotenv file they want to commit.
		writeFileSync(join(cwd, ".env"), "APP_NAME=demo\n");

		await pull(baseProps(new FakeNeonApi(), cwd));

		expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
	});

	it("replaces credential secrets that name no live credential on the branch", async () => {
		// The reported bug: copy a `.env.example` whose secrets are placeholders, run `pull`,
		// and the placeholders survived — reported as "Pulled" while quietly keeping their
		// example values. A pull exists to leave a working `.env` behind, so a secret it cannot
		// verify against this branch is replaced rather than echoed back.
		const api = new StorageNeonApi();
		writeFileSync(
			join(cwd, ".env"),
			[
				"AWS_ACCESS_KEY_ID=nak_live_...",
				"AWS_SECRET_ACCESS_KEY=your-secret-here",
				"",
			].join("\n"),
		);

		const logged = await captureLog(async () => {
			await pull(baseProps(api, cwd));
		});

		const content = readFileSync(join(cwd, ".env"), "utf8");
		expect(content).toContain("AWS_ACCESS_KEY_ID=cred-fake-0001");
		expect(content).not.toContain("nak_live_...");
		expect(content).not.toContain("your-secret-here");
		// The placeholder named no credential, so there was nothing of ours to revoke.
		expect(api.credentials.filter((c) => c.revokedAt).length).toBe(0);
		// And the user is told which values are new, so they can update anything holding the old ones.
		expect(logged).toContain("Issued a new branch credential");
		expect(logged).toContain("AWS_ACCESS_KEY_ID");
	});

	it("does not mint a second credential when the pulled one still verifies", async () => {
		// The other half of the fix: verification must not become a rotation on every run. The
		// values a pull writes have to survive the next pull, or `env pull` would issue a
		// credential per invocation and change the user's keys under them each time.
		const api = new StorageNeonApi();

		await pull(baseProps(api, cwd));
		const afterFirst = readFileSync(join(cwd, ".env.local"), "utf8");
		await pull(baseProps(api, cwd));

		expect(api.createCalls).toBe(1);
		expect(readFileSync(join(cwd, ".env.local"), "utf8")).toBe(afterFirst);
	});
});

describe("env pull --service", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "neonctl-env-services-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("writes only the selected service's vars, leaving the rest of the file alone", async () => {
		writeFileSync(
			join(cwd, ".env"),
			["APP_NAME=demo", "DATABASE_URL=postgres://mine", ""].join("\n"),
		);

		await pull({
			...baseProps(new FakeNeonApi(), cwd),
			services: ["ai-gateway"],
		});

		const content = readFileSync(join(cwd, ".env"), "utf8");
		expect(content).toMatch(/^NEON_AI_GATEWAY_TOKEN=/m);
		expect(content).toMatch(
			/^NEON_AI_GATEWAY_BASE_URL=https:\/\/br-snowy-frost-12345-api\.ai\.fake\.neon\.tech$/m,
		);
		// A pull scoped to the gateway says nothing about Postgres, so it neither refreshes
		// DATABASE_URL nor prunes it.
		expect(content).toContain("DATABASE_URL=postgres://mine");
		expect(content).toContain("APP_NAME=demo");
	});

	it("overrides a neon.ts rather than intersecting with it", async () => {
		// A policy that enables auth, on a branch that has it — yet `-s postgres` asked for
		// Postgres only, so the auth vars must not be written.
		writeFileSync(join(cwd, "neon.ts"), "export default { auth: {} };\n");
		const api = new FakeNeonApi({
			getNeonAuth: async () => ({
				projectId: "auth-project",
				jwksUrl: "https://auth.fake.neon.tech/.well-known/jwks.json",
				baseUrl: "https://auth.fake.neon.tech",
			}),
		});

		await pull({ ...baseProps(api, cwd), services: ["postgres"] });

		const content = readFileSync(join(cwd, ".env.local"), "utf8");
		expect(content).toMatch(/^DATABASE_URL=/m);
		expect(content).not.toContain("NEON_AUTH_BASE_URL");
	});

	it("resolves a service the branch has, and nothing else", async () => {
		const api = new FakeNeonApi({
			getNeonAuth: async () => ({
				projectId: "auth-project",
				jwksUrl: "https://auth.fake.neon.tech/.well-known/jwks.json",
				baseUrl: "https://auth.fake.neon.tech",
			}),
		});

		await pull({ ...baseProps(api, cwd), services: ["auth"] });

		const content = readFileSync(join(cwd, ".env.local"), "utf8");
		expect(content).toMatch(
			/^NEON_AUTH_BASE_URL=https:\/\/auth\.fake\.neon\.tech$/m,
		);
		expect(content).toMatch(/^NEON_AUTH_JWKS_URL=/m);
		expect(content).not.toContain("DATABASE_URL");
	});

	it("fails by name when a selected service is not on the branch", async () => {
		await expect(
			pull({ ...baseProps(new FakeNeonApi(), cwd), services: ["auth"] }),
		).rejects.toThrow(/--service auth: branch .* no Neon Auth integration/);
		expect(existsSync(join(cwd, ".env.local"))).toBe(false);
	});

	it("fails by name when object storage is selected but the branch has no buckets", async () => {
		// Without the check this would resolve to nothing at all and report an empty pull,
		// which reads as "your branch has no env" rather than "that service isn't there".
		await expect(
			pull({
				...baseProps(new FakeNeonApi(), cwd),
				services: ["object-storage"],
			}),
		).rejects.toThrow(
			/--service object-storage: branch .* no object-storage buckets/,
		);
	});

	it("says nothing about a previous credential on a first pull, because there isn't one", async () => {
		// `credential.issued` is also true when nothing was persisted, so a message keyed off
		// it would send someone hunting the Console for a credential that never existed —
		// on the first run of the flagship example, no less.
		const logged = await captureLog(async () => {
			await pull({
				...baseProps(new StorageNeonApi(), cwd),
				services: ["object-storage"],
			});
		});

		expect(logged).toContain("Issued a new branch credential");
		expect(logged).not.toContain("Left the credential it replaced live");
	});

	it("names the credential a scoped pull replaced but left live", async () => {
		const api = new StorageNeonApi();
		await pull(baseProps(api, cwd), { implyAiGateway: true });
		dropEnvLine(join(cwd, ".env.local"), "AWS_SECRET_ACCESS_KEY");

		const logged = await captureLog(async () => {
			await pull({
				...baseProps(api, cwd),
				services: ["object-storage"],
			});
		});

		expect(logged).toContain(
			"Left the credential it replaced live (cred-fake-0001)",
		);
	});

	it("does not revoke a shared credential when replacing only the half it was scoped to", async () => {
		// Object storage and the AI Gateway share one branch credential, and the resolver
		// revokes whatever the persisted secrets name once it mints a replacement. A scoped
		// pull resolves part of the branch, so it cannot know the credential it supersedes
		// also backs a service it isn't rewriting — revoking would kill the gateway while its
		// still-present, now dead token stays on disk.
		const api = new StorageNeonApi();
		await pull(baseProps(api, cwd), { implyAiGateway: true });
		const shared = readEnvFile(join(cwd, ".env.local"));
		expect(shared.AWS_ACCESS_KEY_ID).toBe("cred-fake-0001");
		expect(shared.NEON_AI_GATEWAY_TOKEN).toBe(
			"nt_live_credfake0001_secret",
		);

		// Half the storage secret goes missing — a truncated copy/paste, a partially edited
		// file — so the storage half can no longer be reused and has to be re-minted.
		dropEnvLine(join(cwd, ".env.local"), "AWS_SECRET_ACCESS_KEY");
		await pull({ ...baseProps(api, cwd), services: ["object-storage"] });

		const after = readEnvFile(join(cwd, ".env.local"));
		expect(after.AWS_ACCESS_KEY_ID).toBe("cred-fake-0002");
		// The gateway token is untouched, and the credential behind it is still live.
		expect(after.NEON_AI_GATEWAY_TOKEN).toBe("nt_live_credfake0001_secret");
		expect(api.credentials.filter((c) => c.revokedAt)).toEqual([]);
	});

	it("defers to fetchEnv when the Data API's database cannot be auto-picked", async () => {
		// Data API is per branch *and* database. With several databases and no `neondb`,
		// `fetchEnv` refuses to auto-pick — so claiming "this branch has no Data API" would be
		// a statement this read cannot support. It defers, and fetchEnv names the databases.
		await expect(
			pull({
				...baseProps(new TwoDatabaseNeonApi(), cwd),
				services: ["data-api"],
			}),
		).rejects.toThrow(/cannot auto-pick/);
	});

	it("reports that object storage is unavailable, rather than that the branch has no buckets", async () => {
		// Two different problems with two different fixes. A read that degrades an
		// unavailable feature to an empty list cannot tell them apart, so the selection reads
		// the buckets directly and lets the API's own message through.
		await expect(
			pull({
				...baseProps(new NoStorageFeatureNeonApi(), cwd),
				services: ["object-storage"],
			}),
		).rejects.toThrow(/isn't available for this Neon project/);
	});
});

/** Remove one assignment from a dotenv file, leaving everything else in place. */
const dropEnvLine = (path: string, key: string): void => {
	writeFileSync(
		path,
		readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => !line.startsWith(`${key}=`))
			.join("\n"),
	);
};

/** A branch with two databases and no `neondb`, which `fetchEnv` refuses to auto-pick from. */
class TwoDatabaseNeonApi extends FakeNeonApi {
	override async listBranchDatabases(
		projectId: string,
		branchId: string,
	): Promise<NeonDatabaseSnapshot[]> {
		void projectId;
		return [
			{ name: "orders", branchId, ownerName: "neondb_owner" },
			{ name: "analytics", branchId, ownerName: "neondb_owner" },
		];
	}
}

/** A project in a region where object storage isn't deployed. */
class NoStorageFeatureNeonApi extends FakeNeonApi {
	override async listBranchBuckets(): Promise<NeonBucketSnapshot[]> {
		throw new PlatformError(
			ErrorCode.FeatureUnavailable,
			"Object storage (buckets) isn't available for this Neon project (HTTP 404 Not Found).",
		);
	}
}

/** A project where the branch-credentials endpoint answers "unavailable" for either call. */
class NoCredentialsNeonApi extends FakeNeonApi {
	private readonly unavailable = (): never => {
		throw new PlatformError(
			ErrorCode.FeatureUnavailable,
			"Branch credentials isn't available for this Neon project (HTTP 503 Service Unavailable).",
		);
	};
	override async createCredential(): Promise<NeonCredentialSecret> {
		return this.unavailable();
	}
	override async listCredentials(): Promise<NeonCredentialMeta[]> {
		return this.unavailable();
	}
}

describe("env pull with the AI Gateway implied (no neon.ts)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "neonctl-env-gateway-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("pulls the gateway vars, which the branch read-back cannot report on its own", async () => {
		const result = await pull(baseProps(new FakeNeonApi(), cwd), {
			implyAiGateway: true,
		});

		const content = readFileSync(join(cwd, ".env.local"), "utf8");
		expect(content).toMatch(/^DATABASE_URL=/m);
		expect(content).toMatch(/^NEON_AI_GATEWAY_TOKEN=/m);
		expect(content).toMatch(/^NEON_AI_GATEWAY_BASE_URL=/m);
		expect(result.status).toBe("written");
		if (result.status === "written") expect(result.skipped).toBeUndefined();
	});

	it("leaves the policy in charge when a neon.ts exists", async () => {
		writeFileSync(join(cwd, "neon.ts"), "export default {};\n");

		await pull(baseProps(new FakeNeonApi(), cwd), {
			implyAiGateway: true,
		});

		const content = readFileSync(join(cwd, ".env.local"), "utf8");
		expect(content).toMatch(/^DATABASE_URL=/m);
		expect(content).not.toContain("NEON_AI_GATEWAY");
	});

	it("drops the gateway and says so when the project cannot mint a credential", async () => {
		// The gateway is implied, never named by the user, so a project that doesn't have it
		// must still get the rest of its env — but the result has to report the gap rather
		// than pass for a complete pull.
		let result: PullOutcome | undefined;
		const logged = await captureLog(async () => {
			result = await pull(baseProps(new NoCredentialsNeonApi(), cwd), {
				implyAiGateway: true,
			});
		});

		const content = readFileSync(join(cwd, ".env.local"), "utf8");
		expect(content).toMatch(/^DATABASE_URL=/m);
		expect(content).not.toContain("NEON_AI_GATEWAY");
		expect(logged).toContain(
			"Could not reach the AI Gateway's credentials",
		);
		// The warning names the vars that were not written, and does not assert a cause the
		// error code cannot distinguish (unavailable project vs transient failure).
		expect(logged).toContain("NEON_AI_GATEWAY_TOKEN");
		expect(logged).toContain("or the call failed");
		expect(result?.status).toBe("written");
		if (result?.status === "written") {
			expect(result.skipped).toEqual(["ai-gateway"]);
		}
	});

	it("keeps an existing gateway token when the gateway could not be reached", async () => {
		// `PLATFORM_FEATURE_UNAVAILABLE` covers a transient incident as well as a project that
		// genuinely lacks the feature, and a pull that could not reach the gateway is not
		// evidence that the branch no longer has one. Pruning here would delete a working
		// token whose secret exists nowhere else, and strand the credential behind it.
		writeFileSync(
			join(cwd, ".env"),
			[
				"NEON_AI_GATEWAY_TOKEN=nt_live_credfake0001_secret",
				"NEON_AI_GATEWAY_BASE_URL=https://br-snowy-frost-12345-api.ai.fake.neon.tech",
				"",
			].join("\n"),
		);

		await captureLog(async () => {
			await pull(baseProps(new NoCredentialsNeonApi(), cwd), {
				implyAiGateway: true,
			});
		});

		const content = readFileSync(join(cwd, ".env"), "utf8");
		expect(content).toContain(
			"NEON_AI_GATEWAY_TOKEN=nt_live_credfake0001_secret",
		);
		expect(content).toMatch(/^DATABASE_URL=/m);
	});

	it("prunes gateway vars left over from a different branch, even when the gateway is unreachable", async () => {
		// The other half of the rule above. Not pruning is only defensible for *this* branch's
		// values; a token carried over from another branch is stale by definition, and keeping
		// it would leave the app sending AI traffic to the wrong branch's gateway — a silent
		// failure, and a worse one than losing a token.
		writeFileSync(
			join(cwd, ".env"),
			[
				"NEON_AI_GATEWAY_TOKEN=nt_live_someothercred_secret",
				"NEON_AI_GATEWAY_BASE_URL=https://br-somewhere-else-99999-api.ai.fake.neon.tech",
				"",
			].join("\n"),
		);

		await captureLog(async () => {
			await pull(baseProps(new NoCredentialsNeonApi(), cwd), {
				implyAiGateway: true,
			});
		});

		const content = readFileSync(join(cwd, ".env"), "utf8");
		expect(content).not.toContain("NEON_AI_GATEWAY");
		expect(content).toMatch(/^DATABASE_URL=/m);
	});

	it.each([
		[
			"mentions the branch id elsewhere",
			`https://br-old-00000-api.ai.fake.neon.tech/?from=${BRANCH_ID}`,
		],
		[
			"carries the branch id as userinfo",
			`https://${BRANCH_ID}-api.ai.@br-old-00000-api.ai.fake.neon.tech`,
		],
		["is not a URL at all", `not-a-url-${BRANCH_ID}-api.ai.`],
	])("prunes a gateway URL that %s", async (_case, baseUrl) => {
		// Ownership is the parsed hostname, not a prefix of the raw string. A value that only
		// looks like this branch's gateway is not this branch's gateway, and keeping it would
		// misroute traffic silently.
		writeFileSync(
			join(cwd, ".env"),
			[
				"NEON_AI_GATEWAY_TOKEN=nt_live_someothercred_secret",
				`NEON_AI_GATEWAY_BASE_URL=${baseUrl}`,
				"",
			].join("\n"),
		);

		await captureLog(async () => {
			await pull(baseProps(new NoCredentialsNeonApi(), cwd), {
				implyAiGateway: true,
			});
		});

		const content = readFileSync(join(cwd, ".env"), "utf8");
		expect(content).not.toContain("NEON_AI_GATEWAY");
		expect(content).toMatch(/^DATABASE_URL=/m);
	});

	it("stays off for the pull bundled into link / checkout / apply", async () => {
		// An auto-pull is a side effect of another command; minting a credential for a
		// service the user never named is not something a side effect should do.
		await autoPullEnvAfterPin({
			...baseProps(new FakeNeonApi(), cwd),
			envPull: true,
		});

		const content = readFileSync(join(cwd, ".env.local"), "utf8");
		expect(content).toMatch(/^DATABASE_URL=/m);
		expect(content).not.toContain("NEON_AI_GATEWAY");
	});
});

/**
 * Branch-level `getConnectionUri` failure, to exercise the auto-pull failure path. The pin
 * (`link` / `checkout`) has already happened by the time auto-pull runs, so a pull failure
 * must degrade to a non-throwing `failed` result rather than tearing down the command.
 */
class UnreachableNeonApi extends FakeNeonApi {
	override async getConnectionUri(): Promise<{ uri: string }> {
		throw new Error("boom: Neon API unreachable");
	}
}

describe("autoPullEnvAfterPin (bundled into link / checkout)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "neonctl-auto-pull-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("pulls by default, writing the branch vars into .env.local", async () => {
		const result = await autoPullEnvAfterPin({
			...baseProps(new FakeNeonApi(), cwd),
			envPull: true,
		});

		expect(result.status).toBe("written");
		const content = readFileSync(join(cwd, ".env.local"), "utf8");
		expect(content).toMatch(/^DATABASE_URL=/m);
	});

	it("skips the pull (writing nothing) when --no-env-pull is passed", async () => {
		const result = await autoPullEnvAfterPin({
			...baseProps(new FakeNeonApi(), cwd),
			envPull: false,
		});

		expect(result).toEqual({ status: "skipped" });
		expect(existsSync(join(cwd, ".env.local"))).toBe(false);
		expect(existsSync(join(cwd, ".env"))).toBe(false);
	});

	it("degrades a pull failure to a warning instead of throwing (the pin still stands)", async () => {
		const result = await autoPullEnvAfterPin({
			...baseProps(new UnreachableNeonApi(), cwd),
			envPull: true,
		});

		expect(result.status).toBe("failed");
		// Nothing is written when the pull fails before resolving any vars.
		expect(existsSync(join(cwd, ".env.local"))).toBe(false);
	});
});
