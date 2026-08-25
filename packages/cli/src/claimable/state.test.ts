import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	claimableCredentialsPath,
	listClaimableCredentials,
	readClaimableCredentials,
	removeClaimableCredentials,
	resolveClaimableContext,
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
});

describe("claimable context", () => {
	it("resolves a versioned marker with a matching project", () => {
		expect(
			resolveClaimableContext({
				projectId: "project-test",
				branch: "br-test",
				claimable: {
					version: 1,
					origin: "https://claimable.neon.tech",
				},
			}),
		).toEqual({
			projectId: "project-test",
			branch: "br-test",
			origin: "https://claimable.neon.tech",
		});
	});

	it("returns null for an ordinary Neon context", () => {
		expect(
			resolveClaimableContext({
				orgId: "org-test",
				projectId: "project-test",
				branch: "main",
			}),
		).toBeNull();
	});

	it("refuses a malformed marker rather than falling back to account auth", () => {
		expect(() =>
			resolveClaimableContext(
				JSON.parse(
					'{"projectId":"project-test","claimable":{"version":2,"origin":"https://claimable.neon.tech"}}',
				),
			),
		).toThrow("Unsupported Claimable Neon context version");
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
		expect(
			shouldUseClaimableCredentials(noInputs, undefined, {
				projectId: "project-test",
				claimable: {
					version: 1,
					origin: "https://claimable.neon.tech",
				},
			}),
		).toBe(true);
	});

	it("lets every explicit or ambient account selection override the local marker", () => {
		const context = {
			projectId: "project-test",
			claimable: {
				version: 1,
				origin: "https://claimable.neon.tech",
			},
		} as const;

		expect(
			shouldUseClaimableCredentials(
				{ ...noInputs, apiKeyFlag: "napi_explicit" },
				undefined,
				context,
			),
		).toBe(false);
		expect(
			shouldUseClaimableCredentials(
				{ ...noInputs, apiKeyEnv: "napi_ambient" },
				undefined,
				context,
			),
		).toBe(false);
		expect(
			shouldUseClaimableCredentials(
				{ ...noInputs, profileEnv: "work" },
				undefined,
				context,
			),
		).toBe(false);
		expect(shouldUseClaimableCredentials(noInputs, "work", context)).toBe(
			false,
		);
	});
});
