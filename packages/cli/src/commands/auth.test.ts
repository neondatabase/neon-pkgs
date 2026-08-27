import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { recordCredentialInputs } from "@neon-internals/cli-core/auth_selection";
import {
	createCredentialStore,
	KEYRING_SERVICE,
	type KeyringBackend,
	KeyringUnavailableError,
	KeyringUnreadableError,
	keyringAccount,
} from "@neon-internals/cli-core/credential_store";
import * as profilesCore from "@neon-internals/cli-core/profiles";
import type { OAuth2Server } from "oauth2-mock-server";
import { join } from "path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	vi,
} from "vitest";
import type { NeonApiClient } from "../api.js";
import * as authModule from "../auth";
import * as credentialIo from "../credential_io.js";
import { log } from "../log.js";
import { test } from "../test_utils/fixtures";
import { startOauthServer } from "../test_utils/oauth_server";
import {
	authFlow,
	deleteCredentialsAt,
	ensureAuth,
	locationForAuth,
} from "./auth";

vi.mock("open", () => ({ default: vi.fn((url: string) => fetch(url)) }));
vi.mock("../pkg.ts", () => ({ default: { version: "0.0.0" } }));

// Neither suite names a credential explicitly, so an exported NEON_API_KEY or NEON_PROFILE in
// the shell running the tests would redirect them: the key would satisfy auth outright, and the
// profile would send `authFlow` to write `credentials.<name>.json` instead of `credentials.json`.
beforeEach(() => {
	vi.stubEnv("NEON_API_KEY", "");
	vi.stubEnv("NEON_PROFILE", "");
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe("auth", () => {
	let configDir = "";
	let oauthServer: OAuth2Server;

	beforeAll(async () => {
		configDir = mkdtempSync("test-config");
		oauthServer = await startOauthServer();
	});

	afterAll(async () => {
		rmSync(configDir, { recursive: true });
		await oauthServer.stop();
	});

	test("should auth", async ({ runMockServer }) => {
		const server = await runMockServer("main");
		await authFlow({
			_: ["auth"],
			apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
			clientId: "test-client-id",
			configDir,
			forceAuth: true,
			oauthHost: `http://localhost:${oauthServer.address().port}`,
			allowUnsafeTls: true,
		});

		const credentials = JSON.parse(
			readFileSync(`${configDir}/credentials.json`, "utf-8"),
		);
		expect(credentials.access_token).toEqual(expect.any(String));
		expect(credentials.refresh_token).toEqual(expect.any(String));
		expect(credentials.user_id).toEqual(expect.any(String));
	});

	test("refuses to open a browser when --keyring is set and unavailable", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		const authSpy = vi.spyOn(authModule, "auth");
		const storeSpy = vi
			.spyOn(credentialIo, "storeFor")
			.mockImplementation((dir: string) =>
				createCredentialStore(dir, { keyring: null }),
			);
		try {
			await expect(
				authFlow({
					_: ["auth"],
					apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
					clientId: "test-client-id",
					configDir,
					forceAuth: true,
					oauthHost: `http://localhost:${oauthServer.address().port}`,
					allowUnsafeTls: true,
					keyring: true,
				}),
			).rejects.toBeInstanceOf(KeyringUnavailableError);
			expect(authSpy).not.toHaveBeenCalled();
		} finally {
			authSpy.mockRestore();
			storeSpy.mockRestore();
		}
	});

	test("an existing keyring pointer without the addon says to remove, not to drop --keyring", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		writeFileSync(
			join(configDir, "profiles.json"),
			JSON.stringify({
				version: 1,
				profiles: { DEFAULT: { credentials: "keyring" } },
			}),
		);
		const authSpy = vi.spyOn(authModule, "auth");
		const storeSpy = vi
			.spyOn(credentialIo, "storeFor")
			.mockImplementation((dir: string) =>
				createCredentialStore(dir, { keyring: null }),
			);
		try {
			let err: unknown;
			try {
				await authFlow({
					_: ["auth"],
					apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
					clientId: "test-client-id",
					configDir,
					forceAuth: true,
					oauthHost: `http://localhost:${oauthServer.address().port}`,
					allowUnsafeTls: true,
				});
			} catch (caught) {
				err = caught;
			}
			expect(err).toBeInstanceOf(KeyringUnavailableError);
			expect(String(err)).toContain(
				"`neon profile remove DEFAULT --yes`",
			);
			expect(authSpy).not.toHaveBeenCalled();
		} finally {
			authSpy.mockRestore();
			storeSpy.mockRestore();
			rmSync(join(configDir, "profiles.json"), { force: true });
		}
	});

	test("locationForAuth follows a keyring pointer when --keyring is omitted or false", () => {
		writeFileSync(
			join(configDir, "profiles.json"),
			JSON.stringify({
				version: 1,
				profiles: { work: { credentials: "keyring" } },
			}),
		);
		try {
			expect(locationForAuth(configDir, "work").storage).toBe("keyring");
			expect(locationForAuth(configDir, "work", false).storage).toBe(
				"keyring",
			);
			expect(locationForAuth(configDir, "work", true).storage).toBe(
				"keyring",
			);
		} finally {
			rmSync(join(configDir, "profiles.json"), { force: true });
		}
	});

	test("omitted --keyring follows an existing keyring pointer", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		writeFileSync(
			join(configDir, "profiles.json"),
			JSON.stringify({
				version: 1,
				profiles: { DEFAULT: { credentials: "keyring" } },
			}),
		);
		const items = new Map<string, string>();
		const id = (service: string, account: string) =>
			`${service}\0${account}`;
		const keyring: KeyringBackend = {
			get: (service, account) => items.get(id(service, account)) ?? null,
			set: (service, account, password) => {
				items.set(id(service, account), password);
			},
			delete: (service, account) => items.delete(id(service, account)),
		};
		const storeSpy = vi
			.spyOn(credentialIo, "storeFor")
			.mockImplementation((dir: string) =>
				createCredentialStore(dir, { keyring }),
			);
		try {
			await authFlow({
				_: ["auth"],
				apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
				clientId: "test-client-id",
				configDir,
				forceAuth: true,
				oauthHost: `http://localhost:${oauthServer.address().port}`,
				allowUnsafeTls: true,
			});
			expect(items.size).toBe(1);
		} finally {
			storeSpy.mockRestore();
			rmSync(join(configDir, "profiles.json"), { force: true });
		}
	});

	test("auth --keyring deletes the owned credentials file and revokes the old session once", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		writeFileSync(
			join(configDir, "credentials.json"),
			JSON.stringify({
				type: "oauth",
				access_token: "old",
				refresh_token: "old-r",
				user_id: "u1",
			}),
		);
		const items = new Map<string, string>();
		const id = (service: string, account: string) =>
			`${service}\0${account}`;
		const keyring: KeyringBackend = {
			get: (service, account) => items.get(id(service, account)) ?? null,
			set: (service, account, password) => {
				items.set(id(service, account), password);
			},
			delete: (service, account) => items.delete(id(service, account)),
		};
		const storeSpy = vi
			.spyOn(credentialIo, "storeFor")
			.mockImplementation((dir: string) =>
				createCredentialStore(dir, { keyring }),
			);
		const revokeSpy = vi
			.spyOn(authModule, "revokeToken")
			.mockResolvedValue(true);
		const infoSpy = vi.spyOn(log, "info");
		try {
			await authFlow({
				_: ["auth"],
				apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
				clientId: "test-client-id",
				configDir,
				forceAuth: true,
				oauthHost: `http://localhost:${oauthServer.address().port}`,
				allowUnsafeTls: true,
				keyring: true,
			});
			expect(existsSync(join(configDir, "credentials.json"))).toBe(false);
			expect(revokeSpy).toHaveBeenCalledTimes(1);
			expect(revokeSpy.mock.calls[0]?.[1]).toMatchObject({
				refresh_token: "old-r",
			});
			expect(
				infoSpy.mock.calls.some(
					(call) =>
						typeof call[0] === "string" &&
						call[0].startsWith("Deleted"),
				),
			).toBe(true);
			expect(
				infoSpy.mock.calls.some(
					(call) => call[0] === "Signed out the session it replaced",
				),
			).toBe(true);
		} finally {
			revokeSpy.mockRestore();
			infoSpy.mockRestore();
			storeSpy.mockRestore();
			rmSync(join(configDir, "profiles.json"), { force: true });
			rmSync(join(configDir, "credentials.json"), { force: true });
		}
	});

	test("auth without --keyring overwrites a file and does not revoke", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		writeFileSync(
			join(configDir, "credentials.json"),
			JSON.stringify({
				type: "oauth",
				access_token: "old",
				refresh_token: "old-r",
				user_id: "u1",
			}),
		);
		const revokeSpy = vi
			.spyOn(authModule, "revokeToken")
			.mockResolvedValue(true);
		try {
			await authFlow({
				_: ["auth"],
				apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
				clientId: "test-client-id",
				configDir,
				forceAuth: true,
				oauthHost: `http://localhost:${oauthServer.address().port}`,
				allowUnsafeTls: true,
			});
			expect(existsSync(join(configDir, "credentials.json"))).toBe(true);
			expect(revokeSpy).not.toHaveBeenCalled();
		} finally {
			revokeSpy.mockRestore();
			rmSync(join(configDir, "credentials.json"), { force: true });
		}
	});

	test("throws when credentials cannot be saved", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		const storeSpy = vi
			.spyOn(credentialIo, "storeFor")
			.mockImplementation((dir: string) => {
				const store = createCredentialStore(dir, { keyring: null });
				return {
					...store,
					write: () => {
						throw new Error("disk full");
					},
				};
			});
		try {
			await expect(
				authFlow({
					_: ["auth"],
					apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
					clientId: "test-client-id",
					configDir,
					forceAuth: true,
					oauthHost: `http://localhost:${oauthServer.address().port}`,
					allowUnsafeTls: true,
				}),
			).rejects.toThrow(/disk full/);
		} finally {
			storeSpy.mockRestore();
		}
	});

	test("a failed keyring save does not revoke the file it would replace", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		writeFileSync(
			join(configDir, "credentials.json"),
			JSON.stringify({
				type: "oauth",
				access_token: "old",
				refresh_token: "old-r",
				user_id: "u1",
			}),
		);
		const items = new Map<string, string>();
		const id = (service: string, account: string) =>
			`${service}\0${account}`;
		const keyring: KeyringBackend = {
			get: (service, account) => items.get(id(service, account)) ?? null,
			set: (service, account, password) => {
				items.set(id(service, account), password);
			},
			delete: (service, account) => items.delete(id(service, account)),
		};
		const storeSpy = vi
			.spyOn(credentialIo, "storeFor")
			.mockImplementation((dir: string) => {
				const store = createCredentialStore(dir, { keyring });
				return {
					...store,
					write: () => {
						throw new Error("disk full");
					},
				};
			});
		const revokeSpy = vi
			.spyOn(authModule, "revokeToken")
			.mockResolvedValue(true);
		try {
			await expect(
				authFlow({
					_: ["auth"],
					apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
					clientId: "test-client-id",
					configDir,
					forceAuth: true,
					oauthHost: `http://localhost:${oauthServer.address().port}`,
					allowUnsafeTls: true,
					keyring: true,
				}),
			).rejects.toThrow(/disk full/);
			expect(revokeSpy).not.toHaveBeenCalled();
			expect(existsSync(join(configDir, "credentials.json"))).toBe(true);
		} finally {
			revokeSpy.mockRestore();
			storeSpy.mockRestore();
			rmSync(join(configDir, "credentials.json"), { force: true });
		}
	});

	test("does not delete an existing keyring item when profiles.json cannot be updated", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		writeFileSync(
			join(configDir, "profiles.json"),
			JSON.stringify({
				version: 1,
				profiles: { DEFAULT: { credentials: "keyring" } },
			}),
		);
		const items = new Map<string, string>();
		const id = (service: string, account: string) =>
			`${service}\0${account}`;
		const keyring: KeyringBackend & { size(): number } = {
			get: (service, account) => items.get(id(service, account)) ?? null,
			set: (service, account, password) => {
				items.set(id(service, account), password);
			},
			delete: (service, account) => items.delete(id(service, account)),
			size: () => items.size,
		};
		keyring.set(
			KEYRING_SERVICE,
			keyringAccount(configDir, "DEFAULT"),
			JSON.stringify({
				type: "oauth",
				access_token: "old-token",
				refresh_token: "old-refresh",
				user_id: "u1",
			}),
		);
		const storeSpy = vi
			.spyOn(credentialIo, "storeFor")
			.mockImplementation((dir: string) =>
				createCredentialStore(dir, { keyring }),
			);
		const upsertSpy = vi
			.spyOn(profilesCore, "upsertProfile")
			.mockImplementation(() => {
				throw new Error("profiles.json unwritable");
			});
		try {
			await expect(
				authFlow({
					_: ["auth"],
					apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
					clientId: "test-client-id",
					configDir,
					forceAuth: true,
					oauthHost: `http://localhost:${oauthServer.address().port}`,
					allowUnsafeTls: true,
					keyring: true,
				}),
			).rejects.toThrow(/profiles.json unwritable/);
			expect(keyring.size()).toBe(1);
			const raw = keyring.get(
				KEYRING_SERVICE,
				keyringAccount(configDir, "DEFAULT"),
			);
			expect(raw).not.toBeNull();
			expect(JSON.parse(raw ?? "{}").access_token).not.toBe("old-token");
		} finally {
			upsertSpy.mockRestore();
			storeSpy.mockRestore();
			rmSync(join(configDir, "profiles.json"), { force: true });
		}
	});

	test("rolls back a new keyring item when profiles.json cannot be updated", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		rmSync(join(configDir, "profiles.json"), { force: true });
		rmSync(join(configDir, "credentials.json"), { force: true });
		const items = new Map<string, string>();
		const id = (service: string, account: string) =>
			`${service}\0${account}`;
		const keyring: KeyringBackend & { size(): number } = {
			get: (service, account) => items.get(id(service, account)) ?? null,
			set: (service, account, password) => {
				items.set(id(service, account), password);
			},
			delete: (service, account) => items.delete(id(service, account)),
			size: () => items.size,
		};
		const storeSpy = vi
			.spyOn(credentialIo, "storeFor")
			.mockImplementation((dir: string) =>
				createCredentialStore(dir, { keyring }),
			);
		const upsertSpy = vi
			.spyOn(profilesCore, "upsertProfile")
			.mockImplementation(() => {
				throw new Error("profiles.json unwritable");
			});
		try {
			await expect(
				authFlow({
					_: ["auth"],
					apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
					clientId: "test-client-id",
					configDir,
					forceAuth: true,
					oauthHost: `http://localhost:${oauthServer.address().port}`,
					allowUnsafeTls: true,
					keyring: true,
				}),
			).rejects.toThrow(/profiles.json unwritable/);
			expect(keyring.size()).toBe(0);
		} finally {
			upsertSpy.mockRestore();
			storeSpy.mockRestore();
		}
	});

	test("warns when rollback cannot confirm the new keyring item is gone", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		rmSync(join(configDir, "profiles.json"), { force: true });
		rmSync(join(configDir, "credentials.json"), { force: true });
		const items = new Map<string, string>();
		const id = (service: string, account: string) =>
			`${service}\0${account}`;
		const keyring: KeyringBackend & { size(): number } = {
			get: (service, account) => items.get(id(service, account)) ?? null,
			set: (service, account, password) => {
				items.set(id(service, account), password);
			},
			delete: () => false,
			size: () => items.size,
		};
		const storeSpy = vi
			.spyOn(credentialIo, "storeFor")
			.mockImplementation((dir: string) =>
				createCredentialStore(dir, { keyring }),
			);
		const upsertSpy = vi
			.spyOn(profilesCore, "upsertProfile")
			.mockImplementation(() => {
				throw new Error("profiles.json unwritable");
			});
		const warnSpy = vi.spyOn(log, "warning");
		try {
			await expect(
				authFlow({
					_: ["auth"],
					apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
					clientId: "test-client-id",
					configDir,
					forceAuth: true,
					oauthHost: `http://localhost:${oauthServer.address().port}`,
					allowUnsafeTls: true,
					keyring: true,
				}),
			).rejects.toThrow(/profiles.json unwritable/);
			expect(keyring.size()).toBe(1);
			expect(warnSpy).toHaveBeenCalledWith(
				'Could not confirm the new OS keyring item for profile "%s" was removed after a failed save.',
				"DEFAULT",
			);
		} finally {
			warnSpy.mockRestore();
			upsertSpy.mockRestore();
			storeSpy.mockRestore();
		}
	});
});

describe("ensureAuth", () => {
	let configDir = "";
	let oauthServer: OAuth2Server;
	let mockApiClient: NeonApiClient;
	let authSpy: any;
	let refreshTokenSpy: any;

	beforeAll(async () => {
		configDir = mkdtempSync("test-config");
		oauthServer = await startOauthServer();
		mockApiClient = {} as NeonApiClient;
		authSpy = vi.spyOn(authModule, "auth");
		refreshTokenSpy = vi.spyOn(authModule, "refreshToken");
	});

	afterAll(async () => {
		rmSync(configDir, { recursive: true });
		await oauthServer.stop();
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		authSpy.mockClear();
		refreshTokenSpy.mockClear();
	});

	const setupTestProps = (server: any) => ({
		_: ["some-command"],
		configDir,
		oauthHost: `http://localhost:${oauthServer.address().port}`,
		clientId: "test-client-id",
		forceAuth: true,
		apiKey: "",
		apiHost: `http://localhost:${(server.address() as AddressInfo).port}`,
		help: false,
		apiClient: mockApiClient,
		allowUnsafeTls: true,
	});

	test("should start new auth flow when refresh token fails", async ({
		runMockServer,
	}) => {
		refreshTokenSpy.mockImplementationOnce(() =>
			Promise.reject(new Error("AUTH_REFRESH_FAILED")),
		);

		authSpy.mockImplementationOnce(() =>
			Promise.resolve({
				access_token: "new-auth-token",
				refresh_token: "new-refresh-token",
				expires_at: Math.floor(Date.now() / 1000) + 3600,
			}),
		);

		const server = await runMockServer("main");
		const expiredTokenSet = {
			access_token: "expired-token",
			refresh_token: "refresh-token",
			expires_at: Date.now() - 3600 * 1000,
		};

		writeFileSync(
			join(configDir, "credentials.json"),
			JSON.stringify(expiredTokenSet),
			{ mode: 0o700 },
		);

		const props = setupTestProps(server);
		await ensureAuth(props);

		expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
		expect(authSpy).toHaveBeenCalledTimes(1);
		expect(props.apiKey).toBe("new-auth-token");
	});

	test("does not start OAuth when a keyring pointer's get returns null", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		writeFileSync(
			join(configDir, "profiles.json"),
			JSON.stringify({
				version: 1,
				profiles: { DEFAULT: { credentials: "keyring" } },
			}),
		);
		rmSync(join(configDir, "credentials.json"), { force: true });
		const storeSpy = vi
			.spyOn(credentialIo, "storeFor")
			.mockImplementation((dir: string) =>
				createCredentialStore(dir, {
					keyring: {
						get: () => null,
						set: () => undefined,
						delete: () => false,
					},
				}),
			);
		try {
			await expect(
				ensureAuth(setupTestProps(server)),
			).rejects.toBeInstanceOf(KeyringUnreadableError);
			expect(authSpy).not.toHaveBeenCalled();
		} finally {
			storeSpy.mockRestore();
			rmSync(join(configDir, "profiles.json"), { force: true });
		}
	});

	test("does not start OAuth when a refreshed token cannot be persisted", async ({
		runMockServer,
	}) => {
		refreshTokenSpy.mockImplementationOnce(() =>
			Promise.resolve({
				access_token: "new-token",
				refresh_token: "new-refresh-token",
				expires_at: Math.floor(Date.now() / 1000) + 3600,
			}),
		);
		const server = await runMockServer("main");
		writeFileSync(
			join(configDir, "credentials.json"),
			JSON.stringify({
				access_token: "expired-token",
				refresh_token: "refresh-token",
				expires_at: Date.now() - 3600 * 1000,
			}),
			{ mode: 0o700 },
		);
		const storeSpy = vi
			.spyOn(credentialIo, "storeFor")
			.mockImplementation((dir: string) => {
				const store = createCredentialStore(dir, {
					keyring: null,
				});
				return {
					...store,
					write: () => {
						throw new Error("keyring write failed");
					},
				};
			});
		try {
			await expect(ensureAuth(setupTestProps(server))).rejects.toThrow(
				/keyring write failed/,
			);
			expect(authSpy).not.toHaveBeenCalled();
		} finally {
			storeSpy.mockRestore();
		}
	});

	test("should trigger auth flow when credentials.json does not exist", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");

		// Ensure the credentials file does not exist
		const credentialsPath = join(configDir, "credentials.json");
		if (existsSync(credentialsPath)) {
			rmSync(credentialsPath);
		}

		const props = setupTestProps(server);
		await ensureAuth(props);

		expect(authSpy).toHaveBeenCalledTimes(1);
		expect(refreshTokenSpy).not.toHaveBeenCalled();
		expect(props.apiKey).toEqual(expect.any(String));
	});

	// Changed deliberately: an invalid credentials file used to be treated as absent, so this
	// command would sign in over the top of it — overwriting a file the user might have wanted
	// back, possibly as a different account. It now stops and says how to replace it.
	test("should refuse and name the file when credentials.json is invalid", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		writeFileSync(join(configDir, "credentials.json"), "invalid json", {
			mode: 0o700,
		});

		const props = setupTestProps(server);
		await expect(ensureAuth(props)).rejects.toThrow(/not valid JSON/);
		expect(authSpy).not.toHaveBeenCalled();
	});

	test("should try refresh when token is missing access_token but has refresh_token", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		const tokenWithoutAccess = {
			refresh_token: "refresh-token",
		};

		writeFileSync(
			join(configDir, "credentials.json"),
			JSON.stringify(tokenWithoutAccess),
			{ mode: 0o700 },
		);

		refreshTokenSpy.mockImplementationOnce(() =>
			Promise.resolve({
				access_token: "refreshed-token",
				refresh_token: "new-refresh-token",
				expires_at: Math.floor(Date.now() / 1000) + 3600,
			}),
		);

		const props = setupTestProps(server);
		await ensureAuth(props);

		expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
		expect(authSpy).not.toHaveBeenCalled();
		expect(props.apiKey).toBe("refreshed-token");
	});

	test("should use existing valid token", async ({ runMockServer }) => {
		const server = await runMockServer("main");
		const validTokenSet = {
			access_token: "valid-token",
			refresh_token: "refresh-token",
			expires_at: Date.now() + 3600 * 1000, // 1 hour from now
		};

		writeFileSync(
			join(configDir, "credentials.json"),
			JSON.stringify(validTokenSet),
			{ mode: 0o700 },
		);

		const props = setupTestProps(server);
		await ensureAuth(props);

		expect(authSpy).not.toHaveBeenCalled();
		expect(refreshTokenSpy).not.toHaveBeenCalled();
		expect(props.apiKey).toBe("valid-token");
	});

	test("should skip global auth for init command", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");

		const credentialsPath = join(configDir, "credentials.json");
		if (existsSync(credentialsPath)) {
			rmSync(credentialsPath);
		}

		const props = {
			...setupTestProps(server),
			_: ["init"],
		};

		await ensureAuth(props);

		expect(authSpy).not.toHaveBeenCalled();
		expect(refreshTokenSpy).not.toHaveBeenCalled();
	});

	test("init does not refresh or refuse broken stored credentials", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		writeFileSync(join(configDir, "credentials.json"), "invalid json", {
			mode: 0o700,
		});

		await ensureAuth({
			...setupTestProps(server),
			_: ["init"],
		});

		expect(authSpy).not.toHaveBeenCalled();
		expect(refreshTokenSpy).not.toHaveBeenCalled();
	});

	test("init does not refresh an expired stored token", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		writeFileSync(
			join(configDir, "credentials.json"),
			JSON.stringify({
				access_token: "expired-token",
				refresh_token: "refresh-token",
				expires_at: Date.now() - 3600 * 1000,
			}),
			{ mode: 0o700 },
		);

		await ensureAuth({
			...setupTestProps(server),
			_: ["init"],
		});

		expect(authSpy).not.toHaveBeenCalled();
		expect(refreshTokenSpy).not.toHaveBeenCalled();
	});

	test("init still rejects --api-key together with --profile", async ({
		runMockServer,
	}) => {
		const server = await runMockServer("main");
		recordCredentialInputs({
			apiKeyFlag: "napi_test",
			apiKeyEnv: "",
			profileEnv: "",
			profileFlag: "work",
			configDir,
		});
		try {
			await expect(
				ensureAuth({
					...setupTestProps(server),
					_: ["init"],
					profile: "work",
				}),
			).rejects.toThrow(/--api-key or --profile, not both/);
		} finally {
			recordCredentialInputs({
				apiKeyFlag: "",
				apiKeyEnv: "",
				profileEnv: "",
				profileFlag: "",
				configDir: "",
			});
		}
	});

	test("should successfully refresh expired token", async ({
		runMockServer,
	}) => {
		refreshTokenSpy.mockImplementationOnce(() =>
			Promise.resolve({
				access_token: "new-token",
				refresh_token: "new-refresh-token",
				expires_at: Math.floor(Date.now() / 1000) + 3600,
			}),
		);

		const server = await runMockServer("main");
		const expiredTokenSet = {
			access_token: "expired-token",
			refresh_token: "refresh-token",
			expires_at: Date.now() - 3600 * 1000, // expired 1 hour ago
		};

		writeFileSync(
			join(configDir, "credentials.json"),
			JSON.stringify(expiredTokenSet),
			{ mode: 0o700 },
		);

		const props = setupTestProps(server);
		await ensureAuth(props);

		expect(refreshTokenSpy).toHaveBeenCalledTimes(1);
		expect(authSpy).not.toHaveBeenCalled();
		expect(props.apiKey).toBe("new-token");
	});
});

describe("deleteCredentialsAt", () => {
	let configDir = "";

	beforeAll(() => {
		configDir = mkdtempSync("test-config-delete");
	});

	afterAll(() => {
		rmSync(configDir, { recursive: true });
	});

	test("should successfully delete credentials file", () => {
		const credentialsPath = join(configDir, "credentials.json");
		writeFileSync(credentialsPath, "test-content", { mode: 0o700 });

		expect(existsSync(credentialsPath)).toBe(true);

		deleteCredentialsAt(
			{
				profile: "DEFAULT",
				storage: "file",
				path: credentialsPath,
			},
			configDir,
		);

		expect(existsSync(credentialsPath)).toBe(false);
	});

	test("should handle non-existent file gracefully", () => {
		const nonExistentDir = mkdtempSync("test-config-nonexistent");

		// Ensure the file doesn't exist
		const credentialsPath = join(nonExistentDir, "credentials.json");
		if (existsSync(credentialsPath)) {
			rmSync(credentialsPath);
		}

		expect(existsSync(credentialsPath)).toBe(false);

		// Should not throw an error
		expect(() => {
			deleteCredentialsAt(
				{
					profile: "DEFAULT",
					storage: "file",
					path: credentialsPath,
				},
				nonExistentDir,
			);
		}).not.toThrow();

		rmSync(nonExistentDir, { recursive: true });
	});
});
