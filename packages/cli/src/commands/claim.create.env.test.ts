import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { readClaimableCredentials } from "../claimable/state.js";
import { readEnvFile } from "../env_file.js";
import { create } from "./claim.js";

const PROJECT_ID = "patient-art-12345";
const BRANCH_ID = "br-snowy-frost-12345";
const BRANCH_NAME = "main";
const ACCESS_TOKEN = "claimable-access-token";

class FakeNeonApi implements NeonApi {
	credentialCreateCalls = 0;
	connectionUriCalls = 0;
	failConnectionUri = false;

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
		this.connectionUriCalls += 1;
		if (this.failConnectionUri) {
			throw new Error("connection uri failed");
		}
		const host = input.pooled
			? `${BRANCH_ID}-pooler.fake.neon.tech`
			: `${BRANCH_ID}.fake.neon.tech`;
		return {
			uri: `postgresql://${input.roleName}:pw@${host}/${input.databaseName}?sslmode=require`,
		};
	}
	auth: NeonAuthSnapshot | null = null;
	async getNeonAuth(): Promise<NeonAuthSnapshot | null> {
		return this.auth;
	}
	async enableNeonAuth(): Promise<NeonAuthSnapshot> {
		throw new Error("not implemented");
	}
	dataApi: NeonDataApiSnapshot | null = null;
	async getNeonDataApi(): Promise<NeonDataApiSnapshot | null> {
		return this.dataApi;
	}
	async enableProjectBranchDataApi(): Promise<NeonDataApiSnapshot> {
		throw new Error("not implemented");
	}
	async updateProjectBranchDataApi(): Promise<NeonDataApiSnapshot> {
		throw new Error("not implemented");
	}
	async deleteProjectBranchDataApi(): Promise<void> {}
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
		this.credentialCreateCalls += 1;
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
	async revokeCredential(): Promise<void> {}
	async getProjectBranchStorage(): Promise<NeonBranchStorageSnapshot | null> {
		return {
			s3Endpoint: "https://fake.storage.neon.tech",
			region: "us-east-1",
			forcePathStyle: true,
		};
	}
}

const fakeApiClient = {
	listProjectBranches: async () => ({
		data: {
			branches: [{ id: BRANCH_ID, name: BRANCH_NAME, default: true }],
		},
	}),
};

const REQUIRES_CLAIM = new Set(["storage", "functions", "ai_gateway"]);

const readBody = (req: IncomingMessage): Promise<string> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});

const listen = async (
	onRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
) => {
	const server = createServer((req, res) => {
		onRequest(req, res).catch((error) => {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: String(error) } }));
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "localhost", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("test server did not bind a port");
	}
	return {
		origin: `http://localhost:${address.port}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
};

describe("claim create env pull", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	const workspace = () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-claim-create-env-"));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const configDir = join(cwd, "config");
		mkdirSync(configDir);
		return { cwd, configDir, contextFile: join(cwd, ".neon") };
	};

	const startService = async () => {
		const seen: string[] = [];
		let deleted = false;
		const server = await listen(async (req, res) => {
			const url = req.url ?? "";
			seen.push(`${req.method ?? "GET"} ${url}`);
			if (req.method === "POST" && url === "/v1/agent/identity") {
				const body = JSON.parse(await readBody(req)) as {
					capabilities?: string[];
				};
				const capabilities = (body.capabilities ?? ["postgres"]).map(
					(capability) =>
						REQUIRES_CLAIM.has(capability)
							? {
									capability,
									granted: false,
									reason: "requires_claim",
									message: "Claim this project first.",
								}
							: { capability, granted: true },
				);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						registration_id: "reg-test",
						identity_assertion: "signed-assertion",
						assertion_expires: Math.floor(Date.now() / 1000) + 3600,
						scopes: ["postgres.read"],
						project: {
							id: PROJECT_ID,
							branch_id: BRANCH_ID,
							expires_at: "2099-01-01T00:00:00.000Z",
						},
						capabilities,
					}),
				);
				return;
			}
			if (req.method === "POST" && url === "/v1/oauth2/token") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						access_token: ACCESS_TOKEN,
						token_type: "Bearer",
						expires_in: 900,
						scope: "postgres.read",
					}),
				);
				return;
			}
			if (
				req.method === "DELETE" &&
				url === `/v1/projects/${PROJECT_ID}`
			) {
				deleted = true;
				res.writeHead(204);
				res.end();
				return;
			}
			res.writeHead(404, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					error: { code: "not_found", message: url },
				}),
			);
		});
		cleanups.push(() => server.close());
		return { origin: server.origin, seen, wasDeleted: () => deleted };
	};

	const runCreate = async (
		origin: string,
		api: FakeNeonApi,
		opts: { envPull?: boolean; services?: ("auth" | "data-api")[] } = {},
	) => {
		const { cwd, configDir, contextFile } = workspace();
		const stdout = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		cleanups.push(() => {
			stdout.mockRestore();
			stderr.mockRestore();
		});
		await create({
			_: ["claim", "create"],
			output: "json",
			configDir,
			contextFile,
			claimableHost: origin,
			apiKey: "",
			envPull: opts.envPull ?? true,
			cwd,
			runtimeApi: api,
			apiClient: fakeApiClient as never,
			...(opts.services ? { services: opts.services } : {}),
		});
		return { cwd, configDir, contextFile };
	};

	it("writes DATABASE_URL, DATABASE_URL_UNPOOLED, and NEON_BRANCH", async () => {
		const service = await startService();
		const api = new FakeNeonApi();
		const { cwd } = await runCreate(service.origin, api);

		const env = readEnvFile(join(cwd, ".env.local"));
		expect(env.DATABASE_URL).toContain("-pooler.fake.neon.tech");
		expect(env.DATABASE_URL_UNPOOLED).toContain(
			`${BRANCH_ID}.fake.neon.tech`,
		);
		expect(env.NEON_BRANCH).toBe(BRANCH_NAME);
		expect(api.credentialCreateCalls).toBe(0);
		expect(
			service.seen.some((entry) => entry.includes("/credentials")),
		).toBe(false);
	});

	it("includes granted Auth and Data API from live GETs", async () => {
		const service = await startService();
		const api = new FakeNeonApi();
		api.auth = {
			projectId: "auth-project",
			jwksUrl: "https://auth.fake.neon.tech/.well-known/jwks.json",
			baseUrl: "https://auth.fake.neon.tech",
		};
		api.dataApi = { url: "https://data.fake.neon.tech/rest/v1" };
		const { cwd } = await runCreate(service.origin, api, {
			services: ["auth", "data-api"],
		});

		const env = readEnvFile(join(cwd, ".env.local"));
		expect(env.NEON_AUTH_BASE_URL).toBe("https://auth.fake.neon.tech");
		expect(env.NEON_DATA_API_URL).toBe(
			"https://data.fake.neon.tech/rest/v1",
		);
	});

	it("skips the dotenv file when --no-env-pull", async () => {
		const service = await startService();
		const { cwd, configDir, contextFile } = await runCreate(
			service.origin,
			new FakeNeonApi(),
			{ envPull: false },
		);

		expect(existsSync(join(cwd, ".env.local"))).toBe(false);
		expect(existsSync(contextFile)).toBe(true);
		expect(readClaimableCredentials(configDir, PROJECT_ID)).not.toBeNull();
		expect(
			service.seen.some((entry) => entry.includes("/oauth2/token")),
		).toBe(true);
		expect(
			service.seen.some((entry) => entry.includes("/credentials")),
		).toBe(false);
	});

	it("deletes the project and rolls back when neon.ts declares the AI Gateway", async () => {
		const service = await startService();
		const api = new FakeNeonApi();
		const { cwd, configDir, contextFile } = workspace();
		writeFileSync(
			join(cwd, "neon.ts"),
			"export default { preview: { aiGateway: true } };\n",
		);
		const stdout = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		cleanups.push(() => {
			stdout.mockRestore();
			stderr.mockRestore();
		});

		await expect(
			create({
				_: ["claim", "create"],
				output: "json",
				configDir,
				contextFile,
				claimableHost: service.origin,
				apiKey: "",
				envPull: true,
				cwd,
				runtimeApi: api,
				apiClient: fakeApiClient as never,
			}),
		).rejects.toThrow(
			/ai-gateway.*cannot be used on an unclaimed Claimable Neon project/s,
		);

		expect(service.wasDeleted()).toBe(true);
		expect(existsSync(contextFile)).toBe(false);
		expect(existsSync(join(cwd, ".env.local"))).toBe(false);
		expect(readClaimableCredentials(configDir, PROJECT_ID)).toBeNull();
		expect(api.credentialCreateCalls).toBe(0);
	});

	it("uses --config for the env pull, not a different neon.ts in cwd", async () => {
		const service = await startService();
		const api = new FakeNeonApi();
		const { cwd, configDir, contextFile } = workspace();
		writeFileSync(
			join(cwd, "neon.ts"),
			"export default { preview: { aiGateway: true } };\n",
		);
		const selected = join(cwd, "claimable.ts");
		writeFileSync(selected, "export default {};\n");
		const stdout = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		cleanups.push(() => {
			stdout.mockRestore();
			stderr.mockRestore();
		});

		await create({
			_: ["claim", "create"],
			output: "json",
			configDir,
			contextFile,
			claimableHost: service.origin,
			apiKey: "",
			envPull: true,
			cwd,
			config: selected,
			runtimeApi: api,
			apiClient: fakeApiClient as never,
		});

		expect(existsSync(join(cwd, ".env.local"))).toBe(true);
		expect(readEnvFile(join(cwd, ".env.local")).DATABASE_URL).toBeDefined();
		expect(service.wasDeleted()).toBe(false);
		expect(api.credentialCreateCalls).toBe(0);
	});

	it("rolls back when --config names AI Gateway even if cwd neon.ts does not", async () => {
		const service = await startService();
		const api = new FakeNeonApi();
		const { cwd, configDir, contextFile } = workspace();
		writeFileSync(join(cwd, "neon.ts"), "export default {};\n");
		const selected = join(cwd, "claimable.ts");
		writeFileSync(
			selected,
			"export default { preview: { aiGateway: true } };\n",
		);
		const stdout = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		cleanups.push(() => {
			stdout.mockRestore();
			stderr.mockRestore();
		});

		await expect(
			create({
				_: ["claim", "create"],
				output: "json",
				configDir,
				contextFile,
				claimableHost: service.origin,
				apiKey: "",
				envPull: true,
				cwd,
				config: selected,
				runtimeApi: api,
				apiClient: fakeApiClient as never,
			}),
		).rejects.toThrow(
			/ai-gateway.*cannot be used on an unclaimed Claimable Neon project/s,
		);

		expect(service.wasDeleted()).toBe(true);
		expect(existsSync(join(cwd, ".env.local"))).toBe(false);
		expect(api.credentialCreateCalls).toBe(0);
	});

	it("deletes the project and rolls back local files when pull fails", async () => {
		const service = await startService();
		const api = new FakeNeonApi();
		api.failConnectionUri = true;
		const { cwd, configDir, contextFile } = workspace();
		const stdout = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		cleanups.push(() => {
			stdout.mockRestore();
			stderr.mockRestore();
		});

		await expect(
			create({
				_: ["claim", "create"],
				output: "json",
				configDir,
				contextFile,
				claimableHost: service.origin,
				apiKey: "",
				envPull: true,
				cwd,
				runtimeApi: api,
				apiClient: fakeApiClient as never,
			}),
		).rejects.toThrow(/connection uri failed/);

		expect(service.wasDeleted()).toBe(true);
		expect(existsSync(contextFile)).toBe(false);
		expect(existsSync(join(cwd, ".env.local"))).toBe(false);
		expect(readClaimableCredentials(configDir, PROJECT_ID)).toBeNull();
	});
});
