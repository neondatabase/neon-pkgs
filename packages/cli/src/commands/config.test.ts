import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type {
	ComputeSettings,
	CreateBranchInput,
	CreateBucketInput,
	CreateCredentialInput,
	DeployFunctionInput,
	GetConnectionUriInput,
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
import type { NeonApi } from "@neon/config-runtime";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConfigProps } from "./config.js";
import {
	applyCmd,
	applyPolicyOnCreate,
	createBranchFromPolicyOnCheckout,
	planCmd,
	status,
} from "./config.js";

const PROJECT_ID = "patient-art-12345";
const BRANCH_ID = "br-snowy-frost-12345";
const BRANCH_NAME = "main";

/**
 * Full {@link NeonApi} implementation backed by fixed in-memory state for one
 * project + one default branch. The handful of methods that `inspect` / `plan` /
 * `apply` exercise return real data; everything else throws so an unexpected call
 * fails loudly instead of silently passing. `enableNeonAuth` records its calls so
 * a test can assert `apply` actually mutated remote state.
 */
class FakeNeonApi implements NeonApi {
	readonly enableNeonAuthCalls: { projectId: string; branchId: string }[] =
		[];
	readonly deployBranchFunctionCalls: {
		projectId: string;
		branchId: string;
		slug: string;
		input: DeployFunctionInput;
	}[] = [];
	/** Functions materialized by a deploy, keyed by slug (Neon creates on first deploy). */
	private readonly functions = new Map<string, NeonFunctionSnapshot>();

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
		void projectId;
		return [
			{
				id: BRANCH_ID,
				name: BRANCH_NAME,
				isDefault: true,
				protected: false,
			},
		];
	}

	async createBranch(
		projectId: string,
		input: CreateBranchInput,
	): Promise<{
		branch: NeonBranchSnapshot;
		endpoints: NeonEndpointSnapshot[];
	}> {
		void projectId;
		void input;
		throw new Error("not implemented");
	}

	async updateBranch(): Promise<NeonBranchSnapshot> {
		throw new Error("not implemented");
	}

	async listEndpoints(projectId: string): Promise<NeonEndpointSnapshot[]> {
		void projectId;
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

	async updateEndpoint(
		projectId: string,
		endpointId: string,
		settings: ComputeSettings,
	): Promise<NeonEndpointSnapshot> {
		void projectId;
		void endpointId;
		void settings;
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
		return {
			uri: `postgresql://${input.roleName}:pw@${BRANCH_ID}.fake.neon.tech/${input.databaseName}?sslmode=require`,
		};
	}

	async getNeonAuth(): Promise<NeonAuthSnapshot | null> {
		return null;
	}

	async enableNeonAuth(
		projectId: string,
		branchId: string,
	): Promise<NeonAuthSnapshot> {
		this.enableNeonAuthCalls.push({ projectId, branchId });
		return {
			projectId: "auth-project",
			jwksUrl: "https://auth.fake.neon.tech/.well-known/jwks.json",
			baseUrl: "https://auth.fake.neon.tech",
		};
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

	async createBranchBucket(
		projectId: string,
		branchId: string,
		input: CreateBucketInput,
	): Promise<NeonBucketSnapshot> {
		void projectId;
		void branchId;
		return {
			name: input.name,
			accessLevel: input.accessLevel ?? "private",
		};
	}

	async deleteBranchBucket(): Promise<void> {
		throw new Error("not implemented");
	}

	async listBranchFunctions(): Promise<NeonFunctionSnapshot[]> {
		return [...this.functions.values()];
	}

	async deleteBranchFunction(): Promise<void> {
		throw new Error("not implemented");
	}

	async deployBranchFunction(
		projectId: string,
		branchId: string,
		slug: string,
		input: DeployFunctionInput,
	): Promise<NeonFunctionDeploymentSnapshot> {
		this.deployBranchFunctionCalls.push({
			projectId,
			branchId,
			slug,
			input,
		});
		// Neon creates the function on its first deployment — mirror that so a later
		// `listBranchFunctions` (used to resolve the invocation URL) sees it.
		if (!this.functions.has(slug)) {
			this.functions.set(slug, {
				id: `fn-${slug}`,
				slug,
				name: slug,
				invocationUrl: `https://${branchId}.fake.neon.tech/functions/${slug}`,
			});
		}
		return { id: 1, status: "completed" };
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
 * Minimal stand-in for the neonctl `Api` client. Only `listProjectBranches` is
 * exercised (by `branchIdFromProps`, to resolve the branch name to its id);
 * anything else is absent and would throw if touched.
 */
const fakeApiClient = {
	listProjectBranches: async () => ({
		data: {
			branches: [
				{
					id: BRANCH_ID,
					name: BRANCH_NAME,
					default: true,
				},
			],
		},
	}),
};

/** Capture writer output (the writer respects `props.out`). */
const captureOut = (): { stream: PassThrough; read: () => string } => {
	const stream = new PassThrough();
	let buffer = "";
	stream.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
	});
	return { stream, read: () => buffer };
};

const baseProps = (
	api: FakeNeonApi,
	out: PassThrough,
): ConfigProps & { runtimeApi: NeonApi; out: PassThrough } => ({
	apiClient: fakeApiClient as never,
	apiKey: "",
	apiHost: "https://console.neon.tech/api/v2",
	contextFile: "",
	output: "json",
	projectId: PROJECT_ID,
	branch: BRANCH_NAME,
	runtimeApi: api,
	// Off by default in tests so the apply/plan assertions don't trigger the bundled env
	// pull (which writes a .env to cwd). The dedicated env-pull tests opt back in.
	envPull: false,
	out,
});

describe("config commands", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "neonctl-config-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	const writeConfig = (body: string): string => {
		const path = join(cwd, "neon.ts");
		writeFileSync(path, body);
		return path;
	};

	it("status returns the live project + branch state with a resolved neon.ts-shaped config", async () => {
		const api = new FakeNeonApi();
		const { stream, read } = captureOut();

		await status(baseProps(api, stream));

		const parsed = JSON.parse(read());
		expect(parsed.project.id).toBe(PROJECT_ID);
		expect(parsed.branch.id).toBe(BRANCH_ID);
		expect(parsed.branch.name).toBe(BRANCH_NAME);
		// The `config` column is the resolved neon.ts-shaped view, not the raw `{}`: the fake
		// branch has compute settings (so a `branch.postgres` section) and no auth/dataApi.
		expect(parsed.config.branch.postgres.computeSettings).toMatchObject({
			autoscalingLimitMaxCu: 0.25,
			suspendTimeout: "5m",
		});
		expect(parsed.config.auth).toBeUndefined();
		expect(parsed.config.dataApi).toBeUndefined();
		expect(parsed.config.preview).toBeUndefined();
	});

	it("status --config-json prints only the neon.ts-shaped config to stdout", async () => {
		const api = new FakeNeonApi();
		const { stream, read } = captureOut();

		// Capture process.stdout (the --config-json path writes there directly).
		const chunks: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			chunks.push(chunk.toString());
			return true;
		}) as typeof process.stdout.write;
		try {
			await status({ ...baseProps(api, stream), configJson: true });
		} finally {
			process.stdout.write = orig;
		}

		// The writer (table/json output) is NOT used; only stdout JSON.
		expect(read()).toBe("");
		const json = JSON.parse(chunks.join(""));
		// No project/branch envelope — just the config.
		expect(json.project).toBeUndefined();
		expect(json.branch.postgres.computeSettings.suspendTimeout).toBe("5m");
	});

	it("status --current-branch prints only the pinned branch from .neon and never touches the API", async () => {
		const { stream, read } = captureOut();
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			JSON.stringify({
				orgId: "org-x",
				projectId: "proj-x",
				branch: "my-feature",
			}),
		);

		// Any API access in this mode is a bug: the branch comes purely from `.neon`.
		const throwingApi = new Proxy(
			{},
			{
				get() {
					throw new Error(
						"apiClient must not be called for --current-branch",
					);
				},
			},
		);

		const chunks: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			chunks.push(chunk.toString());
			return true;
		}) as typeof process.stdout.write;
		try {
			await status({
				...baseProps(new FakeNeonApi(), stream),
				apiClient: throwingApi as never,
				contextFile,
				currentBranch: true,
			});
		} finally {
			process.stdout.write = orig;
		}

		// Branch present: exactly the branch name + newline, exit 0 (like `git
		// branch --show-current` for this case); the writer is unused.
		expect(chunks.join("")).toBe("my-feature\n");
		expect(read()).toBe("");
	});

	it("status --current-branch prints nothing to stdout, hints on stderr, and exits non-zero when no branch is pinned", async () => {
		const { stream } = captureOut();
		const contextFile = join(cwd, ".neon");
		// A linked project but no pinned branch — the unset case.
		writeFileSync(
			contextFile,
			JSON.stringify({ orgId: "org-x", projectId: "proj-x" }),
		);

		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const origOut = process.stdout.write.bind(process.stdout);
		const origErr = process.stderr.write.bind(process.stderr);
		const origExitCode = process.exitCode;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdoutChunks.push(chunk.toString());
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderrChunks.push(chunk.toString());
			return true;
		}) as typeof process.stderr.write;
		try {
			await status({
				...baseProps(new FakeNeonApi(), stream),
				contextFile,
				currentBranch: true,
			});

			// stdout stays empty; the hint goes to stderr only.
			expect(stdoutChunks.join("")).toBe("");
			expect(stderrChunks.join("")).toContain(
				"Run `neonctl checkout <branch>`",
			);
			// Non-zero exit (grep-style) so a shell prompt can guard on it directly.
			expect(process.exitCode).toBe(1);
		} finally {
			process.stdout.write = origOut;
			process.stderr.write = origErr;
			// Restore so a failing exit code doesn't leak into the vitest process.
			process.exitCode = origExitCode;
		}
	});

	it("status --current-branch treats a missing .neon as no branch (empty stdout, non-zero exit)", async () => {
		const { stream } = captureOut();
		const contextFile = join(cwd, "does-not-exist", ".neon");

		const stdoutChunks: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		const origExitCode = process.exitCode;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdoutChunks.push(chunk.toString());
			return true;
		}) as typeof process.stdout.write;
		try {
			await status({
				...baseProps(new FakeNeonApi(), stream),
				contextFile,
				currentBranch: true,
			});

			expect(stdoutChunks.join("")).toBe("");
			expect(process.exitCode).toBe(1);
		} finally {
			process.stdout.write = orig;
			process.exitCode = origExitCode;
		}
	});

	it("plan is a dry run whose applied list includes the auth service change", async () => {
		const api = new FakeNeonApi();
		const { stream, read } = captureOut();
		const config = writeConfig("export default { auth: {} };\n");

		await planCmd({ ...baseProps(api, stream), config });

		const result = JSON.parse(read());
		expect(result.dryRun).toBe(true);
		const authChange = result.applied.find(
			(change: { identifier: string }) => change.identifier === "auth",
		);
		expect(authChange).toBeDefined();
		expect(authChange.kind).toBe("service");
		// A dry run never mutates remote state.
		expect(api.enableNeonAuthCalls).toHaveLength(0);
	});

	it("apply actually enables Neon Auth and is not a dry run", async () => {
		const api = new FakeNeonApi();
		const { stream, read } = captureOut();
		const config = writeConfig("export default { auth: {} };\n");

		await applyCmd({ ...baseProps(api, stream), config });

		const result = JSON.parse(read());
		expect(result.dryRun).toBe(false);
		expect(api.enableNeonAuthCalls).toHaveLength(1);
		expect(api.enableNeonAuthCalls[0]).toEqual({
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
		});
	});

	it("apply deploys a function via neonctl's own bundler", async () => {
		const api = new FakeNeonApi();
		const { stream } = captureOut();

		// A real handler module on disk: applyCmd's injected bundler (bundleEntry +
		// zipBundle) actually runs esbuild against this source and zips the output, so
		// it must be valid TypeScript that esbuild can bundle.
		const source = join(cwd, "hello.ts");
		writeFileSync(
			source,
			"export default { fetch() { return new Response('ok'); } };\n",
		);
		const config = writeConfig(
			`export default { preview: { functions: { hello: { name: 'Hello', source: ${JSON.stringify(
				source,
			)} } } } };\n`,
		);

		await applyCmd({ ...baseProps(api, stream), config });

		// The function was new (listBranchFunctions returns []), so apply both creates
		// it and deploys code to it. We assert the deploy carried a real bundle.
		expect(api.deployBranchFunctionCalls).toHaveLength(1);
		const call = api.deployBranchFunctionCalls[0];
		expect(call.projectId).toBe(PROJECT_ID);
		expect(call.branchId).toBe(BRANCH_ID);
		expect(call.slug).toBe("hello");

		// The bundle must be the real ZIP produced by neonctl's bundleEntry + zipBundle
		// (NOT config-runtime's own esbuild default bundler). A non-empty Uint8Array
		// whose first two bytes are the ZIP local-file-header magic ("PK") proves a real
		// archive was built by neonctl's injected FunctionBundler.
		const { bundle } = call.input;
		expect(bundle).toBeInstanceOf(Uint8Array);
		expect(bundle.byteLength).toBeGreaterThan(0);
		expect(bundle[0]).toBe(0x50); // 'P'
		expect(bundle[1]).toBe(0x4b); // 'K'
	});

	it("--env loads a .env file into the environment before evaluating neon.ts", async () => {
		const api = new FakeNeonApi();
		const { stream } = captureOut();

		const source = join(cwd, "hello.ts");
		writeFileSync(
			source,
			"export default { fetch() { return new Response('ok'); } };\n",
		);
		// The function's env value reads process.env.RESEND_API_KEY — which is only present if
		// the --env file is loaded before the policy is evaluated.
		const config = writeConfig(
			`export default { preview: { functions: { hello: { name: 'Hello', source: ${JSON.stringify(
				source,
			)}, env: { resendApiKey: process.env.RESEND_API_KEY ?? '' } } } } };\n`,
		);
		const envFile = join(cwd, ".env.deploy");
		writeFileSync(envFile, "RESEND_API_KEY=re_from_file\n");

		try {
			await applyCmd({ ...baseProps(api, stream), config, env: envFile });
		} finally {
			delete process.env.RESEND_API_KEY;
		}

		expect(api.deployBranchFunctionCalls).toHaveLength(1);
		expect(api.deployBranchFunctionCalls[0].input.environment).toEqual({
			resendApiKey: "re_from_file",
		});
	});

	it("apply surfaces each deployed function invocation URL in the output", async () => {
		const api = new FakeNeonApi();
		const { stream, read } = captureOut();

		const source = join(cwd, "hello.ts");
		writeFileSync(
			source,
			"export default { fetch() { return new Response('ok'); } };\n",
		);
		const config = writeConfig(
			`export default { preview: { functions: { hello: { name: 'Hello', source: ${JSON.stringify(
				source,
			)} } } } };\n`,
		);

		// Human-readable (table) output so we exercise the dedicated Function URLs table; the
		// JSON path already carries the URL inside the raw applied-change details.
		await applyCmd({ ...baseProps(api, stream), output: "table", config });

		const out = read();
		expect(out).toContain("Function URLs");
		expect(out).toContain(
			`https://${BRANCH_ID}.fake.neon.tech/functions/hello`,
		);
	});

	it("keeps the changes table minimal and lists function URLs out of the table (regression)", async () => {
		// Regression: a deployed function's change details carry a long `invocationUrl`. We used
		// to JSON.stringify the whole details object into a "Details" table column, which blew the
		// ASCII table out to ~190 columns so its borders wrapped and misaligned in a normal
		// terminal. The changes table is now minimal (action/kind/identifier only) and the URLs
		// are printed as a plain list below it, so nothing long ever lands in a table cell.
		const api = new FakeNeonApi();
		const { stream, read } = captureOut();

		const source = join(cwd, "hello.ts");
		writeFileSync(
			source,
			"export default { fetch() { return new Response('ok'); } };\n",
		);
		const config = writeConfig(
			`export default { preview: { functions: { hello: { name: 'Hello', source: ${JSON.stringify(
				source,
			)} } } } };\n`,
		);

		await applyCmd({ ...baseProps(api, stream), output: "table", config });

		const out = stripAnsi(read());
		const invocationUrl = `https://${BRANCH_ID}.fake.neon.tech/functions/hello`;

		// The changes table never carries a Details column or the raw details blob.
		const [appliedSection, functionSection = ""] =
			out.split("Function URLs");
		expect(appliedSection).toContain("Applied changes");
		expect(appliedSection).not.toContain("Details");
		expect(appliedSection).not.toContain('{"slug"');
		expect(appliedSection).not.toContain(invocationUrl);

		// The URL is listed (not tabulated) below, as a copy-pasteable bullet.
		expect(functionSection).toContain(`• hello: ${invocationUrl}`);

		// No rendered line is absurdly wide. Pre-fix the function detail row was ~190 cols;
		// a 120-col ceiling fails loudly if a long value ever leaks back into a table cell.
		const widest = Math.max(...out.split("\n").map((line) => line.length));
		expect(widest).toBeLessThan(120);
	});

	it("reports the services a policy utilizes (Postgres always on) in the plan output", async () => {
		const api = new FakeNeonApi();
		const { stream, read } = captureOut();
		const config = writeConfig(
			"export default { auth: {}, dataApi: true, preview: { aiGateway: true, buckets: { uploads: {} } } };\n",
		);

		await planCmd({ ...baseProps(api, stream), config });

		const result = JSON.parse(read());
		// Postgres is always first; each declared service follows in a stable order. The AI
		// Gateway is listed even though it never produces a plan step (it's credential-gated).
		expect(result.services).toEqual([
			"Postgres",
			"Neon Auth",
			"Data API",
			"Object Storage",
			"AI Gateway",
		]);
	});

	it('prints a "Utilized services" summary below the plan table (human output)', async () => {
		const api = new FakeNeonApi();
		const { stream, read } = captureOut();
		const config = writeConfig(
			"export default { auth: {}, preview: { aiGateway: true } };\n",
		);

		await planCmd({ ...baseProps(api, stream), output: "table", config });

		const out = read();
		expect(out).toContain("Planned changes");
		expect(out).toContain(
			"Utilized services: Postgres, Neon Auth, AI Gateway",
		);
	});

	it("still lists utilized services when the branch already matches (no changes)", async () => {
		const api = new FakeNeonApi();
		const { stream, read } = captureOut();
		// Empty policy: nothing to apply, so the plan table is empty — but the summary still
		// shows Postgres so the command never looks like it did nothing meaningful.
		const config = writeConfig("export default {};\n");

		await applyCmd({ ...baseProps(api, stream), output: "table", config });

		expect(read()).toContain("Utilized services: Postgres");
	});

	it("pulls the branch env into a local .env after a successful apply (like link/checkout)", async () => {
		const api = new FakeNeonApi();
		const { stream } = captureOut();
		// Empty policy: apply provisions nothing, but the bundled env pull still writes the
		// branch's connection strings to a local .env so the branch is usable for local dev.
		const config = writeConfig("export default {};\n");

		await applyCmd({
			...baseProps(api, stream),
			output: "table",
			config,
			cwd,
			envPull: true,
		});

		const envPath = join(cwd, ".env.local");
		expect(existsSync(envPath)).toBe(true);
		expect(readFileSync(envPath, "utf8")).toContain("DATABASE_URL=");
	});

	it("skips the env pull after apply when --no-env-pull is set", async () => {
		const api = new FakeNeonApi();
		const { stream } = captureOut();
		const config = writeConfig("export default {};\n");

		await applyCmd({
			...baseProps(api, stream),
			output: "table",
			config,
			cwd,
			envPull: false,
		});

		// Nothing written: --no-env-pull leaves the working tree untouched.
		expect(existsSync(join(cwd, ".env.local"))).toBe(false);
		expect(existsSync(join(cwd, ".env"))).toBe(false);
	});
});

describe("applyPolicyOnCreate", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "neonctl-create-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("applies the neon.ts policy to the new branch when one is present", async () => {
		const api = new FakeNeonApi();
		writeFileSync(join(cwd, "neon.ts"), "export default { auth: {} };\n");

		await applyPolicyOnCreate({
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			runtimeApi: api,
			cwd,
		});

		expect(api.enableNeonAuthCalls).toHaveLength(1);
	});

	it("is a no-op when there is no neon.ts on the path", async () => {
		const api = new FakeNeonApi();

		await applyPolicyOnCreate({
			projectId: PROJECT_ID,
			branchId: BRANCH_ID,
			runtimeApi: api,
			cwd, // empty temp dir, no neon.ts
		});

		expect(api.enableNeonAuthCalls).toHaveLength(0);
	});
});

const NEW_BRANCH_ID = "br-fresh-dawn-98765";
const NEW_BRANCH_NAME = "feature-policy";

/** Tunes compute only on a *new* branch — the "configure new branches" policy shape. */
const NEW_BRANCH_POLICY =
	"export default { branch: (branch) => (branch.exists ? {} : " +
	"{ postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } } }) };\n";

/** What Neon rejects a plan-gated compute setting with (seen live on a Free-plan project). */
const SUSPEND_REJECTED =
	'HTTP 412. Neon API said: "modifying the suspend interval is not permitted on this account".';

const newBranchEndpoint = (): NeonEndpointSnapshot => ({
	id: "ep-fresh-1",
	branchId: NEW_BRANCH_ID,
	type: "read_write",
	autoscalingLimitMinCu: 0.25,
	autoscalingLimitMaxCu: 0.25,
	suspendTimeout: "5m",
});

/**
 * Branch creation succeeds and the new branch comes up on the project's default compute, so a
 * policy that tunes compute has something to change. Records the compute updates so a test can
 * tell "the policy was applied" apart from "nothing happened".
 */
class CreateBranchNeonApi extends FakeNeonApi {
	readonly updateEndpointCalls: {
		endpointId: string;
		settings: ComputeSettings;
	}[] = [];
	/** The branch `createBranch` made, so subsequent listings see it like Neon would. */
	private created: NeonBranchSnapshot | undefined;

	override async listBranches(
		projectId: string,
	): Promise<NeonBranchSnapshot[]> {
		const branches = await super.listBranches(projectId);
		return this.created ? [...branches, this.created] : branches;
	}

	override async createBranch(
		projectId: string,
		input: CreateBranchInput,
	): Promise<{
		branch: NeonBranchSnapshot;
		endpoints: NeonEndpointSnapshot[];
	}> {
		void projectId;
		this.created = {
			id: NEW_BRANCH_ID,
			name: input.name,
			isDefault: false,
			protected: false,
			parentId: input.parentId,
		};
		return { branch: this.created, endpoints: [newBranchEndpoint()] };
	}

	override async listEndpoints(
		projectId: string,
	): Promise<NeonEndpointSnapshot[]> {
		return [...(await super.listEndpoints(projectId)), newBranchEndpoint()];
	}

	override async updateEndpoint(
		projectId: string,
		endpointId: string,
		settings: ComputeSettings,
	): Promise<NeonEndpointSnapshot> {
		void projectId;
		this.updateEndpointCalls.push({ endpointId, settings });
		return newBranchEndpoint();
	}
}

/** Creation succeeds, then Neon rejects the policy's compute setting. */
class CreateBranchThenRejectNeonApi extends CreateBranchNeonApi {
	override async updateEndpoint(): Promise<NeonEndpointSnapshot> {
		throw new Error(SUSPEND_REJECTED);
	}
}

describe("createBranchFromPolicyOnCheckout", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "neonctl-create-policy-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("creates the branch from the policy and applies its settings", async () => {
		const api = new CreateBranchNeonApi();
		writeFileSync(join(cwd, "neon.ts"), NEW_BRANCH_POLICY);

		const created = await createBranchFromPolicyOnCheckout({
			projectId: PROJECT_ID,
			branchName: NEW_BRANCH_NAME,
			runtimeApi: api,
			cwd,
		});

		expect(created).toEqual({ branchId: NEW_BRANCH_ID });
		expect(api.updateEndpointCalls).toEqual([
			{
				endpointId: "ep-fresh-1",
				settings: { autoscalingLimitMaxCu: 2 },
			},
		]);
	});

	it("returns the created branch id and the reason when applying the policy fails", async () => {
		// The branch is created before its settings are pushed, so a rejected setting leaves a
		// real branch behind. It must come back to the caller (checkout pins it) rather than
		// being lost with the thrown error.
		const api = new CreateBranchThenRejectNeonApi();
		writeFileSync(join(cwd, "neon.ts"), NEW_BRANCH_POLICY);

		const created = await createBranchFromPolicyOnCheckout({
			projectId: PROJECT_ID,
			branchName: NEW_BRANCH_NAME,
			runtimeApi: api,
			cwd,
		});

		expect(created?.branchId).toBe(NEW_BRANCH_ID);
		expect(created?.policyFailure).toContain("suspend interval");
	});

	it("returns null when there is no neon.ts on the path", async () => {
		const created = await createBranchFromPolicyOnCheckout({
			projectId: PROJECT_ID,
			branchName: NEW_BRANCH_NAME,
			runtimeApi: new CreateBranchNeonApi(),
			cwd, // empty temp dir, no neon.ts
		});

		expect(created).toBeNull();
	});
});
