import {
	DEFAULT_AI_GATEWAY_CREDENTIAL_NAME,
	DEFAULT_OBJECT_STORAGE_CREDENTIAL_NAME,
	defineConfig,
} from "@neon/config/v1";
import { fetchEnvReusingSecrets } from "@neon-internals/env-core/reuse-secrets";
import { beforeEach, describe, expect, test } from "vitest";
import { FakeNeonApi } from "./fake-neon-api.js";
import { stubCleanNeonEnv } from "./test-utils.js";

beforeEach(() => stubCleanNeonEnv());

function seededFake() {
	const api = new FakeNeonApi();
	const projectId = "proj-env";
	api.seedProject({
		project: {
			id: projectId,
			name: "env-test",
			regionId: "aws-us-east-1",
			pgVersion: 17,
		},
		branches: [
			{ branch: { id: "br-main", name: "main", isDefault: true } },
		],
	});
	return { api, projectId };
}

function mintFallbackFake() {
	const seeded = seededFake();
	seeded.api.clearBranchCredentials(seeded.projectId, "br-main");
	return seeded;
}

const callsTo = (api: FakeNeonApi, method: string) =>
	api.history.filter((h) => h.method === method).length;

const storagePolicy = defineConfig({ preview: { buckets: { uploads: {} } } });
const gatewayPolicy = defineConfig({ preview: { aiGateway: true } });
const bothPolicy = defineConfig({
	preview: { buckets: { uploads: {} }, aiGateway: true },
});

describe("fetchEnvReusingSecrets", () => {
	test("replaces a .env.example placeholder with a real credential", async () => {
		const { api, projectId } = seededFake();

		const { vars, credential } = await fetchEnvReusingSecrets(
			gatewayPolicy,
			{
				api,
				projectId,
				branch: "main",
				env: { NEON_AI_GATEWAY_TOKEN: "nt_live_..." },
			},
		);

		expect(vars.NEON_AI_GATEWAY_TOKEN).not.toBe("nt_live_...");
		expect(vars.NEON_AI_GATEWAY_TOKEN).toMatch(/^nt_live_\w+_/);
		expect(callsTo(api, "createCredential")).toBe(0);
		expect(callsTo(api, "revealCredential")).toBe(1);
		expect(credential).toEqual({
			issued: true,
			keys: ["NEON_AI_GATEWAY_TOKEN"],
			revoked: [],
			superseded: [],
		});
	});

	test("keeps a credential that is still live and sufficiently scoped", async () => {
		const { api, projectId } = seededFake();
		const first = await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
		});

		const second = await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
			env: { ...process.env, ...first.vars },
		});

		expect(callsTo(api, "createCredential")).toBe(0);
		expect(callsTo(api, "revealCredential")).toBe(1);
		expect(callsTo(api, "revokeCredential")).toBe(0);
		expect(second.vars.AWS_ACCESS_KEY_ID).toBe(
			first.vars.AWS_ACCESS_KEY_ID,
		);
		expect(second.vars.AWS_SECRET_ACCESS_KEY).toBe(
			first.vars.AWS_SECRET_ACCESS_KEY,
		);
		expect(second.credential).toEqual({
			issued: false,
			keys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
			revoked: [],
			superseded: [],
		});
		expect(second.vars.AWS_ENDPOINT_URL_S3).toBe(
			first.vars.AWS_ENDPOINT_URL_S3,
		);
	});

	test("replaces a credential revoked out from under the env source", async () => {
		const { api, projectId } = seededFake();
		const first = await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
		});
		const tokenId = first.vars.AWS_ACCESS_KEY_ID as string;
		await api.revokeCredential(projectId, "br-main", tokenId);

		const second = await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
			env: { ...process.env, ...first.vars },
		});

		expect(second.vars.AWS_ACCESS_KEY_ID).not.toBe(tokenId);
		expect(second.credential.issued).toBe(true);
		expect(second.credential.revoked).toEqual([]);
		expect(callsTo(api, "createCredential")).toBe(1);
	});

	test("reveals the gateway default when the branch gains a feature, without revoking storage", async () => {
		const { api, projectId } = seededFake();
		const storageOnly = await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
		});

		const widened = await fetchEnvReusingSecrets(bothPolicy, {
			api,
			projectId,
			branch: "main",
			env: { ...process.env, ...storageOnly.vars },
		});

		expect(callsTo(api, "createCredential")).toBe(0);
		expect(widened.vars.AWS_ACCESS_KEY_ID).toBe(
			storageOnly.vars.AWS_ACCESS_KEY_ID,
		);
		expect(widened.vars.NEON_AI_GATEWAY_TOKEN).toMatch(/^nt_live_/);
		expect(widened.credential).toEqual({
			issued: true,
			keys: [
				"AWS_ACCESS_KEY_ID",
				"AWS_SECRET_ACCESS_KEY",
				"NEON_AI_GATEWAY_TOKEN",
			],
			revoked: [],
			superseded: [],
		});
		const live = await api.listCredentials(projectId, "br-main");
		expect(live.map((c) => c.name).sort()).toEqual([
			DEFAULT_AI_GATEWAY_CREDENTIAL_NAME,
			DEFAULT_OBJECT_STORAGE_CREDENTIAL_NAME,
		]);
	});

	test("does not revoke the storage default when the branch switches to gateway-only", async () => {
		const { api, projectId } = seededFake();
		const storageOnly = await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
		});

		const gatewayOnly = await fetchEnvReusingSecrets(gatewayPolicy, {
			api,
			projectId,
			branch: "main",
			env: { ...process.env, ...storageOnly.vars },
		});

		expect(gatewayOnly.credential).toEqual({
			issued: true,
			keys: ["NEON_AI_GATEWAY_TOKEN"],
			revoked: [],
			superseded: [],
		});
		const live = await api.listCredentials(projectId, "br-main");
		expect(
			live.find((c) => c.name === DEFAULT_OBJECT_STORAGE_CREDENTIAL_NAME),
		).toBeDefined();
		expect(
			live.find((c) => c.name === DEFAULT_AI_GATEWAY_CREDENTIAL_NAME)
				?.scopes,
		).toEqual(["ai_gateway:invoke"]);
	});

	test("re-reveals a default when only one secret half is persisted", async () => {
		const { api, projectId } = seededFake();
		const both = await fetchEnvReusingSecrets(bothPolicy, {
			api,
			projectId,
			branch: "main",
		});

		const storageOnly = await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
			env: { AWS_ACCESS_KEY_ID: both.vars.AWS_ACCESS_KEY_ID },
			revokeSuperseded: false,
		});

		expect(storageOnly.credential.issued).toBe(true);
		expect(storageOnly.credential.revoked).toEqual([]);
		expect(storageOnly.credential.superseded).toEqual([]);
		expect(callsTo(api, "revokeCredential")).toBe(0);
		expect(storageOnly.vars.AWS_ACCESS_KEY_ID).toBe(
			both.vars.AWS_ACCESS_KEY_ID,
		);
	});

	test("never revokes a credential this tool did not issue", async () => {
		const { api, projectId } = seededFake();
		const foreign = await api.createCredential(projectId, "br-main", {
			scopes: ["storage:read"],
			principalType: "user",
			name: "minted-by-hand",
		});

		const result = await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
			env: {
				AWS_ACCESS_KEY_ID: foreign.tokenId,
				AWS_SECRET_ACCESS_KEY: foreign.s3SecretAccessKey,
			},
		});

		expect(result.credential.issued).toBe(true);
		expect(result.credential.revoked).toEqual([]);
		expect(result.credential.superseded).toEqual([]);
		expect(callsTo(api, "revokeCredential")).toBe(0);
		expect(callsTo(api, "createCredential")).toBe(1);
		expect(result.vars.AWS_ACCESS_KEY_ID).not.toBe(foreign.tokenId);
		const live = await api.listCredentials(projectId, "br-main");
		expect(live.map((c) => c.tokenId)).toContain(foreign.tokenId);
	});

	test("keeps storage and gateway halves that name their respective defaults", async () => {
		const { api, projectId } = seededFake();
		const a = await fetchEnvReusingSecrets(bothPolicy, {
			api,
			projectId,
			branch: "main",
		});
		const mixed = await fetchEnvReusingSecrets(bothPolicy, {
			api,
			projectId,
			branch: "main",
			env: {
				AWS_ACCESS_KEY_ID: a.vars.AWS_ACCESS_KEY_ID,
				AWS_SECRET_ACCESS_KEY: a.vars.AWS_SECRET_ACCESS_KEY,
				NEON_AI_GATEWAY_TOKEN: a.vars.NEON_AI_GATEWAY_TOKEN,
			},
		});

		expect(callsTo(api, "createCredential")).toBe(0);
		expect(mixed.vars.AWS_ACCESS_KEY_ID).toBe(a.vars.AWS_ACCESS_KEY_ID);
		expect(mixed.vars.NEON_AI_GATEWAY_TOKEN).toBe(
			a.vars.NEON_AI_GATEWAY_TOKEN,
		);
		expect(mixed.credential.issued).toBe(false);
		expect(a.vars.AWS_ACCESS_KEY_ID).not.toBe(
			// The two defaults are distinct credentials.
			a.vars.NEON_AI_GATEWAY_TOKEN.match(/^nt_live_([^_]+)_/)?.[1],
		);
	});

	test("touches no credential endpoint when the policy enables neither feature", async () => {
		const { api, projectId } = seededFake();

		const { vars, credential } = await fetchEnvReusingSecrets(
			defineConfig({}),
			{ api, projectId, branch: "main" },
		);

		expect(callsTo(api, "listCredentials")).toBe(0);
		expect(callsTo(api, "createCredential")).toBe(0);
		expect(callsTo(api, "revealCredential")).toBe(0);
		expect(credential).toEqual({
			issued: false,
			keys: [],
			revoked: [],
			superseded: [],
		});
		expect(vars.DATABASE_URL).toContain("postgresql://");
		expect(vars.NEON_BRANCH).toBe("main");
	});

	test("reveals and reuses only the selected gateway secret", async () => {
		const { api, projectId } = seededFake();
		const first = await fetchEnvReusingSecrets(bothPolicy, {
			api,
			projectId,
			branch: "main",
			keys: ["NEON_AI_GATEWAY_TOKEN"],
		});

		expect(Object.keys(first.vars)).toEqual(["NEON_AI_GATEWAY_TOKEN"]);
		expect(first.vars.NEON_AI_GATEWAY_TOKEN).toMatch(/^nt_live_/);
		expect(callsTo(api, "createCredential")).toBe(0);
		expect(callsTo(api, "revealCredential")).toBe(1);

		const second = await fetchEnvReusingSecrets(bothPolicy, {
			api,
			projectId,
			branch: "main",
			keys: ["NEON_AI_GATEWAY_TOKEN"],
			env: { ...process.env, ...first.vars },
		});

		expect(callsTo(api, "revealCredential")).toBe(1);
		expect(second.vars).toEqual(first.vars);
		expect(second.credential).toEqual({
			issued: false,
			keys: ["NEON_AI_GATEWAY_TOKEN"],
			revoked: [],
			superseded: [],
		});
	});

	test("reports but does not revoke a leftover neon-env credential on a partial pull", async () => {
		const { api, projectId } = seededFake();
		const storageOnly = await api.createCredential(projectId, "br-main", {
			scopes: ["storage:read", "storage:write"],
			principalType: "user",
			name: "neon-env main",
		});

		const result = await fetchEnvReusingSecrets(bothPolicy, {
			api,
			projectId,
			branch: "main",
			keys: ["NEON_AI_GATEWAY_TOKEN"],
			env: { NEON_AI_GATEWAY_TOKEN: storageOnly.apiToken },
			revokeSuperseded: false,
		});

		expect(result.credential).toEqual({
			issued: true,
			keys: ["NEON_AI_GATEWAY_TOKEN"],
			revoked: [],
			superseded: [storageOnly.tokenId],
		});
		expect(callsTo(api, "revokeCredential")).toBe(0);
	});

	test("does not mint a credential when only a non-secret gateway variable is selected", async () => {
		const { api, projectId } = seededFake();

		const { vars, credential } = await fetchEnvReusingSecrets(
			gatewayPolicy,
			{
				api,
				projectId,
				branch: "main",
				keys: ["NEON_AI_GATEWAY_BASE_URL"],
			},
		);

		expect(vars).toEqual({
			NEON_AI_GATEWAY_BASE_URL:
				"https://br-main-api.ai.aws-us-east-1.fake.neon.tech",
		});
		expect(callsTo(api, "listCredentials")).toBe(0);
		expect(callsTo(api, "createCredential")).toBe(0);
		expect(callsTo(api, "revealCredential")).toBe(0);
		expect(credential).toEqual({
			issued: false,
			keys: [],
			revoked: [],
			superseded: [],
		});
	});

	test("does not widen a credential for a selected non-secret variable", async () => {
		const { api, projectId } = seededFake();

		await fetchEnvReusingSecrets(bothPolicy, {
			api,
			projectId,
			branch: "main",
			keys: [
				"AWS_ACCESS_KEY_ID",
				"AWS_SECRET_ACCESS_KEY",
				"NEON_AI_GATEWAY_BASE_URL",
			],
		});

		expect(callsTo(api, "createCredential")).toBe(0);
		expect(callsTo(api, "revealCredential")).toBe(1);
	});

	test("lists defaults on a first run rather than minting", async () => {
		const { api, projectId } = seededFake();

		await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
		});

		expect(callsTo(api, "listCredentials")).toBe(1);
		expect(callsTo(api, "revealCredential")).toBe(1);
		expect(callsTo(api, "createCredential")).toBe(0);
	});

	test("revokes a leftover neon-env mint once defaults exist", async () => {
		const { api, projectId } = mintFallbackFake();
		const minted = await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
		});
		expect(callsTo(api, "createCredential")).toBe(1);

		const storageDefault = await api.createCredential(
			projectId,
			"br-main",
			{
				name: DEFAULT_OBJECT_STORAGE_CREDENTIAL_NAME,
				scopes: ["storage:read", "storage:write"],
				principalType: "user",
			},
		);

		const migrated = await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
			env: { ...process.env, ...minted.vars },
		});

		expect(migrated.vars.AWS_ACCESS_KEY_ID).toBe(storageDefault.tokenId);
		expect(migrated.credential.revoked).toEqual([
			minted.vars.AWS_ACCESS_KEY_ID,
		]);
		const live = await api.listCredentials(projectId, "br-main");
		expect(
			live.find((c) => c.tokenId === minted.vars.AWS_ACCESS_KEY_ID),
		).toBeUndefined();
	});

	test("mints when the branch has no platform defaults", async () => {
		const { api, projectId } = mintFallbackFake();
		const first = await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
		});
		expect(callsTo(api, "createCredential")).toBe(1);
		expect(first.credential.issued).toBe(true);

		const second = await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
			env: { ...process.env, ...first.vars },
		});
		expect(callsTo(api, "createCredential")).toBe(1);
		expect(second.credential.issued).toBe(false);
	});

	test("keeps a persisted Auth base URL the integration can no longer report", async () => {
		const { api, projectId } = seededFake();
		api.seedNeonAuth(projectId, "br-main", {
			projectId: "auth-br-main",
			jwksUrl: "https://example.com/jwks.json",
		});

		const { vars } = await fetchEnvReusingSecrets(
			defineConfig({ auth: true }),
			{
				api,
				projectId,
				branch: "main",
				env: { NEON_AUTH_BASE_URL: "https://auth.example.com" },
			},
		);

		expect(vars.NEON_AUTH_BASE_URL).toBe("https://auth.example.com");
		expect(vars.NEON_AUTH_JWKS_URL).toBe("https://example.com/jwks.json");
	});

	test("unscoped all-live still emits function URLs when a credential is revealed", async () => {
		const listedUrl = "https://br-main-hello.compute.fake.neon.tech/";
		const helloUrl = "https://br-main-hello.compute.fake.neon.tech";
		const { api, projectId } = seededFake();
		api.seedFunction(projectId, "br-main", {
			id: "fn-hello",
			slug: "hello",
			name: "Hello",
			invocationUrl: listedUrl,
		});

		const { vars } = await fetchEnvReusingSecrets(gatewayPolicy, {
			api,
			projectId,
			branch: "main",
			functionUrls: "all-live",
		});

		expect(vars.NEON_FUNCTION_HELLO_BASE_URL).toBe(helloUrl);
		expect(vars.NEON_AI_GATEWAY_TOKEN).toMatch(/^nt_live_/);
		expect(callsTo(api, "createCredential")).toBe(0);
	});

	test("reusing a gateway token does not drop unscoped function URLs", async () => {
		const listedUrl = "https://br-main-hello.compute.fake.neon.tech/";
		const helloUrl = "https://br-main-hello.compute.fake.neon.tech";
		const { api, projectId } = seededFake();
		api.seedFunction(projectId, "br-main", {
			id: "fn-hello",
			slug: "hello",
			name: "Hello",
			invocationUrl: listedUrl,
		});

		const first = await fetchEnvReusingSecrets(gatewayPolicy, {
			api,
			projectId,
			branch: "main",
			functionUrls: "all-live",
		});
		const second = await fetchEnvReusingSecrets(gatewayPolicy, {
			api,
			projectId,
			branch: "main",
			functionUrls: "all-live",
			env: { ...process.env, ...first.vars },
		});

		expect(second.credential.issued).toBe(false);
		expect(second.vars.NEON_FUNCTION_HELLO_BASE_URL).toBe(helloUrl);
	});
});
