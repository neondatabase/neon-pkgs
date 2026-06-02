import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readNeonctlCredentials, resolveApiKey } from "./auth.js";
import { makeTempRepo, stubCleanNeonEnv } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

beforeEach(() => {
	stubCleanNeonEnv();
});

function setupHome(files: Record<string, string | null>): string {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

describe("readNeonctlCredentials", () => {
	test("reads access_token from <home>/.config/neonctl/credentials.json by default", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "oauth-token-abc",
				refresh_token: "rt-xyz",
			}),
		});
		vi.stubEnv("HOME", home);
		const creds = readNeonctlCredentials();
		expect(creds?.access_token).toBe("oauth-token-abc");
		expect(creds?.refresh_token).toBe("rt-xyz");
	});

	test("honours NEONCTL_CONFIG_DIR over the default location", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "default-loc",
			}),
			"custom/credentials.json": JSON.stringify({
				access_token: "from-env-dir",
			}),
		});
		vi.stubEnv("HOME", home);
		vi.stubEnv("NEONCTL_CONFIG_DIR", `${home}/custom`);
		const creds = readNeonctlCredentials();
		expect(creds?.access_token).toBe("from-env-dir");
	});

	test("honours explicit configDir over the env var", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "default-loc",
			}),
			"env/credentials.json": JSON.stringify({
				access_token: "from-env-dir",
			}),
			"opt/credentials.json": JSON.stringify({
				access_token: "from-option",
			}),
		});
		vi.stubEnv("HOME", home);
		vi.stubEnv("NEONCTL_CONFIG_DIR", `${home}/env`);
		const creds = readNeonctlCredentials({ configDir: `${home}/opt` });
		expect(creds?.access_token).toBe("from-option");
	});

	test("returns null when the file is missing", () => {
		const home = setupHome({ ".config/neonctl/.keep": "" });
		vi.stubEnv("HOME", home);
		expect(readNeonctlCredentials()).toBeNull();
	});

	test("returns null on malformed JSON instead of throwing", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": "not json",
		});
		vi.stubEnv("HOME", home);
		expect(readNeonctlCredentials()).toBeNull();
	});

	test("returns null when access_token is missing or empty", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				refresh_token: "rt-only",
			}),
		});
		vi.stubEnv("HOME", home);
		expect(readNeonctlCredentials()).toBeNull();
		const home2 = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "",
			}),
		});
		vi.stubEnv("HOME", home2);
		expect(readNeonctlCredentials()).toBeNull();
	});

	test("returns null when no home dir resolvable", () => {
		// `stubCleanNeonEnv()` already cleared HOME and USERPROFILE.
		expect(readNeonctlCredentials()).toBeNull();
	});

	test("falls back to USERPROFILE on Windows-style env", () => {
		const winHome = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "win-token",
			}),
		});
		vi.stubEnv("USERPROFILE", winHome);
		const creds = readNeonctlCredentials();
		expect(creds?.access_token).toBe("win-token");
	});
});

describe("resolveApiKey — priority chain", () => {
	test("explicit option wins over env wins over credentials.json", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "from-file",
			}),
		});
		vi.stubEnv("HOME", home);
		vi.stubEnv("NEON_API_KEY", "from-env");
		expect(resolveApiKey({ apiKey: "from-option" })).toEqual({
			token: "from-option",
			source: "option",
		});

		expect(resolveApiKey()).toEqual({ token: "from-env", source: "env" });

		vi.stubEnv("NEON_API_KEY", undefined);
		expect(resolveApiKey()).toEqual({
			token: "from-file",
			source: "neonctl",
		});
	});

	test("returns null when no source provides a token", () => {
		const home = setupHome({ ".config/neonctl/.keep": "" });
		vi.stubEnv("HOME", home);
		expect(resolveApiKey()).toBeNull();
	});

	test("treats whitespace-only option / env as missing", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "from-file",
			}),
		});
		vi.stubEnv("HOME", home);
		vi.stubEnv("NEON_API_KEY", "   ");
		expect(resolveApiKey({ apiKey: "   " })).toEqual({
			token: "from-file",
			source: "neonctl",
		});
	});

	test("trims whitespace around the resolved token", () => {
		const home = setupHome({ ".config/neonctl/.keep": "" });
		vi.stubEnv("HOME", home);
		expect(resolveApiKey({ apiKey: "  napi_x  " })).toEqual({
			token: "napi_x",
			source: "option",
		});
	});
});
