import { defineConfig } from "@neon/config/v1";
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

const callsTo = (api: FakeNeonApi, method: string) =>
	api.history.filter((h) => h.method === method).length;

const storagePolicy = defineConfig({ preview: { buckets: { uploads: {} } } });
const gatewayPolicy = defineConfig({ preview: { aiGateway: true } });
const bothPolicy = defineConfig({
	preview: { buckets: { uploads: {} }, aiGateway: true },
});

describe("fetchEnvReusingSecrets", () => {
	test("replaces a .env.example placeholder with a real credential", async () => {
		// The bug this exists for. `packages/ai-sdk-provider/.env.example` used to ship a
		// token-shaped placeholder; copying it to `.env` and pulling left it untouched, because
		// a presence check can't tell a placeholder from a secret. Anything that names no live
		// credential on this branch must be replaced, not carried through.
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
		expect(callsTo(api, "createCredential")).toBe(1);
		// The placeholder named no credential, so there was nothing of ours to revoke.
		expect(credential).toEqual({
			issued: true,
			keys: ["NEON_AI_GATEWAY_TOKEN"],
			revoked: [],
			superseded: [],
		});
	});

	test("keeps a credential that is still live and sufficiently scoped", async () => {
		// The everyday path: resolve, then resolve again. Verification must not turn into a
		// rotation on every call — that is the credential spam a bare `fetchEnv` would cause.
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

		expect(callsTo(api, "createCredential")).toBe(1); // not minted again
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
		// The non-secret storage vars are still refreshed from the branch — only the secrets
		// are carried through.
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
		// e.g. revoked in the console, or expired. The secrets are still there and still look
		// perfectly real — only the branch knows they're dead.
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
		// Already revoked, so it is not one of ours to revoke again.
		expect(second.credential.revoked).toEqual([]);
	});

	test("revokes the credential it replaces when the branch gains a feature", async () => {
		// Enabling the AI Gateway on a branch that already had storage widens the scopes the
		// credential needs, so the storage-only one has to be replaced. Its secrets lived only
		// in the env source being superseded, so leaving it live would strand a usable
		// credential on the branch — one per call, forever.
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

		expect(callsTo(api, "createCredential")).toBe(2);
		expect(widened.credential).toEqual({
			issued: true,
			keys: [
				"AWS_ACCESS_KEY_ID",
				"AWS_SECRET_ACCESS_KEY",
				"NEON_AI_GATEWAY_TOKEN",
			],
			revoked: [storageOnly.vars.AWS_ACCESS_KEY_ID],
			superseded: [],
		});
		// One credential in, one out — the branch does not accumulate.
		const live = await api.listCredentials(projectId, "br-main");
		expect(live).toHaveLength(1);
		expect(live[0]?.tokenId).toBe(widened.vars.AWS_ACCESS_KEY_ID);
	});

	test("revokes the credential it replaces when the branch switches features", async () => {
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
			revoked: [storageOnly.vars.AWS_ACCESS_KEY_ID],
			superseded: [],
		});
		const live = await api.listCredentials(projectId, "br-main");
		expect(live).toHaveLength(1);
		expect(live[0]?.scopes).toEqual(["ai_gateway:invoke"]);
	});

	test("keeps the superseded credential live when the caller resolves only part of the branch", async () => {
		// `revokeSuperseded: false` is for a caller resolving a subset — `neon env pull
		// --service`. Here the branch has both features on one credential, but the resolve
		// covers storage only: the replacement it mints does not carry the gateway scope, so
		// revoking the old one would kill a gateway token the caller is not rewriting.
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
			// A half-present secret, so the storage credential cannot be reused.
			env: { AWS_ACCESS_KEY_ID: both.vars.AWS_ACCESS_KEY_ID },
			revokeSuperseded: false,
		});

		expect(storageOnly.credential.issued).toBe(true);
		expect(storageOnly.credential.revoked).toEqual([]);
		// Reported rather than merely skipped, so a caller can name what it orphaned.
		expect(storageOnly.credential.superseded).toEqual([
			both.vars.AWS_ACCESS_KEY_ID,
		]);
		expect(callsTo(api, "revokeCredential")).toBe(0);
		// Both are live: the new storage credential, and the one still backing the gateway.
		const live = await api.listCredentials(projectId, "br-main");
		expect(live.map((c) => c.tokenId)).toEqual(
			expect.arrayContaining([
				both.vars.AWS_ACCESS_KEY_ID,
				storageOnly.vars.AWS_ACCESS_KEY_ID,
			]),
		);
	});

	test("never revokes a credential this tool did not issue", async () => {
		// A credential minted by something else (a deployed function, a teammate, the console)
		// can be kept if it fits, but must never be revoked: its secrets live somewhere we know
		// nothing about.
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
			// Scoped `storage:read` only, so the policy's `storage:write` forces a replacement.
			env: {
				AWS_ACCESS_KEY_ID: foreign.tokenId,
				AWS_SECRET_ACCESS_KEY: foreign.s3SecretAccessKey,
			},
		});

		expect(result.credential.issued).toBe(true);
		expect(result.credential.revoked).toEqual([]);
		// Not ours, so it was never superseded either — only declined.
		expect(result.credential.superseded).toEqual([]);
		expect(callsTo(api, "revokeCredential")).toBe(0);
		const live = await api.listCredentials(projectId, "br-main");
		expect(live.map((c) => c.tokenId)).toContain(foreign.tokenId);
	});

	test("re-mints when the storage and gateway halves name different credentials", async () => {
		// One credential backs both features, so halves stitched together from two different
		// calls are not a credential — neither half can be trusted.
		const { api, projectId } = seededFake();
		const a = await fetchEnvReusingSecrets(bothPolicy, {
			api,
			projectId,
			branch: "main",
		});
		const b = await fetchEnvReusingSecrets(bothPolicy, {
			api,
			projectId,
			branch: "main",
		});

		const mixed = await fetchEnvReusingSecrets(bothPolicy, {
			api,
			projectId,
			branch: "main",
			env: {
				...a.vars,
				NEON_AI_GATEWAY_TOKEN: b.vars.NEON_AI_GATEWAY_TOKEN,
			},
		});

		expect(callsTo(api, "createCredential")).toBe(3);
		expect(mixed.vars.AWS_ACCESS_KEY_ID).not.toBe(a.vars.AWS_ACCESS_KEY_ID);
		expect(mixed.vars.NEON_AI_GATEWAY_TOKEN).not.toBe(
			b.vars.NEON_AI_GATEWAY_TOKEN,
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
		expect(credential).toEqual({
			issued: false,
			keys: [],
			revoked: [],
			superseded: [],
		});
		expect(vars.DATABASE_URL).toContain("postgresql://");
		expect(vars.NEON_BRANCH).toBe("main");
	});

	test("mints and reuses only the selected gateway secret", async () => {
		const { api, projectId } = seededFake();
		const first = await fetchEnvReusingSecrets(bothPolicy, {
			api,
			projectId,
			branch: "main",
			keys: ["NEON_AI_GATEWAY_TOKEN"],
		});

		expect(Object.keys(first.vars)).toEqual(["NEON_AI_GATEWAY_TOKEN"]);
		expect(first.vars.NEON_AI_GATEWAY_TOKEN).toMatch(/^nt_live_/);
		const create = api.history.find(
			(entry) => entry.method === "createCredential",
		);
		expect(create?.args[2]).toMatchObject({
			scopes: ["ai_gateway:invoke"],
		});

		const second = await fetchEnvReusingSecrets(bothPolicy, {
			api,
			projectId,
			branch: "main",
			keys: ["NEON_AI_GATEWAY_TOKEN"],
			env: { ...process.env, ...first.vars },
		});

		expect(callsTo(api, "createCredential")).toBe(1);
		expect(second.vars).toEqual(first.vars);
		expect(second.credential).toEqual({
			issued: false,
			keys: ["NEON_AI_GATEWAY_TOKEN"],
			revoked: [],
			superseded: [],
		});
	});

	test("reports but does not revoke a credential replaced by an exact secret pull", async () => {
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

		const create = api.history.find(
			(entry) => entry.method === "createCredential",
		);
		expect(create?.args[2]).toMatchObject({
			scopes: ["storage:read", "storage:write"],
		});
	});

	test("does not look up credentials when nothing is persisted to verify", async () => {
		// A first run has nothing to check, so the list call would be wasted.
		const { api, projectId } = seededFake();

		await fetchEnvReusingSecrets(storagePolicy, {
			api,
			projectId,
			branch: "main",
		});

		expect(callsTo(api, "listCredentials")).toBe(0);
		expect(callsTo(api, "createCredential")).toBe(1);
	});

	test("keeps a persisted Auth base URL the integration can no longer report", async () => {
		// Integrations created before the API returned `base_url` answer with an empty string,
		// and the persisted copy is the only one left. An empty fetched value never carries more
		// information than a non-empty persisted one, so a resolve must not blank it.
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
		// jwks_url is always returned by the snapshot, so it comes from there.
		expect(vars.NEON_AUTH_JWKS_URL).toBe("https://example.com/jwks.json");
	});

	test("unscoped all-live still emits function URLs when a credential is minted", async () => {
		const helloUrl = "https://br-main-hello.compute.fake.neon.tech/";
		const { api, projectId } = seededFake();
		api.seedFunction(projectId, "br-main", {
			id: "fn-hello",
			slug: "hello",
			name: "Hello",
			invocationUrl: helloUrl,
		});

		const { vars } = await fetchEnvReusingSecrets(gatewayPolicy, {
			api,
			projectId,
			branch: "main",
			functionUrls: "all-live",
		});

		expect(vars.NEON_FUNCTION_HELLO_BASE_URL).toBe(helloUrl);
		expect(vars.NEON_AI_GATEWAY_TOKEN).toMatch(/^nt_live_/);
	});

	test("reusing a gateway token does not drop unscoped function URLs", async () => {
		const helloUrl = "https://br-main-hello.compute.fake.neon.tech/";
		const { api, projectId } = seededFake();
		api.seedFunction(projectId, "br-main", {
			id: "fn-hello",
			slug: "hello",
			name: "Hello",
			invocationUrl: helloUrl,
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
