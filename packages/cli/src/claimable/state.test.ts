import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearAuthContext, setAuthContext } from "../auth_context.js";
import {
	assertionHasExpired,
	claimableApiHost,
	claimableCredentialsPath,
	isClaimableEnvTarget,
	listClaimableCredentials,
	readClaimableCredentials,
	readLinkedClaimableCredentials,
	removeClaimableCredentials,
	shouldUseClaimableCredentials,
	writeClaimableCredentials,
} from "./state.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): string => {
	const directory = mkdtempSync(join(tmpdir(), "neon-claimable-state-"));
	temporaryDirectories.push(directory);
	return directory;
};

afterEach(() => {
	clearAuthContext();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

const credentials = {
	version: 1,
	origin: "https://claimable.neon.tech",
	registrationId: "reg_test",
	projectId: "project-test",
	branchId: "br-test",
	identityAssertion: "signed-identity-assertion",
	expiresAt: "2026-08-14T12:00:00.000Z",
} as const;

describe("claimable credentials", () => {
	it("creates the config directory when it does not exist", () => {
		const configDir = join(temporaryDirectory(), "missing", "neon");

		writeClaimableCredentials(configDir, credentials);

		expect(
			readClaimableCredentials(configDir, credentials.projectId),
		).toEqual(credentials);
	});

	it("writes an owner-only secret file and reads it back", () => {
		const configDir = temporaryDirectory();

		writeClaimableCredentials(configDir, credentials);

		const path = claimableCredentialsPath(configDir, credentials.projectId);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(
			readClaimableCredentials(configDir, credentials.projectId),
		).toEqual(credentials);
	});

	it("repairs permissive file permissions on replacement", () => {
		const configDir = temporaryDirectory();
		writeClaimableCredentials(configDir, credentials);
		const path = claimableCredentialsPath(configDir, credentials.projectId);
		chmodSync(path, 0o644);

		writeClaimableCredentials(configDir, credentials);

		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).not.toContain("undefined");
	});

	it("lists and removes only Claimable Neon credential files", () => {
		const configDir = temporaryDirectory();
		writeClaimableCredentials(configDir, credentials);
		writeClaimableCredentials(configDir, {
			...credentials,
			projectId: "another-project",
		});

		expect(
			listClaimableCredentials(configDir).map((item) => item.projectId),
		).toEqual(["another-project", "project-test"]);

		removeClaimableCredentials(configDir, "project-test");
		expect(readClaimableCredentials(configDir, "project-test")).toBeNull();
		expect(listClaimableCredentials(configDir)).toHaveLength(1);
	});

	it("rejects project ids that could escape the config directory", () => {
		const configDir = temporaryDirectory();

		expect(() =>
			claimableCredentialsPath(configDir, "../credentials"),
		).toThrow("Invalid Claimable Neon project ID");
	});

	it("reads credentials that omit assertionExpires", () => {
		const configDir = temporaryDirectory();
		writeClaimableCredentials(configDir, credentials);

		expect(
			assertionHasExpired(
				readClaimableCredentials(configDir, credentials.projectId) ??
					credentials,
			),
		).toBe(false);
	});

	it("treats a stored assertionExpires in the past as expired", () => {
		expect(
			assertionHasExpired(
				{ ...credentials, assertionExpires: 1 },
				1_700_000_000_000,
			),
		).toBe(true);
		expect(
			assertionHasExpired(
				{ ...credentials, assertionExpires: 2_000_000_000 },
				1_700_000_000_000,
			),
		).toBe(false);
	});

	it("rejects a stored assertionExpires that is not a unix timestamp", () => {
		const configDir = temporaryDirectory();
		writeClaimableCredentials(configDir, {
			...credentials,
			assertionExpires: 1_800_000_000,
		});
		const path = claimableCredentialsPath(configDir, credentials.projectId);
		writeFileSync(
			path,
			JSON.stringify({ ...credentials, assertionExpires: 0 }),
		);

		expect(() =>
			readClaimableCredentials(configDir, credentials.projectId),
		).toThrow("valid Claimable Neon credential");
	});
});

describe("claimable context", () => {
	it("reads the assertion file for a linked project id", () => {
		const configDir = temporaryDirectory();
		writeClaimableCredentials(configDir, credentials);

		expect(
			readLinkedClaimableCredentials(configDir, {
				projectId: credentials.projectId,
				branch: "br-test",
			}),
		).toEqual(credentials);
	});

	it("returns null for an ordinary Neon context", () => {
		expect(
			readLinkedClaimableCredentials(temporaryDirectory(), {
				orgId: "org-test",
				projectId: "project-test",
				branch: "main",
			}),
		).toBeNull();
	});

	it("returns null for a project id that could not have an assertion file", () => {
		expect(
			readLinkedClaimableCredentials(temporaryDirectory(), {
				projectId: "new-project id",
			}),
		).toBeNull();
	});

	it("ignores leftover claimable fields in .neon and uses the credential file origin", () => {
		const root = temporaryDirectory();
		const configDir = join(root, "config");
		const contextFile = join(root, ".neon");
		writeClaimableCredentials(configDir, credentials);
		const leftover = {
			projectId: credentials.projectId,
			branch: "br-test",
			claimable: {
				version: 2,
				origin: "https://other.example",
			},
		};
		writeFileSync(contextFile, JSON.stringify(leftover));
		const before = readFileSync(contextFile, "utf8");

		expect(
			shouldUseClaimableCredentials(
				{
					apiKeyFlag: "",
					apiKeyEnv: "",
					profileEnv: "",
					profileFlag: "",
					configDir,
				},
				undefined,
				{ projectId: credentials.projectId, branch: "br-test" },
				configDir,
			),
		).toBe(true);
		expect(
			isClaimableEnvTarget({
				apiHost: claimableApiHost(credentials.origin),
				contextFile,
				configDir,
			}),
		).toBe(true);
		expect(
			isClaimableEnvTarget({
				apiHost: claimableApiHost("https://other.example"),
				contextFile,
				configDir,
			}),
		).toBe(false);
		expect(readFileSync(contextFile, "utf8")).toBe(before);
	});

	it("does not select Claimable auth from a leftover marker without a credential file", () => {
		const root = temporaryDirectory();
		const configDir = join(root, "config");
		const contextFile = join(root, ".neon");
		writeFileSync(
			contextFile,
			JSON.stringify({
				projectId: credentials.projectId,
				claimable: { version: 1, origin: credentials.origin },
			}),
		);
		const before = readFileSync(contextFile, "utf8");

		expect(
			shouldUseClaimableCredentials(
				{
					apiKeyFlag: "",
					apiKeyEnv: "",
					profileEnv: "",
					profileFlag: "",
					configDir,
				},
				undefined,
				{ projectId: credentials.projectId },
				configDir,
			),
		).toBe(false);
		expect(
			isClaimableEnvTarget({
				apiHost: claimableApiHost(credentials.origin),
				contextFile,
				configDir,
			}),
		).toBe(false);
		expect(readFileSync(contextFile, "utf8")).toBe(before);
	});
});

describe("claimable credential selection", () => {
	const noInputs = {
		apiKeyFlag: "",
		apiKeyEnv: "",
		profileEnv: "",
		profileFlag: "",
		configDir: "",
	};

	it("uses the linked claimable project when no account credential was selected", () => {
		const configDir = temporaryDirectory();
		writeClaimableCredentials(configDir, credentials);

		expect(
			shouldUseClaimableCredentials(
				noInputs,
				undefined,
				{ projectId: credentials.projectId },
				configDir,
			),
		).toBe(true);
	});

	it("lets every explicit or ambient account selection override the credential file", () => {
		const configDir = temporaryDirectory();
		writeClaimableCredentials(configDir, credentials);
		const context = { projectId: credentials.projectId };

		expect(
			shouldUseClaimableCredentials(
				{ ...noInputs, apiKeyFlag: "napi_explicit" },
				undefined,
				context,
				configDir,
			),
		).toBe(false);
		expect(
			shouldUseClaimableCredentials(
				{ ...noInputs, apiKeyEnv: "napi_ambient" },
				undefined,
				context,
				configDir,
			),
		).toBe(false);
		expect(
			shouldUseClaimableCredentials(
				{ ...noInputs, profileEnv: "work" },
				undefined,
				context,
				configDir,
			),
		).toBe(false);
		expect(
			shouldUseClaimableCredentials(noInputs, "work", context, configDir),
		).toBe(false);
	});
});

describe("claimable env target", () => {
	it("matches a credential file only when the API host is that origin's /v1", () => {
		const root = temporaryDirectory();
		const configDir = join(root, "config");
		const contextFile = join(root, ".neon");
		writeClaimableCredentials(configDir, credentials);
		writeFileSync(
			contextFile,
			JSON.stringify({ projectId: credentials.projectId }),
		);
		expect(
			isClaimableEnvTarget({
				apiHost: claimableApiHost(credentials.origin),
				contextFile,
				configDir,
			}),
		).toBe(true);
		expect(
			isClaimableEnvTarget({
				apiHost: "https://console.neon.tech/api/v2",
				contextFile,
				configDir,
			}),
		).toBe(false);
	});

	it("treats a claimable auth source as claimable even without a credential file", () => {
		setAuthContext({ source: "claimable", configDir: "/tmp" });
		expect(
			isClaimableEnvTarget({
				apiHost: "https://console.neon.tech/api/v2",
				contextFile: join(temporaryDirectory(), "missing.neon"),
				configDir: "",
			}),
		).toBe(true);
	});
});
